/**
 * 단일 파일 빌드 검증 — node test/dist.test.mjs
 *
 * ui.test.mjs는 개발용 모듈 구조를 검증한다. 이 테스트는 빌드 산출물
 * dist/meal-check.html을 통째로 jsdom에 올려 실제로 스크립트가 실행되고
 * 같은 흐름이 도는지 확인한다. 번들링 과정에서 export 제거나 데이터 인라인이
 * 잘못되면 여기서 잡힌다.
 *
 * ui.test.mjs와 달리 스크립트를 jsdom이 직접 실행한다(runScripts: 'dangerously').
 * 즉 브라우저가 이 파일을 여는 것과 거의 같은 경로다.
 */
import { readFileSync, existsSync } from 'node:fs';
import { JSDOM } from 'jsdom';

const DIST_DIR = new URL('../dist/', import.meta.url);
const DIST = new URL('./index.html', DIST_DIR);
if (!existsSync(DIST)) {
  console.error('✗ dist/index.html이 없습니다. 먼저 node build.mjs를 실행하세요.');
  process.exit(1);
}

let pass = 0, fail = 0;
const check = (name, a, b = true) => {
  const ok = a === b; ok ? pass++ : fail++;
  console.log(`${ok ? '  ✓' : '  ✗'} ${name}${ok ? '' : `  →  기대 ${b}, 실제 ${a}`}`);
};
const section = t => console.log(`\n── ${t}`);

/* file:// 로 여는 상황을 최대한 흉내 낸다 */
const errors = [];
const dom = new JSDOM(readFileSync(DIST, 'utf8'), {
  url: 'file:///Users/test/meal-check.html',
  runScripts: 'dangerously',
  pretendToBeVisual: true,
  virtualConsole: new (await import('jsdom')).VirtualConsole()
    .on('jsdomError', e => errors.push(e.message))
    .on('error', m => errors.push(String(m)))
});
const { window } = dom;
const document = window.document;

/* 앱이 쓰지만 jsdom에 없는 것 */
window.scrollTo = () => {};
window.HTMLElement.prototype.scrollIntoView = () => {};

await new Promise(r => setTimeout(r, 120));

const $ = id => document.getElementById(id);
const click = el => el.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
const setVal = (el, v, ev = 'input') => {
  el.value = v;
  el.dispatchEvent(new window.Event(ev, { bubbles: true }));
};

/* ═══════════════════════════════════════════════════════════
   1. 스크립트가 실제로 실행됐는가
   ═══════════════════════════════════════════════════════════ */
section('스크립트 실행 (file:// 환경)');
{
  check('실행 중 에러 없음', errors.length, 0);
  if (errors.length) errors.slice(0, 3).forEach(e => console.log(`     ${e.split('\n')[0]}`));

  check('외부 스크립트 참조 없음', document.querySelectorAll('script[src]').length, 0);
  check('type=module 없음', document.querySelectorAll('script[type=module]').length, 0);
  check('인라인 스크립트 1개', document.querySelectorAll('script').length, 1);
}

/* ═══════════════════════════════════════════════════════════
   1.5 면책 고지 게이트 — 건너뛸 수 없어야 한다
   ═══════════════════════════════════════════════════════════ */
section('면책 고지 게이트');
{
  const gate = $('gate');
  check('첫 실행 시 고지가 떠 있음', gate.hidden, false);
  check('본문 스크롤 잠김', document.body.classList.contains('gated'));
  check('동의 전에는 버튼 비활성', $('gateBtn').disabled);

  const t = gate.textContent;
  check('의료기기 아님 명시', t.includes('의료기기가 아닙니다'));
  check('추정치임을 명시', t.includes('검증되지 않은 추정치'));
  check('정확도 낮은 항목 명시', t.includes('통풍·와파린·갑상선'));
  check('응급 상황 안내', t.includes('119'));
  check('개인정보 처리방침 링크', !!gate.querySelector('a[href*="privacy"]'));

  // 체크 없이 눌러도 통과 안 됨
  click($('gateBtn'));
  check('동의 없이 누르면 그대로', gate.hidden, false);

  // 동의 후 통과
  const box = $('gateCheck');
  box.checked = true;
  box.dispatchEvent(new window.Event('change', { bubbles: true }));
  check('동의하면 버튼 활성', $('gateBtn').disabled, false);
  click($('gateBtn'));
  check('통과 후 고지 숨김', gate.hidden);
  check('본문 스크롤 복원', document.body.classList.contains('gated'), false);
}

/* ═══════════════════════════════════════════════════════════
   2. 렌더 — 번들이 제대로 초기화됐는가
   ═══════════════════════════════════════════════════════════ */
section('초기 렌더');
{
  check('질환 그룹 6개', document.querySelectorAll('#chips .group').length, 6);
  check('질환 칩 15개', document.querySelectorAll('#chips .chip').length, 15);
  check('어댑터 5종', document.querySelectorAll('#adapterOptions input[name=adapter]').length, 5);
  check('결과 영역 숨김', $('result').hidden);
  check('오류 배너 안 뜸', $('scanErr').style.display !== 'block');
}

/* ═══════════════════════════════════════════════════════════
   2.5 file:// 제약 안내 — 실패하기 전에 미리 알려야 한다
   ═══════════════════════════════════════════════════════════
   file: 출처에서는 CDN 동적 import가 차단돼 기기 인식이 동작하지 않는다.
   그냥 두면 사용자는 버튼을 눌러도 아무 일도 안 일어나는 것처럼 느낀다.
   ═══════════════════════════════════════════════════════════ */
section('file://에서도 사진 올리기는 열려 있다');
{
  /* 이전에는 file://을 감지해 기기 인식을 미리 막고 사진 영역을 숨겼다.
     그런데 (1) 될지 안 될지는 눌러 봐야 알고 (2) 사진 올리기 자체는
     어디서든 되므로, 미리 막는 것은 되는 기능까지 뺏는 짓이었다.
     지금은 막지 않고, 실패했을 때 안내한다. */
  const ondevice = document.querySelector('#adapterOptions input[value=ondevice]');
  const cloud = document.querySelector('#adapterOptions input[value=cloud]');
  check('기기 인식이 미리 차단되지 않음', ondevice.disabled, false);
  check('클라우드 AI도 차단되지 않음 (토큰 넣으면 되므로)', cloud.disabled, false);
  /* 기본값은 "설정 없이 실제로 성공하는 것"이어야 한다.
     Pollinations는 크레딧제로 바뀌어 토큰 없이는 402가 나므로 기본값이 될 수 없다.
     기기 인식(CLIP)은 정확도는 낮아도 아무 설정 없이 확실히 동작해 예전엔 기본값이었다.
     실제로 402가 나는 것을 기본값으로 뒀던 버그가 있었다.
     지금은 LOCAL_MODEL_URL에 학습된 자체 모델이 채워져 있어(2026-08) 자체 모델도
     설정 없이 되는 경로다. ADAPTERS 우선순위상 자체 모델이 더 정확하고 비용이 0이라
     이게 이겨야 맞다(identify.js의 makeIdentifier 주석 참조). */
  const local = document.querySelector('#adapterOptions input[value=local]');
  check('자체 모델이 기본 선택 (설정 없이 성공하는 경로 중 가장 정확함)', local.checked);
  check('사진 영역이 보임', $('photoBlock').hidden, false);

  // Gemini는 못 쓰는 이유뿐 아니라 켜는 방법도 함께 보여야 한다
  const gRow = document.querySelector('#adapterOptions input[value=gemini]').closest('.radio-row');
  check('Gemini 켜는 방법 안내', gRow.textContent.includes('aistudio.google.com'));
  check('무료임을 명시 (돈 걱정 제거)', gRow.textContent.includes('신용카드가 필요 없'));
  check('사진 선택 input 존재', !!$('fileInput'));
  check('카메라 우선 속성 유지', $('fileInput').getAttribute('capture'), 'environment');
  check('2단계 제목이 사진 모드', $('step2Title').textContent, '음식 사진 찍기');
  check('프록시 없는 Gemini만 비활성',
    document.querySelector('#adapterOptions input[value=gemini]').disabled);

  // 직접 고르기로 바꿔도 사진은 여전히 올릴 수 있어야 한다 (참고용)
  const manual = document.querySelector('#adapterOptions input[value=manual]');
  manual.checked = true;
  manual.dispatchEvent(new window.Event('change', { bubbles: true }));
  check('직접 고르기에서도 사진 영역 유지', $('photoBlock').hidden, false);
  check('직접 고르기에서는 자동 인식 버튼만 숨김', $('scanBtn').hidden);
  check('사진이 참고용임을 안내', $('step2Hint').textContent.includes('참고용'));

  ondevice.checked = true;
  ondevice.dispatchEvent(new window.Event('change', { bubbles: true }));
  check('되돌리면 인식 버튼 복원', $('scanBtn').hidden, false);
}

/* ═══════════════════════════════════════════════════════════
   3. 영양 테이블이 인라인으로 로드됐는가 (fetch 없이)
   ═══════════════════════════════════════════════════════════ */
section('인라인 영양 테이블');
{
  setVal($('foodSearch'), '미역국');
  await new Promise(r => setTimeout(r, 30));
  const opts = document.querySelectorAll('#suggest li button');
  check('검색 동작 (fetch 없이)', opts.length > 0);
  check('결과에 미역국 포함', opts[0]?.textContent.includes('미역국'));

  setVal($('foodSearch'), '에너지드링크');
  await new Promise(r => setTimeout(r, 30));
  check('확장된 음식도 검색됨',
    document.querySelector('#suggest li button')?.textContent.includes('에너지드링크'));
}

/* ═══════════════════════════════════════════════════════════
   4. 판정 전체 흐름
   ═══════════════════════════════════════════════════════════ */
section('판정 흐름 (갑상선 + 미역국)');
{
  const chip = [...document.querySelectorAll('#chips .chip')]
    .find(c => c.textContent === '갑상선기능이상');
  click(chip);

  setVal($('foodSearch'), '미역국');
  await new Promise(r => setTimeout(r, 30));
  click(document.querySelector('#suggest li button'));
  await new Promise(r => setTimeout(r, 20));
  check('음식 담김', document.querySelectorAll('#picked li').length, 1);

  click($('judgeBtn'));
  await new Promise(r => setTimeout(r, 80));

  check('결과 표시', $('result').hidden, false);
  check('요오드 과잉으로 피함', $('stamp').textContent, '피함');
  check('질환 카드 렌더', document.querySelectorAll('#diseaseCards .dcard').length, 1);
  check('판정 근거 렌더', document.querySelectorAll('#diseaseCards .why').length, 1);
  check('근거에 수치 포함', /\d+µg/.test(document.querySelector('#diseaseCards .why').textContent));
  check('한계 안내(note) 렌더', document.querySelectorAll('#noteBox .note').length, 1);
  check('팁 렌더', document.querySelectorAll('#tipsList li').length > 0);
  check('출처 표시', $('provenance').textContent.includes('추정치'));
  check('판정 후에도 에러 없음', errors.length, 0);
}

/* ═══════════════════════════════════════════════════════════
   5. 프로필 (localStorage — file://에서도 되는가)
   ═══════════════════════════════════════════════════════════ */
section('프로필 저장');
{
  setVal($('pfWeight'), '55', 'change');
  const tag = $('profileBox').querySelector('.opt-tag');
  check('배지에 반영', tag.textContent, '55kg');
  click($('judgeBtn'));
  await new Promise(r => setTimeout(r, 60));
  check('판정에 체중 반영', $('provenance').textContent.includes('체중 55kg'));
  click($('pfClear'));
}

/* ═══════════════════════════════════════════════════════════
   6. 빌드 산출물 자체 점검
   ═══════════════════════════════════════════════════════════ */
section('산출물 점검');
{
  const raw = readFileSync(DIST, 'utf8');
  const kb = Buffer.byteLength(raw) / 1024;
  check('파일 크기 300KB 미만', kb < 300);
  check('자동 생성 경고 포함', raw.includes('직접 고치지 마세요'));
  check('API 키가 섞여 들어가지 않음',
    !/AIza[0-9A-Za-z_-]{30,}|sk-[0-9A-Za-z]{20,}/.test(raw));
  check('PROXY_URL이 비어 있음 (기본 오프라인 동작)',
    /const PROXY_URL = ''/.test(raw));
  console.log(`     크기 ${kb.toFixed(0)}KB · 음식 ${document.querySelectorAll('#chips .chip').length ? JSON.parse(raw.match(/const EMBEDDED_DB = ([\s\S]*?);\n/)[1]).foods.length : '?'}종 인라인`);
}

/* ═══════════════════════════════════════════════════════════
   7. PWA 자산 — 설치·오프라인이 되려면 이게 다 있어야 한다
   ═══════════════════════════════════════════════════════════ */
section('PWA 자산');
{
  const has = f => existsSync(new URL(`./${f}`, DIST_DIR));
  for (const f of ['manifest.webmanifest', 'sw.js', 'privacy.html', '.nojekyll',
                   'icon.svg', 'icon-192.png', 'icon-512.png', 'icon-maskable.png']) {
    check(`${f} 생성됨`, has(f));
  }
  check('옛 산출물(meal-check.html) 남아 있지 않음', has('meal-check.html'), false);

  const mf = JSON.parse(readFileSync(new URL('./manifest.webmanifest', DIST_DIR), 'utf8'));
  check('manifest: start_url 상대경로 (하위 경로 배포 대응)', mf.start_url.startsWith('./'));
  check('manifest: display standalone', mf.display, 'standalone');
  check('manifest: 아이콘 3종', mf.icons.length, 3);
  check('manifest: maskable 아이콘 포함',
    mf.icons.some(i => i.purpose === 'maskable'));
  check('manifest: 설명에 의료기기 아님 명시', mf.description.includes('의료기기가 아닙니다'));
  check('manifest: lang ko', mf.lang, 'ko');

  const html2 = readFileSync(DIST, 'utf8');
  check('HTML에 manifest 링크', html2.includes('rel="manifest"'));
  check('HTML에 theme-color', html2.includes('name="theme-color"'));
  check('HTML에 apple-touch-icon', html2.includes('apple-touch-icon'));

  const sw = readFileSync(new URL('./sw.js', DIST_DIR), 'utf8');
  check('SW: 앱 셸 캐시 목록에 index.html', sw.includes("'./index.html'"));
  check('SW: 구 버전 캐시 정리', sw.includes('caches.delete'));
  check('SW: 같은 출처만 처리 (CDN 모델 캐시 안 함)',
    sw.includes('url.origin !== location.origin'));
  check('SW: network-first (갱신된 판정 룰이 바로 반영됨)',
    sw.indexOf('fetch(e.request)') < sw.indexOf('caches.match(e.request)'));
  check('SW: 버전이 박혀 있음', /const CACHE = 'meal-check-v[\d.]+'/.test(sw));
}

/* ═══════════════════════════════════════════════════════════
   8. 개인정보 처리방침 — 실제 동작과 일치하는가
   ═══════════════════════════════════════════════════════════ */
section('개인정보 처리방침');
{
  const pv = readFileSync(new URL('./privacy.html', DIST_DIR), 'utf8');
  check('어댑터별 사진 처리 차이 설명', pv.includes('기기를 떠나지 않습니다'));
  check('전송되는 모드를 명시', pv.includes('사진이 외부로 전송됩니다'));
  /* 기본값이 사진을 외부로 보내는 방식이므로, 이 사실과 끄는 방법이
     반드시 방침에 있어야 한다. 정확도를 위해 프라이버시를 내준 선택이라
     사용자가 알고 바꿀 수 있어야 한다. */
  check('기본값이 전송임을 명시', pv.includes('기본값(클라우드 AI)에서는 전송되며'));
  check('전송을 끄는 방법 안내', pv.includes('사진을 외부로 보내고 싶지 않다면'));
  check('전송처를 실명으로 밝힘', pv.includes('Pollinations'));
  check('저장 위치 localStorage 명시', pv.includes('localStorage'));
  check('삭제 방법 안내', pv.includes('입력값 지우기'));
  check('의료 고지 포함', pv.includes('의료기기가 아니며'));
  check('앱에서 링크로 연결됨', readFileSync(DIST, 'utf8').includes('./privacy.html'));
}

console.log(`\n${'═'.repeat(50)}`);
console.log(`통과 ${pass} · 실패 ${fail}`);
console.log('═'.repeat(50));
process.exit(fail ? 1 : 0);
