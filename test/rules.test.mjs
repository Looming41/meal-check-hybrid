/**
 * 룰 엔진 검증 — node test/rules.test.mjs
 *
 * AI가 없어도 판정이 결정적으로 나오는지, 그리고 임상적으로 중요한
 * 경계 케이스가 의도대로 걸러지는지 확인한다.
 */
import { readFileSync } from 'node:fs';
import { evaluate, sumMeal, DISEASE_BY_ID } from '../js/rules.js';

const DB = JSON.parse(readFileSync(new URL('../data/foods-ko.json', import.meta.url), 'utf8'));
const byId = Object.fromEntries(DB.foods.map(f => [f.id, f]));
const meal = (...ids) => sumMeal(ids.map(id => {
  const [fid, p] = String(id).split('@');
  if (!byId[fid]) throw new Error(`음식 없음: ${fid}`);
  return { food: byId[fid], portion: p ? Number(p) : 1 };
}));

let pass = 0, fail = 0;
function check(name, actual, expected) {
  const ok = actual === expected;
  ok ? pass++ : fail++;
  console.log(`${ok ? '  ✓' : '  ✗'} ${name}${ok ? '' : `  →  기대 ${expected}, 실제 ${actual}`}`);
}
function section(t) { console.log(`\n── ${t}`); }
const v = (res, id) => res.byDisease.find(r => r.id === id).verdict;

/* ═══════════════════════════════════════════════════════════
   1. 결정성 — 같은 입력이면 항상 같은 출력
   ═══════════════════════════════════════════════════════════ */
section('결정성');
{
  const m = meal('rice_white', 'kimchi_jjigae', 'kimchi');
  const a = JSON.stringify(evaluate(m, ['htn', 'dm']));
  const b = JSON.stringify(evaluate(m, ['htn', 'dm']));
  check('동일 입력 10회 반복 시 결과 동일', a === b && [...Array(10)]
    .every(() => JSON.stringify(evaluate(m, ['htn', 'dm'])) === a), true);
}

/* ═══════════════════════════════════════════════════════════
   2. 기본 판정 — 상식과 어긋나지 않는가
   ═══════════════════════════════════════════════════════════ */
section('기본 판정');
{
  // 흰쌀밥 + 미역국 + 두부: 순한 밥상
  const mild = meal('rice_white', 'dubu_saengsik', 'sigeumchi_namul');
  check('순한 밥상은 고혈압에 good/caution', ['good', 'caution'].includes(v(evaluate(mild, ['htn']), 'htn')), true);

  // 짬뽕: 나트륨 3000mg
  check('짬뽕은 고혈압 avoid', v(evaluate(meal('jjamppong'), ['htn']), 'htn'), 'avoid');
  check('짬뽕은 심부전 avoid', v(evaluate(meal('jjamppong'), ['hf']), 'hf'), 'avoid');

  // 흰쌀밥 한 공기만으로는 당뇨 주의가 뜨면 안 된다 (실용성 검증)
  check('흰쌀밥 한 공기는 당뇨 good (탄수 69g)', v(evaluate(meal('rice_white'), ['dm']), 'dm'), 'good');
  check('짜장면은 당뇨 avoid (탄수 110g)', v(evaluate(meal('jajangmyeon'), ['dm']), 'dm'), 'avoid');

  // 삼겹살: 포화지방 19g
  check('삼겹살은 이상지질혈증 avoid', v(evaluate(meal('samgyeopsal'), ['lipid']), 'lipid'), 'avoid');
  check('삼겹살은 심근경색 avoid', v(evaluate(meal('samgyeopsal'), ['cad']), 'cad'), 'avoid');
  check('생선회는 이상지질혈증 good', v(evaluate(meal('saengseonhoe'), ['lipid']), 'lipid'), 'good');
}

/* ═══════════════════════════════════════════════════════════
   3. 칼륨 충돌 — 이 앱의 핵심 검증 포인트
   바나나는 고혈압에 좋고 만성콩팥병에 나쁘다.
   ═══════════════════════════════════════════════════════════ */
section('칼륨 충돌 (고혈압 vs 만성콩팥병)');
{
  const banana = meal('banana');

  const htnOnly = evaluate(banana, ['htn']);
  check('바나나 단독 + 고혈압 → good', v(htnOnly, 'htn'), 'good');
  check('바나나 + 고혈압에 칼륨 긍정 코멘트 표시', htnOnly.byDisease[0].positives.length > 0, true);

  const ckdOnly = evaluate(banana, ['ckd']);
  check('바나나 + 만성콩팥병 → caution (칼륨 430mg)', v(ckdOnly, 'ckd'), 'caution');

  const both = evaluate(banana, ['htn', 'ckd']);
  check('둘 다 선택 시 충돌 감지됨', both.conflicts.some(c => c.id === 'potassium'), true);
  check('둘 다 선택 시 overall은 콩팥병 기준(caution)', both.overall, 'caution');
  check('충돌 시 고혈압 칼륨 칭찬이 억제됨',
    both.byDisease.find(r => r.id === 'htn').positives.length, 0);

  // 감자는 칼륨 620mg — 더 극단적인 케이스
  const potato = meal('potato');
  check('감자 + 만성콩팥병 → caution 이상', ['caution', 'avoid'].includes(v(evaluate(potato, ['ckd']), 'ckd')), true);
}

/* ═══════════════════════════════════════════════════════════
   4. 연하곤란 — 영양소가 아닌 질감으로만 판정
   ═══════════════════════════════════════════════════════════ */
section('연하곤란 (질감 판정)');
{
  check('떡 → avoid (질식 위험)', v(evaluate(meal('tteok'), ['dysph']), 'dysph'), 'avoid');
  check('떡볶이 → avoid', v(evaluate(meal('tteokbokki'), ['dysph']), 'dysph'), 'avoid');
  check('견과류 → avoid (딱딱함)', v(evaluate(meal('nuts'), ['dysph']), 'dysph'), 'avoid');
  check('죽 → good', v(evaluate(meal('juk'), ['dysph']), 'dysph'), 'good');
  check('계란찜 → good', v(evaluate(meal('gyeran_jjim'), ['dysph']), 'dysph'), 'good');
  check('된장찌개 → caution (국물+건더기 혼합)', v(evaluate(meal('doenjang_jjigae'), ['dysph']), 'dysph'), 'caution');
  check('우유 → caution (묽은 액체가 오히려 위험)', v(evaluate(meal('milk'), ['dysph']), 'dysph'), 'caution');
  check('고구마 → caution (퍽퍽함)', v(evaluate(meal('sweet_potato'), ['dysph']), 'dysph'), 'caution');

  // 떡은 영양소만 보면 문제없다. 질감 룰이 없으면 놓친다.
  check('떡은 고혈압 기준으로는 good (질감 룰의 필요성)', v(evaluate(meal('tteok'), ['htn']), 'htn'), 'good');
}

/* ═══════════════════════════════════════════════════════════
   5. 와파린 — "금지"가 아니라 "일관성"
   ═══════════════════════════════════════════════════════════ */
section('와파린 (비타민K 일관성)');
{
  const spinach = evaluate(meal('sigeumchi_namul'), ['warf']);
  check('시금치나물 → caution 이상 (비타민K 290µg)', ['caution', 'avoid'].includes(v(spinach, 'warf')), true);
  check('와파린 이유 문구에 "유지" 또는 "일정" 포함',
    /유지|일정|평소/.test(spinach.byDisease[0].reason), true);

  // 와파린은 overall을 끌어내리지 않아야 한다
  const mix = evaluate(meal('sigeumchi_namul', 'rice_white'), ['warf', 'htn']);
  check('와파린 avoid여도 overall은 다른 질환 기준을 따름',
    mix.overall !== 'avoid' || v(mix, 'htn') === 'avoid', true);
  check('와파린 + 타질환 조합 시 설명 충돌 안내 표시',
    mix.conflicts.some(c => c.id === 'vitk'), true);
}

/* ═══════════════════════════════════════════════════════════
   6. 통풍 — 퓨린과 알코올
   ═══════════════════════════════════════════════════════════ */
section('통풍');
{
  check('소주 → avoid (알코올 즉시)', v(evaluate(meal('soju'), ['gout']), 'gout'), 'avoid');
  check('맥주 → avoid', v(evaluate(meal('beer'), ['gout']), 'gout'), 'avoid');
  check('간전(내장) → avoid (퓨린 300mg)', v(evaluate(meal('gan_jeon'), ['gout']), 'gout'), 'avoid');
  check('고등어구이 → avoid (퓨린 230mg)', v(evaluate(meal('godeungeo_gui'), ['gout']), 'gout'), 'avoid');
  check('흰쌀밥 → good', v(evaluate(meal('rice_white'), ['gout']), 'gout'), 'good');
  check('식혜 → caution (과당 28g)', ['caution', 'avoid'].includes(v(evaluate(meal('sikhye'), ['gout']), 'gout')), true);
}

/* ═══════════════════════════════════════════════════════════
   7. 역류성식도염 — 자극성 플래그
   ═══════════════════════════════════════════════════════════ */
section('위염·역류성식도염');
{
  check('김치찌개 → avoid (매움+신맛)', v(evaluate(meal('kimchi_jjigae'), ['gerd']), 'gerd'), 'avoid');
  check('커피 → caution (카페인)', v(evaluate(meal('coffee'), ['gerd']), 'gerd'), 'caution');
  check('죽 → good', v(evaluate(meal('juk'), ['gerd']), 'gerd'), 'good');
  check('치킨 → avoid (기름+매움+지방 34g)', v(evaluate(meal('chicken_fried'), ['gerd']), 'gerd'), 'avoid');
}

/* ═══════════════════════════════════════════════════════════
   8. 다중 선택 — 실제 어르신은 보통 3~4개를 고른다
   ═══════════════════════════════════════════════════════════ */
section('다중 질환 (실사용 시나리오)');
{
  // 고혈압 + 당뇨 + 이상지질혈증: 가장 흔한 조합
  const common = ['htn', 'dm', 'lipid'];
  const r1 = evaluate(meal('rice_white', 'doenjang_jjigae', 'kimchi', 'godeungeo_gui'), common);
  check('한식 정식 3질환 판정에 전 질환 포함', r1.byDisease.length, 3);
  check('overall이 최악값과 일치',
    r1.overall, r1.byDisease.reduce((a, b) => ['good','caution','avoid'].indexOf(a) >= ['good','caution','avoid'].indexOf(b.verdict) ? a : b.verdict, 'good'));

  // 15개 전부 선택해도 터지지 않아야 한다
  const all = Object.keys(DISEASE_BY_ID);
  const r2 = evaluate(meal('rice_white', 'kimchi_jjigae', 'tteok', 'soju'), all);
  check('전체 선택 시 전체 결과 반환', r2.byDisease.length, all.length);
  check('질환·상태 15종 등록됨', all.length, 15);
  check('전체 선택 시 tips 최대 4개', r2.tips.length <= 4, true);
  check('모든 결과에 reason 문자열 존재', r2.byDisease.every(x => typeof x.reason === 'string' && x.reason.length > 0), true);
  check('모든 트리거에 근거(rationale) 존재',
    r2.byDisease.every(x => x.triggers.every(t => typeof t.rationale === 'string' && t.rationale.startsWith('RATIONALE'))), true);
}

/* ═══════════════════════════════════════════════════════════
   9. 양 조절 — portion이 판정을 바꾸는가
   ═══════════════════════════════════════════════════════════ */
section('제공량 조절');
{
  const full = evaluate(meal('jjamppong'), ['htn']);
  const half = evaluate(meal('jjamppong@0.5'), ['htn']);
  check('짬뽕 1인분 → avoid', v(full, 'htn'), 'avoid');
  check('짬뽕 반 그릇 → avoid 유지 (나트륨 1500mg)', v(half, 'htn'), 'avoid');
  const quarter = evaluate(meal('jjamppong@0.25'), ['htn']);
  check('짬뽕 4분의 1 → caution으로 완화', v(quarter, 'htn'), 'caution');
}

/* ═══════════════════════════════════════════════════════════
   10. 입력 방어 — 데이터가 비어도 죽지 않아야 한다
   ═══════════════════════════════════════════════════════════ */
section('입력 방어');
{
  check('빈 식사도 예외 없이 처리', evaluate({}, ['htn', 'ckd']).byDisease.length, 2);
  check('없는 질환 id는 무시', evaluate(meal('rice_white'), ['htn', 'nonexistent']).byDisease.length, 1);
  check('빈 질환 목록 → overall good', evaluate(meal('jjamppong'), []).overall, 'good');
  check('일부 영양소 누락 시 0으로 처리',
    evaluate({ sodium_mg: 1000 }, ['ckd']).byDisease[0].verdict, 'avoid');
}

/* ═══════════════════════════════════════════════════════════
   11. 데이터 무결성
   ═══════════════════════════════════════════════════════════ */
section('데이터 무결성');
{
  const required = ['id','ko','en','serving_g','sodium_mg','potassium_mg','phosphorus_mg',
                    'purine_mg','vitk_ug','texture','src'];
  const missing = DB.foods.filter(f => required.some(k => f[k] === undefined));
  check('모든 음식에 필수 필드 존재', missing.length, 0);
  if (missing.length) console.log('     누락:', missing.map(f => f.id).join(', '));

  const dupes = DB.foods.map(f => f.id).filter((x, i, a) => a.indexOf(x) !== i);
  check('음식 id 중복 없음', dupes.length, 0);

  const validTex = ['soft','normal','hard','dry','sticky','liquid','mixed'];
  check('texture 값이 모두 유효', DB.foods.every(f => validTex.includes(f.texture)), true);

  const validIrr = ['spicy','acidic','greasy','caffeine','salty'];
  check('irritant 값이 모두 유효', DB.foods.every(f => (f.irritant||[]).every(i => validIrr.includes(i))), true);

  const negatives = DB.foods.filter(f => ['sodium_mg','potassium_mg','purine_mg','kcal']
    .some(k => Number(f[k]) < 0));
  check('음수 영양값 없음', negatives.length, 0);

  console.log(`     수록 음식 ${DB.foods.length}종 / 문헌추정(lit) ${DB.foods.filter(f=>f.src==='lit').length}종`);
}

/* ═══════════════════════════════════════════════════════════
   12. 임신·수유 — 전 연령 대응으로 추가된 상태
   ═══════════════════════════════════════════════════════════ */
section('임신·수유');
{
  check('소주 → avoid (안전한 하한 없음)', v(evaluate(meal('soju'), ['preg']), 'preg'), 'avoid');
  check('맥주 → avoid', v(evaluate(meal('beer'), ['preg']), 'preg'), 'avoid');
  // 소간 레티놀 8000µg = 임신 중 상한 3000µg의 두 배 이상
  check('간전 → avoid (레티놀 8000µg)', v(evaluate(meal('gan_jeon'), ['preg']), 'preg'), 'avoid');
  check('커피 1잔 → caution (카페인 100mg)', v(evaluate(meal('coffee'), ['preg']), 'preg'), 'caution');
  check('커피 2잔 → avoid (200mg 초과)', v(evaluate(meal('coffee@2'), ['preg']), 'preg'), 'avoid');
  check('생선회 → caution 이상 (생식품+수은)',
    ['caution', 'avoid'].includes(v(evaluate(meal('saengseonhoe'), ['preg']), 'preg')), true);
  check('미역국 → avoid (요오드 2500µg, 산후 관습의 함정)',
    v(evaluate(meal('miyeokguk'), ['preg']), 'preg'), 'avoid');
  check('흰쌀밥+두부 → good', v(evaluate(meal('rice_white', 'dubu_saengsik'), ['preg']), 'preg'), 'good');

  // 시금치는 비타민A가 많아 보이지만 전량 베타카로틴이라 경고가 뜨면 안 된다
  check('시금치나물 → good (베타카로틴은 레티놀 상한과 무관)',
    v(evaluate(meal('sigeumchi_namul'), ['preg']), 'preg'), 'good');
  check('철분 많은 식사에 긍정 코멘트',
    evaluate(meal('bulgogi'), ['preg']).byDisease[0].positives.length > 0, true);
}

/* ═══════════════════════════════════════════════════════════
   13. 빈혈 — "나쁜 음식"이 아니라 "나쁜 조합"
   ═══════════════════════════════════════════════════════════ */
section('빈혈');
{
  check('커피와 함께 → caution (철 흡수 억제)',
    v(evaluate(meal('bulgogi', 'coffee'), ['anemia']), 'anemia'), 'caution');
  check('불고기 단독 → good', v(evaluate(meal('bulgogi'), ['anemia']), 'anemia'), 'good');
  check('철분 급원에 긍정 코멘트',
    evaluate(meal('gan_jeon'), ['anemia']).byDisease[0].positives.length > 0, true);
  check('철분 없는 식사에 보충 안내',
    evaluate(meal('rice_white'), ['anemia']).byDisease[0].positives.some(p => p.includes('철분')), true);
  check('우유+멸치 → caution (칼슘 과다로 철 흡수 방해)',
    v(evaluate(meal('milk', 'myeolchi_bokkeum'), ['anemia']), 'anemia'), 'caution');
}

/* ═══════════════════════════════════════════════════════════
   14. 갑상선 — 한국 식단의 요오드 과잉
   ═══════════════════════════════════════════════════════════ */
section('갑상선기능이상');
{
  check('미역국 → avoid (요오드 2500µg)', v(evaluate(meal('miyeokguk'), ['thyroid']), 'thyroid'), 'avoid');
  check('김 → caution (요오드 300µg)', v(evaluate(meal('gim'), ['thyroid']), 'thyroid'), 'caution');
  check('흰쌀밥 → good', v(evaluate(meal('rice_white'), ['thyroid']), 'thyroid'), 'good');
  // 십자화과는 정보 제공 수준이지 금지가 아니다
  const bro = evaluate(meal('brocolli'), ['thyroid']);
  check('브로콜리 → caution 수준까지만', v(bro, 'thyroid'), 'caution');
  check('십자화과 문구가 "끊을 필요 없다"고 안내',
    /끊을 필요는 없/.test(bro.byDisease[0].reason), true);
  check('갑상선에 한계 안내(note) 존재',
    evaluate(meal('gim'), ['thyroid']).notes.length, 1);
}

/* ═══════════════════════════════════════════════════════════
   15. 지방간·비만
   ═══════════════════════════════════════════════════════════ */
section('지방간·비만');
{
  check('삼계탕 → avoid (800kcal)', v(evaluate(meal('samgyetang'), ['nafld']), 'nafld'), 'avoid');
  check('소주 → avoid (알코올)', v(evaluate(meal('soju'), ['nafld']), 'nafld'), 'avoid');
  check('식혜 → caution 이상 (당류 28g)',
    ['caution', 'avoid'].includes(v(evaluate(meal('sikhye'), ['nafld']), 'nafld')), true);
  check('라면 → caution 이상 (가공식품+포화지방 8g)',
    ['caution', 'avoid'].includes(v(evaluate(meal('ramyeon'), ['nafld']), 'nafld')), true);
  check('죽 → good', v(evaluate(meal('juk'), ['nafld']), 'nafld'), 'good');
}

/* ═══════════════════════════════════════════════════════════
   16. 프로필 보정 — 전부 선택 입력이다
   ═══════════════════════════════════════════════════════════ */
section('프로필 보정 (선택 입력)');
{
  const m = meal('bulgogi');   // 단백질 27g

  // 미입력이면 60kg 가정
  const none = evaluate(m, ['ckd']);
  check('프로필 미입력도 정상 판정', none.byDisease.length, 1);
  check('미입력 시 기본 체중 60kg', none.profile.weightKg, 60);
  check('미입력 시 weightGiven false', none.profile.weightGiven, false);

  /* 체중 비례: 단백질 caution 0.35g/kg, avoid 0.5g/kg.
     불고기는 나트륨도 850mg이라 CKD 종합 판정은 나트륨에 걸린다.
     체중 보정 효과만 보려면 단백질 트리거 하나만 떼어 봐야 한다. */
  const proteinLevel = (w) => {
    const r = evaluate(m, ['ckd'], { weightKg: w });
    return r.byDisease[0].triggers.find(t => t.axis === 'protein_g')?.level ?? 'good';
  };
  check('45kg → 단백질 27g은 avoid', proteinLevel(45), 'avoid');   // 임계 15.8 / 22.5
  check('60kg → 단백질 27g은 caution', proteinLevel(60), 'caution'); // 임계 21 / 30
  check('90kg → 같은 27g이 good', proteinLevel(90), 'good');       // 임계 31.5 / 45
  check('체중 보정이 근거에 표시됨',
    evaluate(m, ['ckd'], { weightKg: 45 }).byDisease[0].triggers
      .some(t => t.scaledBy?.includes('45kg')), true);

  // 연령 보정
  const adult = evaluate(meal('ramyeon'), ['htn']);
  const child = evaluate(meal('ramyeon'), ['htn'], { ageYears: 8 });
  check('성인 라면 → avoid (나트륨 1800mg)', v(adult, 'htn'), 'avoid');
  check('8세도 avoid, 임계값은 더 낮게 조정됨',
    child.byDisease[0].triggers[0].threshold < adult.byDisease[0].triggers[0].threshold, true);

  const mildMeal = meal('doenjang_jjigae@0.5');   // 나트륨 575mg
  check('성인 → 된장찌개 반 그릇은 caution', v(evaluate(mildMeal, ['htn']), 'htn'), 'caution');
  check('5세 → 같은 양이 avoid로 올라감',
    v(evaluate(mildMeal, ['htn'], { ageYears: 5 }), 'htn'), 'avoid');
  check('연령 보정이 근거에 표시됨',
    evaluate(mildMeal, ['htn'], { ageYears: 5 }).byDisease[0].triggers.some(t => t.scaledBy?.includes('5세')), true);

  // 잘못된 입력은 무시하고 기본값으로
  check('음수 체중은 무시', evaluate(m, ['ckd'], { weightKg: -10 }).profile.weightKg, 60);
  check('문자열 나이는 무시', evaluate(m, ['ckd'], { ageYears: 'abc' }).profile.ageYears, null);
  check('빈 프로필 객체 허용', evaluate(m, ['ckd'], {}).profile.weightGiven, false);
}

/* ═══════════════════════════════════════════════════════════
   17. 신규 충돌 규칙
   ═══════════════════════════════════════════════════════════ */
section('신규 충돌');
{
  const ic = evaluate(meal('milk', 'bulgogi'), ['anemia', 'osteo']);
  check('빈혈+골다공증 충돌 감지', ic.conflicts.some(c => c.id === 'iron_calcium'), true);
  check('충돌 문구가 "끊으라"가 아니라 "나누라"',
    ic.conflicts.find(c => c.id === 'iron_calcium').msg.includes('시간을 나누라'), true);

  const ip = evaluate(meal('miyeokguk'), ['preg', 'thyroid']);
  check('임신+갑상선 요오드 충돌 감지', ip.conflicts.some(c => c.id === 'iodine_preg'), true);
  check('임신+갑상선은 갑상선 기준 우선',
    ip.conflicts.find(c => c.id === 'iodine_preg').winner, 'thyroid');

  const pe = evaluate(meal('samgyetang'), ['preg', 'nafld']);
  check('임신+지방간 충돌 감지', pe.conflicts.some(c => c.id === 'preg_energy'), true);
  check('임신 중 임의 감량 금지 안내',
    pe.conflicts.find(c => c.id === 'preg_energy').msg.includes('줄이지 마'), true);
}

/* ═══════════════════════════════════════════════════════════
   18. 신규 축 데이터 무결성
   ═══════════════════════════════════════════════════════════ */
section('신규 축 데이터');
{
  const newAxes = ['iron_mg', 'iodine_ug', 'caffeine_mg', 'vita_ug'];
  check('모든 음식에 신규 축 존재',
    DB.foods.every(f => newAxes.every(a => typeof f[a] === 'number')), true);
  check('모든 음식에 tags 배열 존재', DB.foods.every(f => Array.isArray(f.tags)), true);

  const validTags = ['raw', 'high_mercury', 'cruciferous', 'organ', 'processed'];
  check('tags 값이 모두 유효', DB.foods.every(f => f.tags.every(t => validTags.includes(t))), true);
  check('신규 축에 음수 없음',
    DB.foods.every(f => newAxes.every(a => f[a] >= 0)), true);

  // 레티놀은 동물성만. 식물성 식품에 레티놀이 잡히면 정의 위반이다.
  const plantOnly = ['sigeumchi_namul', 'brocolli', 'cabbage_ssam', 'banana', 'apple',
                     'sweet_potato', 'potato', 'kongnamul_muchim'];
  check('식물성 식품의 레티놀은 0 (베타카로틴 제외 원칙)',
    plantOnly.every(id => byId[id].vita_ug === 0), true);

  /* 카페인 축을 넣어 두고 급원이 커피뿐이면 젊은 층 판정이 사실상 작동하지 않는다.
     확장 후 실제 급원이 여럿인지 확인한다. */
  const cafSources = DB.foods.filter(f => f.caffeine_mg > 0);
  check('카페인 급원이 5종 이상', cafSources.length >= 5, true);
  check('에너지드링크가 카페인 급원에 포함',
    cafSources.some(f => f.id === 'energy_drink'), true);
  check('아메리카노가 믹스커피보다 카페인 높음',
    byId.americano.caffeine_mg > byId.coffee.caffeine_mg, true);

  const top = axis => DB.foods.slice().sort((a, b) => b[axis] - a[axis])[0];
  console.log(`     요오드 최고: ${top('iodine_ug').ko} (${top('iodine_ug').iodine_ug}µg)`);
  console.log(`     레티놀 최고: ${top('vita_ug').ko} (${top('vita_ug').vita_ug}µg)`);
  console.log(`     카페인 최고: ${top('caffeine_mg').ko} (${top('caffeine_mg').caffeine_mg}mg)`);
  console.log(`     나트륨 최고: ${top('sodium_mg').ko} (${top('sodium_mg').sodium_mg}mg)`);
}

/* ═══════════════════════════════════════════════════════════
   19. 확장된 음식 — 젊은 층 식단이 룰에 제대로 걸리는가
   ═══════════════════════════════════════════════════════════ */
section('전 연령 식단 판정');
{
  // 카페인: 축은 있었지만 급원이 커피뿐이던 구멍을 메운 결과
  check('에너지드링크 → 임신 caution (카페인 80mg)',
    v(evaluate(meal('energy_drink'), ['preg']), 'preg'), 'caution');
  check('아메리카노 → 임신 caution (카페인 150mg)',
    v(evaluate(meal('americano'), ['preg']), 'preg'), 'caution');
  check('아메리카노 2잔 → 임신 avoid (300mg, 하루 권장 초과)',
    v(evaluate(meal('americano@2'), ['preg']), 'preg'), 'avoid');
  check('버블티 → 지방간 avoid (당류 52g)', v(evaluate(meal('bubble_tea'), ['nafld']), 'nafld'), 'avoid');
  check('콜라 → 당뇨 avoid (당류 39g)', v(evaluate(meal('cola'), ['dm']), 'dm'), 'avoid');
  check('에너지드링크 → 빈혈 caution (철 흡수 방해)',
    v(evaluate(meal('energy_drink'), ['anemia']), 'anemia'), 'caution');

  // 다시마는 이 테이블에서 요오드가 가장 극단적이다
  check('다시마 → 갑상선 avoid (요오드 5400µg)',
    v(evaluate(meal('dasima'), ['thyroid']), 'thyroid'), 'avoid');
  check('김자반 → 갑상선 avoid (요오드 600µg)',
    ['caution', 'avoid'].includes(v(evaluate(meal('gimjaban'), ['thyroid']), 'thyroid')), true);

  // 젊은 층 대표 식단
  check('마라탕 → 고혈압 avoid (나트륨 3200mg)', v(evaluate(meal('maratang'), ['htn']), 'htn'), 'avoid');
  check('부대찌개 → 고혈압 avoid', v(evaluate(meal('budae_jjigae'), ['htn']), 'htn'), 'avoid');
  check('피자 → 이상지질혈증 avoid (포화지방 14g)', v(evaluate(meal('pizza'), ['lipid']), 'lipid'), 'avoid');
  check('크림파스타 → 심근경색 avoid (포화지방 20g)', v(evaluate(meal('pasta_cream'), ['cad']), 'cad'), 'avoid');
  check('샐러드 → 고혈압 good', v(evaluate(meal('salad_green'), ['htn']), 'htn'), 'good');
  check('닭가슴살 → 지방간 good', v(evaluate(meal('chicken_breast'), ['nafld']), 'nafld'), 'good');

  // 단백질 급원이 콩팥병에 걸리는지 (프로틴쉐이크는 30g)
  check('프로틴쉐이크 → 콩팥병 avoid (단백질 30g)',
    v(evaluate(meal('protein_shake'), ['ckd']), 'ckd'), 'avoid');
  check('닭가슴살 → 콩팥병 avoid (단백질 40g)',
    v(evaluate(meal('chicken_breast'), ['ckd']), 'ckd'), 'avoid');

  // 임신 관련 신규
  check('육회 → 임신 caution (생식품)', v(evaluate(meal('yukhoe'), ['preg']), 'preg'), 'caution');
  check('초밥 → 임신 caution (생식품)', v(evaluate(meal('sushi'), ['preg']), 'preg'), 'caution');
  check('참치캔 → 임신 caution (수은)', v(evaluate(meal('tuna_can'), ['preg']), 'preg'), 'caution');
  check('막걸리 → 임신 avoid', v(evaluate(meal('makgeolli'), ['preg']), 'preg'), 'avoid');
  check('와인 → 임신 avoid', v(evaluate(meal('wine'), ['preg']), 'preg'), 'avoid');
  /* 내장류라고 다 같지 않다. 소간(8,000µg)은 상한을 넘지만 곱창(900µg)은 넘지 않는다.
     같은 organ 태그라도 레티놀 수치로 갈리는 것이 정상이다. */
  check('곱창 → 임신 caution (나트륨. 레티놀 900µg은 상한 미만)',
    v(evaluate(meal('gopchang'), ['preg']), 'preg'), 'caution');
  check('곱창은 레티놀 트리거가 걸리지 않음',
    evaluate(meal('gopchang'), ['preg']).byDisease[0].triggers.some(t => t.axis === 'vita_ug'), false);
  check('간전은 레티놀 트리거가 걸림',
    evaluate(meal('gan_jeon'), ['preg']).byDisease[0].triggers.some(t => t.axis === 'vita_ug'), true);

  // 연하곤란 — 새 음식의 질감
  check('팝콘 → 연하곤란 avoid (딱딱함)', v(evaluate(meal('popcorn'), ['dysph']), 'dysph'), 'avoid');
  check('아이스크림 → 연하곤란 good', v(evaluate(meal('ice_cream'), ['dysph']), 'dysph'), 'good');
  check('라볶이 → 연하곤란 avoid (떡)', v(evaluate(meal('rabokki'), ['dysph']), 'dysph'), 'avoid');

  // 통풍
  check('곱창 → 통풍 avoid (퓨린 260mg)', v(evaluate(meal('gopchang'), ['gout']), 'gout'), 'avoid');
  check('감자탕 → 통풍 avoid (퓨린 260mg)', v(evaluate(meal('gamjatang'), ['gout']), 'gout'), 'avoid');
  check('맥주 대체: 막걸리도 통풍 avoid', v(evaluate(meal('makgeolli'), ['gout']), 'gout'), 'avoid');
}

console.log(`\n${'═'.repeat(50)}`);
console.log(`통과 ${pass} · 실패 ${fail}`);
console.log('═'.repeat(50));
process.exit(fail ? 1 : 0);
