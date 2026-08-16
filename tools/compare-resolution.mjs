/**
 * 사진 해상도별 원가·정확도 비교 — node tools/compare-resolution.mjs <키> <사진들...>
 *
 * 왜 필요한가
 * ───────────
 * "512px로 줄이면 토큰이 절반"은 맞지만, **인식 정확도가 얼마나 떨어지는지는
 * 아무도 모른다.** 추측으로 정할 문제가 아니라 재 볼 문제다.
 * 이 스크립트는 같은 사진을 여러 해상도로 줄여 Gemini에 보내고,
 * 해상도별 토큰 사용량과 인식 결과를 나란히 보여 준다.
 *
 * 사용법
 *   node tools/compare-resolution.mjs <API키> 밥상1.jpg 밥상2.jpg ...
 *   node tools/compare-resolution.mjs <API키> ./photos/*.jpg
 *
 * 사진마다 해상도 수만큼 호출하므로 무료 한도를 빠르게 씁니다.
 * (사진 10장 × 해상도 3개 = 30회)
 *
 * 필요: npm install sharp
 */
import { readFileSync, existsSync } from 'node:fs';
import { basename } from 'node:path';

const KEY = process.argv[2];
const FILES = process.argv.slice(3).filter(f => existsSync(f));
const SIZES = [1024, 768, 512, 384];
const MODEL = 'gemini-flash-latest';

if (!KEY || FILES.length === 0) {
  console.error('사용법: node tools/compare-resolution.mjs <API키> <사진1> [사진2 ...]');
  console.error('  키 발급: https://aistudio.google.com  (무료, 신용카드 불필요)');
  console.error('  필요:   npm install sharp');
  process.exit(1);
}

let sharp;
try { sharp = (await import('sharp')).default; }
catch {
  console.error('✗ sharp가 필요합니다: npm install sharp');
  process.exit(1);
}

const PROMPT =
`이 사진에 담긴 음식을 식별하세요. 판정이나 조언은 하지 마세요.
보이는 음식마다 한국어 이름만 쉼표로 구분해 한 줄로 답하세요.
예: 흰쌀밥, 된장찌개, 김치`;

/** 한 장을 지정 크기로 줄여 Gemini에 보내고 결과와 토큰 수를 받는다 */
async function askAt(file, side) {
  const buf = await sharp(readFileSync(file))
    .resize(side, side, { fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: 85 })
    .toBuffer();

  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': KEY },
      body: JSON.stringify({
        contents: [{ parts: [
          { text: PROMPT },
          { inline_data: { mime_type: 'image/jpeg', data: buf.toString('base64') } }
        ] }],
        generationConfig: { temperature: 0.1, maxOutputTokens: 200 }
      })
    }
  );

  if (res.status === 429) return { error: '429 한도 초과' };
  if (!res.ok) return { error: `HTTP ${res.status}` };

  const data = await res.json();
  const text = (data?.candidates?.[0]?.content?.parts || []).map(p => p.text || '').join('').trim();
  const u = data?.usageMetadata || {};
  return {
    text: text.replace(/\s+/g, ' '),
    inTok: u.promptTokenCount ?? 0,
    outTok: u.candidatesTokenCount ?? 0,
    bytes: buf.length
  };
}

/* Flash-Lite 유료 단가 기준 추정. 모델·시점에 따라 달라지므로 참고값이다. */
const USD_PER_1M_IN = 0.10, USD_PER_1M_OUT = 0.40;
const cost = r => (r.inTok / 1e6) * USD_PER_1M_IN + (r.outTok / 1e6) * USD_PER_1M_OUT;

const totals = Object.fromEntries(SIZES.map(s => [s, { inTok: 0, n: 0 }]));

for (const file of FILES) {
  console.log(`\n${'═'.repeat(66)}`);
  console.log(basename(file));
  console.log('═'.repeat(66));
  console.log('  해상도  전송크기   입력토큰   추정원가        인식 결과');
  console.log('  ' + '─'.repeat(62));

  for (const side of SIZES) {
    const r = await askAt(file, side);
    if (r.error) { console.log(`  ${String(side).padStart(4)}px  ✗ ${r.error}`); continue; }
    totals[side].inTok += r.inTok;
    totals[side].n++;
    console.log(
      `  ${String(side).padStart(4)}px  ` +
      `${String(Math.round(r.bytes / 1024)).padStart(5)}KB  ` +
      `${String(r.inTok).padStart(8)}  ` +
      `$${cost(r).toFixed(6)}   ` +
      r.text.slice(0, 30)
    );
    await new Promise(t => setTimeout(t, 7000));   // 분당 한도 회피
  }
}

console.log(`\n${'═'.repeat(66)}`);
console.log('해상도별 평균 (사진 ' + FILES.length + '장)');
console.log('═'.repeat(66));
const base = totals[SIZES[0]];
for (const s of SIZES) {
  const t = totals[s];
  if (!t.n) continue;
  const avg = t.inTok / t.n;
  const baseAvg = base.n ? base.inTok / base.n : avg;
  const ratio = baseAvg ? (avg / baseAvg * 100).toFixed(0) : 100;
  const per1k = (avg / 1e6) * USD_PER_1M_IN * 1000;
  console.log(`  ${String(s).padStart(4)}px  평균 ${Math.round(avg).toString().padStart(6)}토큰` +
              `  (${String(ratio).padStart(3)}%)  1,000끼당 약 $${per1k.toFixed(2)}`);
}

console.log(`
판단 기준
  · 위 "인식 결과" 열을 눈으로 비교하세요. 해상도를 낮췄을 때
    음식 이름이 달라지거나 빠지기 시작하는 지점이 한계선입니다.
  · 토큰이 줄어도 인식이 무너지면 손해입니다. 사용자가 손으로
    고치는 시간이 늘고, 틀린 채로 판정받을 위험도 커집니다.
  · 결정한 값을 js/app.js의 MAX_IMAGE_SIDE에 넣고 npm run build 하세요.

⚠️ 원가는 Flash-Lite 단가 기준 추정입니다. 실제 청구는 모델과 시점에 따라 다릅니다.`);
