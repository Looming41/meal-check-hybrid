/**
 * build.mjs — 단일 파일 빌드
 *
 * 왜 필요한가
 * ───────────
 * 개발용 구조는 ES 모듈이라 반드시 웹서버가 있어야 한다. `file://`로 열면
 * 모듈 로딩이 CORS에 막혀 흰 화면만 나온다. 서버를 띄울 수 없는 상황
 * (그냥 더블클릭해서 보고 싶을 때, 파일 하나만 넘겨줄 때)을 위해
 * 모든 소스와 영양 테이블을 index.html 하나에 인라인한다.
 *
 * 소스를 손으로 복사하지 않고 기존 파일에서 생성하므로 원본과 절대 어긋나지 않는다.
 *
 * 실행: node build.mjs  →  dist/meal-check.html
 */
import { readFileSync, writeFileSync, mkdirSync, copyFileSync, existsSync, rmSync } from 'node:fs';

const R = p => readFileSync(new URL(p, import.meta.url), 'utf8');

/* ── 1. 소스 읽기 ─────────────────────────────────────────── */
const foodsJson = R('./data/foods-ko.json');
let rules     = R('./js/rules.js');
let nutrition = R('./js/nutrition.js');
let identify  = R('./js/identify.js');
let app       = R('./js/app.js');
let html      = R('./index.html');

/* ── 2. 모듈 문법 제거 ────────────────────────────────────── */
// export 키워드만 떼면 그대로 전역 선언이 된다
const stripExports = s => s
  .replace(/^export\s+(const|let|var|function|class|async\s+function)\s/gm, '$1 ')
  .replace(/^export\s+\{[^}]*\};?\s*$/gm, '')
  .replace(/^export\s+default\s+/gm, '');

// import 문 제거 (CDN 동적 import는 남겨야 하므로 정적 import만)
const stripImports = s => s.replace(/^import\s+[^;]+?from\s+['"][^'"]+['"];?\s*$/gm, '');

rules     = stripExports(rules);
nutrition = stripExports(stripImports(nutrition));
identify  = stripExports(stripImports(identify));
app       = stripImports(app);

/* ── 3. 파일 의존 부분을 인라인 데이터로 교체 ─────────────── */
// nutrition.js는 fetch로 영양 테이블을 읽는다. 인라인 상수로 바꾼다.
nutrition = nutrition.replace(
  /const LOCAL_DB_URL = new URL\([^)]*\);/,
  '/* 단일 파일 빌드: 영양 테이블이 아래 EMBEDDED_DB에 인라인돼 있다 */'
);
nutrition = nutrition.replace(
  /this\._ready = fetch\(LOCAL_DB_URL\)[\s\S]*?return this; \}\);/,
  `this._ready = Promise.resolve(EMBEDDED_DB)
        .then(db => { this.foods = db.foods; this.meta = db._meta; return this; });`
);

if (nutrition.includes('LOCAL_DB_URL')) {
  console.error('✗ 영양 테이블 인라인 치환 실패 — nutrition.js 구조가 바뀌었습니다.');
  process.exit(1);
}

/* ── 4. 번들 조립 ─────────────────────────────────────────── */
const banner = `/* ============================================================
   밥상 판정 — 단일 파일 빌드
   생성: ${new Date().toISOString().slice(0, 19).replace('T', ' ')}
   원본: js/rules.js · js/nutrition.js · js/identify.js · js/app.js
        + data/foods-ko.json (음식 ${JSON.parse(foodsJson).foods.length}종)

   이 파일은 자동 생성됩니다. 직접 고치지 마세요.
   고칠 곳은 위 원본 파일이고, node build.mjs로 다시 만드세요.
   ============================================================ */`;

const bundle = [
  banner,
  `const EMBEDDED_DB = ${foodsJson.trim()};`,
  '/* ── rules.js ───────────────────────────────────────────── */',
  rules,
  '/* ── nutrition.js ───────────────────────────────────────── */',
  nutrition,
  '/* ── identify.js ────────────────────────────────────────── */',
  identify,
  '/* ── app.js ─────────────────────────────────────────────── */',
  app
].join('\n\n');

/* ── 5. HTML에 삽입 ───────────────────────────────────────── */
// 원본의 module 스크립트 태그를 통째로 갈아끼운다.
// type="module"을 떼야 file://에서도 실행된다.
const before = html;
html = html.replace(
  /<script type="module" src="\.\/js\/app\.js"><\/script>/,
  `<script>\n${bundle}\n</script>`
);
if (html === before) {
  console.error('✗ 스크립트 태그 치환 실패 — index.html 구조가 바뀌었습니다.');
  process.exit(1);
}

// 단일 파일임을 알리는 안내를 헤더에 덧붙인다
html = html.replace(
  '<title>밥상 판정 — 질환 맞춤 식사 확인</title>',
  '<title>밥상 판정 — 질환 맞춤 식사 확인 (단일 파일)</title>'
);

/* ── 6. PWA 자산 주입 ─────────────────────────────────────── */
const APP_VERSION = JSON.parse(R('./package.json')).version;

html = html.replace('</head>', `  <link rel="manifest" href="./manifest.webmanifest">
  <meta name="theme-color" content="#2F6B4F">
  <meta name="description" content="질환·상태별 식이 기준에 따라 식사를 판정하는 참고 도구. 의료기기가 아닙니다.">
  <link rel="icon" href="./icon.svg" type="image/svg+xml">
  <link rel="apple-touch-icon" href="./icon-192.png">
  <meta name="apple-mobile-web-app-capable" content="yes">
  <meta name="apple-mobile-web-app-status-bar-style" content="default">
</head>`);

/* ── 7. 출력 ──────────────────────────────────────────────── */
const dist = new URL('./dist/', import.meta.url);
/* 옛 산출물이 남아 함께 배포되는 것을 막는다. 파일명이 바뀐 경우 특히 위험하다.
   삭제 권한이 없는 환경(네트워크 마운트 등)에서는 경고만 하고 진행한다. */
try {
  rmSync(dist, { recursive: true, force: true });
} catch {
  console.warn('⚠ dist/를 비우지 못했습니다. 옛 파일이 남아 있을 수 있으니 배포 전 확인하세요.');
}
mkdirSync(dist, { recursive: true });

// GitHub Pages는 index.html을 기본 문서로 쓴다
writeFileSync(new URL('./index.html', dist), html);
// Jekyll 처리를 끄지 않으면 밑줄로 시작하는 파일이 무시된다
writeFileSync(new URL('./.nojekyll', dist), '');

/* manifest — 설치형 앱 메타데이터 */
writeFileSync(new URL('./manifest.webmanifest', dist), JSON.stringify({
  name: '밥상 판정 — 질환 맞춤 식사 확인',
  short_name: '밥상 판정',
  description: '질환·상태별 식이 기준에 따라 식사를 판정하는 참고 도구입니다. 의료기기가 아닙니다.',
  start_url: './index.html',
  scope: './',
  display: 'standalone',
  orientation: 'portrait',
  background_color: '#F1F3EE',
  theme_color: '#2F6B4F',
  lang: 'ko',
  categories: ['health', 'lifestyle'],
  icons: [
    { src: './icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
    { src: './icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
    { src: './icon-maskable.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' }
  ]
}, null, 2) + '\n');

/* 서비스워커 — 앱 셸만 캐시한다.
   CLIP 모델(수백 MB)은 절대 캐시하지 않는다. 브라우저 캐시에 맡긴다. */
writeFileSync(new URL('./sw.js', dist), `/* 밥상 판정 서비스워커 — 자동 생성 (build.mjs) */
const CACHE = 'meal-check-v${APP_VERSION}';
const SHELL = ['./', './index.html', './manifest.webmanifest',
               './icon.svg', './icon-192.png', './icon-512.png', './privacy.html'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  // 버전이 오르면 옛 캐시를 지운다. 안 지우면 갱신된 판정 룰이 반영되지 않는다.
  e.waitUntil(
    caches.keys()
      .then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  // 같은 출처의 GET만 다룬다. CDN 모델·프록시 요청은 건드리지 않는다.
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;

  // 앱 셸은 network-first: 새 판정 룰이 배포되면 바로 받도록.
  // 오프라인이면 캐시로 떨어진다.
  e.respondWith(
    fetch(e.request)
      .then(res => {
        const copy = res.clone();
        caches.open(CACHE).then(c => c.put(e.request, copy));
        return res;
      })
      .catch(() => caches.match(e.request).then(r => r || caches.match('./index.html')))
  );
});
`);

/* 아이콘 — 밥그릇 위에 체크 표시 */
const iconSvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
  <rect width="512" height="512" rx="96" fill="#2F6B4F"/>
  <path d="M116 232h280c0 84-63 140-140 140s-140-56-140-140z" fill="#F1F3EE"/>
  <rect x="96" y="212" width="320" height="26" rx="13" fill="#F1F3EE"/>
  <path d="M196 292l40 40 84-84" fill="none" stroke="#2F6B4F"
        stroke-width="30" stroke-linecap="round" stroke-linejoin="round"/>
  <rect x="150" y="392" width="212" height="22" rx="11" fill="#F1F3EE" opacity=".85"/>
</svg>`;
writeFileSync(new URL('./icon.svg', dist), iconSvg);

/* PNG 아이콘은 tools/make-icons.py가 미리 만들어 둔 것을 복사한다.
   빌드가 Python·이미지 라이브러리에 의존하지 않게 하기 위해서다. */
const icons = ['icon-192.png', 'icon-512.png', 'icon-maskable.png'];
const missingIcons = [];
for (const f of icons) {
  const src = new URL(`./assets/${f}`, import.meta.url);
  if (!existsSync(src)) { missingIcons.push(f); continue; }
  copyFileSync(src, new URL(`./${f}`, dist));
}
if (missingIcons.length) {
  console.error(`✗ 아이콘 없음: ${missingIcons.join(', ')}`);
  console.error('  → python3 tools/make-icons.py 를 먼저 실행하세요.');
  process.exit(1);
}

/* 개인정보 처리방침 */
copyFileSync(new URL('./privacy.html', import.meta.url), new URL('./privacy.html', dist));

const kb = (Buffer.byteLength(html) / 1024).toFixed(0);
console.log(`dist/index.html 생성 (${kb}KB)`);
console.log('dist/  manifest.webmanifest · sw.js · privacy.html · icon.svg · PNG 3종');

/* ── 7. 자체 점검 ─────────────────────────────────────────── */
const checks = [
  ['모듈 import 잔존 없음', !/^import\s/m.test(bundle)],
  ['export 키워드 잔존 없음', !/^export\s/m.test(bundle)],
  ['import.meta 잔존 없음', !bundle.includes('import.meta')],
  ['type="module" 제거됨', !html.includes('type="module"')],
  ['외부 js 참조 없음', !/src="\.\/js\//.test(html)],
  ['영양 데이터 인라인됨', html.includes('EMBEDDED_DB')],
  ['CDN 동적 import는 유지됨', bundle.includes('cdn.jsdelivr.net')]
];
let bad = 0;
for (const [name, ok] of checks) {
  console.log(`  ${ok ? '✓' : '✗'} ${name}`);
  if (!ok) bad++;
}
process.exit(bad ? 1 : 0);
