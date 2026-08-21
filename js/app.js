/**
 * app.js — UI 통합
 *
 * 화면 흐름: 질환 선택 → 음식 식별 → 사용자 확인·보정 → 룰 판정
 * 3단계(확인·보정)가 이 앱의 안전장치다. AI가 틀려도 사용자가 눈으로 잡는다.
 */
import { DISEASE_BY_ID, DISEASE_GROUPS, evaluate, sumMeal, verdictKo, resolveProfile } from './rules.js';
import { NutritionStore } from './nutrition.js';
import { ADAPTERS, makeIdentifier, shrinkImage, judgeMealWithGemini } from './identify.js';

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
//   'gemini-3.7-flash'       분당 10회 · 하루  250회 — 정확도 우선
//   'gemini-flash-lite-latest'  분당 15회 · 하루 1000회 — 한도 우선
// 한 끼 판정이 요청 1회이므로, 하루 세 끼 기준
// Flash는 약 80명, Flash-Lite는 약 330명까지 감당합니다.
// 한도를 넘기면 요금이 아니라 429가 오고, 앱이 안내한 뒤 검색으로 넘깁니다.
// 구체적 버전을 고정한다(2026-08-21). -latest 별칭으로 바꿔봤다가 실사용에서
// 곧바로 "Failed to fetch"가 재현됐고, 이 고정 버전으로 되돌리자 다시 정상
// 동작했다 — 이 계정/키에서는 별칭보다 고정 버전이 더 안정적으로 확인됐다.
// 다음에 모델을 바꿀 일이 있으면 별칭 대신 실제 존재하는 구체적 버전명을
// 확인해서 박아 넣을 것(예전엔 안전하다고 여겼던 판단이 틀렸다).
const GEMINI_MODEL = 'gemini-3.7-flash';
const GEMINI_DAILY_LIMIT = 250;   // 위 모델의 하루 한도. 모델을 바꾸면 같이 고치세요.

// 사진을 보내기 전 줄일 크기(긴 변, 픽셀). 작을수록 토큰=원가와 업로드 용량이 줄어듭니다.
// 다만 너무 줄이면 인식 정확도가 떨어지므로 실측이 필요합니다.
//   tools/compare-resolution.mjs 로 같은 사진을 해상도별로 비교할 수 있습니다.
// 1024→768로 낮춘 이유(2026-08-20): 모바일 네트워크에서 사진 업로드 자체가
// "Load failed"로 실패하는 사례가 실사용에서 보고됐다. 재검증(models 목록 조회,
// 본문 없음)은 성공했는데 업로드(본문 수백KB)만 실패했다는 점에서 페이로드
// 크기가 유력한 원인이다. Gemini의 비전 인코더도 내부적으로 이미지를 타일 단위
// (한 변 약 768px)로 나눠 처리하므로, 1024px는 어차피 업로드 용량만 늘리고
// 인식 정확도에는 크게 기여하지 않을 가능성이 높다.
const MAX_IMAGE_SIDE = 768;

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
/* 'mc.gemini_key' 리터럴을 직접 쓰는 이유: GEMINI_USER_KEY 상수는 파일 뒤쪽
   설정 패널 섹션에서 선언되는데, 이 값은 그보다 먼저 필요하다.
   함수로 두는 이유: 온보딩·설정에서 방금 키를 저장한 "같은 세션" 안에서도
   바로 반영돼야 한다. 상수로 얼려 두면 새로고침 전까지 갱신되지 않는다. */
function geminiReady() { return !!(PROXY_URL || DEV_GEMINI_KEY || safeStore.get('mc.gemini_key')); }
const CLOUD_READY = !!POLLINATIONS_TOKEN;
const LOCAL_READY = !!LOCAL_MODEL_URL;
/* 기본값 선택 기준: Gemini를 항상 먼저 쓴다. 온보딩에서 이미 키 등록을 사실상
   필수로 만들었으므로, 대부분의 사용자는 진입 시점에 바로 Gemini를 쓸 수 있다.
   자체 모델(한국 음식 특화, 비용 0)은 Gemini가 준비되지 않았을 때만 대신 쓰는
   차선책이다. 이 우선순위가 바뀌면 아래 pickDefaultAdapter()도 함께 봐야 한다. */
function pickDefaultAdapter() {
  return geminiReady() ? 'gemini' : LOCAL_READY ? 'local' : CLOUD_READY ? 'cloud' : 'ondevice';
}
/* mc.adapter에 예전 값(예: 'local')이 저장돼 있으면 예전엔 그 값이 영영 이겼다 —
   과거 세션에서 아무 때나 한 번 저장된 값이 Gemini 키를 새로 등록해도 계속
   깔려 있었다는 뜻이다. 그 결과 "Gemini가 항상 먼저"가 조용히 깨지고, 무겁고
   실패하기 쉬운(모바일에서 CDN 모델 다운로드) 경로로 계속 새 나갔다(실사용 버그).
   이제 Gemini가 준비돼 있으면 저장된 값과 상관없이 Gemini가 이긴다. 사용자가
   "직접 고르기(manual)"를 명시적으로 골랐을 때만 예외로 존중한다 — 그건 AI 자체를
   쓰지 않겠다는 의도적 선택이기 때문이다. */
function resolveAdapterId() {
  const saved = safeStore.get('mc.adapter');
  if (saved === 'manual') return 'manual';
  if (geminiReady()) return 'gemini';
  return saved || pickDefaultAdapter();
}
let adapterId = resolveAdapterId();

/** Gemini 키가 온보딩·설정에서 방금 저장되거나 지워졌을 때 부른다.
    Gemini가 막 준비됐으면(수동으로 'manual'을 고른 게 아닌 한) 곧바로 Gemini로
    전환해 화면에 반영한다. */
function refreshDefaultAdapter() {
  adapterId = resolveAdapterId();
  renderAdapterOptions();
  applyAdapterMode();
}

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
  if (adapterId !== 'gemini' || !geminiReady()) { el.hidden = true; return; }
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
  lab.dataset.ko = g.label;
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
      saveDiseaseSelection();
      syncButtons();
    });
    row.appendChild(b);
  }
  wrap.append(lab, row);
  $('chips').appendChild(wrap);
}
const selectedDiseaseIds = () =>
  [...document.querySelectorAll('.chip[aria-pressed="true"]')].map(c => c.dataset.id);

/* 질환·상태 선택은 이제 설정 화면에만 있어서, 매번 다시 고르지 않도록 저장해 둔다. */
const DISEASE_KEY = 'mc.diseases';
function saveDiseaseSelection() {
  safeStore.set(DISEASE_KEY, JSON.stringify(selectedDiseaseIds()));
}
function loadDiseaseSelection() {
  let ids = [];
  try { ids = JSON.parse(safeStore.get(DISEASE_KEY) || '[]'); } catch { /* 무시 */ }
  for (const id of ids) {
    const chip = document.querySelector(`.chip[data-id="${id}"]`);
    if (chip) chip.setAttribute('aria-pressed', 'true');
  }
}

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
    const usable = A.id === 'gemini' ? geminiReady()
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
     geminiModel을 그냥 model로 넘기면 온디바이스 CLIP 모델을 덮어쓴다.
     Gemini 전용 필드(devApiKey/proxyUrl)는 사용자 본인 키가 있으면 그걸 우선한다. */
  const ident = makeIdentifier(adapterId, {
    ...(adapterId === 'gemini' ? geminiIdentifierOpts() : {}),
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

    let found = await ident.identify(imageDataUrl, store);
    if (PROXY_URL && adapterId === 'gemini') refreshQuota();   // 남은 횟수 갱신

    /* 신뢰도가 낮으면 아무것도 담지 않고 후보만 보여 준다.
       CLIP은 한국 음식에 약해서 애매한 경우가 잦은데, 그때 1등을 조용히 담아 버리면
       사용자가 틀린 줄 모르고 판정을 받는다. 고르게 하는 편이 훨씬 안전하다. */
    const UNSURE = 0.35;
    let unsure = found.length > 0 && found[0].confidence < UNSURE;

    /* 자체 모델이 애매해하면(신뢰도 낮음), Gemini가 설정돼 있는 경우
       한 번 더 물어봐 정확도를 끌어올린다. 자체 모델은 빠르고 무료라 항상
       먼저 쓰고, 이 보강 호출은 애매한 사진에서만 일어나므로 평소엔
       속도·비용에 영향이 없다. Gemini도 실패하면 조용히 원래 흐름(후보 보여주기)으로 돌아간다. */
    if (unsure && adapterId === 'local' && geminiReady()) {
      setLoadingText('확신이 낮아 온라인으로 한 번 더 확인하고 있습니다…');
      try {
        const opts = geminiIdentifierOpts();
        const backup = makeIdentifier('gemini', opts);
        const geminiFound = await backup.identify(imageDataUrl, store);
        if (opts.proxyUrl) refreshQuota();
        if (geminiFound.length > 0) {
          found = geminiFound;
          unsure = false;
        }
      } catch (e) {
        /* 네트워크 문제·쿼터 소진 등으로 실패해도 사용자에게 별도 에러를
           보이지 않는다. 어차피 아래에서 "애매함" 안내가 나가므로 충분하다. */
      }
    }

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
       해결책도 명확하므로 일반 오류와 다르게 안내한다.
       "Load failed"는 사파리(WebKit)가 네트워크 요청 실패를 알리는 표현이다 —
       크롬의 "Failed to fetch"와 같은 상황인데 문구가 달라 예전엔 이 정규식이
       사파리에서만 못 걸러내고 엉뚱한 메시지로 새 나갔다(실사용 버그, iOS에서 재현). */
    const blocked = /dynamically imported module|Failed to fetch|Load failed|importScripts|NetworkError|network connection was lost|internet connection appears to be offline/i
      .test(e.message);

    /* 어떤 메시지가 뜨든 끝에 실제 오류 원문을 남긴다. 사용자가 화면을 그대로
       캡처해 보내면 "무슨 일이 있었는지"를 추측 없이 바로 알 수 있어야 한다 —
       친절한 문구로만 감싸면 나중에 원인 추적이 막막해진다. */
    const detail = ` [상세: ${e.message}]`;

    if (blocked && IS_FILE) {
      showErr('이 브라우저는 파일을 직접 열었을 때 AI 모델 불러오기를 막습니다. ' +
              '사진은 그대로 두고 아래에서 음식을 검색해 담으시면 판정은 똑같이 됩니다. ' +
              '자동 인식을 쓰시려면 같은 폴더의 열기.command로 열어 주세요.' + detail);
    } else if (blocked) {
      showErr('AI에 연결하지 못했습니다. 인터넷 연결을 확인하고 다시 시도해 주세요. ' +
              '아래에서 직접 골라 주셔도 판정은 똑같이 됩니다.' + detail);
    } else if (e.message === 'RATE_LIMIT') {
      /* Gemini 429는 분당 한도와 하루 한도 두 가지가 있다.
         어느 쪽인지에 따라 기다리는 시간이 완전히 다르므로 구분해 안내한다. */
      const { count } = readUsage();
      showErr((count >= GEMINI_DAILY_LIMIT
        ? `오늘 무료 한도(${GEMINI_DAILY_LIMIT}회)를 다 썼습니다. 내일 자정(태평양시)에 초기화됩니다. `
        : '요청이 잠깐 몰렸습니다. 1분쯤 뒤에 다시 눌러 주세요. ') +
        '아래에서 직접 골라 주시면 지금 바로 판정할 수 있습니다.' + detail);
    } else if (e.message === 'QUOTA_EXCEEDED') {
      /* 서버가 등급 한도로 막은 경우. 구글 rate limit과 달리
         기다린다고 풀리지 않으므로 안내가 달라야 한다. */
      const q = e.quota || {};
      serverQuota = { ...serverQuota, ...q, enforced: true, remaining: 0 };
      renderUsage();
      showErr(`오늘 사용 가능한 횟수(${q.limit ?? '?'}회)를 모두 썼습니다. 내일 다시 채워집니다. ` +
              '아래에서 직접 골라 주시면 판정은 똑같이 됩니다.' + detail);
    } else if (e.message === 'NO_CREDIT') {
      showErr('클라우드 AI에 남은 무료 크레딧이 없습니다. ' +
              '아래에서 직접 골라 주셔도 판정은 똑같이 됩니다.' + detail);
    } else if (e.message === 'BAD_TOKEN') {
      showErr('클라우드 AI 접속에 문제가 있습니다. 아래에서 직접 골라 주세요.' + detail);
    } else if (e.message === 'BAD_KEY') {
      /* devApiKey는 앱을 만든 사람용 테스트 키다. 실사용자는 전부 설정에서
         본인이 붙여넣은 키(BYOK)를 쓰므로, "당신의 키"라고 콕 집어 안내해야
         뭘 고쳐야 할지 안다 — 예전엔 "app.js의 DEV_GEMINI_KEY 확인" 이라는,
         일반 사용자는 볼 수도 고칠 수도 없는 문구가 떴다(실사용 버그). */
      showErr('저장된 Gemini API 키가 거부됐습니다. 키가 삭제됐거나 무료 한도를 다 썼을 수 있습니다. ' +
              '☰ 설정 → Gemini API 키에서 다시 확인하거나 새 키를 붙여넣어 주세요. ' +
              '아래에서 직접 골라 주시면 지금 바로 판정할 수 있습니다.' + detail);
    } else if (e.message === 'PARSE' || e.message === 'EMPTY') {
      showErr('AI 응답을 읽지 못했습니다. 다시 시도하시거나 아래에서 직접 골라 주세요.' + detail);
    } else if (e.message === 'NETWORK') {
      showErr('인터넷 연결을 확인해 주세요. 아래에서 직접 골라 주셔도 판정은 똑같이 됩니다.' + detail);
    } else {
      showErr(`음식을 찾지 못했습니다. 아래에서 직접 골라 주셔도 판정은 똑같이 됩니다.${detail}`);
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
    /* 우리 DB에 없어 Gemini가 직접 추정한 영양치를 쓴 항목은 정확도가 다르므로
       반드시 구분해 보여준다 — src-tag는 원래 식약처 항목용이라 재사용한다. */
    if (item.food.src === 'gemini_est') {
      const tag = document.createElement('span');
      tag.className = 'src-tag';
      tag.style.marginLeft = '8px';
      tag.textContent = 'AI 추정';
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

/** Gemini의 직접 판정 결과를 render()가 읽는 모양으로 바꾼다. */
function toRenderResult(parsed, diseases) {
  const byName = Object.fromEntries(diseases.map(d => [d.id, d.name]));
  const byDisease = parsed.byDisease.map(r => ({
    id: r.id, disease: byName[r.id] || r.id, verdict: r.verdict, reason: r.reason,
    triggers: [], positives: [], inverted: false, note: null
  }));
  const resolved = (parsed.foods || []).map(f => ({ food: { ko: f.name }, portionLabel: f.portion || '' }));
  const res = {
    byDisease, overall: parsed.overall, overallComment: parsed.overallComment,
    tips: parsed.tips || [], conflicts: [], notes: [], aiJudged: true
  };
  return { res, resolved };
}

$('judgeBtn').addEventListener('click', async () => {
  const ids = selectedDiseaseIds();
  const diseases = ids.map(id => DISEASE_BY_ID[id]).filter(Boolean)
    .map(d => ({ id: d.id, name: d.name, focus: d.focus }));
  const profile = resolveProfile(readProfile());

  /* Gemini가 준비돼 있고 사진이 있으면 판정 자체도 Gemini에게 맡긴다 — 식별뿐
     아니라 좋음/주의/피함과 이유·팁까지 한 번에 받는다. 실패하면(쿼터·네트워크 등)
     조용히 아래 규칙 엔진 경로로 되돌아간다. 사용자를 빈손으로 두지 않는 것이
     "판정이 결정적이어야 한다"는 원칙보다 지금은 우선한다. */
  if (imageDataUrl && adapterId === 'gemini' && geminiReady() && diseases.length) {
    setLoading(true, 'AI가 사진을 보고 직접 판정하고 있습니다…');
    try {
      const g = geminiIdentifierOpts();
      const parsed = await judgeMealWithGemini(imageDataUrl, diseases, profile,
        { proxyUrl: g.proxyUrl, devApiKey: g.devApiKey, model: g.geminiModel, userToken: g.userToken });
      if (g.proxyUrl) refreshQuota(); else bumpUsage();
      const { res, resolved } = toRenderResult(parsed, diseases);
      render(res, resolved, null);
      setLoading(false);
      return;
    } catch (e) {
      /* "Load failed"는 사파리(iOS)가 쓰는 네트워크 실패 표현, "Failed to fetch"는
         크롬 쪽 표현이다 — 둘 다 같은 상황(요청이 서버까지 못 감)이므로 같이 잡는다.
         어떤 경우든 원문(e.message)을 끝에 남겨 다음에 같은 문제가 생기면 화면
         캡처만으로 원인을 바로 알 수 있게 한다. */
      const networkIssue = /Failed to fetch|Load failed|NetworkError|network connection was lost/i
        .test(e.message);
      const reason =
        e.message === 'QUOTA_EXCEEDED' || e.message === 'RATE_LIMIT'
          ? '오늘 무료 한도를 다 썼거나 요청이 몰렸습니다'
        : e.message === 'BAD_KEY'
          ? '저장된 키가 거부됐습니다 — ☰ 설정에서 Gemini 키를 다시 확인해 주세요'
        : networkIssue
          ? '인터넷 연결이 불안정합니다'
          : e.message;
      showErr(`AI 직접 판정에 실패해 자체 규칙으로 대신 판정했습니다. (${reason}) [상세: ${e.message}]`);
      /* setLoading(false)는 아래 규칙 엔진 경로가 다시 setLoading(true)를 부르므로 생략 */
    }
  }

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
    r.portionLabel ? `${r.food.ko}(${r.portionLabel})`
    : r.portion === 1 ? r.food.ko
    : `${r.food.ko}(${PORTIONS.find(p => p[0] === r.portion)?.[1] || r.portion})`
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
  /* AI가 직접 판정한 경우 — rules.js 결정적 판정과 다르다는 것을 숨기지 않는다.
     같은 사진이어도 다시 물으면 문구가 조금씩 달라질 수 있고, 항목별 수치
     근거(판정의 근거 보기)도 이 경로에서는 만들 수 없다. */
  if (res.aiJudged) {
    const d = document.createElement('div');
    d.className = 'note';
    const t = document.createElement('b');
    t.textContent = 'ℹ️ 이 판정은 AI가 사진을 보고 직접 냈습니다';
    const p = document.createElement('span');
    p.textContent = '자체 데이터베이스에 없는 음식이라 규칙 엔진 대신 Gemini가 판정했습니다. ' +
      '같은 사진이라도 다시 판정하면 표현이 달라질 수 있고, 항목별 수치 근거는 보여드릴 수 없습니다.';
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

  if (!res.aiJudged && remoteFoods.length) {
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

  /* AI 직접 판정 경로는 rules.js의 profile/meal 합계가 없다 — 프로필도 이미
     프롬프트 안에서 Gemini에게 전달돼 판정에 반영됐으므로 별도 줄이 필요 없다. */
  const lines = res.aiJudged ? [] : (() => {
    const p = res.profile;
    const profLine = (p.weightGiven || p.ageYears)
      ? `기준 조정: ${[p.weightGiven ? `체중 ${p.weightKg}kg` : null,
                       p.ageYears ? `나이 ${p.ageYears}세` : null].filter(Boolean).join(' · ')}`
      : '체중·나이를 넣지 않아 성인 60kg 기준으로 판정했습니다.';
    return [
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
  })();
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
  const hasDisease = selectedDiseaseIds().length > 0;
  $('judgeBtn').disabled = !(picked.length > 0 && hasDisease);
  $('judgeBtn').textContent = !hasDisease
    ? t('needDisease')
    : picked.length === 0 ? t('needFood') : t('judgeBtn');
  $('diseaseNudge').hidden = hasDisease;
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

/* ── 첫 실행 온보딩 — 체중·나이·성별 → 동의(면책 고지) → 질환·상태 → Gemini 키 → 앱 시작
   화면을 하나씩 순서대로 넘긴다. 각 화면은 설정 패널 안의 실제 섹션을 그대로 보여주므로
   (별도로 만든 입력칸이 아니다), 나중에 설정에서 똑같은 항목을 다시 고칠 수 있다.
   면책 고지(#gate)만은 법적으로 중요해서 건너뛸 수 없게 별도로 처리한다. */
const GATE_KEY = 'mc.gate.v1';
const ONBOARD_KEY = 'mc.onboard.v2';   // 화면을 나눠 보여주는 방식으로 바뀌어 v1과 구분

function showOnlySettingsSection(id) {
  for (const s of document.querySelectorAll('.settings-section')) s.hidden = (s.id !== id);
}
function showAllSettingsSections() {
  for (const s of document.querySelectorAll('.settings-section')) s.hidden = false;
}

/** 설정 패널을 "마법사 모드"로 한 화면만 보여주고, 다음 버튼을 누르면 onNext를 부른다.
    canProceed을 주면 그 결과가 참일 때만 다음으로 넘어간다(거짓이면 그 자리에 머문다). */
function openWizardStep(sectionId, label, onNext, canProceed) {
  showOnlySettingsSection(sectionId);
  $('settingsClose').hidden = true;
  const btn = $('wizardNextBtn');
  btn.hidden = false;
  btn.textContent = label;
  const handler = () => {
    if (canProceed && !canProceed()) return;
    btn.removeEventListener('click', handler);
    onNext();
  };
  btn.addEventListener('click', handler);
  $('settingsPanel').hidden = false;
  document.body.classList.add('gated');
}

/** 온보딩이 끝났을 때(또는 평소 설정을 열 때) 화면을 정상 상태로 되돌린다. */
function resetSettingsChrome() {
  $('wizardNextBtn').hidden = true;
  $('settingsClose').hidden = false;
  showAllSettingsSections();
}

function showGateStep(onDone) {
  const gate = $('gate');
  if (safeStore.get(GATE_KEY) === 'ok') { gate.hidden = true; onDone(); return; }
  const box = $('gateCheck');
  const btn = $('gateBtn');
  $('settingsPanel').hidden = true;
  gate.hidden = false;
  document.body.classList.add('gated');
  box.addEventListener('change', () => { btn.disabled = !box.checked; });
  const handler = () => {
    if (!box.checked) return;
    safeStore.set(GATE_KEY, 'ok');
    gate.hidden = true;
    btn.removeEventListener('click', handler);
    onDone();
  };
  btn.addEventListener('click', handler);
}

function runOnboarding() {
  openWizardStep('profileBox', t('wizardNext'), () => {
    showGateStep(() => {
      openWizardStep('secDisease', t('wizardNext'), () => {
        openWizardStep('secGemini', t('wizardDone'), () => {
          safeStore.set(ONBOARD_KEY, 'ok');
          resetSettingsChrome();
          $('settingsPanel').hidden = true;
          document.body.classList.remove('gated');
        }, () => {
          const ok = !!safeStore.get(GEMINI_USER_KEY);
          if (!ok) {
            const status = $('geminiKeyStatus');
            status.hidden = false;
            status.style.color = 'var(--red)';
            status.textContent = t('geminiRequired');
          }
          return ok;
        });
      });
    });
  });
}

/** 앱 시작 시 한 번만 실행. 온보딩을 이미 마쳤으면 아무것도 안 하고,
    (드문 경우) 게이트 기록만 없으면 게이트만 다시 보여준다. */
function initOnboardingOrGate() {
  if (safeStore.get(ONBOARD_KEY) === 'ok') {
    $('gate').hidden = true;
    if (safeStore.get(GATE_KEY) !== 'ok') {
      showGateStep(() => {});
    }
    return;
  }
  runOnboarding();
}

/* ── 다국어(한/영) ─────────────────────────────────────────
   설정 화면·질환 이름 같은 "UI 뼈대"만 번역한다. 판정 근거·팁처럼
   rules.js가 만드는 긴 문장(의학적 정확도가 중요함)은 이번 범위 밖이라
   언어를 영어로 바꿔도 그 부분은 한국어로 남는다. */
const LANG_KEY = 'mc.lang';
const I18N = {
  ko: {
    eyebrow: '밥상 판정', title: '이 밥상, 나에게 괜찮을까?',
    tagline: '앓고 있는 질환이나 상태를 고르고 음식을 알려 주면, 각각의 식이 기준에 따라 판정해 드립니다.',
    settingsTitle: '설정', langLabel: '언어 · Language',
    diseaseLabel: '앓고 있는 질환·상태',
    diseaseHint: '해당하는 것을 모두 눌러 주세요. 여러 개를 골라도 됩니다. 한 번 고르면 계속 저장됩니다.',
    profileLabel: '체중 · 나이 · 성별', optTag: '선택',
    profileHint: '넣지 않아도 판정됩니다. 넣으면 체중·나이에 맞춰 기준이 조정됩니다. 입력값은 이 기기 안에만 저장되고 어디로도 전송되지 않습니다.',
    weightLabel: '체중', weightHint: 'kg · 콩팥병 단백질, 심부전 수분 기준에 쓰입니다',
    ageLabel: '나이', ageHint: '세 · 소아·청소년은 기준이 더 낮게 조정됩니다',
    sexLabel: '성별', sexNone: '고르지 않음', sexF: '여성', sexM: '남성', sexHint: '철·칼슘 안내에 참고됩니다',
    profileClear: '입력값 지우기',
    geminiLabel: 'Gemini API 키',
    geminiHint: '가장 정확한 인식을 위해 필요합니다. 키를 넣으면 여러분 본인의 무료 한도를 쓰게 되어, 저희 서버 비용도 안 들고 여러분이 결제할 일도 없습니다.',
    geminiStep1: '아래 링크로 이동해 구글 계정으로 로그인한 뒤, "API 키 만들기"를 누릅니다.',
    geminiStep2: '이름은 아무거나 두고 프로젝트도 기본값 그대로 "키 만들기"를 누릅니다.',
    geminiStep3: '만들어진 키 옆의 네모 상자(복사) 아이콘을 눌러 키를 복사합니다.',
    geminiStep4: '이 화면으로 돌아와 아래 입력칸에 붙여넣고 "저장"을 누릅니다.',
    geminiKeyPlaceholder: '여기에 API 키를 붙여넣으세요',
    geminiHasKeyPlaceholder: '저장된 키가 있습니다 (바꾸려면 새로 붙여넣으세요)',
    geminiSave: '저장', geminiClear: '키 지우기',
    geminiValidating: '확인 중…', geminiValid: '✓ 정상적으로 확인된 키입니다.',
    geminiInvalid: '키가 올바르지 않습니다. 다시 확인해 주세요.',
    geminiNetworkErr: '확인 중 오류가 발생했습니다. 인터넷 연결을 확인해 주세요.',
    geminiEmpty: 'API 키를 입력해 주세요.',
    geminiRequired: '먼저 위에서 API 키를 붙여넣고 저장해서 확인을 마쳐야 다음으로 넘어갈 수 있습니다.',
    geminiGuideNote: '이 키는 이 기기에만 저장되며, 저희 서버로 전송되지 않습니다. 구글의 무료 한도 안에서 쓰이며, 한도를 넘으면 자체 모델의 결과만 쓰이니 앱이 멈추지 않습니다. 설정에서 언제든 바꾸거나 지울 수 있습니다.',
    diseaseNudge: '⚙️ 먼저 설정에서 질환·상태를 골라 주세요 →',
    confirmTitle: '음식 목록 확인하기',
    needDisease: '먼저 질환·상태를 골라 주세요', needFood: '먼저 음식을 골라 주세요', judgeBtn: '밥상 판정 받기',
    wizardNext: '다음', wizardDone: '시작하기'
  },
  en: {
    eyebrow: 'Meal Check', title: 'Is this meal okay for me?',
    tagline: 'Pick your conditions and tell us what you ate — we’ll check it against each condition’s guidelines.',
    settingsTitle: 'Settings', langLabel: '언어 · Language',
    diseaseLabel: 'Your conditions',
    diseaseHint: 'Tap everything that applies. You can pick more than one. Your choices are saved.',
    profileLabel: 'Weight · Age · Sex', optTag: 'Optional',
    profileHint: 'Not required. If provided, thresholds are adjusted for your weight and age. Stored only on this device, never sent anywhere.',
    weightLabel: 'Weight', weightHint: 'kg · used for kidney-disease protein and heart-failure fluid limits',
    ageLabel: 'Age', ageHint: 'years · lower thresholds are used for children and teens',
    sexLabel: 'Sex', sexNone: 'Prefer not to say', sexF: 'Female', sexM: 'Male', sexHint: 'used for iron/calcium guidance',
    profileClear: 'Clear',
    geminiLabel: 'Gemini API key',
    geminiHint: 'Needed for the most accurate recognition. Your own key means you use your own free quota — no cost to us or to you.',
    geminiStep1: 'Go to the link below, sign in with your Google account, then click "Create API key".',
    geminiStep2: 'Leave the name as-is and keep the default project, then click "Create key".',
    geminiStep3: 'Click the copy-icon box next to the new key to copy it.',
    geminiStep4: 'Come back here, paste it in the box below, then click "Save".',
    geminiKeyPlaceholder: 'Paste your API key here',
    geminiHasKeyPlaceholder: 'A key is saved (paste a new one to replace it)',
    geminiSave: 'Save', geminiClear: 'Clear key',
    geminiValidating: 'Verifying…', geminiValid: '✓ Key verified successfully.',
    geminiInvalid: 'This key doesn’t look valid. Please check and try again.',
    geminiNetworkErr: 'Something went wrong while verifying. Please check your connection.',
    geminiEmpty: 'Please enter an API key.',
    geminiRequired: 'Paste your API key above and save it to verify before continuing.',
    geminiGuideNote: 'This key is stored only on this device and never sent to our servers. It runs within Google’s free quota; if you run out, the app just falls back to the on-device model. You can change or remove it anytime in Settings.',
    diseaseNudge: '⚙️ Pick your conditions in Settings first →',
    confirmTitle: 'Review your food list',
    needDisease: 'Pick your conditions first', needFood: 'Add food first', judgeBtn: 'Check this meal',
    wizardNext: 'Next', wizardDone: 'Get started'
  }
};
/* 질환 칩·그룹은 rules.js가 한국어 원문만 준다. 영어 전환용 매핑을 따로 둔다. */
const DISEASE_NAME_EN = {
  htn: 'Hypertension', dm: 'Diabetes', cad: 'Heart Attack / Angina', hf: 'Heart Failure',
  lipid: 'Dyslipidemia', ckd: 'Chronic Kidney Disease', gout: 'Gout', osteo: 'Osteoporosis',
  gerd: 'Gastritis / GERD', warf: 'On Warfarin', dysph: 'Dysphagia (Swallowing Difficulty)',
  preg: 'Pregnant / Breastfeeding', anemia: 'Anemia', thyroid: 'Thyroid Dysfunction',
  nafld: 'Fatty Liver / Obesity',
  prediab: 'Prediabetes / Metabolic Syndrome', migraine: 'Migraine', insomnia: 'Insomnia / Sleep Trouble',
  pms: 'PMS / Menstrual Pain', stones: 'Kidney Stones', oa: 'Osteoarthritis', acne: 'Acne / Skin Trouble',
  lactose: 'Lactose Intolerance', celiac: 'Gluten Sensitivity / Celiac Disease',
  allerg_peanut: 'Peanut Allergy', allerg_treenut: 'Tree Nut Allergy', allerg_shellfish: 'Shellfish Allergy',
  allerg_egg: 'Egg Allergy', allerg_milk: 'Milk / Dairy Allergy', allerg_soy: 'Soy Allergy'
};
const GROUP_LABEL_EN = {
  '심장·혈관': 'Heart & Vascular', '대사': 'Metabolic', '콩팥·요로': 'Kidney & Urinary',
  '뼈·피': 'Bone & Blood', '관절·피부': 'Joints & Skin', '소화·삼킴': 'Digestive & Swallowing',
  '신경·수면': 'Neurological & Sleep', '약물·생리 상태': 'Medication & Physiological',
  '식품 알레르기': 'Food Allergies'
};

function currentLang() { return safeStore.get(LANG_KEY) === 'en' ? 'en' : 'ko'; }
function t(key) { return I18N[currentLang()][key] ?? I18N.ko[key] ?? key; }

function applyI18n() {
  const lang = currentLang();
  document.documentElement.lang = lang;
  for (const el of document.querySelectorAll('[data-i18n]')) {
    const val = I18N[lang][el.dataset.i18n];
    if (val != null) el.textContent = val;
  }
  for (const btn of document.querySelectorAll('.lang-btn')) {
    btn.classList.toggle('active', btn.dataset.lang === lang);
  }
  for (const el of document.querySelectorAll('.chip[data-id]')) {
    const ko = DISEASE_BY_ID[el.dataset.id]?.name ?? el.textContent;
    el.textContent = lang === 'en' ? (DISEASE_NAME_EN[el.dataset.id] ?? ko) : ko;
  }
  for (const el of document.querySelectorAll('.group-label[data-ko]')) {
    el.textContent = lang === 'en' ? (GROUP_LABEL_EN[el.dataset.ko] ?? el.dataset.ko) : el.dataset.ko;
  }
  for (const img of document.querySelectorAll('.guide-shot[data-src-en]')) {
    const src = lang === 'en' ? img.dataset.srcEn : img.dataset.srcKo;
    if (src && img.getAttribute('src') !== src) img.src = src;
  }
  refreshGeminiKeyStatus();
  syncButtons();
}

function initLangToggle() {
  for (const btn of document.querySelectorAll('.lang-btn')) {
    btn.addEventListener('click', () => {
      safeStore.set(LANG_KEY, btn.dataset.lang);
      applyI18n();
    });
  }
}

/* ── 설정 패널 (언어·질환·프로필·Gemini 키) ────────────────── */
function initSettingsPanel() {
  const panel = $('settingsPanel');
  const open = () => { resetSettingsChrome(); panel.hidden = false; document.body.classList.add('gated'); };
  const close = () => { panel.hidden = true; document.body.classList.remove('gated'); };
  $('settingsBtn').addEventListener('click', open);
  $('settingsClose').addEventListener('click', close);
  $('diseaseNudge').addEventListener('click', open);
  /* 배경 클릭으로 닫기는 평소 설정에서만 허용한다. 온보딩 중엔(wizardNextBtn이 보이는 동안)
     실수로 배경을 눌러 순서를 건너뛰지 못하게 막는다. */
  panel.addEventListener('click', e => {
    if (e.target === panel && $('wizardNextBtn').hidden) close();
  });
}

/* ── Gemini API 키 (BYOK — 사용자 본인 키) ──────────────────
   여기에 키가 있으면 우리 프록시 대신 이 키로 구글에 직접 붙는다.
   그러면 우리 서버 비용도, 사용자의 무료 한도 소진 걱정도 없다. */
const GEMINI_USER_KEY = 'mc.gemini_key';

function geminiIdentifierOpts() {
  const userKey = safeStore.get(GEMINI_USER_KEY) || '';
  if (userKey) return { devApiKey: userKey, geminiModel: GEMINI_MODEL, userToken: deviceToken() };
  return { proxyUrl: PROXY_URL, devApiKey: DEV_GEMINI_KEY, geminiModel: GEMINI_MODEL, userToken: deviceToken() };
}

/** 구글에 실제로 가벼운 요청을 보내 키가 진짜 동작하는지 확인한다.
    (모델 목록 조회 — 과금도, 사진 전송도 없는 가장 싼 엔드포인트) */
async function validateGeminiKey(key) {
  try {
    const res = await fetch('https://generativelanguage.googleapis.com/v1beta/models', {
      headers: { 'x-goog-api-key': key }
    });
    if (res.ok) return { ok: true };
    if (res.status === 400 || res.status === 403) return { ok: false, reason: 'bad_key' };
    return { ok: false, reason: 'error' };
  } catch {
    return { ok: false, reason: 'network' };
  }
}

function refreshGeminiKeyStatus() {
  const input = $('geminiKeyInput');
  const status = $('geminiKeyStatus');
  const has = !!safeStore.get(GEMINI_USER_KEY);
  if (has) {
    status.hidden = false;
    status.style.color = 'var(--green)';
    status.textContent = t('geminiValid');
    input.value = '';
  } else {
    status.hidden = true;
  }
  input.placeholder = has ? t('geminiHasKeyPlaceholder') : t('geminiKeyPlaceholder');
}

function initGeminiKeyBox() {
  const input = $('geminiKeyInput');
  const status = $('geminiKeyStatus');
  const saveBtn = $('geminiKeySave');

  saveBtn.addEventListener('click', async () => {
    const v = input.value.trim();
    if (!v) {
      status.hidden = false;
      status.style.color = 'var(--red)';
      status.textContent = t('geminiEmpty');
      return;
    }
    saveBtn.disabled = true;
    status.hidden = false;
    status.style.color = 'var(--ink-soft)';
    status.textContent = t('geminiValidating');
    const result = await validateGeminiKey(v);
    saveBtn.disabled = false;
    if (result.ok) {
      safeStore.set(GEMINI_USER_KEY, v);
      refreshGeminiKeyStatus();
      refreshDefaultAdapter();
    } else {
      status.style.color = 'var(--red)';
      status.textContent = result.reason === 'network' ? t('geminiNetworkErr') : t('geminiInvalid');
    }
  });
  $('geminiKeyClear').addEventListener('click', () => {
    safeStore.remove(GEMINI_USER_KEY);
    input.value = '';
    refreshGeminiKeyStatus();
    refreshDefaultAdapter();
  });
  refreshGeminiKeyStatus();
}

/* ── 서비스워커 (PWA 설치·오프라인) ──────────────────────
   file://이나 http에서는 등록되지 않는다. 실패해도 앱은 정상 동작한다. */
function initServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  if (location.protocol !== 'https:' && location.hostname !== 'localhost') return;
  navigator.serviceWorker.register('./sw.js').catch(() => { /* 무시 */ });
}

/* ── 시작 ────────────────────────────────────────────────── */
renderAdapterOptions();
applyAdapterMode();
loadProfile();
loadDiseaseSelection();
initSettingsPanel();
initGeminiKeyBox();
initLangToggle();
applyI18n();
renderPicked();
syncButtons();
initOnboardingOrGate();
initServiceWorker();
// 최근 목록은 영양 테이블이 로드된 뒤에야 id → 음식 변환이 된다
store.ready().then(renderRecent).catch(e => showErr(e.message));
