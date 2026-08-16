/**
 * proxy.js — 밥상 판정 앱용 Cloudflare Worker
 *
 * 역할: 브라우저 대신 이 서버가 API 키를 들고 외부를 호출한다.
 *       사용자는 어떤 키도 입력하지 않고, 키는 브라우저 코드에 노출되지 않는다.
 *
 *   브라우저 → /gemini → Gemini API      (사진에서 음식 이름 식별)
 *   브라우저 → /mfds   → 식약처 영양성분DB (음식 이름으로 영양 조회)
 *
 * 배포는 README의 "프록시 배포" 절 참조.
 *
 * ⚠️ 이 프록시가 없어도 앱은 온디바이스·수동 인식 + 내장 영양 테이블로
 *    완전히 동작한다. 프록시는 정확도를 올리는 선택 사항이다.
 */

/* 내 사이트만 허용. 이게 없으면 남이 내 프록시를 자기 서비스에 갖다 쓴다.
   ⚠️ HTTP 헤더는 ASCII만 담을 수 있다. 한글이 섞인 주소를 넣으면
      거부 응답을 만들 때 Worker가 예외로 죽는다(테스트가 잡은 실제 버그).
      배포 시 아래 첫 줄을 본인 도메인으로 바꾸되 반드시 ASCII여야 한다. */
const ALLOWED_ORIGINS = [
  'https://example.github.io',
  'http://localhost:8000',
  'http://127.0.0.1:8000',
  /* 로컬 실제 테스트용(8123 포트, LAN IP로 폰 접속 포함). 실배포 시 지워도 된다. */
  'http://localhost:8123',
  'http://127.0.0.1:8123',
  'http://219.255.222.153:8123'
];

const GEMINI_MODEL = 'gemini-flash-latest';
const MAX_BODY_BYTES = 8 * 1024 * 1024;   // 사진 포함 8MB 상한

/* IP당 시간당 요청 상한. RATE_KV를 바인딩해야 동작하며, 없으면 조용히 건너뛴다.
   무료 등급 소진과 프록시 남용을 막는 최소 방어선이다. */
const RATE_LIMIT = { max: 60, windowSec: 3600 };

/* ────────────────────────────────────────────────────────────
   구독 등급별 일일 쿼터
   ────────────────────────────────────────────────────────────
   ⚠️ 이 제한은 반드시 서버에서 걸어야 한다. 클라이언트 카운터는
      개발자도구로 몇 초면 우회된다. 구독제의 근거가 되는 숫자이므로
      브라우저를 믿으면 안 된다.

   등급은 KV의 `tier:<userId>`에 저장한다. 결제 시스템(스토어 영수증 검증,
   Stripe webhook 등)이 이 값을 갱신하는 구조를 상정한다.
   결제 연동은 이 파일의 범위 밖이다.

   'unlimited'를 진짜 무한으로 두지 않는 이유: 한 계정이 자동화로
   수만 번 때리면 마진이 통째로 날아간다. 공정사용 상한을 둔다. */
const TIERS = {
  free:      { daily: 5,    label: '무료' },
  basic:     { daily: 50,   label: '베이직' },
  pro:       { daily: 300,  label: '프로' },
  unlimited: { daily: 2000, label: '무제한' }   // 공정사용 상한
};
const DEFAULT_TIER = 'free';

/* 쿼터를 소비하는 경로. 영양 조회(/mfds)는 비용이 거의 없어 제외한다. */
const METERED_PATHS = ['/gemini'];

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin') || '';
    const allowed = ALLOWED_ORIGINS.includes(origin);
    const cors = {
      'Access-Control-Allow-Origin': allowed ? origin : ALLOWED_ORIGINS[0],
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Vary': 'Origin'
    };

    if (request.method === 'OPTIONS') return new Response(null, { headers: cors });
    if (request.method !== 'POST')   return json({ error: 'POST만 허용됩니다' }, 405, cors);
    if (!allowed)                    return json({ error: '허용되지 않은 출처입니다' }, 403, cors);

    const limited = await checkRate(request, env, cors);
    if (limited) return limited;

    const path = new URL(request.url).pathname.replace(/\/+$/, '');

    /* 쿼터 확인은 상위 API를 호출하기 전에 한다.
       호출한 뒤에 막으면 이미 돈이 나간 뒤다. */
    let quota = null;
    if (METERED_PATHS.includes(path)) {
      quota = await checkQuota(request, env);
      if (!quota.allowed) {
        return json({
          error: 'QUOTA_EXCEEDED',
          message: `오늘 사용 가능한 횟수(${quota.limit}회)를 모두 썼습니다.`,
          tier: quota.tier, used: quota.used, limit: quota.limit,
          resetsAt: quota.resetsAt
        }, 429, cors);
      }
    }

    try {
      if (path === '/quota')  return json(await checkQuota(request, env, false), 200, cors);
      if (path === '/gemini') {
        const res = await handleGemini(request, env, cors);
        // 성공했을 때만 차감한다. 상위 오류로 실패했는데 깎으면 억울하다.
        if (res.status === 200 && quota) await consumeQuota(env, quota);
        return res;
      }
      if (path === '/mfds')   return await handleMfds(request, env, cors);
      return json({ error: '없는 경로입니다' }, 404, cors);
    } catch (e) {
      // 내부 오류 메시지를 그대로 노출하지 않는다
      console.error(path, e);
      return json({ error: '프록시 오류' }, 500, cors);
    }
  }
};

/* ── Gemini 중계 ─────────────────────────────────────────── */
async function handleGemini(request, env, cors) {
  if (!env.GEMINI_API_KEY) return json({ error: 'Gemini 키가 설정되지 않았습니다' }, 503, cors);

  const raw = await request.text();
  if (raw.length > MAX_BODY_BYTES) return json({ error: '사진 용량이 너무 큽니다' }, 413, cors);

  const upstream = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': env.GEMINI_API_KEY },
      body: raw
    }
  );

  // 429 등 상태 코드를 그대로 전달해야 앱이 "잠시 후 다시" 안내를 띄울 수 있다
  return new Response(await upstream.text(), {
    status: upstream.status,
    headers: { ...cors, 'Content-Type': 'application/json' }
  });
}

/* ── 식약처 식품영양성분DB 중계 ──────────────────────────── */
async function handleMfds(request, env, cors) {
  if (!env.MFDS_API_KEY) return json({ error: '식약처 키가 설정되지 않았습니다' }, 503, cors);

  const { service, param, value, rows } = await request.json();

  /* 화이트리스트 검증. 경로 조작으로 다른 서비스를 호출하지 못하게 막는다. */
  const ALLOWED_SERVICES = ['I2790', 'I0750'];
  const ALLOWED_PARAMS   = ['DESC_KOR', 'FOOD_NM_KR'];
  if (!ALLOWED_SERVICES.includes(service)) return json({ error: '허용되지 않은 서비스' }, 400, cors);
  if (!ALLOWED_PARAMS.includes(param))     return json({ error: '허용되지 않은 파라미터' }, 400, cors);
  if (typeof value !== 'string' || value.length === 0 || value.length > 60)
    return json({ error: '검색어가 올바르지 않습니다' }, 400, cors);

  // 검색 결과 개수. 과도한 요청을 막기 위해 상한을 둔다.
  const n = Math.min(Math.max(Number(rows) || 1, 1), 10);

  /* I2790은 2023년에 서비스가 끝났지만 코드는 남겨 둔다(구 키로 테스트하던 흔적, 테스트 스위트도 이 경로를 검증한다).
     I0750은 2026-08 실측 결과 옛 openapi.foodsafetykorea.go.kr 경로가 완전히 죽어 있었고,
     data.go.kr의 새 REST 엔드포인트(apis.data.go.kr, serviceKey는 쿼리스트링)로 이전된 것을 확인했다.
     ⚠️ MFDS_API_KEY는 반드시 "Encoding" 키(데이터포털에서 주는 %-인코딩된 값)를 그대로 넣어야 한다.
        Decoding 키를 넣으면 키 안의 raw '/' 때문에 옛 경로식 URL이 깨지고, 이 새 경로에서도
        쿼리스트링에 특수문자가 그대로 들어가 인코딩이 어긋난다. */
  const url = service === 'I0750'
    ? `https://apis.data.go.kr/1471000/FoodNtrCpntDbInfo02/getFoodNtrCpntDbInq02` +
      `?serviceKey=${env.MFDS_API_KEY}&type=json&numOfRows=${n}&pageNo=1&${param}=${encodeURIComponent(value)}`
    : `http://openapi.foodsafetykorea.go.kr/api/${env.MFDS_API_KEY}` +
      `/${service}/json/1/${n}/${param}=${encodeURIComponent(value)}`;

  const upstream = await fetch(url);
  if (!upstream.ok) return json({ error: '식약처 API 오류' }, 502, cors);

  const text = await upstream.text();

  /* 응답에 키가 섞여 나오는 일은 없지만, 만에 하나를 대비해 한 번 걸러낸다 */
  const safe = text.split(env.MFDS_API_KEY).join('***');

  return new Response(safe, {
    status: 200,
    headers: {
      ...cors,
      'Content-Type': 'application/json',
      // 같은 음식을 여러 사용자가 조회하므로 엣지 캐시가 효과가 크다
      'Cache-Control': 'public, max-age=86400'
    }
  });
}

/* ────────────────────────────────────────────────────────────
   사용자 식별 + 일일 쿼터
   ────────────────────────────────────────────────────────────
   사용자 식별은 Authorization: Bearer <userId>로 받는다.
   지금은 앱이 생성한 기기 토큰을 그대로 쓰지만, 실제 서비스에서는
   여기를 계정 인증(JWT 검증, 스토어 영수증 검증 등)으로 바꿔야 한다.

   ⚠️ 기기 토큰은 사용자가 지우고 새로 만들면 쿼터가 초기화된다.
      무료 등급 남용을 정말 막으려면 계정 로그인이 필요하다.
      그래서 IP 기준 rate limit을 함께 걸어 두 겹으로 방어한다.
*/
function userIdOf(request) {
  const auth = request.headers.get('Authorization') || '';
  const m = auth.match(/^Bearer\s+([A-Za-z0-9_-]{8,64})$/);
  if (m) return `u:${m[1]}`;
  // 토큰이 없으면 IP로 떨어진다 (공용 IP에서는 서로 쿼터를 나눠 쓰게 된다)
  return `ip:${request.headers.get('CF-Connecting-IP') || 'unknown'}`;
}

/** UTC 기준 날짜 키. 자정에 초기화된다. */
function dayKey() { return new Date().toISOString().slice(0, 10); }

function nextMidnightISO() {
  const d = new Date();
  d.setUTCHours(24, 0, 0, 0);
  return d.toISOString();
}

/**
 * 남은 쿼터를 확인한다. consume=false면 조회만 한다(/quota 경로).
 * KV가 없으면 제한을 걸 수 없으므로 통과시키되 그 사실을 응답에 남긴다.
 */
async function checkQuota(request, env, enforce = true) {
  const id = userIdOf(request);
  const resetsAt = nextMidnightISO();

  if (!env.RATE_KV) {
    return { allowed: true, tier: DEFAULT_TIER, used: 0,
             limit: TIERS[DEFAULT_TIER].daily, resetsAt, enforced: false, id };
  }

  const tier = (await env.RATE_KV.get(`tier:${id}`)) || DEFAULT_TIER;
  const conf = TIERS[tier] || TIERS[DEFAULT_TIER];
  const key = `q:${id}:${dayKey()}`;
  const used = Number(await env.RATE_KV.get(key)) || 0;

  return {
    allowed: !enforce || used < conf.daily,
    tier, tierLabel: conf.label, used, limit: conf.daily,
    remaining: Math.max(0, conf.daily - used),
    resetsAt, enforced: true, key
  };
}

/** 실제 호출이 성공한 뒤에만 차감한다. */
async function consumeQuota(env, quota) {
  if (!env.RATE_KV || !quota?.key) return;
  await env.RATE_KV.put(quota.key, String(quota.used + 1),
    { expirationTtl: 60 * 60 * 48 });   // 이틀 뒤 자동 삭제
}

/* ── 간이 rate limit (RATE_KV 바인딩 시에만 동작) ────────── */
async function checkRate(request, env, cors) {
  if (!env.RATE_KV) return null;
  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  const bucket = Math.floor(Date.now() / 1000 / RATE_LIMIT.windowSec);
  const key = `rl:${ip}:${bucket}`;
  const count = Number(await env.RATE_KV.get(key)) || 0;
  if (count >= RATE_LIMIT.max) {
    return json({ error: '요청이 너무 많습니다. 잠시 후 다시 시도해 주세요.' }, 429, cors);
  }
  // KV는 결과적 일관성이라 정확한 카운팅은 아니지만, 남용 억제 목적에는 충분하다
  await env.RATE_KV.put(key, String(count + 1), { expirationTtl: RATE_LIMIT.windowSec * 2 });
  return null;
}

function json(obj, status, headers) {
  return new Response(JSON.stringify(obj), {
    status, headers: { ...headers, 'Content-Type': 'application/json' }
  });
}
