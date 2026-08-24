/**
 * 식약처 API 필드 검증 — node tools/verify-mfds.mjs <API키(Encoding)> [검색어]
 *
 * 왜 필요한가
 * ───────────
 * nutrition.js의 MFDS_PROFILES는 실제 응답을 보고 확정한 것이다. 식약처·data.go.kr은
 * 예고 없이 엔드포인트를 옮기거나(2026-08에 I0750이 openapi.foodsafetykorea.go.kr에서
 * apis.data.go.kr로 이전된 사례) 필드를 바꿀 수 있으므로, 판정이 이상해지면 가장 먼저
 * 이 스크립트로 재검증한다.
 *
 *   1. 엔드포인트가 응답하는가 (URL이 또 바뀌었을 수 있다)
 *   2. 필드명이 맞는가
 *   3. 값이 100g 기준인가 1회 제공량 기준인가 (basis) — SERVING_SIZE로 직접 확인
 *   4. 칼륨·인이 실제로 채워져 있는가 (콩팥병 판정에 필수)
 *
 * 키는 공공데이터포털(data.go.kr) 또는 식품안전나라에서 무료로 발급받는다.
 * ⚠️ "Encoding" 키를 그대로 넣을 것 — 이 키는 쿼리스트링에 들어가므로 %-인코딩된
 *    형태 그대로 써야 한다. "Decoding"(원본) 키를 쓰면 특수문자가 깨진다.
 * 이 스크립트는 키를 파일에 저장하지 않는다.
 */
const KEY = process.argv[2];
const QUERY = process.argv[3] || '된장찌개';

if (!KEY) {
  console.error('사용법: node tools/verify-mfds.mjs <API키(Encoding)> [검색어]');
  console.error('키 발급: https://www.data.go.kr 또는 https://www.foodsafetykorea.go.kr');
  process.exit(1);
}

/* I2790: 2023년에 서비스가 끝났다. 옛 경로가 죽어 있는지 확인차 한 번 찔러만 본다.
   I0750: 2026-08 현재 살아있는 서비스. data.go.kr 표준 REST 포맷으로 응답한다. */
const REQUESTS = [
  {
    svc: 'I2790',
    label: 'I2790 (구, 2023년 종료)',
    url: `http://openapi.foodsafetykorea.go.kr/api/${KEY}/I2790/json/1/1/DESC_KOR=${encodeURIComponent(QUERY)}`,
    envelope: 'legacy',
    expectDead: true
  },
  {
    svc: 'I0750',
    label: 'I0750 (신)',
    url: `https://apis.data.go.kr/1471000/FoodNtrCpntDbInfo02/getFoodNtrCpntDbInq02` +
         `?serviceKey=${KEY}&type=json&numOfRows=1&pageNo=1&FOOD_NM_KR=${encodeURIComponent(QUERY)}`,
    envelope: 'datago',
    expectDead: false
  }
];

/* nutrition.js의 매핑과 같은 내용. 여기서 실제 응답과 대조한다. */
const EXPECTED = {
  I2790: { kcal: 'NUTR_CONT1', carb_g: 'NUTR_CONT2', protein_g: 'NUTR_CONT3',
           fat_g: 'NUTR_CONT4', sugar_g: 'NUTR_CONT5', sodium_mg: 'NUTR_CONT6',
           cholesterol_mg: 'NUTR_CONT7', satfat_g: 'NUTR_CONT8', transfat_g: 'NUTR_CONT9' },
  I0750: { kcal: 'AMT_NUM1', protein_g: 'AMT_NUM3', fat_g: 'AMT_NUM4', carb_g: 'AMT_NUM6',
           sugar_g: 'AMT_NUM7', calcium_mg: 'AMT_NUM9', iron_mg: 'AMT_NUM10',
           phosphorus_mg: 'AMT_NUM11', potassium_mg: 'AMT_NUM12', sodium_mg: 'AMT_NUM13',
           cholesterol_mg: 'AMT_NUM23', satfat_g: 'AMT_NUM24', transfat_g: 'AMT_NUM25' }
};

for (const { svc, label, url, envelope, expectDead } of REQUESTS) {
  console.log(`\n${'═'.repeat(60)}`);
  console.log(`${label}  ·  검색어=${QUERY}`);
  console.log('═'.repeat(60));

  let res, body;
  try {
    res = await fetch(url);
    body = await res.text();
  } catch (e) {
    console.log(`  ✗ 요청 실패: ${e.message}`);
    continue;
  }

  if (!res.ok) {
    console.log(`  ${expectDead ? '·' : '✗'} HTTP ${res.status}` +
                (expectDead ? ' (예상대로 죽어 있음 — 정상)' : ' ⚠️ 살아있어야 하는데 죽었다. URL이 또 바뀌었을 수 있다.'));
    continue;
  }

  let data;
  try { data = JSON.parse(body); }
  catch { console.log('  ✗ JSON이 아님:', body.slice(0, 200)); continue; }

  /* 응답 껍데기별 결과 코드·행 추출 */
  let row, statusOk, statusMsg;
  if (envelope === 'datago') {
    statusOk = data?.header?.resultCode === '00';
    statusMsg = `${data?.header?.resultCode} ${data?.header?.resultMsg || ''}`;
    const items = data?.body?.items;
    row = Array.isArray(items) ? items[0] : items;
  } else {
    const result = data?.[svc]?.RESULT;
    statusOk = !result || /INFO-000/.test(result.CODE);
    statusMsg = result ? `${result.CODE}: ${result.MSG}` : '(RESULT 없음)';
    row = data?.[svc]?.row?.[0];
  }

  if (!statusOk) {
    console.log(`  ${expectDead ? '·' : '✗'} ${statusMsg}` + (expectDead ? ' (예상대로 실패 — 정상)' : ''));
    continue;
  }
  if (expectDead) console.log(`  ⚠️ 죽었을 거라 예상한 서비스가 살아났다. nutrition.js를 다시 확인하라.`);
  if (!row) { console.log('  · 결과 없음 (검색어를 바꿔 보세요)'); continue; }

  /* 1. 필드명 대조 */
  console.log('\n  [1] 필드명');
  const map = EXPECTED[svc];
  let ok = 0, miss = [];
  for (const [axis, field] of Object.entries(map)) {
    const has = row[field] !== undefined;
    if (has) ok++; else miss.push(`${axis}(${field})`);
  }
  console.log(`      맞음 ${ok}/${Object.keys(map).length}`);
  if (miss.length) console.log(`      ✗ 응답에 없는 필드: ${miss.join(', ')}`);

  /* 2. basis — SERVING_SIZE/SERVING_WT로 직접 확인 (더 이상 역산 추정 안 함) */
  console.log('\n  [2] 값의 기준 (basis)');
  const servingField = envelope === 'datago' ? 'SERVING_SIZE' : 'SERVING_WT';
  console.log(`      ${servingField}: ${row[servingField] ?? '없음'}`);
  if (row[servingField] === '100g') console.log('      → per_100g 확정');

  /* 3. 아트워터 교차검증 — kcal ≈ 단백질*4 + 지방*9 + 탄수화물*4 */
  const kcal = Number(row[map.kcal]), p = Number(row[map.protein_g]),
        f = Number(row[map.fat_g]), c = Number(row[map.carb_g]);
  if ([kcal, p, f, c].every(Number.isFinite)) {
    const calc = p * 4 + f * 9 + c * 4;
    const diff = Math.abs(calc - kcal);
    console.log(`\n  [3] 아트워터 교차검증: 표기 ${kcal}kcal vs 계산 ${calc.toFixed(1)}kcal ` +
                (diff <= kcal * 0.15 + 3 ? '✓ 필드 매핑 일치' : '⚠️ 차이가 큼 — 필드가 밀렸을 수 있다'));
  }

  /* 4. 콩팥병 판정에 필요한 축 */
  console.log('\n  [4] 콩팥병 판정에 필요한 축');
  for (const axis of ['potassium_mg', 'phosphorus_mg']) {
    const fld = map[axis];
    if (!fld) { console.log(`      · ${axis}: 이 서비스는 제공하지 않음`); continue; }
    const v = row[fld];
    console.log(`      · ${axis} (${fld}): ${v === undefined ? '필드 없음' : v === '' ? '빈 값' : v}`);
  }

  console.log(`\n  [5] ${row[envelope === 'datago' ? 'FOOD_NM_KR' : 'DESC_KOR']} 원본 (앞부분)`);
  console.log('      ' + JSON.stringify(row).slice(0, 400) + '...');
}

console.log(`\n${'═'.repeat(60)}`);
console.log('바뀐 게 있으면 js/nutrition.js의 MFDS_PROFILES를 실제 응답에 맞게 고치세요.');
console.log('═'.repeat(60));
