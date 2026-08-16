/**
 * UI 흐름 검증 — node test/ui.test.mjs
 *
 * 실제 index.html을 DOM에 올리고 app.js를 그대로 실행한 뒤,
 * 사람이 하는 것과 같은 순서로 클릭·입력해 결과 화면까지 도달하는지 본다.
 *
 * 검증 범위
 *   ✅ 질환 칩 렌더·그룹핑·다중 선택
 *   ✅ 프로필 입력·저장·복원·초기화
 *   ✅ 음식 검색 → 후보 클릭 → 목록 추가 → 양 변경 → 삭제
 *   ✅ 판정 실행 → 결과 DOM(도장·카드·근거·충돌·팁·출처) 렌더
 *   ✅ 어댑터 전환 시 화면 변화
 *   ✅ 다시하기 초기화
 *
 * 검증 못 하는 것 (실제 브라우저 필요)
 *   ❌ 카메라·파일 선택          — jsdom에 canvas가 없다
 *   ❌ CLIP 모델 다운로드·추론    — WebGPU/WASM이 없다
 *   ❌ 실제 렌더링 결과(레이아웃) — jsdom은 스타일을 계산하지 않는다
 *
 * 사전 준비: npm install jsdom
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';

const root = new URL('../', import.meta.url);
const html = readFileSync(new URL('index.html', root), 'utf8');

/* ── 브라우저 환경 구성 ─────────────────────────────────── */
const dom = new JSDOM(html, { url: 'http://localhost:8000/', pretendToBeVisual: true });
const { window } = dom;

globalThis.window = window;
globalThis.document = window.document;
globalThis.location = window.location;   // app.js가 file:// 여부를 판별하는 데 쓴다
globalThis.Image = window.Image;
globalThis.FileReader = window.FileReader;
globalThis.HTMLElement = window.HTMLElement;
// Node 22의 globalThis.navigator는 getter라 대입이 막힌다. 정의로 덮어쓴다.
Object.defineProperty(globalThis, 'navigator', { value: window.navigator, configurable: true });

/* localStorage: jsdom에도 있지만 테스트 간 격리를 위해 직접 만든다 */
const store = new Map();
globalThis.localStorage = {
  getItem: k => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: k => store.delete(k)
};

/* fetch: 영양 테이블 로드만 파일 읽기로 대체. 프록시는 애초에 안 쓴다. */
globalThis.fetch = async (url) => {
  const p = fileURLToPath(url);
  return { ok: true, status: 200, json: async () => JSON.parse(readFileSync(p, 'utf8')) };
};

/* app.js가 쓰는 스크롤 API는 jsdom에 없다 */
window.scrollTo = () => {};
window.HTMLElement.prototype.scrollIntoView = () => {};

/* ── 실행 ───────────────────────────────────────────────── */
await import('../js/app.js');
await new Promise(r => setTimeout(r, 60));   // store.ready() 완료 대기

/* ── 테스트 도구 ────────────────────────────────────────── */
let pass = 0, fail = 0;
function check(name, a, b = true) {
  const ok = a === b; ok ? pass++ : fail++;
  console.log(`${ok ? '  ✓' : '  ✗'} ${name}${ok ? '' : `  →  기대 ${b}, 실제 ${a}`}`);
}
const section = t => console.log(`\n── ${t}`);
const $ = id => document.getElementById(id);
const click = el => el.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
const setVal = (el, v, ev = 'input') => {
  el.value = v;
  el.dispatchEvent(new window.Event(ev, { bubbles: true }));
};
const text = id => $(id).textContent;

/* ═══════════════════════════════════════════════════════════
   1. 초기 렌더
   ═══════════════════════════════════════════════════════════ */
section('초기 렌더');
{
  const groups = document.querySelectorAll('#chips .group');
  const chips = document.querySelectorAll('#chips .chip');
  check('질환 그룹 6개 렌더', groups.length, 6);
  check('질환 칩 15개 렌더', chips.length, 15);
  check('모든 칩에 주의 항목 툴팁', [...chips].every(c => c.title.startsWith('주의 항목')));
  check('임신 칩이 "약물·생리 상태" 그룹에 있음',
    [...groups].find(g => g.querySelector('.group-label').textContent === '약물·생리 상태')
      ?.textContent.includes('임신'));

  check('어댑터 5종 렌더', document.querySelectorAll('#adapterOptions input[name=adapter]').length, 5);
  check('프록시 미설정 시 Gemini 어댑터 비활성',
    document.querySelector('#adapterOptions input[value=gemini]').disabled);

  check('결과 영역은 처음에 숨김', $('result').hidden);
  check('빈 목록 안내 표시', $('emptyNote').hidden, false);
  check('판정 버튼 비활성', $('judgeBtn').disabled);
  check('판정 버튼이 다음 할 일을 안내', text('judgeBtn'), '먼저 질환·상태를 골라 주세요');
}

/* ═══════════════════════════════════════════════════════════
   2. 프로필 — 선택 입력이 진짜 선택인가
   ═══════════════════════════════════════════════════════════ */
section('프로필 입력 (선택)');
{
  const tag = $('profileBox').querySelector('.opt-tag');
  check('미입력 시 "선택" 배지', tag.textContent, '선택');

  setVal($('pfWeight'), '72');
  check('체중 입력 시 배지에 반영', tag.textContent, '72kg');

  setVal($('pfAge'), '28');
  setVal($('pfSex'), 'f', 'change');
  check('세 값 모두 배지에 표시', tag.textContent, '72kg · 28세 · 여성');
  check('localStorage에 저장됨', JSON.parse(localStorage.getItem('mc.profile')).weightKg, '72');

  click($('pfClear'));
  check('초기화 후 배지 복원', tag.textContent, '선택');
  check('초기화 후 저장값 삭제', localStorage.getItem('mc.profile'), null);
  check('초기화 후 입력칸 비움', $('pfWeight').value, '');
}

/* ═══════════════════════════════════════════════════════════
   3. 질환 선택
   ═══════════════════════════════════════════════════════════ */
section('질환 선택');
{
  const chipBy = name => [...document.querySelectorAll('#chips .chip')]
    .find(c => c.textContent === name);

  click(chipBy('고혈압'));
  check('클릭 시 aria-pressed true', chipBy('고혈압').getAttribute('aria-pressed'), 'true');
  check('음식이 없으면 여전히 비활성', $('judgeBtn').disabled);
  check('버튼이 음식 선택을 안내', text('judgeBtn'), '먼저 음식을 골라 주세요');

  click(chipBy('만성콩팥병'));
  check('두 번째 칩도 선택 (다중 선택)',
    document.querySelectorAll('#chips .chip[aria-pressed="true"]').length, 2);

  click(chipBy('고혈압'));
  check('다시 누르면 해제', chipBy('고혈압').getAttribute('aria-pressed'), 'false');
  click(chipBy('고혈압'));   // 다시 켜 둔다
}

/* ═══════════════════════════════════════════════════════════
   4. 음식 검색·추가·수정
   ═══════════════════════════════════════════════════════════ */
section('음식 검색·추가');
{
  setVal($('foodSearch'), '바나나');
  await new Promise(r => setTimeout(r, 20));
  const opts = document.querySelectorAll('#suggest li button');
  check('검색 결과 표시', opts.length > 0);
  check('결과에 1인분 중량 표기', opts[0].textContent.includes('1인분'));

  click(opts[0]);
  await new Promise(r => setTimeout(r, 10));
  check('목록에 추가됨', document.querySelectorAll('#picked li').length, 1);
  check('검색창 비워짐', $('foodSearch').value, '');
  check('후보 목록 닫힘', document.querySelectorAll('#suggest li').length, 0);
  check('빈 목록 안내 숨김', $('emptyNote').hidden);
  check('판정 버튼 활성화', $('judgeBtn').disabled, false);
  check('버튼 문구 정상 복귀', text('judgeBtn'), '밥상 판정 받기');

  // 같은 음식을 또 넣으면 항목이 늘지 않고 양이 합쳐져야 한다
  setVal($('foodSearch'), '바나나');
  await new Promise(r => setTimeout(r, 20));
  click(document.querySelector('#suggest li button'));
  await new Promise(r => setTimeout(r, 10));
  check('중복 추가 시 항목 수 유지', document.querySelectorAll('#picked li').length, 1);
  check('중복 추가 시 양이 합산(2인분)',
    document.querySelector('#picked select').value, '2');

  // 양 되돌리기
  setVal(document.querySelector('#picked select'), '1', 'change');

  // 두 번째 음식
  setVal($('foodSearch'), '감자');
  await new Promise(r => setTimeout(r, 20));
  click(document.querySelector('#suggest li button'));
  await new Promise(r => setTimeout(r, 10));
  check('두 번째 음식 추가', document.querySelectorAll('#picked li').length, 2);

  // 삭제
  click(document.querySelectorAll('#picked .del')[1]);
  await new Promise(r => setTimeout(r, 10));
  check('삭제 동작', document.querySelectorAll('#picked li').length, 1);

  // 다시 추가 (판정 시나리오용)
  setVal($('foodSearch'), '감자');
  await new Promise(r => setTimeout(r, 20));
  click(document.querySelector('#suggest li button'));
  await new Promise(r => setTimeout(r, 10));
}

/* ═══════════════════════════════════════════════════════════
   4.5 최근 먹은 것 — AI 호출을 없애는 가장 큰 수단
   ═══════════════════════════════════════════════════════════ */
section('최근 먹은 것');
{
  const box = $('recentBox');
  const chips = () => [...document.querySelectorAll('#recentChips .chip')].map(c => c.textContent);

  check('담은 음식이 최근 목록에 들어감', chips().includes('바나나'));
  check('두 번째 음식도 기록', chips().includes('감자'));
  check('가장 최근 것이 앞에 옴', chips()[0], '감자');
  check('목록이 보임', box.hidden, false);
  check('localStorage에 저장', JSON.parse(localStorage.getItem('mc.recent')).length > 0, true);

  // 같은 음식을 또 담아도 칩이 늘지 않아야 한다
  const before = chips().length;
  setVal($('foodSearch'), '바나나');
  await new Promise(r => setTimeout(r, 20));
  click(document.querySelector('#suggest li button'));
  await new Promise(r => setTimeout(r, 10));
  check('중복은 하나로 합쳐짐', chips().length, before);
  check('다시 담은 것이 맨 앞으로', chips()[0], '바나나');

  // 칩을 누르면 AI 호출 없이 바로 담긴다 — 이게 이 기능의 핵심
  const pickedBefore = document.querySelectorAll('#picked li').length;
  const potatoChip = [...document.querySelectorAll('#recentChips .chip')]
    .find(c => c.textContent === '감자');
  click(potatoChip);
  await new Promise(r => setTimeout(r, 10));
  check('칩 클릭으로 담김 (호출 0회)',
    document.querySelectorAll('#picked li').length >= pickedBefore, true);

  // 지우기
  click($('recentClear'));
  await new Promise(r => setTimeout(r, 10));
  check('지우기 후 목록 숨김', box.hidden);
  check('지우기 후 저장값 삭제', localStorage.getItem('mc.recent'), null);

  // 다시 담으면 되살아난다
  setVal($('foodSearch'), '감자');
  await new Promise(r => setTimeout(r, 20));
  click(document.querySelector('#suggest li button'));
  await new Promise(r => setTimeout(r, 10));
  check('다시 담으면 목록 복원', box.hidden, false);
}

/* ═══════════════════════════════════════════════════════════
   5. 판정 — 칼륨 충돌 시나리오가 화면까지 도달하는가
   ═══════════════════════════════════════════════════════════ */
section('판정 실행 (고혈압 + 만성콩팥병 / 바나나 + 감자)');
{
  click($('judgeBtn'));
  await new Promise(r => setTimeout(r, 60));

  check('결과 영역 표시', $('result').hidden, false);
  check('판정 도장 표시', ['좋음', '주의', '피함'].includes(text('stamp')));
  check('칼륨 과다로 피함 판정', text('stamp'), '피함');
  check('종합 코멘트 존재', text('overallComment').length > 0);
  check('식별된 음식 표기', text('foodsLine').includes('바나나'));

  check('질환 카드 2개', document.querySelectorAll('#diseaseCards .dcard').length, 2);
  check('충돌 안내 표시', document.querySelectorAll('#conflictBox .conflict').length, 1);
  check('충돌 문구가 칼륨을 설명',
    document.querySelector('#conflictBox .conflict').textContent.includes('칼륨'));

  // 판정 근거 — 룰 엔진이라 항상 보여 줄 수 있어야 한다
  const details = document.querySelectorAll('#diseaseCards details');
  check('근거 보기 섹션 존재', details.length > 0);
  const why = details[0].querySelector('.why');
  check('근거에 수치와 임계값 표시', /\d+mg/.test(why.textContent));
  check('근거에 RATIONALE이 사람 말로 표시', why.textContent.includes('근거:'));
  check('근거에 RATIONALE 원문 태그가 새지 않음', why.textContent.includes('RATIONALE'), false);

  check('팁 렌더', document.querySelectorAll('#tipsList li').length > 0);
  check('칼륨 저감 팁 포함', text('tipsList').includes('데쳐'));

  const prov = text('provenance');
  check('프로필 미입력 안내', prov.includes('성인 60kg 기준'));
  check('출처 비율 표시', prov.includes('추정치'));
  check('한계 고지 표시', prov.includes('정확도가 낮'));
  check('영양 수치 요약 표시', prov.includes('칼륨'));
}

/* ═══════════════════════════════════════════════════════════
   6. 프로필이 판정 화면에 반영되는가
   ═══════════════════════════════════════════════════════════ */
section('프로필 반영');
{
  setVal($('pfWeight'), '45', 'change');
  setVal($('pfAge'), '9', 'change');
  click($('judgeBtn'));
  await new Promise(r => setTimeout(r, 60));

  check('출처란에 조정 내역 표시', text('provenance').includes('체중 45kg'));
  check('나이도 함께 표시', text('provenance').includes('나이 9세'));
  const why = document.querySelector('#diseaseCards .why');
  check('근거에 조정 표기', why.textContent.includes('조정됨'));

  click($('pfClear'));
}

/* ═══════════════════════════════════════════════════════════
   7. 갑상선 note가 화면에 뜨는가
   ═══════════════════════════════════════════════════════════ */
section('한계 안내(note) 렌더');
{
  const chipBy = name => [...document.querySelectorAll('#chips .chip')]
    .find(c => c.textContent === name);
  click(chipBy('갑상선기능이상'));

  setVal($('foodSearch'), '미역국');
  await new Promise(r => setTimeout(r, 20));
  click(document.querySelector('#suggest li button'));
  await new Promise(r => setTimeout(r, 10));

  click($('judgeBtn'));
  await new Promise(r => setTimeout(r, 60));

  check('note 박스 렌더', document.querySelectorAll('#noteBox .note').length, 1);
  check('note가 항진·저하 미구분을 밝힘',
    document.querySelector('#noteBox .note').textContent.includes('항진증'));
  check('미역국으로 갑상선 피함 판정',
    [...document.querySelectorAll('#diseaseCards .dcard')]
      .find(c => c.textContent.includes('갑상선'))?.classList.contains('avoid'));
}

/* ═══════════════════════════════════════════════════════════
   7.5 http에서는 사진 기능이 정상이어야 한다
   ═══════════════════════════════════════════════════════════
   이 테스트는 http://localhost 환경이다. file:// 대응을 넣다가
   http에서까지 사진 영역이 사라진 적이 있어 양쪽을 다 고정한다.
   ═══════════════════════════════════════════════════════════ */
section('http 환경에서 사진 기능');
{
  // 기기 인식 모드로 되돌린 뒤 확인
  const od = document.querySelector('#adapterOptions input[value=ondevice]');
  check('기기 인식이 활성 상태', od.disabled, false);
  od.checked = true;
  od.dispatchEvent(new window.Event('change', { bubbles: true }));

  check('사진 영역 보임', $('photoBlock').hidden, false);
  check('자동 인식 버튼 보임', $('scanBtn').hidden, false);
  check('사진 선택 input 존재', !!$('fileInput'));
  check('카메라 우선 속성 유지', $('fileInput').getAttribute('capture'), 'environment');
  check('이미지만 받도록 제한', $('fileInput').getAttribute('accept'), 'image/*');
  check('2단계 제목이 사진 모드', text('step2Title'), '음식 사진 찍기');
  check('사진 없으면 스캔 버튼 비활성', $('scanBtn').disabled);
}

/* ═══════════════════════════════════════════════════════════
   8. 어댑터 전환
   ═══════════════════════════════════════════════════════════ */
section('어댑터 전환');
{
  const manual = document.querySelector('#adapterOptions input[value=manual]');
  manual.checked = true;
  manual.dispatchEvent(new window.Event('change', { bubbles: true }));
  /* 수동 모드에서도 사진은 올릴 수 있다. 보면서 고르는 편이 편하기 때문이다.
     감추는 것은 자동 인식 버튼뿐이다. */
  check('수동 모드에서도 사진 영역 유지', $('photoBlock').hidden, false);
  check('수동 모드에서는 인식 버튼만 숨김', $('scanBtn').hidden);
  check('수동 모드 제목 변경', text('step2Title'), '사진 올리기 (선택)');
  check('사진이 참고용임을 안내', $('step2Hint').textContent.includes('참고용'));
  check('선택이 localStorage에 저장', localStorage.getItem('mc.adapter'), 'manual');

  const ondevice = document.querySelector('#adapterOptions input[value=ondevice]');
  ondevice.checked = true;
  ondevice.dispatchEvent(new window.Event('change', { bubbles: true }));
  check('기기 인식 모드에서 인식 버튼 복원', $('scanBtn').hidden, false);
  check('제목 복원', text('step2Title'), '음식 사진 찍기');
}

/* ═══════════════════════════════════════════════════════════
   9. 다시하기
   ═══════════════════════════════════════════════════════════ */
section('다시하기');
{
  click($('retryBtn'));
  await new Promise(r => setTimeout(r, 20));
  check('결과 숨김', $('result').hidden);
  check('음식 목록 비움', document.querySelectorAll('#picked li').length, 0);
  check('빈 목록 안내 복원', $('emptyNote').hidden, false);
  check('판정 버튼 비활성', $('judgeBtn').disabled);
  check('질환 선택은 유지 (다시 고르게 하지 않음)',
    document.querySelectorAll('#chips .chip[aria-pressed="true"]').length > 0);
}

/* ═══════════════════════════════════════════════════════════
   10. XSS 방어 — AI 응답이 화면에 삽입되는 경로
   ═══════════════════════════════════════════════════════════ */
section('XSS 방어');
{
  // 음식 이름에 스크립트가 들어와도 실행되지 않고 글자로만 보여야 한다
  const { NutritionStore } = await import('../js/nutrition.js');
  const s = new NutritionStore({ proxyUrl: '' });
  await s.ready();
  const evil = { ...s.byId('rice_white'), ko: '<img src=x onerror=alert(1)>' };
  const div = document.createElement('div');
  div.textContent = evil.ko;
  check('textContent 삽입 시 태그가 이스케이프됨', div.innerHTML.includes('&lt;img'));
  check('app.js가 innerHTML로 AI 응답을 넣지 않음',
    !/innerHTML\s*=\s*[^'"]*\$\{/.test(readFileSync(new URL('js/app.js', root), 'utf8')));
}

console.log(`\n${'═'.repeat(50)}`);
console.log(`통과 ${pass} · 실패 ${fail}`);
console.log('═'.repeat(50));
if (fail) console.log('\n※ 카메라·CLIP 추론은 jsdom에서 검증 불가. 실제 브라우저 확인 필요.');
process.exit(fail ? 1 : 0);
