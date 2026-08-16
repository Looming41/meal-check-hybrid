/**
 * CLIP 어댑터 실행 검증 — node test/clip-smoke.mjs
 *
 * 왜 필요한가
 * ───────────
 * identify.js의 온디바이스 어댑터는 Transformers.js API를 문서 기억에 의존해 작성했고
 * 한 번도 실행된 적이 없다. 다음 셋 중 하나라도 틀리면 브라우저에서 즉시 깨진다.
 *
 *   1. 패키지 버전·import 경로
 *   2. 파이프라인 태스크명 ('zero-shot-image-classification')과 모델 ID
 *   3. 반환 형태 ([{label, score}] 인지, 정렬돼 있는지)
 *
 * 이 스크립트는 Node에서 같은 API를 그대로 호출해 셋을 확인한다.
 * 브라우저 전용인 WebGPU 경로는 여기서 검증되지 않는다(Node는 WASM으로 떨어진다).
 *
 * 사전 준비:
 *   npm install @huggingface/transformers@3.7.5
 * 최초 실행 시 모델을 내려받으므로 수 분이 걸릴 수 있다.
 */
import { readFileSync, existsSync } from 'node:fs';

const DB = JSON.parse(readFileSync(new URL('../data/foods-ko.json', import.meta.url), 'utf8'));
const IMG = process.argv[2];   // 선택: 실제 음식 사진 경로

let pass = 0, fail = 0;
const check = (name, a, b = true) => {
  const ok = a === b; ok ? pass++ : fail++;
  console.log(`${ok ? '  ✓' : '  ✗'} ${name}${ok ? '' : `  →  기대 ${b}, 실제 ${a}`}`);
};

console.log('── 1. 패키지 import');
let pipeline, env, RawImage;
try {
  ({ pipeline, env, RawImage } = await import('@huggingface/transformers'));
  check('import 성공', typeof pipeline, 'function');
  check('env 노출', typeof env, 'object');
  check('RawImage 노출 (브라우저에서 dataURL 처리에 사용)', typeof RawImage, 'function');
} catch (e) {
  console.log(`  ✗ import 실패: ${e.message}`);
  console.log('\n  → npm install @huggingface/transformers@3.7.5 후 다시 실행하세요.');
  process.exit(1);
}

/* ── 2. 정적 계약 검증 ─────────────────────────────────────
   모델을 내려받지 못하는 환경(오프라인·방화벽)에서도 이만큼은 확인할 수 있다.
   설치된 패키지 소스에서 태스크명·시그니처·반환 형태를 직접 읽는다. */
console.log('\n── 2. API 계약 (설치된 패키지 소스 기준, 네트워크 불필요)');
{
  const srcPath = new URL('../node_modules/@huggingface/transformers/src/pipelines.js', import.meta.url);
  if (existsSync(srcPath)) {
    const src = readFileSync(srcPath, 'utf8');
    check(`태스크명 'zero-shot-image-classification' 등록됨`,
      src.includes('"zero-shot-image-classification"'));
    check('ZeroShotImageClassificationPipeline 클래스 존재',
      src.includes('class ZeroShotImageClassificationPipeline'));
    check('호출 시그니처가 (images, candidate_labels)',
      /_call\(images,\s*candidate_labels/.test(src));
    check('반환이 { score, label } 객체 배열',
      /score:\s*x,\s*\n\s*label:\s*candidate_labels\[i\]/.test(src));
    check('점수 내림차순 정렬됨', src.includes('sort((a, b) => b.score - a.score)'));
    check('라이브러리 예제도 같은 모델(Xenova/clip-vit-base-patch32)을 씀',
      src.includes('Xenova/clip-vit-base-patch32'));
  } else {
    console.log('  · 패키지 소스를 찾지 못해 정적 검증을 건너뜁니다.');
  }
}

console.log('\n── 3. 파이프라인 생성 (최초 실행 시 모델 다운로드 ~150MB)');
const MODEL = 'Xenova/clip-vit-base-patch32';
let pipe;
const t0 = Date.now();
try {
  pipe = await pipeline('zero-shot-image-classification', MODEL, {
    progress_callback: p => {
      if (p.status === 'progress' && p.total && p.loaded === p.total) {
        console.log(`     받음: ${p.file} (${(p.total / 1e6).toFixed(1)}MB)`);
      }
    }
  });
  check(`모델 ${MODEL} 로드 성공`, typeof pipe, 'function');
  console.log(`     소요 ${((Date.now() - t0) / 1000).toFixed(1)}초`);
} catch (e) {
  /* 네트워크 차단과 API 오류를 구분한다. 둘을 뭉뚱그리면
     "코드가 틀렸다"고 잘못 결론 내린다. */
  const net = /fetch failed|EAI_AGAIN|ENOTFOUND|ECONNREFUSED|ETIMEDOUT/i.test(
    e.message + (e.cause?.code ?? ''));
  if (net) {
    console.log('  · huggingface.co에 접속할 수 없어 모델을 내려받지 못했습니다.');
    console.log('    코드 문제가 아니라 네트워크 문제입니다. 위 2단계 계약 검증은 통과했습니다.');
    console.log(`\n${'═'.repeat(50)}`);
    console.log(`통과 ${pass} · 실패 ${fail}  (모델 다운로드 구간 미실행)`);
    console.log('═'.repeat(50));
    console.log('\n※ 인터넷이 되는 환경에서 다시 실행하면 추론까지 검증됩니다.');
    process.exit(fail ? 1 : 0);
  }
  console.log(`  ✗ 파이프라인 생성 실패: ${e.message}`);
  console.log('\n  → 태스크명 또는 모델 ID가 틀렸습니다. identify.js를 고쳐야 합니다.');
  process.exit(1);
}

console.log('\n── 3. 추론 실행');
const labels = DB.foods.map(f => f.en);
console.log(`     후보 라벨 ${labels.length}개 (내장 테이블 전체)`);

/* 실제 사진이 없으면 합성 이미지로라도 API 계약을 확인한다.
   합성 이미지의 분류 '결과'는 의미가 없지만, 반환 형태는 동일하게 검증된다. */
let input;
if (IMG && existsSync(IMG)) {
  input = IMG;
  console.log(`     입력: ${IMG}`);
} else {
  const w = 224, h = 224;
  const data = new Uint8ClampedArray(w * h * 3);
  for (let i = 0; i < w * h; i++) {
    data[i * 3] = (i % w) & 255;
    data[i * 3 + 1] = ((i / w) | 0) & 255;
    data[i * 3 + 2] = 128;
  }
  input = new RawImage(data, w, h, 3);
  console.log('     입력: 합성 이미지 (실제 사진 경로를 인자로 주면 그걸 씁니다)');
}

let out;
try {
  out = await pipe(input, labels);
} catch (e) {
  console.log(`  ✗ 추론 실패: ${e.message}`);
  process.exit(1);
}

console.log('\n── 4. 반환 형태 — identify.js가 가정한 계약과 맞는가');
check('배열 반환', Array.isArray(out));
check('결과 수 = 라벨 수', out.length, labels.length);
check('항목에 label 필드', typeof out[0]?.label, 'string');
check('항목에 score 필드', typeof out[0]?.score, 'number');
check('점수 내림차순 정렬 (identify.js가 slice(0,topK)로 상위를 취함)',
  out.every((r, i) => i === 0 || out[i - 1].score >= r.score));
check('label이 내장 테이블의 en과 정확히 일치 (byClipLabel 역매핑 가능)',
  DB.foods.some(f => f.en === out[0].label));
check('점수 합이 1에 근접 (softmax)', Math.abs(out.reduce((s, r) => s + r.score, 0) - 1) < 0.01);

console.log('\n── 5. identify.js의 신뢰도 감쇠 로직 재현');
{
  const top = out.slice(0, 5);
  const margin = top.length > 1 ? top[0].score - top[1].score : top[0].score;
  const damp = Math.min(1, margin * 4);
  check('margin이 0~1 범위', margin >= 0 && margin <= 1);
  check('damp가 0~1 범위', damp >= 0 && damp <= 1);
  console.log(`     1위 ${(top[0].score * 100).toFixed(1)}% · 2위 ${(top[1].score * 100).toFixed(1)}%` +
              ` · margin ${(margin * 100).toFixed(1)}%p · 최종 신뢰도 ${(top[0].score * damp * 100).toFixed(1)}%`);
  console.log('\n     상위 5개:');
  for (const r of top) {
    const ko = DB.foods.find(f => f.en === r.label)?.ko ?? '?';
    console.log(`       ${(r.score * 100).toFixed(1).padStart(5)}%  ${ko}`);
  }
}

console.log(`\n${'═'.repeat(50)}`);
console.log(`통과 ${pass} · 실패 ${fail}`);
console.log('═'.repeat(50));
console.log('\n※ 여기서 검증된 것: 패키지·태스크명·모델·반환 계약');
console.log('※ 검증 안 된 것: WebGPU 경로, dataURL 입력, 실제 한국 음식 인식 정확도');
process.exit(fail ? 1 : 0);
