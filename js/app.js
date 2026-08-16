/**
 * app.js — UI 통합
 *
 * 화면 흐름: 질환 선택 → 음식 식별 → 사용자 확인·보정 → 룰 판정
 * 3단계(확인·보정)가 이 앱의 안전장치다. AI가 틀려도 사용자가 눈으로 잡는다.
 */
import { DISEASE_BY_ID, DISEASE_GROUPS, evaluate, sumMeal, verdictKo } from './rules.js';
import { NutritionStore } from './nutrition.js';
import { ADAPTERS, makeIdentifier, shrinkImage } from './identify.js';

/* ══════════════════════════════════════════════════════════
   설정 — 배포 시 여기만 채우면 됩니다
   ══════════════════════════════════════════════════════════ */

// Cloudflare Worker 주소. 채우면 Gemini 인식과 식약처 영양 조회가 켜집니다.
// 비워 둬도 앱은 완전히 동작합니다(클라우드 AI·기기 인식·직접 고르기).
//   예: "https://meal-check.내계정.workers.dev"
const PROXY_URL = 'https://meal-check-proxy.meal-check-hybrid.workers.dev';

// ── Gemini를 지금 바로 시험해 보고 싶을 때만 ────────────────────────────
// aistudio.google.com에서 발급받은 키를 여기 붙여넣으면
// 프록시 없이 곧바로 Gemini 인식이 켜집니다.
//
// 💰 요금: 무료 등급은 신용카드가 필요 없고 기간 제한도 없습니다.
//    결제(billing)를 활성화하지 않는 한 청구 자체가 불가능합니다.
//    한도를 넘기면 돈이 나가는 게 아니라 429 오류가 뜨고, 앱은
//    "잠시 후 다시" 안내를 띄운 뒤 검색으로 담도록 넘깁니다.
//    ⚠️ 단, AI Studio에서 결제를 켜는 순간 무료 등급이 사라집니다. 켜지 마세요.
//
// ⚠️ 보안: 이 키가 든 파일을 인터넷에 올리면 누구나 훔쳐 씁니다.
//    품질만 확인하고 반드시 지운 뒤 PROXY_URL 방식으로 배포하세요.
const DEV_GEMINI_KEY = '';

// 쓸 Gemini 모델. 무료 등급 한도(2026년 기준)가 모델마다 다릅니다.
//   'gemini-flash-latest'       분당 10회 · 하루  250회 — 정확도 우선
//   'gemini-flash-lite-latest'  분당 15회 · 하루 1000회 — 한도 우선
// 한 끼 판정이 요청 1회이므로, 하루 세 끼 기준
// Flash는 약 80명, Flash-Lite는 약 330명까지 감당합니다.
// 한도를 넘기면 요금이 아니라 429가 오고, 앱이 안내한 뒤 검색으로 넘깁니다.
const GEMINI_MODEL = 'gemini-flash-latest';
const GEMINI_DAILY_LIMIT = 250;   // 위 모델의 하루 한도. 모델을 바꾸면 같이 고치세요.

// 사진을 보내기 전 줄일 크기(긴 변, 픽셀). 작을수록 토큰=원가가 줄어듭니다.
// 다만 너무 줄이면 인식 정확도가 떨어지므로 실측이 필요합니다.
//   tools/compare-resolution.mjs 로 같은 사진을 해상도별로 비교할 수 있습니다.
const MAX_IMAGE_SIDE = 1024;

// Pollinations 퍼블리셔블 토큰(pk_...). auth.pollinations.ai에서 무료 가입 시 발급.
// 비워 두면 익명으로 시도하는데, 지금은 크레딧제라 대부분 402로 실패합니다.
const POLLINATIONS_TOKEN = '';

// ── 자체 학습 모델 ──────────────────────────────────────────────────
// train/ 폴더의 파이프라인으로 학습해 내보낸 모델이 있는 폴더 주소.
// food-classifier.onnx 와 food-classes.json 이 이 아래에 있어야 합니다.
//   예: './models'  또는  'https://내도메인/models'
//
// 이게 설정되면 한국 음식 인식이 가장 정확해지고 호출 비용이 0이 됩니다.
// 아직 학습 전이면 비워 두세요. 다른 어댑터로 정상 동작합니다.
const LOCAL_MODEL_URL = './models';
// ────────────────────────────────────────────────────────────────────

// 식약처 API 프로파일. 'I2790'은 2023년에 서비스가 끝나 항상 실패한다(코드만 남겨 둠).
// 'I0750'이 후속 서비스이며 2026-08-13 실제 키로 필드·엔드포인트 검증을 마쳤다.
const MFDS_PROFILE = 'I0750';

/* ══════════════════════════════════════════════════════════ */

const $ = id => document.getElementById(id);
const store = new NutritionStore({ proxyUrl: PROXY_URL, profile: MFDS_PROFILE });

/* localStorage 안전 래퍼.
   file://로 열면 origin이 opaque가 되어 localStorage 접근 자체가 예외를 던진다
   (브라우저마다 다르다). 감싸지 않으면 첫 줄에서 스크립트 전체가 죽어 흰 화면이 된다.
   저장이 안 되는 건 불편할 뿐이지만, 앱이 안 뜨는 건 치명적이다.
   시크릿 모드·저장공간 부족·쿠키 차단에서도 같은 일이 생긴다. */
const mem = new Map();
const safeStore = {
  available: (() => {
    try { localStorage.setItem('mc.probe', '1'); localStorage.removeItem('mc.probe'); return true; }
    catch { return false; }
  })(),
  get(k) {
    try { return this.available ? localStorage.getItem(k) : (mem.get(k) ?? null); }
    catch { return null; }
  },
  set(k, v) {
    try { this.available ? localStorage.setItem(k, v) : mem.set(k, v); } catch { /* 무시 */ }
  },
  remove(k) {
    try { this.available ? localStorage.removeItem(k) : mem.delete(k); } catch { /* 무시 */ }
  }
};

/* file://로 열면 CDN 동적 import가 막힐 수 있다(브라우저마다 다름).
   그렇다고 미리 막아 버리면, 될 수도 있는 환경에서까지 기능을 뺏는다.
   그래서 막지 않는다. 일단 해 보고 실패하면 그때 이유를 알려 준다.
   사진 올리기 자체는 어느 환경에서든 되므로 항상 열어 둔다. */
const IS_FILE = location.protocol === 'file:';

let picked = [];          // [{ food, portion, confidence }]
let imageDataUrl = null;
const GEMINI_READY = !!(PROXY_URL || DEV_GEMINI_KEY);
const CLOUD_READY = !!POLLINATIONS_TOKEN;
const LOCAL_READY = !!LOCAL_MODEL_URL;
/* 기본값 선택 기준: "설정 없이 실제로 성공하는 것 중 가장 나은 것".
   자체 모델 > Gemini > Pollinations(토큰 있을 때) > 기기 인식(CLIP) 순.
   자체 모델이 1순위인 이유: 한국 음식에 가장 정확하고 비용이 0이다.
   Pollinations는 크레딧제라 토큰 없이는 402가 나므로 기본값이 될 수 없다. */
let adapterId = safeStore.get('mc.adapter')
  || (LOCAL_READY ? 'local' : GEMINI_READY ? 'gemini' : CLOUD_READY ? 'cloud' : 'ondevice');

/* ── 무료 등급 사용량 카운터 ─────────────────────────────
   Gemini 무료 등급은 하루 요청 수 제한이 있다. 한도에 닿으면 429가 오는데,
   그때 처음 알게 되면 "왜 갑자기 안 되지"가 된다. 미리 남은 횟수를 보여 준다.
   기기 안에서만 세므로 실제 서버 카운트와 오차가 있을 수 있다(참고용). */
const USAGE_KEY = 'mc.usage';
const TOKEN_KEY = 'mc.token';

/* 기기 토큰. 프록시가 사용자별 쿼터를 세는 식별자다.
   ⚠️ 이건 인증이 아니다. 지우고 새로 만들면 쿼터가 초기화된다.
      실제 구독 서비스에서는 계정 로그인으로 대체해야 한다.
      그때까지는 프록시의 IP 기준 rate limit이 2차 방어선이다. */
function deviceToken() {
  let t = safeStore.get(TOKEN_KEY);
  if (!t) {
    const b = new Uint8Array(16);
    (globalThis.crypto || {}).getRandomValues?.(b);
    t = [...b].map(x => x.toString(16).padStart(2, '0')).join('')
      || String(Date.now()) + Math.random().toString(36).slice(2);
    safeStore.set(TOKEN_KEY, t);
  }
  return t;
}

function today() { return new Date().toISOString().slice(0, 10); }

/* 서버가 알려 준 쿼터. 프록시를 쓸 때는 이게 진짜 값이다.
   로컬 카운터는 프록시가 없을 때(임시 키 모드)만 쓰는 참고값이다. */
let serverQuota = null;

function readUsage() {
  try {
    const u = JSON.parse(safeStore.get(USAGE_KEY) || '{}');
    return u.date === today() ? u : { date: today(), count: 0 };
  } catch { return { date: today(), count: 0 }; }
}
function bumpUsage() {
  const u = readUsage();
  u.count += 1;
  safeStore.set(USAGE_KEY, JSON.stringify(u));
  renderUsage();
  return u.count;
}

/** 프록시에 남은 횟수를 물어본다. 실패해도 앱은 그대로 동작한다. */
async function refreshQuota() {
  if (!PROXY_URL) return;
  try {
    const res = await fetch(`${PROXY_URL}/quota`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json',
                 Authorization: `Bearer ${deviceToken()}` },
      body: '{}'
    });
    if (res.ok) serverQuota = await res.json();
  } catch { /* 무시 */ }
  renderUsage();
}

function renderUsage() {
  const el = $('usageNote');
  if (!el) return;
  if (adapterId !== 'gemini' || !GEMINI_READY) { el.hidden = true; return; }
  el.hidden = false;

  if (serverQuota?.enforced) {
    const { used, limit, remaining, tierLabel } = serverQuota;
    el.textContent = `${tierLabel} 등급 · 오늘 ${used}/${limit}회 사용 · ${remaining}회 남음`;
    el.classList.toggle('warn', remaining <= Math.max(2, limit * 0.1));
    return;
  }
  // 프록시 없이 임시 키로 쓰는 경우 — 기기 안 카운터(참고값)
  const { count } = readUsage();
  const left = Math.max(0, GEMINI_DAILY_LIMIT - count);
  el.textContent = `오늘 무료 한도 ${count}/${GEMINI_DAILY_LIMIT}회 사용 · ${left}회 남음 (기기 기준 추정)`
    + (left <= 20 ? ' — 다 쓰면 내일 자정(태평양시)에 초기화됩니다.' : '');
  el.classList.toggle('warn', left <= 20);
}

/* ── 최근 먹은 것 ─────────────────────────────────────────
   비용 절감의 가장 큰 수단이다. 사람은 같은 음식을 반복해서 먹으므로,
   한 번 담은 것을 다시 꺼내 쓰면 AI 호출이 아예 일어나지 않는다.
   기기 안에만 저장하며 서버로 보내지 않는다. */
const RECENT_KEY = 'mc.recent';
const RECENT_MAX = 12;

function readRecent() {
  try {
    const ids = JSON.parse(safeStore.get(RECENT_KEY) || '[]');
    return Array.isArray(ids) ? ids.filter(x => typeof x === 'string') : [];
  } catch { return []; }
}

/** 담을 때마다 호출. 가장 최근 것이 앞으로 오고 중복은 하나로 합친다. */
function rememberFood(id) {
  const ids = [id, ...readRecent().filter(x => x !== id)].slice(0, RECENT_MAX);
  safeStore.set(RECENT_KEY, JSON.stringify(ids));
  renderRecent();
}

function renderRecent() {
  const box = $('recentBox');
  const row = $('recentChips');
  if (!box || !row) return;

  // 테이블에서 사라진 id는 조용히 걸러낸다 (음식 목록이 바뀔 수 있으므로)
  const foods = readRecent().map(id => store.byId(id)).filter(Boolean);
  box.hidden = foods.length === 0;
  row.innerHTML = '';

  for (const food of foods) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'chip';
    b.textContent = food.ko;
    b.addEventListener('click', () => addFood(food, 1, 1));
    row.appendChild(b);
  }
}

$('recentClear').addEventListener('click', () => {
  safeStore.remove(RECENT_KEY);
  renderRecent();
});

/* ── 질환·상태 칩 (계통별로 묶어 표시) ──────────────────── */
for (const g of DISEASE_GROUPS) {
  const wrap = document.createElement('div');
  wrap.className = 'group';
  const lab = document.createElement('div');
  lab.className = 'group-label';
  lab.textContent = g.label;
  const row = document.createElement('div');
  row.className = 'chips';

  for (const id of g.ids) {
    const d = DISEASE_BY_ID[id];
    if (!d) continue;
    const b = document.createElement('button');
    b.className = 'chip';
    b.textContent = d.name;
    b.title = `주의 항목: ${d.focus}`;
    b.setAttribute('aria-pressed', 'false');
    b.dataset.id = d.id;
    b.addEventListener('click', () => {
      b.setAttribute('aria-pressed', b.getAttribute('aria-pressed') === 'true' ? 'false' : 'true');
      syncButtons();
    });
    row.appendChild(b);
  }
  wrap.append(lab, row);
  $('chips').appendChild(wrap);
}
const selectedDiseaseIds = () =>
  [...document.querySelectorAll('.chip[aria-pressed="true"]')].map(c => c.dataset.id);

/* ── 개인 프로필 (전부 선택 입력) ────────────────────────
   기기 밖으로 나가지 않는다. localStorage에만 남고 프록시로도 전송하지 않는다. */
const PF_KEY = 'mc.profile';

function readProfile() {
  return {
    weightKg: $('pfWeight').value,
    ageYears: $('pfAge').value,
    sex: $('pfSex').value || null
  };
}
function saveProfile() {
  safeStore.set(PF_KEY, JSON.stringify(readProfile()));
  updateProfileSummary();
}
function loadProfile() {
  try {
    const p = JSON.parse(safeStore.get(PF_KEY) || '{}');
    if (p.weightKg) $('pfWeight').value = p.weightKg;
    if (p.ageYears) $('pfAge').value = p.ageYears;
    if (p.sex) $('pfSex').value = p.sex;
  } catch { /* 저장값이 깨져 있어도 무시하고 빈 상태로 시작 */ }
  updateProfileSummary();
}
function updateProfileSummary() {
  const p = readProfile();
  const parts = [];
  if (p.weightKg) parts.push(`${p.weightKg}kg`);
  if (p.ageYears) parts.push(`${p.ageYears}세`);
  if (p.sex) parts.push(p.sex === 'f' ? '여성' : '남성');
  const tag = $('profileBox').querySelector('.opt-tag');
  tag.textContent = parts.length ? parts.join(' · ') : '선택';
}
for (const id of ['pfWeight', 'pfAge', 'pfSex']) {
  $(id).addEventListener('change', saveProfile);
  $(id).addEventListener('input', updateProfileSummary);
}
$('pfClear').addEventListener('click', () => {
  $('pfWeight').value = ''; $('pfAge').value = ''; $('pfSex').value = '';
  safeStore.remove(PF_KEY);
  updateProfileSummary();
});

/* ── 어댑터 선택 ─────────────────────────────────────────── */
function renderAdapterOptions() {
  const box = $('adapterOptions');
  box.innerHTML = '';
  for (const A of ADAPTERS) {
    /* 필요한 설정이 아예 없으면 원리적으로 불가능하므로 막는다.
       나머지는 될지 안 될지 눌러 봐야 아는 것이라 막지 않는다. */
    const usable = A.id === 'gemini' ? GEMINI_READY
                 : A.id === 'local'  ? LOCAL_READY
                 : true;

    const label = document.createElement('label');
    label.className = 'radio-row';
    const input = document.createElement('input');
    Object.assign(input, { type: 'radio', name: 'adapter', value: A.id,
                           checked: adapterId === A.id, disabled: !usable });
    const b = document.createElement('b');
    b.textContent = A.label + (usable ? '' : ' (설정 필요)');
    const small = document.createElement('small');
    small.textContent = A.blurb;
    label.append(input, b, small);

    /* 못 쓰는 이유만 적어 두면 사용자는 거기서 막힌다. 켜는 방법을 함께 적는다. */
    const HOWTO = {
      gemini: 'aistudio.google.com에서 키를 받아 app.js의 DEV_GEMINI_KEY에 붙여넣고 ' +
              'npm run build. 무료 등급은 신용카드가 필요 없고, 결제를 켜지 않으면 ' +
              '요금이 청구되지 않습니다.',
      local:  'train/ 폴더의 안내대로 한국 음식 데이터로 모델을 학습한 뒤, ' +
              '내보낸 폴더 주소를 app.js의 LOCAL_MODEL_URL에 넣으세요. ' +
              '학습만 되면 호출 비용도 한도도 없습니다.'
    };
    if (!usable && HOWTO[A.id]) {
      const how = document.createElement('small');
      how.className = 'howto';
      how.textContent = `켜는 법: ${HOWTO[A.id]}`;
      label.appendChild(how);
    }
    input.addEventListener('change', () => {
      adapterId = A.id;
      safeStore.set('mc.adapter', A.id);
      applyAdapterMode();
    });
    box.appendChild(label);
  }
}

function applyAdapterMode() {
  const manual = adapterId === 'manual';
  /* 사진 올리기는 어느 모드에서도 막지 않는다.
     '직접 고르기'에서도 사진을 보면서 음식을 고르는 편이 편하다.
     자동 인식 버튼만 모드에 따라 감춘다. */
  $('scanBtn').hidden = manual;
  $('step2Title').textContent = manual ? '사진 올리기 (선택)' : '음식 사진 찍기';
  $('step2Hint').textContent = manual
    ? '사진은 참고용입니다. 보면서 아래에서 음식을 골라 담으세요.'
    : '밥상 전체가 위에서 잘 보이게, 밝은 곳에서 찍을수록 정확합니다.';
  renderUsage();
  syncButtons();
}

/* ── 사진 ────────────────────────────────────────────────── */
$('photoZone').addEventListener('click', () => $('fileInput').click());
$('photoZone').addEventListener('keydown', e => {
  if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); $('fileInput').click(); }
});
$('fileInput').addEventListener('change', async () => {
  const f = $('fileInput').files[0];
  if (!f) return;
  hideErr();
  try {
    imageDataUrl = await shrinkImage(f, MAX_IMAGE_SIDE);
    $('preview').src = imageDataUrl;
    $('preview').style.display = 'block';
  } catch (e) {
    showErr(e.message);
  }
  syncButtons();
});

/* ── 식별 실행 ───────────────────────────────────────────── */
$('scanBtn').addEventListener('click', async () => {
  hideErr();
  /* 어댑터마다 model이 뜻하는 게 다르므로 이름을 분리해 넘긴다.
     geminiModel을 그냥 model로 넘기면 온디바이스 CLIP 모델을 덮어쓴다. */
  const ident = makeIdentifier(adapterId, {
    proxyUrl: PROXY_URL,
    devApiKey: DEV_GEMINI_KEY,
    geminiModel: GEMINI_MODEL,
    token: POLLINATIONS_TOKEN,
    userToken: deviceToken(),
    localModelUrl: LOCAL_MODEL_URL
  });
  // 프록시가 있으면 서버가 세므로 로컬 카운터는 건드리지 않는다
  if (adapterId === 'gemini' && !PROXY_URL) bumpUsage();
  setLoading(true, adapterId === 'ondevice' ? '기기에서 음식을 살펴보고 있습니다…' : '음식을 살펴보고 있습니다…');

  try {
    await store.ready();

    if (adapterId === 'ondevice' || adapterId === 'local') {
      setProgress(0);
      await ident.prepare(p => {
        if (p.done) { setLoadingText('사진을 분석하고 있습니다…'); setProgress(null); }
        else { setLoadingText(`처음 한 번만 모델을 내려받습니다… ${p.pct}%`); setProgress(p.pct); }
      });
    }

    const found = await ident.identify(imageDataUrl, store);
    if (PROXY_URL && adapterId === 'gemini') refreshQuota();   // 남은 횟수 갱신

    /* 신뢰도가 낮으면 아무것도 담지 않고 후보만 보여 준다.
       CLIP은 한국 음식에 약해서 애매한 경우가 잦은데, 그때 1등을 조용히 담아 버리면
       사용자가 틀린 줄 모르고 판정을 받는다. 고르게 하는 편이 훨씬 안전하다. */
    const UNSURE = 0.35;
    const unsure = found.length > 0 && found[0].confidence < UNSURE;

    if (!unsure) {
      for (const c of found) addFood(c.food, c.portion, c.confidence);
      renderAlternatives(found.alternatives || [], false);
    } else {
      renderAlternatives([found[0].food, ...(found.alternatives || [])], true);
    }

    if (found.unmatched?.length) {
      showErr(`"${found.unmatched.map(u => u.name).join(', ')}"은(는) 영양 정보가 없어 목록에 넣지 못했습니다. ` +
              `아래에서 비슷한 음식을 직접 찾아 더해 주세요. 빠뜨리면 판정이 실제보다 관대해집니다.`);
    } else if (found.length === 0) {
      showErr('사진에서 아는 음식을 찾지 못했습니다. 아래에서 직접 골라 주세요.');
    } else if (unsure) {
      showErr('사진 속 음식을 확실하게 알아보지 못했습니다. 아래 후보 중에 있으면 눌러 주시고, ' +
              '없으면 검색해서 직접 골라 주세요.');
    } else if (found.singlePick) {
      /* 기기 인식은 사진 한 장에서 음식 하나만 집어낸다.
         반찬이 여러 개인 밥상인데 하나만 담기면 나트륨이 과소 집계돼
         판정이 실제보다 관대해진다. 반드시 알려야 한다. */
      showErr('사진에서 음식 하나만 알아냈습니다. 밥·국·반찬이 더 있으면 아래에서 직접 더해 주세요. ' +
              '빠뜨리면 판정이 실제보다 관대해집니다.');
    }

    $('confirmStep').scrollIntoView({ behavior: 'smooth' });
  } catch (e) {
    /* 동적 import 실패는 file://에서 흔하다. 원인이 사용자 잘못이 아니고
       해결책도 명확하므로 일반 오류와 다르게 안내한다. */
    const blocked = /dynamically imported module|Failed to fetch|importScripts|NetworkError/i
      .test(e.message);

    if (blocked && IS_FILE) {
      showErr('이 브라우저는 파일을 직접 열었을 때 AI 모델 불러오기를 막습니다. ' +
              '사진은 그대로 두고 아래에서 음식을 검색해 담으시면 판정은 똑같이 됩니다. ' +
              '자동 인식을 쓰시려면 같은 폴더의 열기.command로 열어 주세요.');
    } else if (blocked) {
      showErr('AI 모델을 불러오지 못했습니다. 인터넷 연결을 확인해 주세요. ' +
              '아래에서 직접 골라 주셔도 판정은 똑같이 됩니다.');
    } else if (e.message === 'RATE_LIMIT') {
      if (adapterId === 'cloud') {
        showErr('클라우드 AI는 15초에 한 번만 요청할 수 있습니다. 잠시 뒤 다시 눌러 주세요.');
      } else {
        /* Gemini 429는 분당 한도와 하루 한도 두 가지가 있다.
           어느 쪽인지에 따라 기다리는 시간이 완전히 다르므로 구분해 안내한다. */
        const { count } = readUsage();
        showErr(count >= GEMINI_DAILY_LIMIT
          ? `오늘 무료 한도(${GEMINI_DAILY_LIMIT}회)를 다 썼습니다. 내일 자정(태평양시)에 초기화됩니다. ` +
            '설정에서 "기기에서 인식"으로 바꾸거나 아래에서 직접 골라 주세요. 요금은 청구되지 않습니다.'
          : '분당 요청 한도를 넘었습니다. 1분쯤 뒤에 다시 눌러 주세요. 요금은 청구되지 않습니다.');
      }
    } else if (e.message === 'QUOTA_EXCEEDED') {
      /* 서버가 등급 한도로 막은 경우. 구글 rate limit과 달리
         기다린다고 풀리지 않으므로 안내가 달라야 한다. */
      const q = e.quota || {};
      serverQuota = { ...serverQuota, ...q, enforced: true, remaining: 0 };
      renderUsage();
      showErr(`오늘 사용 가능한 횟수(${q.limit ?? '?'}회)를 모두 썼습니다. ` +
              '내일 다시 채워집니다. 설정에서 "기기에서 인식"으로 바꾸거나 ' +
              '아래에서 직접 골라 주시면 판정은 똑같이 됩니다.');
    } else if (e.message === 'NO_CREDIT') {
      /* Pollinations가 크레딧제로 바뀌어 익명 호출은 여기서 걸린다.
         "실패했다"만 말하면 사용자는 다음에 뭘 해야 할지 모른다. */
      showErr('클라우드 AI에 남은 무료 크레딧이 없습니다(402). ' +
              'auth.pollinations.ai에서 무료 토큰을 받아 app.js의 POLLINATIONS_TOKEN에 넣으면 켜집니다. ' +
              '설정에서 "기기에서 인식"으로 바꾸면 지금 바로 쓸 수 있고, ' +
              '아래에서 직접 골라 주셔도 판정은 똑같이 됩니다.');
    } else if (e.message === 'BAD_TOKEN') {
      showErr('클라우드 AI 토큰이 올바르지 않습니다. app.js의 POLLINATIONS_TOKEN을 확인해 주세요.');
    } else if (e.message === 'BAD_KEY') {
      showErr('Gemini 키가 올바르지 않거나 권한이 없습니다. app.js의 DEV_GEMINI_KEY를 확인해 주세요.');
    } else if (e.message === 'PARSE') {
      showErr('AI 응답을 읽지 못했습니다. 다시 시도하시거나 아래에서 직접 골라 주세요.');
    } else if (e.message === 'NETWORK') {
      showErr('인터넷 연결을 확인해 주세요. 아래에서 직접 골라 주셔도 판정은 똑같이 됩니다.');
    } else {
      showErr(`음식을 찾지 못했습니다. 아래에서 직접 골라 주셔도 판정은 똑같이 됩니다. (${e.message})`);
    }
    // 실패해도 막다른 길이 되지 않게 검색창으로 넘긴다
    $('confirmStep').scrollIntoView({ behavior: 'smooth' });
    $('foodSearch').focus();
  } finally {
    setLoading(false);
  }
});

/* ── 검색 ────────────────────────────────────────────────── */
let searchSeq = 0;   // 늦게 도착한 원격 결과가 최신 입력을 덮어쓰지 않게 하는 순번

$('foodSearch').addEventListener('input', async e => {
  await store.ready();
  const q = e.target.value;
  const seq = ++searchSeq;

  const ul = $('suggest');
  const render = (foods, remote) => {
    if (seq !== searchSeq) return;   // 그사이 사용자가 더 입력했으면 버린다
    for (const f of foods) {
      const li = document.createElement('li');
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = `${f.ko}  ·  1인분 ${f.serving_g}g`;
      if (remote) {
        /* 식약처 항목은 퓨린·요오드·질감 등이 비어 있다. 겉보기엔 똑같은
           검색 결과인데 판정 정확도가 다르므로 반드시 구분해 보여 준다. */
        const tag = document.createElement('span');
        tag.className = 'src-tag';
        tag.textContent = '식약처';
        b.appendChild(tag);
      }
      b.addEventListener('click', () => {
        addFood(f, 1, 1);
        e.target.value = '';
        ul.innerHTML = '';
        e.target.focus();
      });
      li.appendChild(b);
      ul.appendChild(li);
    }
  };

  ul.innerHTML = '';
  const local = store.search(q);
  render(local, false);

  /* 내장에서 충분히 나오면 원격은 부르지 않는다. 호출을 아끼는 것이 목적이다. */
  if (local.length >= 3 || q.trim().length < 2 || !PROXY_URL) return;
  const remote = await store.searchRemote(q, 6 - local.length);
  const seen = new Set(local.map(f => f.ko));
  render(remote.filter(f => !seen.has(f.ko)), true);
});

/* ── 고른 음식 목록 ──────────────────────────────────────── */
const PORTIONS = [[0.25, '4분의 1'], [0.5, '반'], [0.75, '4분의 3'],
                  [1, '1인분'], [1.5, '1.5인분'], [2, '2인분']];

/* 인식이 틀렸을 때 한 번에 갈아 끼우도록 차순위 후보를 보여 준다.
   CLIP은 한국 음식에 약해서 1등이 틀리는 일이 잦은데, 그때마다
   지우고 검색하게 만들면 사용자가 그냥 틀린 채로 판정을 받는다. */
/**
 * 인식 후보를 보여 준다.
 * @param {boolean} pickMode  true면 "아직 아무것도 안 담았으니 골라 주세요",
 *                            false면 "1등은 담았고 틀렸으면 바꾸세요"
 */
function renderAlternatives(alts, pickMode) {
  const box = $('altBox');
  box.innerHTML = '';
  box.hidden = alts.length === 0;
  if (!alts.length) return;
  box.classList.toggle('pick', !!pickMode);

  const lab = document.createElement('div');
  lab.className = 'alt-label';
  lab.textContent = pickMode
    ? '이 중에 있나요? (누르면 목록에 담습니다)'
    : '혹시 이건가요? (누르면 바꿔 담습니다)';
  box.appendChild(lab);

  const row = document.createElement('div');
  row.className = 'chips';
  for (const food of alts) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'chip';
    b.textContent = food.ko;
    b.addEventListener('click', () => {
      if (pickMode) {
        // 아직 담긴 게 없다. 고른 것을 그대로 추가한다.
        addFood(food, 1, 1);
      } else if (picked.length) {
        // 1등이 이미 담겨 있다. 그걸 이 후보로 교체한다.
        picked[0] = { food, portion: picked[0].portion, confidence: 1 };
        renderPicked();
      } else {
        addFood(food, 1, 1);
      }
      box.hidden = true;
      hideErr();
    });
    row.appendChild(b);
  }
  box.appendChild(row);
}

function addFood(food, portion = 1, confidence = 1) {
  const existing = picked.find(p => p.food.id === food.id);
  if (existing) existing.portion = Math.round((existing.portion + portion) * 4) / 4;
  else picked.push({ food, portion, confidence });
  rememberFood(food.id);
  renderPicked();
}

function renderPicked() {
  const ul = $('picked');
  ul.innerHTML = '';
  for (const item of picked) {
    const li = document.createElement('li');

    const nm = document.createElement('div');
    nm.className = 'nm';
    nm.textContent = item.food.ko;
    if (item.confidence < 0.999) {
      const tag = document.createElement('span');
      const lvl = item.confidence >= 0.6 ? 'hi' : item.confidence >= 0.3 ? 'mid' : 'lo';
      tag.className = `conf ${lvl}`;
      tag.textContent = lvl === 'hi' ? '확실' : lvl === 'mid' ? '아마도' : '확인 필요';
      tag.style.marginLeft = '8px';
      nm.appendChild(tag);
    }
    const sub = document.createElement('small');
    sub.textContent = `1인분 ${item.food.serving_g}g`;
    nm.appendChild(sub);

    const sel = document.createElement('select');
    sel.setAttribute('aria-label', `${item.food.ko} 양`);
    for (const [v, t] of PORTIONS) {
      const o = document.createElement('option');
      o.value = v; o.textContent = t;
      if (Math.abs(v - item.portion) < 0.13) o.selected = true;
      sel.appendChild(o);
    }
    sel.addEventListener('change', () => { item.portion = Number(sel.value); });

    const del = document.createElement('button');
    del.className = 'del';
    del.textContent = '✕';
    del.setAttribute('aria-label', `${item.food.ko} 지우기`);
    del.addEventListener('click', () => {
      picked = picked.filter(p => p !== item);
      renderPicked();
    });

    li.append(nm, sel, del);
    ul.appendChild(li);
  }
  $('emptyNote').hidden = picked.length > 0;
  syncButtons();
}

/* ── 판정 ────────────────────────────────────────────────── */
$('judgeBtn').addEventListener('click', async () => {
  const ids = selectedDiseaseIds();
  setLoading(true, '영양 정보를 확인하고 있습니다…');
  try {
    await store.ready();
    const resolved = await Promise.all(
      picked.map(p => store.resolve(p.food).then(food => ({ food, portion: p.portion })))
    );
    const meal = sumMeal(resolved);
    render(evaluate(meal, ids, readProfile()), resolved, meal);
  } catch (e) {
    showErr(`판정 중 문제가 생겼습니다. (${e.message})`);
  } finally {
    setLoading(false);
  }
});

function render(res, resolved, meal) {
  $('stamp').className = `stamp ${res.overall}`;
  $('stamp').textContent = verdictKo(res.overall);
  $('overallComment').textContent = res.overallComment;

  $('foodsLine').innerHTML = '';
  const lbl = document.createElement('span');
  lbl.textContent = '이 식사: ';
  const b = document.createElement('b');
  b.textContent = resolved.map(r =>
    r.portion === 1 ? r.food.ko : `${r.food.ko}(${PORTIONS.find(p => p[0] === r.portion)?.[1] || r.portion})`
  ).join(', ');
  $('foodsLine').append(lbl, b);

  /* 충돌 안내 */
  const cb = $('conflictBox');
  cb.innerHTML = '';
  for (const c of res.conflicts) {
    const d = document.createElement('div');
    d.className = 'conflict';
    const t = document.createElement('b');
    t.textContent = '⚖️ 고른 항목끼리 권고가 엇갈립니다';
    const p = document.createElement('span');
    p.textContent = c.msg;
    d.append(t, p);
    cb.appendChild(d);
  }

  /* 룰이 다루지 못하는 범위를 미리 밝히는 안내 (예: 갑상선 항진/저하 구분 없음) */
  const nb = $('noteBox');
  nb.innerHTML = '';
  for (const n of res.notes) {
    const d = document.createElement('div');
    d.className = 'note';
    const t = document.createElement('b');
    t.textContent = `ℹ️ ${n.disease} — 이 판정이 다루지 않는 것`;
    const p = document.createElement('span');
    p.textContent = n.msg;
    d.append(t, p);
    nb.appendChild(d);
  }

  /* 질환별 카드 */
  const cards = $('diseaseCards');
  cards.innerHTML = '';
  for (const d of res.byDisease) {
    const el = document.createElement('div');
    el.className = `dcard ${d.verdict}`;

    const row = document.createElement('div');
    row.className = 'dname';
    const nm = document.createElement('span');
    nm.textContent = d.disease;
    const badge = document.createElement('span');
    badge.className = 'badge';
    badge.textContent = verdictKo(d.verdict);
    row.append(nm, badge);

    const reason = document.createElement('div');
    reason.className = 'reason';
    reason.textContent = d.reason;
    el.append(row, reason);

    /* 판정 근거 — 룰 엔진이라 항상 보여 줄 수 있다.
       AI 판정이었다면 이 섹션 자체가 불가능하다. */
    if (d.triggers.length) {
      const det = document.createElement('details');
      const sm = document.createElement('summary');
      sm.textContent = '이 판정의 근거 보기';
      const why = document.createElement('div');
      why.className = 'why';
      for (const t of d.triggers) {
        const line = document.createElement('div');
        if (t.kind === 'numeric') {
          const code = document.createElement('code');
          code.textContent = `${t.label} ${t.value}${t.unit}`;
          line.append(code, document.createTextNode(
            ` — ${verdictKo(t.level)} 기준 ${t.threshold}${t.unit} 이상`));
          // 프로필로 임계값이 조정됐으면 무엇 때문인지 밝힌다
          if (t.scaledBy) {
            const s = document.createElement('span');
            s.style.cssText = 'color:var(--blue);font-weight:700';
            s.textContent = ` (${t.scaledBy} 기준으로 조정됨)`;
            line.appendChild(s);
          }
        } else {
          line.textContent = `· ${t.text}`;
        }
        const rat = document.createElement('div');
        rat.style.cssText = 'font-size:12px;opacity:.75;margin-top:2px';
        rat.textContent = t.rationale.replace(/^RATIONALE:\s*/, '근거: ');
        line.appendChild(rat);
        why.appendChild(line);
      }
      det.append(sm, why);
      el.appendChild(det);
    }
    cards.appendChild(el);
  }

  const tl = $('tipsList');
  tl.innerHTML = '';
  for (const t of res.tips) {
    const li = document.createElement('li');
    li.textContent = t;
    tl.appendChild(li);
  }

  /* 출처 표시 — 이 숫자들이 어디서 왔는지 숨기지 않는다 */
  const pv = NutritionStore.provenance(resolved.map(r => r.food));
  /* 식약처에서 온 음식은 퓨린·요오드 등이 비어 있다. 그 축을 쓰는 질환을
     골랐다면 판정이 실제보다 관대해진다. 반드시 알려야 한다. */
  const AXIS_DISEASE = {
    purine_mg: '통풍', vitk_ug: '와파린', iodine_ug: '갑상선',
    iron_mg: '빈혈', caffeine_mg: '빈혈·임신', vita_ug: '임신'
  };
  const remoteFoods = resolved.filter(r => r.food.remote);
  const affected = [...new Set(
    remoteFoods.flatMap(r => r.food.missingAxes || [])
      .map(a => AXIS_DISEASE[a]).filter(Boolean)
  )];
  const selected = new Set(res.byDisease.map(d => d.disease));
  const relevant = affected.filter(name => [...selected].some(s => s.includes(name.split('·')[0])));

  if (remoteFoods.length) {
    const d = document.createElement('div');
    d.className = 'note';
    const t = document.createElement('b');
    t.textContent = '⚠️ 일부 음식은 영양 정보가 불완전합니다';
    const txt = document.createElement('span');
    txt.textContent =
      `${remoteFoods.map(r => r.food.ko).join(', ')}은(는) 식약처 DB에서 가져왔습니다. ` +
      '식약처는 퓨린·비타민K·요오드·철·카페인을 제공하지 않아 이 값들이 0으로 계산됐습니다. ' +
      (relevant.length
        ? `고르신 ${relevant.join('·')} 판정이 실제보다 관대하게 나왔을 수 있습니다.`
        : '해당 축을 쓰는 질환을 고르지 않아 이번 판정에는 영향이 적습니다.');
    d.append(t, txt);
    nb.appendChild(d);
  }

  const p = res.profile;
  const profLine = (p.weightGiven || p.ageYears)
    ? `기준 조정: ${[p.weightGiven ? `체중 ${p.weightKg}kg` : null,
                     p.ageYears ? `나이 ${p.ageYears}세` : null].filter(Boolean).join(' · ')}`
    : '체중·나이를 넣지 않아 성인 60kg 기준으로 판정했습니다.';

  const lines = [
    profLine,
    pv.total === 0 ? '' :
      pv.pct > 0
        ? `영양 수치의 ${pv.pct}%는 식약처 식품영양성분DB, 나머지는 내장 추정치입니다.`
        : '영양 수치는 모두 내장 추정치입니다. (식약처 API 미연결)',
    '퓨린·비타민K·요오드·철·카페인·레티놀은 식약처 DB에 없어 문헌 추정치를 씁니다. ' +
    '통풍·와파린·갑상선·빈혈·임신 판정은 다른 항목보다 정확도가 낮습니다.',
    `열량 ${Math.round(meal.kcal)}kcal · 나트륨 ${Math.round(meal.sodium_mg)}mg · ` +
    `칼륨 ${Math.round(meal.potassium_mg)}mg · 인 ${Math.round(meal.phosphorus_mg)}mg · ` +
    `당류 ${Math.round(meal.sugar_g)}g · 포화지방 ${Math.round(meal.satfat_g * 10) / 10}g · ` +
    `요오드 ${Math.round(meal.iodine_ug)}µg · 철 ${Math.round(meal.iron_mg * 10) / 10}mg`
  ].filter(Boolean);
  $('provenance').innerHTML = '';
  for (const l of lines) {
    const p = document.createElement('div');
    p.textContent = l;
    p.style.marginBottom = '4px';
    $('provenance').appendChild(p);
  }

  $('result').hidden = false;
  $('result').scrollIntoView({ behavior: 'smooth' });
}

$('retryBtn').addEventListener('click', () => {
  picked = [];
  imageDataUrl = null;
  $('fileInput').value = '';
  $('preview').style.display = 'none';
  $('result').hidden = true;
  $('foodSearch').value = '';
  $('suggest').innerHTML = '';
  $('altBox').hidden = true;
  renderPicked();
  hideErr();
  window.scrollTo({ top: 0, behavior: 'smooth' });
});

/* ── 상태 헬퍼 ───────────────────────────────────────────── */
function syncButtons() {
  $('scanBtn').disabled = !imageDataUrl;
  $('judgeBtn').disabled = !(picked.length > 0 && selectedDiseaseIds().length > 0);
  $('judgeBtn').textContent = selectedDiseaseIds().length === 0
    ? '먼저 질환·상태를 골라 주세요'
    : picked.length === 0 ? '먼저 음식을 골라 주세요' : '밥상 판정 받기';
}
function setLoading(on, text) {
  $('loading').style.display = on ? 'block' : 'none';
  if (text) setLoadingText(text);
  if (!on) setProgress(null);
}
const setLoadingText = t => { $('loadingText').textContent = t; };
function setProgress(pct) {
  const bar = $('progBar');
  bar.hidden = pct == null;
  if (pct != null) bar.querySelector('i').style.width = `${pct}%`;
}
function showErr(msg) { $('scanErr').textContent = msg; $('scanErr').style.display = 'block'; }
function hideErr() { $('scanErr').style.display = 'none'; }

/* ── 첫 실행 면책 고지 ───────────────────────────────────
   건강 판정 앱이므로 한계를 보지 않고 지나갈 수 없게 한다.
   버전을 키에 넣어, 고지 내용이 바뀌면 다시 확인받는다. */
const GATE_KEY = 'mc.gate.v1';

function initGate() {
  const gate = $('gate');
  const box = $('gateCheck');
  const btn = $('gateBtn');

  if (safeStore.get(GATE_KEY) === 'ok') {
    gate.hidden = true;
    return;
  }
  document.body.classList.add('gated');
  box.addEventListener('change', () => { btn.disabled = !box.checked; });
  btn.addEventListener('click', () => {
    if (!box.checked) return;
    safeStore.set(GATE_KEY, 'ok');
    gate.hidden = true;
    document.body.classList.remove('gated');
  });
}

/* ── 서비스워커 (PWA 설치·오프라인) ──────────────────────
   file://이나 http에서는 등록되지 않는다. 실패해도 앱은 정상 동작한다. */
function initServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  if (location.protocol !== 'https:' && location.hostname !== 'localhost') return;
  navigator.serviceWorker.register('./sw.js').catch(() => { /* 무시 */ });
}

/* ── 시작 ────────────────────────────────────────────────── */
initGate();
renderAdapterOptions();
applyAdapterMode();
loadProfile();
renderPicked();
initServiceWorker();
// 최근 목록은 영양 테이블이 로드된 뒤에야 id → 음식 변환이 된다
store.ready().then(renderRecent).catch(e => showErr(e.message));
