/**
 * 프록시 쿼터 검증 — node test/proxy.test.mjs
 *
 * 구독제의 근거가 되는 숫자를 서버가 제대로 세는지 확인한다.
 * 이 로직이 틀리면 무료 사용자가 무제한으로 쓰거나, 유료 사용자가
 * 돈을 내고도 막히거나, 원가가 예측 불가능해진다.
 *
 * Worker를 실제로 띄우지 않고 fetch 핸들러를 직접 호출한다.
 * KV는 Map으로 흉내 낸다.
 */
import workerModule from '../worker/proxy.js';

let pass = 0, fail = 0;
const check = (name, a, b = true) => {
  const ok = a === b; ok ? pass++ : fail++;
  console.log(`${ok ? '  ✓' : '  ✗'} ${name}${ok ? '' : `  →  기대 ${b}, 실제 ${a}`}`);
};
const section = t => console.log(`\n── ${t}`);

/* ── 가짜 KV ─────────────────────────────────────────────── */
function makeKV(seed = {}) {
  const m = new Map(Object.entries(seed));
  return {
    _m: m,
    async get(k) { return m.has(k) ? m.get(k) : null; },
    async put(k, v) { m.set(k, v); },
    async delete(k) { m.delete(k); }
  };
}

const ORIGIN = 'https://example.github.io';   // proxy.js의 ALLOWED_ORIGINS 첫 항목

function req(path, { token, origin = ORIGIN, body = '{}' } = {}) {
  const headers = { Origin: origin, 'Content-Type': 'application/json',
                    'CF-Connecting-IP': '203.0.113.1' };
  if (token) headers.Authorization = `Bearer ${token}`;
  return new Request(`https://proxy.test${path}`, { method: 'POST', headers, body });
}

/* 상위 API 호출을 가로챈다. 쿼터 로직만 보려는 것이므로 항상 성공시킨다. */
let upstreamCalls = 0;
globalThis.fetch = async () => {
  upstreamCalls++;
  return new Response(JSON.stringify({
    candidates: [{ content: { parts: [{ text: '{"items":[]}' }] } }]
  }), { status: 200 });
};

const env = () => ({ GEMINI_API_KEY: 'test-key', MFDS_API_KEY: 'mfds-key', RATE_KV: makeKV() });

/* ═══════════════════════════════════════════════════════════
   1. 쿼터 조회
   ═══════════════════════════════════════════════════════════ */
section('쿼터 조회 (/quota)');
{
  const e = env();
  const res = await workerModule.fetch(req('/quota', { token: 'devicetoken123' }), e);
  const q = await res.json();
  check('200 응답', res.status, 200);
  check('기본 등급은 free', q.tier, 'free');
  check('free 한도 5회', q.limit, 5);
  check('처음엔 0회 사용', q.used, 0);
  check('남은 횟수 계산', q.remaining, 5);
  check('서버가 실제로 강제함', q.enforced, true);
  check('초기화 시각 제공', typeof q.resetsAt, 'string');
  check('조회만으로는 차감 안 됨', (await (await workerModule.fetch(
    req('/quota', { token: 'devicetoken123' }), e)).json()).used, 0);
}

/* ═══════════════════════════════════════════════════════════
   2. 한도 소진 — 구독제의 핵심
   ═══════════════════════════════════════════════════════════ */
section('일일 한도 소진');
{
  const e = env();
  const T = 'devicetoken456';
  upstreamCalls = 0;

  for (let i = 1; i <= 5; i++) {
    const r = await workerModule.fetch(req('/gemini', { token: T }), e);
    check(`${i}번째 호출 통과`, r.status, 200);
  }
  check('상위 API가 5번 호출됨', upstreamCalls, 5);

  const blocked = await workerModule.fetch(req('/gemini', { token: T }), e);
  check('6번째는 429로 차단', blocked.status, 429);
  const info = await blocked.json();
  check('차단 사유가 QUOTA_EXCEEDED', info.error, 'QUOTA_EXCEEDED');
  check('한도를 응답에 포함', info.limit, 5);
  check('등급을 응답에 포함', info.tier, 'free');
  /* 여기가 가장 중요하다. 막았는데 상위 API를 이미 불렀으면 돈은 이미 나간 뒤다. */
  check('차단 시 상위 API를 부르지 않음 (비용 발생 없음)', upstreamCalls, 5);
}

/* ═══════════════════════════════════════════════════════════
   3. 등급별 한도
   ═══════════════════════════════════════════════════════════ */
section('구독 등급별 한도');
{
  const cases = [['free', 5], ['basic', 50], ['pro', 300], ['unlimited', 2000]];
  for (const [tier, limit] of cases) {
    const e = env();
    await e.RATE_KV.put(`tier:u:token_${tier}`, tier);
    const q = await (await workerModule.fetch(
      req('/quota', { token: `token_${tier}` }), e)).json();
    check(`${tier} 등급 한도 ${limit}회`, q.limit, limit);
  }
  /* "무제한"을 진짜 무한으로 두면 한 계정의 자동화가 마진을 통째로 날린다.
     공정사용 상한이 반드시 있어야 한다. */
  const e = env();
  await e.RATE_KV.put('tier:u:tok_unlimited', 'unlimited');
  const q = await (await workerModule.fetch(req('/quota', { token: 'tok_unlimited' }), e)).json();
  check('무제한 등급도 상한이 존재 (남용 방지)', Number.isFinite(q.limit), true);
}

/* ═══════════════════════════════════════════════════════════
   4. 사용자 분리 — 남의 쿼터를 쓰면 안 된다
   ═══════════════════════════════════════════════════════════ */
section('사용자별 분리');
{
  const e = env();
  for (let i = 0; i < 5; i++) await workerModule.fetch(req('/gemini', { token: 'userAAAA' }), e);
  const a = await (await workerModule.fetch(req('/quota', { token: 'userAAAA' }), e)).json();
  const b = await (await workerModule.fetch(req('/quota', { token: 'userBBBB' }), e)).json();
  check('A는 5회 사용', a.used, 5);
  check('B는 영향 없음', b.used, 0);
  check('A는 소진', a.remaining, 0);
  check('B는 그대로', b.remaining, 5);
}

/* ═══════════════════════════════════════════════════════════
   5. 토큰이 없을 때 — IP로 떨어진다
   ═══════════════════════════════════════════════════════════ */
section('토큰 없는 요청');
{
  const e = env();
  const q = await (await workerModule.fetch(req('/quota'), e)).json();
  check('토큰 없어도 쿼터가 적용됨', q.enforced, true);
  check('IP 기준으로 식별', q.limit, 5);
}

/* ═══════════════════════════════════════════════════════════
   6. 영양 조회는 쿼터를 쓰지 않는다
   ═══════════════════════════════════════════════════════════ */
section('영양 조회(/mfds)는 무과금');
{
  const e = env();
  const T = 'mfdsuser111';
  globalThis.fetch = async () => new Response(JSON.stringify({ I2790: { row: [] } }), { status: 200 });
  for (let i = 0; i < 8; i++) await workerModule.fetch(req('/mfds', {
    token: T, body: JSON.stringify({ service: 'I2790', param: 'DESC_KOR', value: '밥' })
  }), e);
  const q = await (await workerModule.fetch(req('/quota', { token: T }), e)).json();
  check('영양 조회 8회에도 쿼터 0 소비', q.used, 0);
}

/* ═══════════════════════════════════════════════════════════
   7. KV가 없으면 — 막을 수 없다는 사실을 숨기지 않는다
   ═══════════════════════════════════════════════════════════ */
section('KV 미바인딩');
{
  globalThis.fetch = async () => new Response(JSON.stringify({
    candidates: [{ content: { parts: [{ text: '{}' }] } }] }), { status: 200 });
  const e = { GEMINI_API_KEY: 'k', MFDS_API_KEY: 'm' };   // RATE_KV 없음
  const q = await (await workerModule.fetch(req('/quota', { token: 'nokv1234' }), e)).json();
  check('통과시키되 강제하지 않음을 표시', q.enforced, false);
  check('그래도 요청 자체는 동작', (await workerModule.fetch(req('/gemini', { token: 'nokv1234' }), e)).status, 200);
}

/* ═══════════════════════════════════════════════════════════
   8. 출처 제한 — 남이 내 프록시를 못 쓰게
   ═══════════════════════════════════════════════════════════ */
section('출처 제한');
{
  const e = env();
  const bad = await workerModule.fetch(req('/gemini', { token: 'x1234567', origin: 'https://evil.com' }), e);
  check('허용되지 않은 출처는 403', bad.status, 403);
  const opt = await workerModule.fetch(new Request('https://proxy.test/gemini', {
    method: 'OPTIONS', headers: { Origin: ORIGIN } }), e);
  check('preflight는 통과', opt.status, 200);
  const get = await workerModule.fetch(new Request('https://proxy.test/gemini', {
    method: 'GET', headers: { Origin: ORIGIN } }), e);
  check('GET은 405', get.status, 405);
}

/* ═══════════════════════════════════════════════════════════
   9. 식약처 검색 파라미터 방어
   ═══════════════════════════════════════════════════════════ */
section('식약처 경로 방어');
{
  const e = env();
  let calledUrl = '';
  globalThis.fetch = async (u) => { calledUrl = String(u);
    return new Response(JSON.stringify({ I2790: { row: [] } }), { status: 200 }); };

  const bad1 = await workerModule.fetch(req('/mfds', { body: JSON.stringify({
    service: 'EVIL', param: 'DESC_KOR', value: '밥' }) }), e);
  check('허용되지 않은 서비스는 400', bad1.status, 400);

  const bad2 = await workerModule.fetch(req('/mfds', { body: JSON.stringify({
    service: 'I2790', param: 'HACK', value: '밥' }) }), e);
  check('허용되지 않은 파라미터는 400', bad2.status, 400);

  await workerModule.fetch(req('/mfds', { body: JSON.stringify({
    service: 'I2790', param: 'DESC_KOR', value: '밥', rows: 999 }) }), e);
  check('rows 상한이 걸림 (과도한 조회 방지)', /\/1\/10\//.test(calledUrl), true);

  await workerModule.fetch(req('/mfds', { body: JSON.stringify({
    service: 'I2790', param: 'DESC_KOR', value: '밥', rows: 6 }) }), e);
  check('정상 rows는 그대로 전달', /\/1\/6\//.test(calledUrl), true);
}

console.log(`\n${'═'.repeat(50)}`);
console.log(`통과 ${pass} · 실패 ${fail}`);
console.log('═'.repeat(50));
process.exit(fail ? 1 : 0);
