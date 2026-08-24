/**
 * rules.js — 지병별 식사 판정 룰 엔진
 *
 * 설계 원칙
 * ─────────
 * 1. 결정적(deterministic)이다. 같은 입력이면 항상 같은 출력이 나온다.
 *    AI가 판정에 관여하지 않으므로 "왜 이 결과가 나왔는지" 항상 추적 가능하다.
 * 2. 모든 임계값에 근거 주석(RATIONALE)을 단다. 보고서에 그대로 인용할 수 있어야 한다.
 * 3. 임계값은 "1회 식사분" 기준이다. 1일 권장량을 끼니 수로 나눈 값에서 출발한다.
 * 4. 판정은 3단계: good(좋음) < caution(주의) < avoid(피함)
 *
 * ⚠️ 임계값은 일반적인 식이 지침에서 유도한 것이며 개인의 병기·신기능·투약에 따라
 *    달라진다. 임상 적용 전 영양사 검토가 필요하다.
 */

export const VERDICT = { GOOD: 'good', CAUTION: 'caution', AVOID: 'avoid' };
const RANK = { good: 0, caution: 1, avoid: 2 };
const VERDICT_KO = { good: '좋음', caution: '주의', avoid: '피함' };
const VERDICT_EN = { good: 'Good', caution: 'Caution', avoid: 'Avoid' };

export function worse(a, b) { return RANK[a] >= RANK[b] ? a : b; }
export function verdictKo(v) { return VERDICT_KO[v] || '?'; }
export function verdictEn(v) { return VERDICT_EN[v] || '?'; }
/** 언어 코드로 판정어를 고른다. 기본은 한국어 — 인자를 주지 않던 기존 호출은 그대로다. */
export function verdictText(v, lang = 'ko') { return lang === 'en' ? verdictEn(v) : verdictKo(v); }

/* ────────────────────────────────────────────────────────────
   영양소 축 정의 — 표시 이름과 단위
   ──────────────────────────────────────────────────────────── */
export const AXES = {
  sodium_mg:      { label: '나트륨',     label_en: 'Sodium',        unit: 'mg' },
  potassium_mg:   { label: '칼륨',       label_en: 'Potassium',     unit: 'mg' },
  phosphorus_mg:  { label: '인',         label_en: 'Phosphorus',    unit: 'mg' },
  protein_g:      { label: '단백질',     label_en: 'Protein',       unit: 'g'  },
  carb_g:         { label: '탄수화물',   label_en: 'Carbohydrate',  unit: 'g'  },
  sugar_g:        { label: '당류',       label_en: 'Sugars',        unit: 'g'  },
  fat_g:          { label: '지방',       label_en: 'Fat',           unit: 'g'  },
  satfat_g:       { label: '포화지방',   label_en: 'Saturated fat', unit: 'g'  },
  transfat_g:     { label: '트랜스지방', label_en: 'Trans fat',     unit: 'g'  },
  cholesterol_mg: { label: '콜레스테롤', label_en: 'Cholesterol',   unit: 'mg' },
  calcium_mg:     { label: '칼슘',       label_en: 'Calcium',       unit: 'mg' },
  purine_mg:      { label: '퓨린',       label_en: 'Purines',       unit: 'mg' },
  vitk_ug:        { label: '비타민K',    label_en: 'Vitamin K',     unit: 'µg' },
  fluid_ml:       { label: '수분',       label_en: 'Fluid',         unit: 'ml' },
  kcal:           { label: '열량',       label_en: 'Calories',      unit: 'kcal' },
  iron_mg:        { label: '철',         label_en: 'Iron',          unit: 'mg' },
  iodine_ug:      { label: '요오드',     label_en: 'Iodine',        unit: 'µg' },
  caffeine_mg:    { label: '카페인',     label_en: 'Caffeine',      unit: 'mg' },
  vita_ug:        { label: '레티놀',     label_en: 'Retinol',       unit: 'µg' }
};

/** 축 이름을 언어에 맞춰 고른다. 영어 이름이 없으면 한국어로 되돌아간다. */
export function axisLabel(axis, lang = 'ko') {
  const a = AXES[axis];
  if (!a) return axis;
  return (lang === 'en' && a.label_en) ? a.label_en : a.label;
}

/* ────────────────────────────────────────────────────────────
   개인 프로필 — 전부 선택 입력이다
   ────────────────────────────────────────────────────────────
   아무것도 입력하지 않아도 판정이 된다. 입력하면 정확해질 뿐이다.
   건강 앱에서 개인정보 입력을 강제하면 쓰지 않게 되고, 강제해서 얻는
   정확도보다 안 쓰게 되는 손실이 크다.
*/
export const PROFILE_DEFAULTS = { weightKg: 60, sex: null, ageYears: null };

export function resolveProfile(p = {}) {
  const w = Number(p.weightKg);
  const a = Number(p.ageYears);
  return {
    weightKg:    w > 0 ? w : PROFILE_DEFAULTS.weightKg,
    weightGiven: w > 0,
    sex:         (p.sex === 'f' || p.sex === 'm') ? p.sex : null,
    ageYears:    a > 0 ? a : null
  };
}

/**
 * 연령 보정 계수.
 * RATIONALE: 한국인 영양소 섭취기준의 연령별 권장량은 체격에 거의 비례한다.
 * 성인 기준을 그대로 소아에게 쓰면 아이가 성인 한 끼를 다 먹어도 '좋음'이 나온다.
 * 정밀한 소아 기준표를 넣기 전까지의 보수적 근사이며, 나이를 입력하지 않으면 보정하지 않는다.
 */
export function ageFactor(age) {
  if (age == null) return 1;
  if (age < 6)  return 0.5;
  if (age < 12) return 0.65;
  if (age < 15) return 0.8;
  if (age < 19) return 0.9;
  if (age >= 75) return 0.9;   // 고령은 총 섭취량이 줄어 같은 절대량의 부담이 크다
  return 1;
}

/* 수치형 룰 헬퍼. direction:'high'는 값이 높을수록 나쁨.
   opts.perKg를 주면 체중이 입력됐을 때 체중 비례 임계값으로 바뀐다.
   opts.ageScaled:false면 연령 보정을 적용하지 않는다. */
const hi = (axis, caution, avoid, rationale, msg, opts = {}) =>
  ({ axis, direction: 'high', caution, avoid, rationale, msg, ...opts });

/* ────────────────────────────────────────────────────────────
   질환 정의
   ──────────────────────────────────────────────────────────── */
export const DISEASES = [
  {
    id: 'htn', name: '고혈압', name_en: 'Hypertension', focus: '나트륨', focus_en: 'sodium',
    rules: [
      hi('sodium_mg', 500, 900,
        'RATIONALE: WHO·대한고혈압학회 1일 나트륨 2,000mg(소금 5g) 미만 권고. 3끼로 나누면 약 667mg. ' +
        '반찬·간식 여유를 두어 500mg에서 주의, 하루치의 45%를 한 끼에 넘기는 900mg에서 피함으로 둔다.',
        { caution: v => `나트륨이 ${v}mg입니다. 한 끼 권장(약 670mg)에 가까워 국물을 남기시는 게 좋습니다.`,
          avoid:   v => `나트륨이 ${v}mg으로 하루 권장량(2,000mg)의 절반에 육박합니다. 혈압을 직접 올립니다.` },
        { rationale_en:
            'RATIONALE: WHO and the Korean Society of Hypertension recommend under 2,000mg of sodium ' +
            '(5g of salt) per day. Divided over 3 meals that is about 667mg per meal. Leaving room for ' +
            'side dishes and snacks, caution is set at 500mg, and avoid at 900mg — more than 45% of the ' +
            'daily allowance in a single meal.',
          msg_en: {
            caution: v => `Sodium is ${v}mg. That is close to the per-meal target (about 670mg), so it is best to leave the broth behind.`,
            avoid:   v => `Sodium is ${v}mg — nearly half the daily limit (2,000mg) in one meal. Sodium raises blood pressure directly.` } })
    ],
    /* 칼륨은 고혈압에 이롭다(DASH). 다만 콩팥병이 함께 있으면 무효화된다 — resolveConflicts 참조 */
    bonus: { axis: 'potassium_mg', min: 300,
             msg: v => `칼륨이 ${v}mg으로 넉넉합니다. 칼륨은 나트륨 배출을 도와 혈압에 이롭습니다.`,
             msg_en: v => `Potassium is a generous ${v}mg. Potassium helps the body excrete sodium, which is good for blood pressure.` }
  },

  {
    id: 'dm', name: '당뇨병', name_en: 'Diabetes', focus: '당류·탄수화물', focus_en: 'sugars and carbohydrate',
    rules: [
      hi('sugar_g', 15, 25,
        'RATIONALE: WHO 유리당 1일 총열량의 10% 미만(2,000kcal 기준 50g), 가급적 5%(25g). ' +
        '1끼 배분 시 약 16g. 15g 주의, 하루 목표 상한을 한 끼에 다 쓰는 25g에서 피함.',
        { caution: v => `당류가 ${v}g입니다. 식후 혈당이 빠르게 오를 수 있습니다.`,
          avoid:   v => `당류가 ${v}g으로 하루 목표치를 한 끼에 다 채웁니다. 혈당 급상승이 예상됩니다.` },
        { rationale_en:
            'RATIONALE: WHO recommends free sugars below 10% of daily energy (50g on a 2,000kcal diet), ' +
            'and ideally below 5% (25g). Split across meals that is about 16g per meal. Caution at 15g; ' +
            'avoid at 25g, which spends the whole ideal daily target on one meal.',
          msg_en: {
            caution: v => `Sugars are ${v}g. Your blood glucose may rise quickly after this meal.`,
            avoid:   v => `Sugars are ${v}g — the entire daily target in a single meal. Expect a sharp blood glucose spike.` } }),
      hi('carb_g', 75, 100,
        'RATIONALE: 1일 탄수화물 250~300g(총열량 55~60%) 기준 1끼 약 85~100g. ' +
        '흰쌀밥 한 공기(210g)가 69g이므로 밥 한 공기만으로는 주의에 걸리지 않도록 75g에서 주의를 둔다.',
        { caution: v => `탄수화물이 ${v}g입니다. 밥·면 양을 3분의 2로 줄이시면 좋습니다.`,
          avoid:   v => `탄수화물이 ${v}g으로 한 끼 적정량을 크게 넘습니다.` },
        { rationale_en:
            'RATIONALE: At 250-300g of carbohydrate per day (55-60% of energy), one meal works out to ' +
            'about 85-100g. A bowl of white rice (210g) is 69g, so caution is set at 75g to keep a single ' +
            'bowl of rice from tripping the threshold on its own.',
          msg_en: {
            caution: v => `Carbohydrate is ${v}g. Cutting the rice or noodles to two-thirds would help.`,
            avoid:   v => `Carbohydrate is ${v}g, well above a sensible amount for one meal.` } })
    ]
  },

  {
    id: 'cad', name: '심근경색·협심증', name_en: 'Heart Attack / Angina',
    focus: '포화지방·나트륨·콜레스테롤', focus_en: 'saturated fat, sodium and cholesterol',
    rules: [
      hi('satfat_g', 6, 11,
        'RATIONALE: 미국심장협회 포화지방 1일 총열량 6% 미만(2,000kcal 기준 13g). 1끼 약 4~5g.',
        { caution: v => `포화지방이 ${v}g입니다. 기름진 부위와 국물 기름을 걷어내세요.`,
          avoid:   v => `포화지방이 ${v}g으로 하루 권장(약 13g)에 육박합니다. 관상동맥에 부담이 됩니다.` },
        { rationale_en:
            'RATIONALE: The American Heart Association recommends saturated fat below 6% of daily energy ' +
            '(about 13g on a 2,000kcal diet), which is roughly 4-5g per meal.',
          msg_en: {
            caution: v => `Saturated fat is ${v}g. Trim the fatty cuts and skim the fat off the broth.`,
            avoid:   v => `Saturated fat is ${v}g, close to the whole daily allowance (about 13g). That strains the coronary arteries.` } }),
      hi('transfat_g', 0.3, 0.6,
        'RATIONALE: WHO 트랜스지방 1일 총열량 1% 미만(약 2.2g). 3끼 배분 시 0.7g.',
        { caution: v => `트랜스지방이 ${v}g 들어 있습니다. 튀김·가공식품을 줄이세요.`,
          avoid:   v => `트랜스지방이 ${v}g입니다. 트랜스지방은 섭취량에 안전한 하한이 없습니다.` },
        { rationale_en:
            'RATIONALE: WHO recommends trans fat below 1% of daily energy (about 2.2g), which is 0.7g ' +
            'when divided over 3 meals.',
          msg_en: {
            caution: v => `This meal contains ${v}g of trans fat. Cut back on fried and processed foods.`,
            avoid:   v => `Trans fat is ${v}g. There is no intake level of trans fat considered safe.` } }),
      hi('cholesterol_mg', 120, 220,
        'RATIONALE: 심혈관질환자 1일 콜레스테롤 200mg 미만 권고. 1끼 약 67mg이나 ' +
        '계란 1개(약 190mg)를 곧바로 피함으로 판정하면 실용성이 떨어져 220mg에서 피함으로 둔다.',
        { caution: v => `콜레스테롤이 ${v}mg입니다. 노른자·내장류는 횟수를 줄이세요.`,
          avoid:   v => `콜레스테롤이 ${v}mg으로 하루 권장(200mg)을 한 끼에 넘습니다.` },
        { rationale_en:
            'RATIONALE: People with cardiovascular disease are advised to stay under 200mg of cholesterol ' +
            'per day, about 67mg per meal. Flagging a single egg (about 190mg) as "avoid" outright would be ' +
            'impractical, so avoid is set at 220mg.',
          msg_en: {
            caution: v => `Cholesterol is ${v}mg. Have egg yolks and organ meats less often.`,
            avoid:   v => `Cholesterol is ${v}mg, exceeding the daily recommendation (200mg) in one meal.` } }),
      hi('sodium_mg', 500, 900,
        'RATIONALE: 고혈압과 동일. 나트륨은 혈압을 통해 심장 부담을 늘린다.',
        { caution: v => `나트륨이 ${v}mg입니다. 혈압이 오르면 심장 부담도 함께 커집니다.`,
          avoid:   v => `나트륨이 ${v}mg으로 과다합니다.` },
        { rationale_en:
            'RATIONALE: Same basis as hypertension. Sodium raises blood pressure, and that in turn ' +
            'increases the workload on the heart.',
          msg_en: {
            caution: v => `Sodium is ${v}mg. When blood pressure rises, the strain on the heart rises with it.`,
            avoid:   v => `Sodium is ${v}mg, which is excessive.` } })
    ]
  },

  {
    id: 'hf', name: '심부전', name_en: 'Heart Failure', focus: '나트륨·수분', focus_en: 'sodium and fluid',
    rules: [
      hi('sodium_mg', 400, 700,
        'RATIONALE: 심부전은 나트륨 저류가 곧 부종·호흡곤란으로 이어져 고혈압보다 엄격히 본다. ' +
        '1일 2,000mg 이하를 3끼로 나눈 667mg을 상한선으로 잡고 한 단계씩 낮춘다.',
        { caution: v => `나트륨이 ${v}mg입니다. 심부전에서는 고혈압보다 더 엄격하게 보셔야 합니다.`,
          avoid:   v => `나트륨이 ${v}mg입니다. 몸이 물을 붙잡아 부종과 숨참을 유발할 수 있습니다.` },
        { rationale_en:
            'RATIONALE: In heart failure, sodium retention translates directly into edema and shortness of ' +
            'breath, so the thresholds are stricter than for hypertension. Taking 2,000mg per day divided ' +
            'over 3 meals (667mg) as the ceiling, each level is stepped down one notch.',
          msg_en: {
            caution: v => `Sodium is ${v}mg. With heart failure you need to be stricter about sodium than someone with hypertension alone.`,
            avoid:   v => `Sodium is ${v}mg. Your body will hold on to fluid, which can cause swelling and breathlessness.` } }),
      hi('fluid_ml', 300, 500,
        'RATIONALE: 중등도 이상 심부전에서 1일 수분 1.5~2L 제한이 흔하다. 수분 제한은 통상 ' +
        '25~30ml/kg/일로 처방되므로 체중이 입력되면 그 값을 3끼로 나눠 쓴다(주의 5ml/kg·피함 8.3ml/kg).',
        { caution: v => `국물과 음료를 합쳐 수분이 약 ${v}ml입니다. 국물은 남기는 게 좋습니다.`,
          avoid:   v => `수분이 약 ${v}ml입니다. 하루 수분 제한이 있다면 이 한 끼로 상당량을 쓰게 됩니다.` },
        { rationale_en:
            'RATIONALE: A fluid restriction of 1.5-2L per day is common in moderate or worse heart failure. ' +
            'Such restrictions are usually prescribed as 25-30ml/kg/day, so when body weight is entered that ' +
            'figure is divided over 3 meals (caution 5ml/kg, avoid 8.3ml/kg).',
          msg_en: {
            caution: v => `Broth and drinks together come to about ${v}ml of fluid. It is better to leave the broth.`,
            avoid:   v => `Fluid is about ${v}ml. If you are on a daily fluid restriction, this one meal uses up a large share of it.` },
          perKg: { caution: 5, avoid: 8.3 } })
    ]
  },

  {
    id: 'lipid', name: '이상지질혈증', name_en: 'Dyslipidemia',
    focus: '포화지방·트랜스지방', focus_en: 'saturated fat and trans fat',
    rules: [
      hi('satfat_g', 5, 9,
        'RATIONALE: 이상지질혈증 치료 식이는 포화지방 1일 총열량 7% 미만. cad보다 한 단계 엄격하게 둔다.',
        { caution: v => `포화지방이 ${v}g입니다. LDL 콜레스테롤을 직접 올리는 성분입니다.`,
          avoid:   v => `포화지방이 ${v}g으로 과다합니다. 지질 수치 관리에 불리합니다.` },
        { rationale_en:
            'RATIONALE: Therapeutic diets for dyslipidemia keep saturated fat below 7% of daily energy. ' +
            'Set one step stricter than the coronary artery disease thresholds.',
          msg_en: {
            caution: v => `Saturated fat is ${v}g. It raises LDL cholesterol directly.`,
            avoid:   v => `Saturated fat is ${v}g, which is excessive and works against your lipid targets.` } }),
      hi('transfat_g', 0.2, 0.5,
        'RATIONALE: 트랜스지방은 LDL을 올리고 HDL을 낮춰 이상지질혈증에서 가장 불리하다.',
        { caution: v => `트랜스지방이 ${v}g 들어 있습니다.`,
          avoid:   v => `트랜스지방이 ${v}g입니다. 좋은 콜레스테롤까지 낮춥니다.` },
        { rationale_en:
            'RATIONALE: Trans fat raises LDL and lowers HDL at the same time, making it the worst single ' +
            'component for dyslipidemia.',
          msg_en: {
            caution: v => `This meal contains ${v}g of trans fat.`,
            avoid:   v => `Trans fat is ${v}g. It even lowers your good cholesterol.` } }),
      hi('cholesterol_mg', 120, 220,
        'RATIONALE: cad와 동일 근거.',
        { caution: v => `콜레스테롤이 ${v}mg입니다.`,
          avoid:   v => `콜레스테롤이 ${v}mg으로 하루 권장을 한 끼에 넘습니다.` },
        { rationale_en: 'RATIONALE: Same basis as coronary artery disease.',
          msg_en: {
            caution: v => `Cholesterol is ${v}mg.`,
            avoid:   v => `Cholesterol is ${v}mg, exceeding the daily recommendation in a single meal.` } })
    ]
  },

  {
    id: 'ckd', name: '만성콩팥병', name_en: 'Chronic Kidney Disease',
    focus: '칼륨·인·나트륨·단백질', focus_en: 'potassium, phosphorus, sodium and protein',
    rules: [
      hi('potassium_mg', 400, 700,
        'RATIONALE: 진행된 만성콩팥병(3b기 이상)에서 1일 칼륨 2,000~2,500mg 제한이 흔하다. ' +
        '3끼+간식으로 나누면 1끼 약 600mg. 고칼륨혈증은 부정맥·심정지로 직결되므로 보수적으로 잡는다.',
        { caution: v => `칼륨이 ${v}mg입니다. 채소는 데쳐서 물을 버리면 칼륨이 줄어듭니다.`,
          avoid:   v => `칼륨이 ${v}mg입니다. 콩팥이 칼륨을 못 걸러내면 부정맥 위험이 있습니다.` },
        { rationale_en:
            'RATIONALE: In advanced chronic kidney disease (stage 3b and beyond) a potassium restriction of ' +
            '2,000-2,500mg per day is common. Divided over 3 meals plus a snack that is about 600mg per ' +
            'meal. Because hyperkalemia leads directly to arrhythmia and cardiac arrest, the thresholds ' +
            'are set conservatively.',
          msg_en: {
            caution: v => `Potassium is ${v}mg. Blanching vegetables and discarding the water lowers their potassium.`,
            avoid:   v => `Potassium is ${v}mg. When the kidneys cannot clear potassium, there is a risk of arrhythmia.` } }),
      hi('phosphorus_mg', 250, 400,
        'RATIONALE: 만성콩팥병 1일 인 800~1,000mg 제한. 3끼로 나누면 약 300mg. ' +
        '가공식품의 무기인은 흡수율이 90% 이상이라 같은 수치라도 더 위험하다.',
        { caution: v => `인이 ${v}mg입니다. 가공식품·유제품·견과류에 특히 많습니다.`,
          avoid:   v => `인이 ${v}mg입니다. 장기적으로 뼈와 혈관 석회화를 일으킵니다.` },
        { rationale_en:
            'RATIONALE: Chronic kidney disease calls for 800-1,000mg of phosphorus per day, about 300mg per ' +
            'meal. Inorganic phosphate additives in processed food are more than 90% absorbed, so the same ' +
            'number on the label is more dangerous when it comes from processed food.',
          msg_en: {
            caution: v => `Phosphorus is ${v}mg. Processed foods, dairy and nuts are especially high in it.`,
            avoid:   v => `Phosphorus is ${v}mg. Over time this drives bone disease and vascular calcification.` } }),
      hi('protein_g', 21, 30,
        'RATIONALE: 투석 전 만성콩팥병 저단백식 0.6~0.8g/kg/일. 이 축은 체중에 정비례하므로 ' +
        '체중을 입력하면 g/kg으로 환산한다(주의 0.35g/kg·피함 0.5g/kg, 1끼 기준). ' +
        '미입력 시 60kg 가정. 투석 중이면 반대로 단백질을 늘려야 하므로 이 룰은 투석 전 기준이다.',
        { caution: v => `단백질이 ${v}g입니다. (투석 전 기준입니다. 투석 중이시면 오히려 더 드셔야 합니다.)`,
          avoid:   v => `단백질이 ${v}g으로 저단백 식이 기준을 넘습니다. 노폐물이 늘어 콩팥 부담이 커집니다.` },
        { rationale_en:
            'RATIONALE: Pre-dialysis chronic kidney disease uses a low-protein diet of 0.6-0.8g/kg/day. ' +
            'This axis scales directly with body weight, so when weight is entered the threshold is ' +
            'converted to g/kg (caution 0.35g/kg, avoid 0.5g/kg, per meal). Without a weight, 60kg is ' +
            'assumed. Patients on dialysis need MORE protein, not less, so this rule is a pre-dialysis rule.',
          msg_en: {
            caution: v => `Protein is ${v}g. (This is a pre-dialysis threshold. If you are on dialysis you should be eating more protein, not less.)`,
            avoid:   v => `Protein is ${v}g, above the low-protein diet threshold. More nitrogenous waste means more work for the kidneys.` },
          perKg: { caution: 0.35, avoid: 0.5 } }),
      hi('sodium_mg', 500, 900,
        'RATIONALE: 고혈압과 동일. 나트륨 제한은 만성콩팥병 전 단계에서 공통이다.',
        { caution: v => `나트륨이 ${v}mg입니다.`,
          avoid:   v => `나트륨이 ${v}mg으로 과다합니다. 혈압과 부종을 모두 악화시킵니다.` },
        { rationale_en:
            'RATIONALE: Same basis as hypertension. Sodium restriction applies at every stage of chronic ' +
            'kidney disease.',
          msg_en: {
            caution: v => `Sodium is ${v}mg.`,
            avoid:   v => `Sodium is ${v}mg, which is excessive. It worsens both blood pressure and swelling.` } })
    ]
  },

  {
    id: 'gout', name: '통풍', name_en: 'Gout', focus: '퓨린·알코올', focus_en: 'purines and alcohol',
    rules: [
      hi('purine_mg', 100, 200,
        'RATIONALE: 통풍 급성기 1일 퓨린 400mg 이하, 관해기 완화. 3끼로 나누면 약 130mg. ' +
        '주의: 이 축의 데이터는 전량 문헌 추정치이며 식약처 DB에 퓨린 항목이 없다.',
        { caution: v => `퓨린이 약 ${v}mg입니다. 국물에 퓨린이 많이 녹아 있으니 건더기만 드세요.`,
          avoid:   v => `퓨린이 약 ${v}mg입니다. 요산이 올라 발작을 유발할 수 있습니다.` },
        { rationale_en:
            'RATIONALE: During an acute gout flare, purine intake is kept at or below 400mg per day, eased ' +
            'during remission. Divided over 3 meals that is about 130mg. Note: every value on this axis is ' +
            'a literature estimate — the Korean MFDS food database has no purine field.',
          msg_en: {
            caution: v => `Purines are about ${v}mg. A lot of purine dissolves into the broth, so eat the solids and leave the soup.`,
            avoid:   v => `Purines are about ${v}mg. That can raise uric acid and trigger a flare.` } }),
      hi('sugar_g', 20, 35,
        'RATIONALE: 과당은 ATP를 소모하며 요산 생성을 직접 늘린다. 통풍에서 당류는 퓨린과 별개의 위험요인이다.',
        { caution: v => `당류가 ${v}g입니다. 과당은 요산을 직접 올립니다.`,
          avoid:   v => `당류가 ${v}g으로 많습니다. 과당 섭취는 통풍 발작 위험을 높입니다.` },
        { rationale_en:
            'RATIONALE: Fructose consumes ATP as it is metabolized and directly increases uric acid ' +
            'production. In gout, sugars are a risk factor independent of purines.',
          msg_en: {
            caution: v => `Sugars are ${v}g. Fructose raises uric acid directly.`,
            avoid:   v => `Sugars are a high ${v}g. Fructose intake increases the risk of a gout attack.` } })
    ],
    flags: [
      { when: n => n.alcohol, verdict: VERDICT.AVOID,
        rationale: 'RATIONALE: 알코올은 요산 배설을 억제하고 맥주는 퓨린까지 공급한다. 통풍에서 가장 강한 유발 인자.',
        rationale_en: 'RATIONALE: Alcohol suppresses uric acid excretion, and beer supplies purines on top of ' +
                      'that. It is the strongest dietary trigger in gout.',
        msg: () => '술이 포함돼 있습니다. 알코올은 요산이 빠져나가는 것을 막아 발작을 직접 유발합니다.',
        msg_en: () => 'This meal includes alcohol. Alcohol blocks uric acid from leaving the body and can trigger an attack directly.' }
    ]
  },

  {
    id: 'osteo', name: '골다공증', name_en: 'Osteoporosis', focus: '칼슘·나트륨', focus_en: 'calcium and sodium',
    rules: [
      hi('sodium_mg', 900, 1500,
        'RATIONALE: 나트륨 배설 시 칼슘이 함께 빠져나간다(나트륨 2,300mg당 칼슘 약 40mg 손실). ' +
        '골다공증에서 나트륨은 직접 위험이 아닌 간접 위험이라 다른 질환보다 느슨하게 잡는다.',
        { caution: v => `나트륨이 ${v}mg입니다. 짜게 먹으면 소변으로 칼슘이 함께 빠져나갑니다.`,
          avoid:   v => `나트륨이 ${v}mg입니다. 칼슘 손실이 상당할 수 있습니다.` },
        { rationale_en:
            'RATIONALE: Calcium is lost along with sodium in the urine (roughly 40mg of calcium per ' +
            '2,300mg of sodium). In osteoporosis sodium is an indirect rather than a direct hazard, so ' +
            'the thresholds are looser than for other conditions.',
          msg_en: {
            caution: v => `Sodium is ${v}mg. Eating salty food pulls calcium out with the urine.`,
            avoid:   v => `Sodium is ${v}mg. The resulting calcium loss can be substantial.` } })
    ],
    bonus: { axis: 'calcium_mg', min: 250,
             msg: v => `칼슘이 ${v}mg으로 넉넉합니다. 뼈에 좋습니다.`,
             msg_en: v => `Calcium is a generous ${v}mg. That is good for your bones.` },
    /* 한 끼만으로는 칼슘 부족을 단정할 수 없다. 낮다고 avoid를 주지 않고 팁으로만 안내한다. */
    lowNote: { axis: 'calcium_mg', below: 100,
               msg: () => '이 식사에는 칼슘이 거의 없습니다. 하루 중 우유·두부·멸치를 챙기세요.',
               msg_en: () => 'This meal has almost no calcium. Try to fit in milk, tofu or small dried anchovies somewhere in the day.' }
  },

  {
    id: 'gerd', name: '위염·역류성식도염', name_en: 'Gastritis / GERD',
    focus: '자극성·지방', focus_en: 'irritants and fat',
    rules: [
      hi('fat_g', 25, 40,
        'RATIONALE: 지방은 위 배출을 늦추고 하부식도괄약근 압력을 낮춰 역류를 조장한다.',
        { caution: v => `지방이 ${v}g입니다. 기름진 음식은 위에 오래 머물러 역류를 조장합니다.`,
          avoid:   v => `지방이 ${v}g으로 많습니다. 식후 눕지 마시고 2~3시간 두세요.` },
        { rationale_en:
            'RATIONALE: Fat slows gastric emptying and lowers lower-esophageal-sphincter pressure, both of ' +
            'which promote reflux.',
          msg_en: {
            caution: v => `Fat is ${v}g. Greasy food sits in the stomach longer and encourages reflux.`,
            avoid:   v => `Fat is a high ${v}g. Do not lie down after eating — stay upright for 2-3 hours.` } })
    ],
    flags: [
      { when: n => n.irritants.includes('spicy') && n.irritants.includes('acidic'),
        verdict: VERDICT.AVOID,
        rationale: 'RATIONALE: 캡사이신과 산이 함께 있으면 식도 점막 자극이 가중된다.',
        rationale_en: 'RATIONALE: Capsaicin and acid together compound the irritation of the esophageal mucosa.',
        msg: () => '맵고 신맛이 함께 있습니다. 손상된 식도 점막을 강하게 자극합니다.',
        msg_en: () => 'This meal is both spicy and acidic. That strongly irritates an already damaged esophageal lining.' },
      { when: n => n.irritants.includes('spicy') && n.irritants.includes('greasy'),
        verdict: VERDICT.AVOID,
        rationale: 'RATIONALE: 고지방은 위 배출을 지연시켜 캡사이신이 위에 머무는 시간을 늘린다. ' +
                   '두 자극이 단순 합산이 아니라 서로를 증폭시키므로 각각 주의가 아닌 피함으로 올린다.',
        rationale_en: 'RATIONALE: A high fat load delays gastric emptying, which lengthens the time capsaicin ' +
                      'stays in the stomach. The two irritants amplify each other rather than simply adding up, ' +
                      'so the combination is raised from caution to avoid.',
        msg: () => '맵고 기름진 음식입니다. 기름이 위 배출을 늦춰 매운 성분이 위에 오래 머뭅니다.',
        msg_en: () => 'This meal is spicy and greasy. The fat slows stomach emptying, so the spice stays in the stomach longer.' },
      { when: n => n.irritants.includes('spicy'), verdict: VERDICT.CAUTION,
        rationale: 'RATIONALE: 캡사이신은 식도 통증 수용체를 자극한다.',
        rationale_en: 'RATIONALE: Capsaicin stimulates pain receptors in the esophagus.',
        msg: () => '매운 음식입니다. 속쓰림이 있으시면 피하세요.',
        msg_en: () => 'This is spicy food. Avoid it if you have heartburn.' },
      { when: n => n.irritants.includes('caffeine'), verdict: VERDICT.CAUTION,
        rationale: 'RATIONALE: 카페인은 하부식도괄약근을 이완시켜 역류를 늘린다.',
        rationale_en: 'RATIONALE: Caffeine relaxes the lower esophageal sphincter and increases reflux.',
        msg: () => '카페인이 들어 있습니다. 식도 조임근을 느슨하게 만들어 역류를 늘립니다.',
        msg_en: () => 'This meal contains caffeine. It loosens the valve at the base of the esophagus and increases reflux.' },
      { when: n => n.irritants.includes('acidic'), verdict: VERDICT.CAUTION,
        rationale: 'RATIONALE: 산성 식품은 이미 손상된 점막에 직접 자극이 된다.',
        rationale_en: 'RATIONALE: Acidic foods directly irritate a mucosa that is already damaged.',
        msg: () => '신맛이 강합니다. 공복에는 특히 피하세요.',
        msg_en: () => 'This is strongly acidic. Avoid it especially on an empty stomach.' }
    ]
  },

  {
    id: 'warf', name: '와파린 복용 중', name_en: 'On Warfarin',
    focus: '비타민K 변동', focus_en: 'swings in vitamin K',
    /* 이 질환만 판정의 성격이 다르다. "많으면 나쁨"이 아니라 "갑자기 바뀌면 나쁨"이다.
       메시지에서 이 차이를 반드시 드러내야 사용자가 오해하지 않는다. */
    inverted: true,
    rules: [
      hi('vitk_ug', 100, 250,
        'RATIONALE: 와파린은 비타민K 길항제라 비타민K 섭취량이 INR을 직접 흔든다. ' +
        '성인 1일 충분섭취량은 남 75µg·여 65µg. 핵심은 절대량이 아니라 일관성이므로 ' +
        '"금지"가 아니라 "평소와 같은 양을 유지하라"는 메시지로 전달한다.',
        { caution: v => `비타민K가 ${v}µg입니다. 드셔도 되지만 평소와 비슷한 양을 유지하세요. 갑자기 늘리면 약효가 떨어집니다.`,
          avoid:   v => `비타민K가 ${v}µg으로 하루 권장(약 70µg)의 몇 배입니다. 이번 한 번만 많이 드시면 INR이 흔들릴 수 있습니다. 평소 이 정도를 드셔 오셨다면 문제없습니다.` },
        { rationale_en:
            'RATIONALE: Warfarin is a vitamin K antagonist, so vitamin K intake moves the INR directly. ' +
            'Adequate intake for adults is 75µg/day for men and 65µg/day for women. What matters is ' +
            'consistency rather than the absolute amount, so the message is "keep your usual amount", ' +
            'not "avoid this".',
          msg_en: {
            caution: v => `Vitamin K is ${v}µg. You may eat this, but keep the amount close to what you usually have. A sudden increase weakens the drug.`,
            avoid:   v => `Vitamin K is ${v}µg, several times the daily adequate intake (about 70µg). Eating this much just this once can swing your INR. If this is roughly what you normally eat, it is fine.` } })
    ],
    flags: [
      { when: n => n.alcohol, verdict: VERDICT.CAUTION,
        rationale: 'RATIONALE: 급성 음주는 와파린 대사를 억제해 INR을 올리고 출혈 위험을 높인다.',
        rationale_en: 'RATIONALE: Acute alcohol intake inhibits warfarin metabolism, raising the INR and with ' +
                      'it the risk of bleeding.',
        msg: () => '술이 포함돼 있습니다. 와파린과 함께면 출혈 위험이 올라갑니다.',
        msg_en: () => 'This meal includes alcohol. Combined with warfarin, it raises your bleeding risk.' }
    ]
  },

  {
    id: 'dysph', name: '연하곤란(삼킴장애)', name_en: 'Dysphagia (Swallowing Difficulty)',
    focus: '질감', focus_en: 'texture',
    /* 유일하게 영양소가 아닌 물리적 성질로만 판정한다.
       고령에서 가장 흔하지만 뇌졸중·파킨슨병·두경부암·근이영양증 등으로
       젊은 층에도 생긴다. 연령과 무관한 상태로 다룬다. */
    textureOnly: true,
    rules: [],
    flags: [
      { when: n => n.textures.includes('sticky'), verdict: VERDICT.AVOID,
        rationale: 'RATIONALE: 떡류는 국내 질식사고 원인 1위. 점착성이 높아 기도에 들러붙는다. ' +
                   '고령층에서 사고가 가장 많지만 소아 질식사고에서도 상위를 차지한다.',
        rationale_en: 'RATIONALE: Tteok (glutinous rice cake) is the leading cause of choking deaths in Korea. ' +
                      'It is highly adhesive and sticks in the airway. Most incidents involve older adults, ' +
                      'but it also ranks near the top for choking in children.',
        msg: () => '떡처럼 끈적한 음식이 있습니다. 질식사고의 가장 흔한 원인입니다. 잘게 잘라 천천히 드세요.',
        msg_en: () => 'This meal contains sticky food such as rice cake — the most common cause of choking. Cut it into small pieces and eat slowly.' },
      { when: n => n.textures.includes('hard'), verdict: VERDICT.AVOID,
        rationale: 'RATIONALE: 저작·구강 준비기가 손상된 상태에서 단단한 음식은 덩어리째 삼켜질 위험이 크다.',
        rationale_en: 'RATIONALE: When chewing and the oral preparatory phase are impaired, hard food carries a ' +
                      'high risk of being swallowed as an intact lump.',
        msg: () => '딱딱하거나 질긴 음식이 있습니다. 잘게 다지거나 갈아서 드리세요.',
        msg_en: () => 'This meal contains hard or tough food. Mince or puree it before serving.' },
      { when: n => n.textures.includes('dry'), verdict: VERDICT.CAUTION,
        rationale: 'RATIONALE: 퍽퍽한 음식은 식괴 형성이 어려워 인두에 잔류하기 쉽다.',
        rationale_en: 'RATIONALE: Dry, crumbly food is hard to form into a bolus and tends to leave residue in ' +
                      'the pharynx.',
        msg: () => '퍽퍽한 음식이 있습니다. 목에 걸리기 쉬우니 국물이나 소스를 곁들이세요.',
        msg_en: () => 'This meal contains dry, crumbly food. It catches in the throat easily, so serve it with broth or sauce.' },
      { when: n => n.textures.includes('mixed'), verdict: VERDICT.CAUTION,
        rationale: 'RATIONALE: 국물+건더기 혼합식은 액체와 고체가 서로 다른 속도로 이동해 흡인 위험이 가장 크다.',
        rationale_en: 'RATIONALE: Mixed consistencies (solids floating in broth) carry the highest aspiration ' +
                      'risk, because the liquid and the solid travel at different speeds.',
        msg: () => '국물에 건더기가 섞인 형태입니다. 액체와 고체가 따로 넘어가 사레가 가장 잘 걸립니다. 건더기와 국물을 나눠 드세요.',
        msg_en: () => 'This is solids in broth. Liquid and solid go down separately, which is the easiest way to choke. Eat the solids and the broth separately.' },
      { when: n => n.textures.includes('liquid'), verdict: VERDICT.CAUTION,
        rationale: 'RATIONALE: 묽은 액체(thin liquid)는 흐름이 빨라 후두 폐쇄 전에 기도로 들어가기 쉽다. ' +
                   '연하곤란에서는 오히려 점도증진제로 걸쭉하게 만들어야 안전하다.',
        rationale_en: 'RATIONALE: Thin liquids flow fast and can enter the airway before the larynx closes. ' +
                      'In dysphagia they are safer when thickened with a commercial thickener.',
        msg: () => '묽은 음료가 있습니다. 물처럼 묽은 것이 오히려 사레가 잘 걸립니다. 점도증진제로 걸쭉하게 하세요.',
        msg_en: () => 'This meal contains a thin drink. Watery liquids are actually the easiest to choke on — thicken them with a thickening agent.' }
    ]
  },

  /* ══════════════════════════════════════════════════════════
     아래 4개는 전 연령 대응으로 추가된 상태다.
     질병이 아닌 생리적 상태(임신)도 포함하므로 '질환'이 아니라 '상태'로 부른다.
     ══════════════════════════════════════════════════════════ */

  {
    id: 'preg', name: '임신·수유 중', name_en: 'Pregnant / Breastfeeding',
    focus: '알코올·카페인·레티놀·생식품', focus_en: 'alcohol, caffeine, retinol and raw foods',
    rules: [
      hi('caffeine_mg', 70, 200,
        'RATIONALE: 임신 중 카페인 1일 200mg 이하 권고(식약처 300mg, 다수 산과 지침 200mg). ' +
        '3끼로 나누면 1끼 약 67mg이므로 커피 한 잔(약 100mg)이 곧바로 주의에 걸리도록 70mg에 둔다. ' +
        '한 끼에 하루 권장을 다 쓰는 200mg에서 피함. 카페인은 태반을 통과하고 태아는 대사 효소가 미성숙하다.',
        { caution: v => `카페인이 ${v}mg입니다. 임신 중 하루 200mg 이하가 권장됩니다. 오늘 마신 양을 합쳐 세어 보세요.`,
          avoid:   v => `카페인이 ${v}mg으로 하루 권장을 한 끼에 다 씁니다. 카페인은 태반을 그대로 통과합니다.` },
        { rationale_en:
            'RATIONALE: Caffeine in pregnancy is recommended at 200mg or less per day (the Korean MFDS says ' +
            '300mg; most obstetric guidelines say 200mg). Divided over 3 meals that is about 67mg, so ' +
            'caution is set at 70mg — one cup of coffee (about 100mg) trips it immediately. Avoid at 200mg, ' +
            'which spends the whole daily allowance on one meal. Caffeine crosses the placenta and the ' +
            'fetus has immature metabolizing enzymes.',
          msg_en: {
            caution: v => `Caffeine is ${v}mg. During pregnancy 200mg or less per day is recommended. Add up everything you have had today.`,
            avoid:   v => `Caffeine is ${v}mg — the whole daily allowance in one meal. Caffeine passes straight through the placenta.` } }),
      hi('vita_ug', 1500, 3000,
        'RATIONALE: 레티놀(동물성 비타민A) 1일 상한 3,000µg. 임신 초기 과잉은 최기형성이 보고돼 있다. ' +
        '소간 100g의 레티놀이 약 9,000µg으로 상한의 세 배라 간·간유는 임신 중 금기로 다룬다. ' +
        '식물성 베타카로틴은 전환이 조절돼 이 상한과 무관하므로 이 축에 넣지 않는다.',
        { caution: v => `레티놀이 ${v}µg입니다. 임신 중 상한은 하루 3,000µg입니다.`,
          avoid:   v => `레티놀이 ${v}µg으로 상한을 크게 넘습니다. 간·내장류는 임신 중 피하는 것이 원칙입니다.` },
        { rationale_en:
            'RATIONALE: The tolerable upper intake level for retinol (preformed, animal-source vitamin A) is ' +
            '3,000µg/day. Excess in early pregnancy has documented teratogenic effects. 100g of beef liver ' +
            'holds about 9,000µg of retinol — three times the upper limit — so liver and cod liver oil are ' +
            'treated as contraindicated in pregnancy. Plant beta-carotene is converted under regulation and ' +
            'is unrelated to this limit, so it is not counted on this axis.',
          msg_en: {
            caution: v => `Retinol is ${v}µg. The upper limit in pregnancy is 3,000µg per day.`,
            avoid:   v => `Retinol is ${v}µg, far above the upper limit. As a rule, avoid liver and organ meats during pregnancy.` } }),
      hi('iodine_ug', 400, 1200,
        'RATIONALE: 요오드 1일 상한 2,400µg(한국인 영양소 섭취기준), 임신부 권장섭취량 240µg. ' +
        '한 끼가 하루 상한의 절반(1,200µg)을 넘으면 피함, 권장량 상당(약 400µg)에서 주의. ' +
        '임신 중 요구량은 늘지만 과잉은 태아 갑상선기능저하를 일으킬 수 있다. ' +
        '산후 미역국을 매 끼 먹는 한국 관습이 실제로 상한을 넘길 수 있어 판정에 포함한다.',
        { caution: v => `요오드가 ${v}µg입니다. 미역·다시마는 하루 한 번 정도가 적당합니다.`,
          avoid:   v => `요오드가 ${v}µg으로 하루 상한(2,400µg)을 넘습니다. 과잉 요오드는 태아 갑상선에 영향을 줍니다.` },
        { rationale_en:
            'RATIONALE: The upper intake level for iodine is 2,400µg/day (Dietary Reference Intakes for ' +
            'Koreans), with a recommended intake of 240µg in pregnancy. A meal past half the daily upper ' +
            'limit (1,200µg) is set to avoid, and around the recommended daily intake (about 400µg) to ' +
            'caution. Requirements rise in pregnancy, but excess can cause fetal hypothyroidism. The Korean ' +
            'custom of eating seaweed soup at every meal after childbirth really can exceed the upper ' +
            'limit, so it is included in the judgment.',
          msg_en: {
            caution: v => `Iodine is ${v}µg. About once a day is enough for sea mustard or kelp.`,
            avoid:   v => `Iodine is ${v}µg, over the daily upper limit (2,400µg). Excess iodine affects the fetal thyroid.` } }),
      hi('sodium_mg', 700, 1200,
        'RATIONALE: 임신성 고혈압·부종 관리를 위해 나트륨을 제한하나, 임신 중 극단적 저나트륨은 ' +
        '오히려 해로워 일반 고혈압보다 느슨하게 잡는다.',
        { caution: v => `나트륨이 ${v}mg입니다. 붓기와 혈압을 위해 조금 싱겁게 드세요.`,
          avoid:   v => `나트륨이 ${v}mg입니다. 임신성 고혈압 위험이 있으면 특히 주의하세요.` },
        { rationale_en:
            'RATIONALE: Sodium is limited to manage gestational hypertension and edema, but extreme sodium ' +
            'restriction is itself harmful in pregnancy, so the thresholds are looser than for ordinary ' +
            'hypertension.',
          msg_en: {
            caution: v => `Sodium is ${v}mg. Eat a little less salty to help with swelling and blood pressure.`,
            avoid:   v => `Sodium is ${v}mg. Be especially careful if you are at risk of gestational hypertension.` } })
    ],
    flags: [
      { when: n => n.alcohol, verdict: VERDICT.AVOID,
        rationale: 'RATIONALE: 태아알코올스펙트럼장애에는 안전한 하한이 없다. 이 앱에서 유일하게 ' +
                   '양과 무관하게 즉시 피함을 주는 항목이다.',
        rationale_en: 'RATIONALE: There is no safe lower bound for fetal alcohol spectrum disorder. This is the ' +
                      'one item in this app that returns avoid immediately, regardless of amount.',
        msg: () => '술이 포함돼 있습니다. 임신 중 알코올은 안전한 양이 없습니다. 한 모금도 권하지 않습니다.',
        msg_en: () => 'This meal includes alcohol. There is no safe amount of alcohol in pregnancy — not even a sip is advised.' },
      { when: n => n.tags.includes('raw'), verdict: VERDICT.CAUTION,
        rationale: 'RATIONALE: 비가열 식품은 리스테리아·톡소플라스마 감염 경로다. 임신 중 리스테리아증은 ' +
                   '유산·사산으로 이어질 수 있어 일반인보다 훨씬 보수적으로 본다.',
        rationale_en: 'RATIONALE: Uncooked foods are a route for listeria and toxoplasma infection. Listeriosis ' +
                      'in pregnancy can end in miscarriage or stillbirth, so the threshold is far more ' +
                      'conservative than for the general population.',
        msg: () => '익히지 않은 음식이 있습니다. 임신 중에는 회·젓갈 같은 생식품을 익혀 드시는 것이 안전합니다.',
        msg_en: () => 'This meal contains uncooked food. During pregnancy it is safer to cook raw items such as sashimi or salted seafood.' },
      { when: n => n.tags.includes('high_mercury'), verdict: VERDICT.CAUTION,
        rationale: 'RATIONALE: 메틸수은은 태반을 통과해 태아 신경계에 축적된다. 식약처는 임신부에게 ' +
                   '심해성 대형어를 주 1회 이하로 권고한다.',
        rationale_en: 'RATIONALE: Methylmercury crosses the placenta and accumulates in the fetal nervous ' +
                      'system. The Korean MFDS advises pregnant women to eat large deep-sea fish no more ' +
                      'than once a week.',
        msg: () => '수은이 쌓일 수 있는 생선입니다. 임신 중에는 주 1회 정도로 줄이세요.',
        msg_en: () => 'This is a fish that can accumulate mercury. During pregnancy, cut back to about once a week.' }
    ],
    bonus: { axis: 'iron_mg', min: 3,
             msg: v => `철분이 ${v}mg으로 넉넉합니다. 임신 중에는 철 요구량이 크게 늘어 도움이 됩니다.`,
             msg_en: v => `Iron is a generous ${v}mg. Iron requirements rise sharply in pregnancy, so this helps.` }
  },

  {
    id: 'anemia', name: '빈혈', name_en: 'Anemia',
    focus: '철 흡수 방해 요인', focus_en: 'things that block iron absorption',
    /* 이 상태는 "나쁜 음식"보다 "나쁜 조합"이 핵심이다.
       같은 음식이라도 무엇과 함께 먹느냐로 철 흡수율이 몇 배 달라진다. */
    rules: [
      hi('caffeine_mg', 50, 150,
        'RATIONALE: 커피·차의 폴리페놀(탄닌)은 비헴철 흡수를 최대 60~90%까지 억제한다. ' +
        '식사와 동시에 마실 때 영향이 가장 크고, 1시간 간격을 두면 대부분 회피된다. ' +
        '카페인 자체보다 함께 든 폴리페놀이 원인이므로 카페인을 지표로 삼는다.',
        { caution: v => `카페인 음료가 함께 있습니다(${v}mg). 식사 중 커피·차는 철 흡수를 크게 방해합니다. 1시간 뒤에 드세요.`,
          avoid:   v => `카페인이 ${v}mg입니다. 이 식사의 철분이 거의 흡수되지 않을 수 있습니다.` },
        { rationale_en:
            'RATIONALE: The polyphenols (tannins) in coffee and tea inhibit non-heme iron absorption by as ' +
            'much as 60-90%. The effect is largest when they are drunk with the meal and is mostly avoided ' +
            'by leaving an hour in between. The polyphenols rather than the caffeine are the cause, but ' +
            'caffeine is used here as the marker.',
          msg_en: {
            caution: v => `A caffeinated drink comes with this meal (${v}mg). Coffee or tea with a meal badly blocks iron absorption — have it an hour later.`,
            avoid:   v => `Caffeine is ${v}mg. Very little of the iron in this meal may end up absorbed.` } }),
      hi('calcium_mg', 500, 900,
        'RATIONALE: 칼슘은 헴철·비헴철 모두의 흡수를 경쟁적으로 억제한다. 유제품과 철분 급원을 ' +
        '같은 끼니에 몰아 먹으면 손해다.',
        { caution: v => `칼슘이 ${v}mg입니다. 유제품과 철분 음식을 같은 끼니에 드시면 흡수가 줄어듭니다.`,
          avoid:   v => `칼슘이 ${v}mg으로 많습니다. 철분 보충제를 드신다면 이 식사와 시간을 띄우세요.` },
        { rationale_en:
            'RATIONALE: Calcium competitively inhibits the absorption of both heme and non-heme iron. ' +
            'Loading dairy and iron sources into the same meal wastes both.',
          msg_en: {
            caution: v => `Calcium is ${v}mg. Eating dairy and iron-rich food in the same meal cuts how much iron you absorb.`,
            avoid:   v => `Calcium is a high ${v}mg. If you take an iron supplement, space it away from this meal.` } })
    ],
    bonus: { axis: 'iron_mg', min: 3,
             msg: v => `철분이 ${v}mg으로 넉넉합니다. 비타민C가 많은 채소·과일을 곁들이면 흡수가 더 좋아집니다.`,
             msg_en: v => `Iron is a generous ${v}mg. Adding vegetables or fruit rich in vitamin C improves absorption further.` },
    lowNote: { axis: 'iron_mg', below: 1,
               msg: () => '이 식사에는 철분이 거의 없습니다. 붉은 살코기·간·시금치·콩류를 하루 중에 챙기세요.',
               msg_en: () => 'This meal has almost no iron. Try to fit in red meat, liver, spinach or legumes somewhere in the day.' }
  },

  {
    id: 'thyroid', name: '갑상선기능이상', name_en: 'Thyroid Dysfunction',
    focus: '요오드 과잉', focus_en: 'excess iodine',
    /* 항진증과 저하증은 원인이 다르지만, 한국 식단에서 실제로 문제가 되는 것은
       결핍이 아니라 과잉이다(해조류 섭취량이 세계 최고 수준). 그래서 이 룰은
       과잉만 판정하고, 결핍 쪽은 판정하지 않는다는 것을 화면에 명시한다. */
    rules: [
      hi('iodine_ug', 250, 1200,
        'RATIONALE: 요오드 1일 상한 2,400µg(한국인 영양소 섭취기준), 권장섭취량 150µg. ' +
        '1끼 권장 상당은 50µg이므로 그 5배인 250µg에서 주의, 하루 상한의 절반인 1,200µg에서 피함. ' +
        '주의 기준을 상한보다 훨씬 낮게 두는 것은 김·미역·국물이 매 끼 누적되기 때문이다. ' +
        '한국인 평균 섭취량은 이미 권장량의 몇 배이며 미역국 한 그릇이 하루 상한에 육박한다. ' +
        '과잉 요오드는 하시모토 갑상선염을 악화시키고 항진증에서는 호르몬 합성을 늘린다.',
        { caution: v => `요오드가 ${v}µg입니다. 미역·다시마·김이 겹치면 금방 넘습니다. 하루 한 번으로 줄이세요.`,
          avoid:   v => `요오드가 ${v}µg으로 하루 상한(2,400µg)에 이릅니다. 해조류는 갑상선 상태를 직접 흔듭니다.` },
        { rationale_en:
            'RATIONALE: The upper intake level for iodine is 2,400µg/day (Dietary Reference Intakes for ' +
            'Koreans) against a recommended intake of 150µg. One meal\'s share of the recommendation is ' +
            '50µg, so caution is set at five times that (250µg) and avoid at half the daily upper limit ' +
            '(1,200µg). Caution sits far below the upper limit because laver, sea mustard and seaweed ' +
            'broth accumulate meal after meal. Average Korean intake is already several times the ' +
            'recommendation, and a single bowl of seaweed soup approaches the daily upper limit. Excess ' +
            'iodine aggravates Hashimoto thyroiditis and increases hormone synthesis in hyperthyroidism.',
          msg_en: {
            caution: v => `Iodine is ${v}µg. Sea mustard, kelp and laver stack up fast — keep seaweed to once a day.`,
            avoid:   v => `Iodine is ${v}µg, reaching the daily upper limit (2,400µg). Seaweed moves thyroid status directly.` } })
    ],
    flags: [
      { when: n => n.tags.includes('cruciferous'), verdict: VERDICT.CAUTION,
        rationale: 'RATIONALE: 십자화과 채소의 고이트로겐은 요오드 이용을 방해하나, 조리 시 대부분 파괴되고 ' +
                   '통상 섭취량에서 임상적 영향은 작다. 금지가 아니라 정보 제공 수준으로만 표시한다.',
        rationale_en: 'RATIONALE: Goitrogens in cruciferous vegetables interfere with iodine utilization, but ' +
                      'most are destroyed by cooking and the clinical effect at normal intakes is small. ' +
                      'Shown for information only, not as a prohibition.',
        msg: () => '십자화과 채소(배추·브로콜리 등)가 있습니다. 익혀 드시면 갑상선에 미치는 영향은 거의 없습니다. 끊을 필요는 없습니다.',
        msg_en: () => 'This meal contains cruciferous vegetables (cabbage, broccoli and the like). Cooked, they have almost no effect on the thyroid. There is no need to give them up.' }
    ],
    note: '이 판정은 요오드 과잉만 봅니다. 항진증·저하증 구분과 약(레보티록신) 복용 시점은 반영하지 않으니 담당의 지시를 우선하세요.',
    note_en: 'This check looks only at excess iodine. It does not distinguish hyper- from hypothyroidism and ' +
             'does not account for the timing of your medication (levothyroxine), so follow your doctor\'s instructions first.'
  },

  {
    id: 'nafld', name: '지방간·비만', name_en: 'Fatty Liver / Obesity',
    focus: '열량·과당·알코올', focus_en: 'calories, fructose and alcohol',
    rules: [
      hi('kcal', 800, 1100,
        'RATIONALE: 성인 1일 1,800~2,200kcal를 3끼로 나누면 1끼 600~730kcal. ' +
        '체중 감량기에는 이보다 낮춰야 하므로 800kcal에서 주의를 둔다. 이 축은 연령 보정을 크게 받는다.',
        { caution: v => `열량이 ${v}kcal입니다. 한 끼 적정량을 넘습니다.`,
          avoid:   v => `열량이 ${v}kcal로 하루 필요량의 절반을 한 끼에 씁니다.` },
        { rationale_en:
            'RATIONALE: An adult intake of 1,800-2,200kcal per day divided over 3 meals is 600-730kcal per ' +
            'meal. While losing weight it should be lower still, so caution is set at 800kcal. This axis is ' +
            'strongly affected by the age adjustment.',
          msg_en: {
            caution: v => `Calories are ${v}kcal, above a sensible amount for one meal.`,
            avoid:   v => `Calories are ${v}kcal — half a day's energy needs in a single meal.` } }),
      hi('sugar_g', 15, 25,
        'RATIONALE: 과당은 간에서만 대사되며 de novo 지방 생성을 직접 자극한다. ' +
        '비알코올성 지방간에서 당류는 총 열량과 별개의 독립 위험요인이다.',
        { caution: v => `당류가 ${v}g입니다. 과당은 간에서 곧바로 지방으로 바뀝니다.`,
          avoid:   v => `당류가 ${v}g입니다. 지방간에는 총 열량보다 당류가 더 직접적인 원인입니다.` },
        { rationale_en:
            'RATIONALE: Fructose is metabolized only in the liver and directly stimulates de novo ' +
            'lipogenesis. In non-alcoholic fatty liver disease, sugars are a risk factor independent of ' +
            'total calories.',
          msg_en: {
            caution: v => `Sugars are ${v}g. Fructose is turned straight into fat in the liver.`,
            avoid:   v => `Sugars are ${v}g. For fatty liver, sugar is a more direct cause than total calories.` } }),
      hi('satfat_g', 7, 12,
        'RATIONALE: 포화지방은 간 내 지방 축적과 인슐린 저항성을 함께 악화시킨다.',
        { caution: v => `포화지방이 ${v}g입니다.`,
          avoid:   v => `포화지방이 ${v}g으로 많습니다. 간 지방 축적을 직접 늘립니다.` },
        { rationale_en:
            'RATIONALE: Saturated fat worsens both hepatic fat accumulation and insulin resistance.',
          msg_en: {
            caution: v => `Saturated fat is ${v}g.`,
            avoid:   v => `Saturated fat is a high ${v}g. It directly increases fat accumulation in the liver.` } })
    ],
    flags: [
      { when: n => n.alcohol, verdict: VERDICT.AVOID,
        rationale: 'RATIONALE: 알코올은 그 자체로 지방간의 원인이며, 비알코올성 지방간에 겹치면 ' +
                   '섬유화 진행이 가속된다.',
        rationale_en: 'RATIONALE: Alcohol is a cause of fatty liver in its own right, and on top of ' +
                      'non-alcoholic fatty liver disease it accelerates progression to fibrosis.',
        msg: () => '술이 포함돼 있습니다. 지방간이 있으면 소량의 음주도 섬유화를 앞당깁니다.',
        msg_en: () => 'This meal includes alcohol. With fatty liver, even a small amount brings fibrosis on sooner.' },
      { when: n => n.tags.includes('processed'), verdict: VERDICT.CAUTION,
        rationale: 'RATIONALE: 초가공식품은 액상과당·정제 탄수화물·포화지방이 함께 들어 있어 ' +
                   '개별 영양소 합계보다 대사에 불리하다는 관찰이 축적돼 있다.',
        rationale_en: 'RATIONALE: Ultra-processed foods combine high-fructose syrup, refined carbohydrate and ' +
                      'saturated fat, and observational evidence has built up that they are worse for ' +
                      'metabolism than the sum of their individual nutrients.',
        msg: () => '가공식품이 있습니다. 같은 열량이라도 가공식품은 간에 더 불리합니다.',
        msg_en: () => 'This meal contains processed food. Calorie for calorie, processed food is harder on the liver.' }
    ]
  },

  /* ────────────────────────────────────────────────────────────
     여기부터 확장분 (2026-08-19) — 기존 15종은 고령·중증 만성질환
     위주였다. 실제로는 훨씬 젊고 흔한 조건이 더 많은 사람에게 영향을
     준다는 지적을 반영해, 유병률이 높은 조건과 식품 알레르기·불내증을
     추가한다. 통계 출처는 각 RATIONALE에 표기한다.
     ──────────────────────────────────────────────────────────── */

  {
    id: 'prediab', name: '당뇨병 전단계·대사증후군', name_en: 'Prediabetes / Metabolic Syndrome',
    focus: '당류·탄수화물(완화 기준)', focus_en: 'sugars and carbohydrate (relaxed thresholds)',
    /* 이미 확진된 당뇨병(dm)보다 느슨한 기준이다. 전단계에 dm과 같은 엄격한 기준을 쓰면
       조기 경고가 아니라 불필요한 공포를 준다 — 목적이 다르므로 별도 항목으로 둔다. */
    rules: [
      hi('sugar_g', 20, 35,
        'RATIONALE: 국민건강영양조사 기준 국내 성인 당뇨병 유병률은 9.4%(2023)이나, ' +
        '당뇨병 전단계(공복혈당장애·내당능장애)는 이보다 훨씬 넓게 분포한다고 추정된다. ' +
        '아직 혈당 조절 능력이 남아 있는 단계이므로 dm 기준(15/25g)보다 여유를 둔다.',
        { caution: v => `당류가 ${v}g입니다. 전단계에서는 지금 습관을 바꾸면 진행을 늦출 수 있습니다.`,
          avoid:   v => `당류가 ${v}g으로 많습니다. 반복되면 당뇨병으로 진행할 위험이 커집니다.` },
        { rationale_en:
            'RATIONALE: By the Korea National Health and Nutrition Examination Survey, diabetes prevalence ' +
            'among Korean adults is 9.4% (2023), while prediabetes (impaired fasting glucose and impaired ' +
            'glucose tolerance) is estimated to be far more widespread. Since glucose regulation is still ' +
            'partly intact at this stage, the thresholds allow more room than the diabetes rule (15/25g).',
          msg_en: {
            caution: v => `Sugars are ${v}g. At the prediabetes stage, changing habits now can slow the progression.`,
            avoid:   v => `Sugars are a high ${v}g. Repeated often, this raises the risk of progressing to diabetes.` } }),
      hi('carb_g', 90, 120,
        'RATIONALE: dm 기준(75/100g)보다 15~20% 여유를 둔 완화 기준.',
        { caution: v => `탄수화물이 ${v}g입니다.`,
          avoid:   v => `탄수화물이 ${v}g으로 한 끼 적정량을 크게 넘습니다.` },
        { rationale_en:
            'RATIONALE: Relaxed thresholds, allowing 15-20% more room than the diabetes rule (75/100g).',
          msg_en: {
            caution: v => `Carbohydrate is ${v}g.`,
            avoid:   v => `Carbohydrate is ${v}g, well above a sensible amount for one meal.` } })
    ],
    note: '이미 당뇨병으로 진단받으셨다면 이 항목이 아니라 "당뇨병" 항목을 선택하세요. 이 항목은 진단 전 단계용 완화 기준입니다.',
    note_en: 'If you have already been diagnosed with diabetes, choose the "Diabetes" item instead of this one. ' +
             'These are relaxed thresholds for the pre-diagnosis stage.'
  },

  {
    id: 'migraine', name: '편두통', name_en: 'Migraine',
    focus: '카페인·알코올·티라민', focus_en: 'caffeine, alcohol and tyramine',
    rules: [
      hi('caffeine_mg', 200, 400,
        'RATIONALE: 카페인은 양날의 검이다 — 급성 편두통에는 진통 보조가 되지만 평소보다 ' +
        '급격히 늘리거나 끊으면 금단성 두통을 유발한다. WHO·유럽식품안전청(EFSA)의 성인 1일 안전 ' +
        '상한 근사치인 400mg 부근에서 위험이 커진다고 보고 이를 기준으로 삼는다.',
        { caution: v => `카페인이 ${v}mg입니다. 평소보다 갑자기 늘리면 편두통을 유발할 수 있습니다.`,
          avoid:   v => `카페인이 ${v}mg으로 많습니다. 편두통이 있으면 하루 총량을 꼭 확인하세요.` },
        { rationale_en:
            'RATIONALE: Caffeine cuts both ways — it helps analgesia in an acute migraine, but a sudden ' +
            'increase or withdrawal triggers headache. Risk rises around 400mg, the approximate safe daily ' +
            'ceiling for adults from WHO and the European Food Safety Authority (EFSA), which is used here ' +
            'as the reference point.',
          msg_en: {
            caution: v => `Caffeine is ${v}mg. A sudden increase over your usual amount can trigger a migraine.`,
            avoid:   v => `Caffeine is a high ${v}mg. With migraine, always keep track of your daily total.` } })
    ],
    flags: [
      { when: n => n.alcohol, verdict: VERDICT.CAUTION,
        rationale: 'RATIONALE: 알코올, 특히 레드와인은 편두통 환자에서 가장 흔히 보고되는 식이 유발 요인 중 하나다.',
        rationale_en: 'RATIONALE: Alcohol, and red wine in particular, is one of the most commonly reported ' +
                      'dietary triggers among people with migraine.',
        msg: () => '술이 포함돼 있습니다. 특히 레드와인은 편두통을 흔히 유발합니다.',
        msg_en: () => 'This meal includes alcohol. Red wine in particular is a common migraine trigger.' },
      { when: n => n.tags.includes('tyramine'), verdict: VERDICT.CAUTION,
        rationale: 'RATIONALE: 숙성 치즈·가공육·젓갈 등 발효·숙성 식품에 많은 티라민은 혈관을 ' +
                   '수축·이완시켜 편두통을 유발하는 대표적 식이 트리거로 보고된다.',
        rationale_en: 'RATIONALE: Tyramine, abundant in aged and fermented foods such as aged cheese, cured ' +
                      'meats and salted seafood, constricts and dilates blood vessels and is reported as a ' +
                      'classic dietary migraine trigger.',
        msg: () => '숙성·발효·가공 식품이 있습니다(숙성치즈·젓갈·가공육 등). 편두통 유발 요인으로 흔히 보고됩니다.',
        msg_en: () => 'This meal contains aged, fermented or cured food (aged cheese, salted seafood, processed meat and the like), commonly reported as a migraine trigger.' }
    ],
    note: '편두통 유발 식품은 사람마다 크게 다릅니다. 이 항목은 흔히 보고되는 요인만 안내하며, 본인만의 유발 식품 일지를 따로 기록하시는 것이 가장 정확합니다.',
    note_en: 'Migraine trigger foods vary greatly from person to person. This item only flags commonly reported ' +
             'triggers — keeping your own food diary is by far the most accurate approach.'
  },

  {
    id: 'insomnia', name: '불면증·수면장애', name_en: 'Insomnia / Sleep Trouble',
    focus: '카페인·알코올', focus_en: 'caffeine and alcohol',
    rules: [
      hi('caffeine_mg', 100, 200,
        'RATIONALE: 카페인의 반감기는 약 5~6시간으로, 늦은 시간 섭취하면 취침 시점까지 절반 ' +
        '이상이 체내에 남는다. 이 앱은 섭취 시각을 알 수 없으므로 보수적으로 100mg(커피 한 잔 ' +
        '미만) 부근부터 주의를 둔다.',
        { caution: v => `카페인이 ${v}mg입니다. 오후 늦게 드셨다면 잠들기 어려울 수 있습니다.`,
          avoid:   v => `카페인이 ${v}mg으로 많습니다. 저녁 이후라면 수면에 직접 영향을 줍니다.` },
        { rationale_en:
            'RATIONALE: Caffeine has a half-life of about 5-6 hours, so a late intake leaves more than half ' +
            'of it in the body at bedtime. This app cannot know what time you ate, so caution is set ' +
            'conservatively from around 100mg (less than one cup of coffee).',
          msg_en: {
            caution: v => `Caffeine is ${v}mg. If you had this late in the day, you may have trouble falling asleep.`,
            avoid:   v => `Caffeine is a high ${v}mg. In the evening or later, this directly affects your sleep.` } })
    ],
    flags: [
      { when: n => n.alcohol, verdict: VERDICT.CAUTION,
        rationale: 'RATIONALE: 알코올은 입면은 도와도 수면 후반부의 얕은 수면과 각성을 늘려 ' +
                   '총 수면의 질을 떨어뜨린다.',
        rationale_en: 'RATIONALE: Alcohol helps you fall asleep but increases light sleep and awakenings in the ' +
                      'second half of the night, lowering overall sleep quality.',
        msg: () => '술이 포함돼 있습니다. 잠들기는 쉬워져도 새벽에 자주 깨게 됩니다.',
        msg_en: () => 'This meal includes alcohol. It makes falling asleep easier but you will wake often in the early morning.' }
    ]
  },

  {
    id: 'pms', name: '생리전증후군(PMS)·생리통', name_en: 'PMS / Menstrual Pain',
    focus: '나트륨·카페인', focus_en: 'sodium and caffeine',
    rules: [
      hi('sodium_mg', 700, 1200,
        'RATIONALE: 나트륨은 생리 전 수분 저류(부종·복부 팽만)를 악화시킨다는 보고가 일관적이다. ' +
        '평소 고혈압 기준(500/900mg)보다 다소 여유를 둔 완화 기준이다.',
        { caution: v => `나트륨이 ${v}mg입니다. 생리 전에는 평소보다 붓기가 쉽게 심해집니다.`,
          avoid:   v => `나트륨이 ${v}mg으로 많습니다. 부종·팽만감이 더 심해질 수 있습니다.` },
        { rationale_en:
            'RATIONALE: Reports consistently find that sodium worsens premenstrual fluid retention (swelling ' +
            'and bloating). These are relaxed thresholds, somewhat looser than the usual hypertension ' +
            'thresholds (500/900mg).',
          msg_en: {
            caution: v => `Sodium is ${v}mg. Before your period, swelling worsens more easily than usual.`,
            avoid:   v => `Sodium is a high ${v}mg. Swelling and bloating may get noticeably worse.` } }),
      hi('caffeine_mg', 200, 300,
        'RATIONALE: 카페인은 유방 압통·불안·과민성을 악화시킨다는 보고가 있다.',
        { caution: v => `카페인이 ${v}mg입니다. 예민함이나 두통이 더해질 수 있습니다.`,
          avoid:   v => `카페인이 ${v}mg으로 많습니다.` },
        { rationale_en:
            'RATIONALE: Caffeine has been reported to worsen breast tenderness, anxiety and irritability.',
          msg_en: {
            caution: v => `Caffeine is ${v}mg. It may add to irritability or headache.`,
            avoid:   v => `Caffeine is a high ${v}mg.` } })
    ]
  },

  {
    id: 'stones', name: '요로결석(신장결석)', name_en: 'Kidney Stones',
    focus: '나트륨·퓨린', focus_en: 'sodium and purines',
    rules: [
      hi('sodium_mg', 700, 1200,
        'RATIONALE: 나트륨 과잉 섭취는 소변 내 칼슘 배설을 늘려 가장 흔한 유형인 칼슘결석의 ' +
        '위험을 직접 높인다.',
        { caution: v => `나트륨이 ${v}mg입니다. 소변으로 빠져나가는 칼슘이 늘어 결석 위험을 높입니다.`,
          avoid:   v => `나트륨이 ${v}mg으로 많습니다. 결석 재발 병력이 있다면 특히 주의하세요.` },
        { rationale_en:
            'RATIONALE: Excess sodium intake increases urinary calcium excretion, directly raising the risk ' +
            'of calcium stones, the most common type.',
          msg_en: {
            caution: v => `Sodium is ${v}mg. More calcium leaves in the urine, which raises stone risk.`,
            avoid:   v => `Sodium is a high ${v}mg. Be especially careful if you have had stones before.` } }),
      hi('purine_mg', 200, 400,
        'RATIONALE: 퓨린 대사산물인 요산은 요산결석의 직접 원인이다. 통풍(gout)과 같은 축을 ' +
        '쓰되 결석 예방 목적에서는 조금 더 여유를 둔다.',
        { caution: v => `퓨린이 ${v}mg입니다.`,
          avoid:   v => `퓨린이 ${v}mg으로 많습니다. 요산결석 위험을 높입니다.` },
        { rationale_en:
            'RATIONALE: Uric acid, the end product of purine metabolism, is the direct cause of uric acid ' +
            'stones. The same axis as gout is used, with a little more room since the goal here is stone ' +
            'prevention.',
          msg_en: {
            caution: v => `Purines are ${v}mg.`,
            avoid:   v => `Purines are a high ${v}mg, which raises the risk of uric acid stones.` } })
    ],
    note: '결석 예방에서 가장 중요한 것은 하루 2~2.5L 이상의 수분 섭취입니다. 이 판정은 음식 성분만 보며 물 섭취량은 반영하지 않으니 별도로 챙기세요.',
    note_en: 'The single most important thing for preventing stones is drinking 2-2.5L of fluid a day or more. ' +
             'This check looks only at what is in the food and does not track how much you drink, so keep an eye on that separately.'
  },

  {
    id: 'oa', name: '퇴행성관절염(골관절염)', name_en: 'Osteoarthritis',
    focus: '포화지방·당류(근거 약함)', focus_en: 'saturated fat and sugars (weak evidence)',
    /* 항염 식이가 관절염 통증에 미치는 임상 효과는 근거 수준이 중등도 이하다.
       그래도 흔한 조건까지 폭넓게 다루기 위해 넣되, 메시지에서 근거 수준을 분명히 밝힌다. */
    rules: [
      hi('satfat_g', 10, 18,
        'RATIONALE: 포화지방이 전신 염증 지표(CRP 등)를 높인다는 관찰 연구가 있으나 ' +
        '관절염 통증에 대한 직접 개입 효과는 근거 수준이 약하다. 참고용으로만 제시한다.',
        { caution: v => `포화지방이 ${v}g입니다. 염증 관련 지표를 높일 수 있다는 관찰 연구가 있습니다(근거는 약함).`,
          avoid:   v => `포화지방이 ${v}g으로 많습니다.` },
        { rationale_en:
            'RATIONALE: Observational studies link saturated fat to higher systemic inflammatory markers ' +
            '(CRP and others), but the evidence for a direct effect of intervention on arthritis pain is ' +
            'weak. Presented for reference only.',
          msg_en: {
            caution: v => `Saturated fat is ${v}g. Observational studies suggest it may raise inflammatory markers (the evidence is weak).`,
            avoid:   v => `Saturated fat is a high ${v}g.` } }),
      hi('sugar_g', 25, 40,
        'RATIONALE: 정제당 과다 섭취와 염증 지표 상승의 연관성이 관찰되나 인과관계는 확립되지 않았다.',
        { caution: v => `당류가 ${v}g입니다(근거는 약함, 참고용).`,
          avoid:   v => `당류가 ${v}g으로 많습니다.` },
        { rationale_en:
            'RATIONALE: An association between high refined sugar intake and raised inflammatory markers has ' +
            'been observed, but causation is not established.',
          msg_en: {
            caution: v => `Sugars are ${v}g (weak evidence, for reference only).`,
            avoid:   v => `Sugars are a high ${v}g.` } })
    ],
    note: '이 항목의 근거 수준은 다른 항목보다 약합니다. 체중 관리와 관절에 무리 없는 운동이 식이보다 더 확실한 효과가 있습니다.',
    note_en: 'The evidence behind this item is weaker than for the others. Weight management and joint-friendly ' +
             'exercise have a far more reliable effect than diet.'
  },

  {
    id: 'acne', name: '여드름·피부트러블', name_en: 'Acne / Skin Trouble',
    focus: '당류·유제품(근거 약함)', focus_en: 'sugars and dairy (weak evidence)',
    rules: [
      hi('sugar_g', 25, 40,
        'RATIONALE: 고혈당지수 식이가 인슐린·IGF-1을 자극해 피지 분비를 늘린다는 연구가 있으나 ' +
        '개인차가 크고 인과관계의 크기는 작다. 참고용으로만 제시한다.',
        { caution: v => `당류가 ${v}g입니다(근거는 약함, 참고용).`,
          avoid:   v => `당류가 ${v}g으로 많습니다.` },
        { rationale_en:
            'RATIONALE: Studies suggest that a high-glycemic-index diet stimulates insulin and IGF-1 and ' +
            'increases sebum production, but individual variation is large and the effect size is small. ' +
            'Presented for reference only.',
          msg_en: {
            caution: v => `Sugars are ${v}g (weak evidence, for reference only).`,
            avoid:   v => `Sugars are a high ${v}g.` } })
    ],
    flags: [
      { when: n => n.tags.includes('dairy'), verdict: VERDICT.CAUTION,
        rationale: 'RATIONALE: 유제품, 특히 저지방 우유와 여드름의 연관성이 일부 관찰 연구에서 ' +
                   '보고되나 근거 수준은 낮고 논쟁이 있다.',
        rationale_en: 'RATIONALE: Some observational studies report an association between dairy — low-fat milk ' +
                      'in particular — and acne, but the evidence is weak and disputed.',
        msg: () => '유제품이 있습니다. 일부 연구에서 여드름과의 연관성이 보고되지만 근거는 약합니다.',
        msg_en: () => 'This meal contains dairy. Some studies report a link with acne, but the evidence is weak.' }
    ],
    note: '피부 트러블의 원인은 대부분 식이 외 요인(호르몬·스트레스·피부관리)이 더 큽니다. 이 항목은 참고용입니다.',
    note_en: 'Most skin trouble is driven by factors other than diet (hormones, stress, skin care). This item is ' +
             'for reference only.'
  },

  {
    id: 'lactose', name: '유당불내증', name_en: 'Lactose Intolerance', focus: '유제품', focus_en: 'dairy',
    rules: [],
    flags: [
      { when: n => n.tags.includes('dairy'), verdict: VERDICT.CAUTION,
        rationale: 'RATIONALE: 국내 성인 유당불내증 유병률은 약 31.9%로 보고되며, 대부분 증상이 ' +
                   '경미한 수준에 그친다. 유당분해효소 보충이나 소량 섭취로 관리 가능한 경우가 많아 ' +
                   '면역 반응인 우유 알레르기와 달리 "피함"이 아닌 "주의"로 둔다.',
        rationale_en: 'RATIONALE: Lactose intolerance is reported in about 31.9% of Korean adults, and symptoms ' +
                      'are mild in most cases. It can often be managed with a lactase supplement or by keeping ' +
                      'portions small, so unlike milk allergy — an immune reaction — this is set to "caution" ' +
                      'rather than "avoid".',
        msg: () => '유제품이 있습니다. 양이 많으면 복부 팽만·설사가 생길 수 있습니다. 소량이거나 유당을 분해한 유제품이면 대부분 괜찮습니다.',
        msg_en: () => 'This meal contains dairy. A large amount can cause bloating or diarrhea. A small serving, or a lactose-free product, is usually fine.' }
    ]
  },

  {
    id: 'celiac', name: '글루텐 민감증·셀리악병', name_en: 'Gluten Sensitivity / Celiac Disease',
    focus: '밀·보리·호밀(글루텐)', focus_en: 'wheat, barley and rye (gluten)',
    rules: [],
    flags: [
      { when: n => n.tags.includes('gluten'), verdict: VERDICT.AVOID,
        rationale: 'RATIONALE: 셀리악병은 글루텐이 소장 점막을 직접 손상시키는 자가면역질환으로, ' +
                   '미량 섭취도 누적 손상을 일으킬 수 있어 완전 회피가 원칙이다. 비셀리악 글루텐 ' +
                   '민감증도 증상 관리를 위해 통상 회피를 권장한다.',
        rationale_en: 'RATIONALE: Celiac disease is an autoimmune condition in which gluten directly damages the ' +
                      'small intestinal mucosa. Even trace amounts can cause cumulative damage, so complete ' +
                      'avoidance is the rule. Non-celiac gluten sensitivity is also generally managed by ' +
                      'avoidance to control symptoms.',
        msg: () => '밀가루·보리 등 글루텐이 든 재료가 있습니다. 면·빵·튀김옷 등에 흔히 섞여 있으니 확인하세요.',
        msg_en: () => 'This meal contains gluten-bearing ingredients such as wheat flour or barley. They are common in noodles, bread and batter, so check the ingredients.' }
    ],
    note: '셀리악병 확진자는 미량 교차오염도 위험할 수 있습니다. 이 판정은 주재료 기준이며 조리 과정의 교차오염까지는 확인하지 못합니다.',
    note_en: 'For someone with confirmed celiac disease, even trace cross-contamination can be a risk. This check ' +
             'looks at the main ingredients and cannot detect cross-contamination during cooking.'
  },

  {
    id: 'allerg_peanut', name: '땅콩 알레르기', name_en: 'Peanut Allergy', focus: '땅콩', focus_en: 'peanuts',
    rules: [],
    flags: [
      { when: n => n.tags.includes('peanut'), verdict: VERDICT.AVOID,
        rationale: 'RATIONALE: 땅콩 알레르기는 아나필락시스 위험이 높은 대표적 식품 알레르기로, ' +
                   '식품의약품안전처가 지정한 알레르기 유발물질 표시 대상이다. 소량도 위험할 수 있어 ' +
                   '회피를 원칙으로 한다.',
        rationale_en: 'RATIONALE: Peanut allergy is the classic food allergy with a high risk of anaphylaxis and ' +
                      'is on the Korean MFDS list of allergens requiring label declaration. Even a small ' +
                      'amount can be dangerous, so avoidance is the rule.',
        msg: () => '땅콩이 들어 있습니다. 소량이라도 심한 알레르기 반응을 일으킬 수 있습니다.',
        msg_en: () => 'This meal contains peanuts. Even a small amount can cause a severe allergic reaction.' }
    ]
  },

  {
    id: 'allerg_treenut', name: '견과류 알레르기', name_en: 'Tree Nut Allergy',
    focus: '호두·아몬드 등 견과류', focus_en: 'tree nuts such as walnuts and almonds',
    rules: [],
    flags: [
      { when: n => n.tags.includes('treenut'), verdict: VERDICT.AVOID,
        rationale: 'RATIONALE: 견과류 알레르기는 땅콩 알레르기와 원인 단백질이 달라 별도로 ' +
                   '관리해야 하며, 식약처 지정 알레르기 유발물질 표시 대상이다.',
        rationale_en: 'RATIONALE: Tree nut allergy involves different causative proteins from peanut allergy and ' +
                      'must be managed separately. Tree nuts are on the Korean MFDS list of allergens ' +
                      'requiring label declaration.',
        msg: () => '호두·아몬드 등 견과류가 들어 있습니다.',
        msg_en: () => 'This meal contains tree nuts such as walnuts or almonds.' }
    ]
  },

  {
    id: 'allerg_shellfish', name: '갑각류·조개류 알레르기', name_en: 'Shellfish Allergy',
    focus: '새우·게·조개·오징어 등', focus_en: 'shrimp, crab, clams, squid and the like',
    rules: [],
    flags: [
      { when: n => n.tags.includes('shellfish'), verdict: VERDICT.AVOID,
        rationale: 'RATIONALE: 갑각류·연체동물 알레르기는 성인 식품 알레르기 중 흔한 유형이며, ' +
                   '식약처 지정 알레르기 유발물질(새우·게·오징어·조개류)을 하나의 항목으로 묶었다.',
        rationale_en: 'RATIONALE: Crustacean and mollusk allergy is one of the more common food allergies in ' +
                      'adults. The MFDS-declared allergens (shrimp, crab, squid, shellfish) are grouped ' +
                      'here into a single item.',
        msg: () => '새우·게·조개·오징어 등이 들어 있습니다.',
        msg_en: () => 'This meal contains shrimp, crab, clams, squid or similar.' }
    ]
  },

  {
    id: 'allerg_egg', name: '계란 알레르기', name_en: 'Egg Allergy', focus: '계란', focus_en: 'eggs',
    rules: [],
    flags: [
      { when: n => n.tags.includes('egg'), verdict: VERDICT.AVOID,
        rationale: 'RATIONALE: 계란은 소아 식품 알레르기의 가장 흔한 원인 중 하나이며, ' +
                   '빵·면·소스 등에 숨어 들어가는 경우가 많아 확인이 특히 중요하다.',
        rationale_en: 'RATIONALE: Egg is one of the most common causes of food allergy in children, and it is ' +
                      'often hidden in bread, noodles and sauces, so checking matters especially here.',
        msg: () => '계란이 들어 있습니다. 튀김옷·소스에도 흔히 섞여 있으니 확인하세요.',
        msg_en: () => 'This meal contains egg. It is also common in batter and sauces, so check the ingredients.' }
    ]
  },

  {
    id: 'allerg_milk', name: '우유·유제품 알레르기', name_en: 'Milk / Dairy Allergy',
    focus: '우유 단백질', focus_en: 'milk protein',
    rules: [],
    flags: [
      { when: n => n.tags.includes('dairy'), verdict: VERDICT.AVOID,
        rationale: 'RATIONALE: 우유 알레르기는 유당불내증과 원인이 다르다(면역 반응 대 소화효소 ' +
                   '부족). 면역 반응이므로 소량도 반응을 일으킬 수 있어, 같은 유제품 태그를 쓰지만 ' +
                   '유당불내증과 달리 "피함"을 기본으로 둔다.',
        rationale_en: 'RATIONALE: Milk allergy has a different cause from lactose intolerance (an immune ' +
                      'reaction versus a missing digestive enzyme). Because it is an immune reaction, even a ' +
                      'small amount can provoke a response — so although it uses the same dairy tag, unlike ' +
                      'lactose intolerance it defaults to "avoid".',
        msg: () => '우유·유제품이 들어 있습니다. 유당불내증과 달리 소량도 반응을 일으킬 수 있습니다.',
        msg_en: () => 'This meal contains milk or dairy. Unlike lactose intolerance, even a small amount can trigger a reaction.' }
    ]
  },

  {
    id: 'allerg_soy', name: '대두(콩) 알레르기', name_en: 'Soy Allergy',
    focus: '대두·두부·된장 등', focus_en: 'soybeans, tofu, soybean paste and the like',
    rules: [],
    flags: [
      { when: n => n.tags.includes('soy'), verdict: VERDICT.AVOID,
        rationale: 'RATIONALE: 대두는 두부·된장·간장 등 한식 기본 재료에 광범위하게 쓰여 회피가 ' +
                   '까다로운 알레르기 유발물질이다. 식약처 지정 알레르기 유발물질 표시 대상이다.',
        rationale_en: 'RATIONALE: Soy runs through the staple ingredients of Korean cooking — tofu, doenjang, ' +
                      'soy sauce — which makes it a difficult allergen to avoid. It is on the Korean MFDS ' +
                      'list of allergens requiring label declaration.',
        msg: () => '대두(콩)가 들어 있습니다. 두부·된장·간장 등에 흔히 들어 있으니 확인하세요.',
        msg_en: () => 'This meal contains soy. It is common in tofu, doenjang and soy sauce, so check the ingredients.' }
    ]
  }
];

export const DISEASE_BY_ID = Object.fromEntries(DISEASES.map(d => [d.id, d]));

/* 화면에서 15개를 한 줄로 늘어놓으면 찾기 어렵다. 신체 계통으로 묶는다.
   임신은 질환이 아니므로 '생리 상태'로 따로 둔다. */
export const DISEASE_GROUPS = [
  { label: '심장·혈관',   label_en: 'Heart & Vascular',   ids: ['htn', 'cad', 'hf', 'lipid'] },
  { label: '대사',        label_en: 'Metabolic',          ids: ['dm', 'prediab', 'nafld', 'gout'] },
  { label: '콩팥·요로',   label_en: 'Kidney & Urinary',   ids: ['ckd', 'stones'] },
  { label: '뼈·피',       label_en: 'Bone & Blood',       ids: ['osteo', 'anemia', 'thyroid'] },
  { label: '관절·피부',   label_en: 'Joints & Skin',      ids: ['oa', 'acne'] },
  { label: '소화·삼킴',   label_en: 'Digestive & Swallowing', ids: ['gerd', 'dysph', 'celiac', 'lactose'] },
  { label: '신경·수면',   label_en: 'Neurological & Sleep',   ids: ['migraine', 'insomnia'] },
  { label: '약물·생리 상태', label_en: 'Medication & Physiological', ids: ['warf', 'preg', 'pms'] },
  { label: '식품 알레르기', label_en: 'Food Allergies', ids: ['allerg_peanut', 'allerg_treenut', 'allerg_shellfish', 'allerg_egg', 'allerg_milk', 'allerg_soy'] }
];

/* ────────────────────────────────────────────────────────────
   충돌 규칙 — 두 질환의 권고가 반대 방향일 때
   ──────────────────────────────────────────────────────────── */
export const CONFLICTS = [
  {
    id: 'potassium',
    when: ids => ids.includes('ckd') && (ids.includes('htn') || ids.includes('hf')),
    winner: 'ckd',
    suppressBonusOn: ['htn'],
    msg: '고혈압에는 칼륨이 이롭지만 만성콩팥병에서는 위험합니다. ' +
         '고칼륨혈증은 부정맥으로 바로 이어질 수 있어 콩팥병 기준을 우선 적용했습니다.',
    msg_en: 'Potassium is good for blood pressure but dangerous in chronic kidney disease. ' +
            'Because hyperkalemia can lead straight to arrhythmia, the kidney thresholds were applied first.'
  },
  {
    id: 'protein',
    when: ids => ids.includes('ckd') && ids.includes('osteo'),
    winner: 'ckd',
    msg: '골다공증에는 단백질이 필요하지만 만성콩팥병에서는 제한합니다. ' +
         '콩팥병 기준을 우선했으니 뼈 건강은 칼슘·비타민D로 보완하세요.',
    msg_en: 'Osteoporosis needs protein, but chronic kidney disease restricts it. The kidney thresholds took ' +
            'priority, so support your bones with calcium and vitamin D instead.'
  },
  {
    id: 'vitk',
    when: ids => ids.includes('warf') && ids.length > 1,
    winner: null,
    msg: '와파린은 다른 질환과 판정 방식이 다릅니다. 다른 질환에 좋은 녹색채소가 ' +
         '와파린에는 "양을 일정하게 유지하라"는 뜻이 됩니다. 끊으라는 뜻이 아닙니다.',
    msg_en: 'Warfarin is judged differently from the other conditions. Green vegetables that are good for ' +
            'your other conditions mean "keep the amount steady" on warfarin — not "stop eating them".'
  },
  {
    id: 'fluid',
    when: ids => ids.includes('hf') && ids.includes('dysph'),
    winner: null,
    msg: '심부전은 수분을 줄여야 하고, 연하곤란은 액체를 걸쭉하게 만들어야 합니다. ' +
         '두 조건이 겹치면 국물은 줄이되 마시는 물은 점도증진제를 쓰세요.',
    msg_en: 'Heart failure calls for less fluid, while dysphagia calls for thickened liquids. With both, cut ' +
            'back on broth but thicken the water you do drink with a thickening agent.'
  },
  {
    id: 'iron_calcium',
    when: ids => ids.includes('anemia') && ids.includes('osteo'),
    winner: null,
    msg: '골다공증에는 칼슘이 필요하지만 칼슘은 철 흡수를 방해합니다. 끊으라는 뜻이 아니라 ' +
         '시간을 나누라는 뜻입니다. 유제품은 간식으로, 철분 음식은 식사로 나눠 드세요.',
    msg_en: 'Osteoporosis needs calcium, but calcium blocks iron absorption. This does not mean giving either ' +
            'up — it means separating them in time. Have dairy as a snack and iron-rich food at meals.'
  },
  {
    id: 'iodine_preg',
    when: ids => ids.includes('preg') && ids.includes('thyroid'),
    winner: 'thyroid',
    msg: '임신 중에는 요오드 요구량이 늘지만 갑상선 질환이 있으면 과잉이 더 위험합니다. ' +
         '둘 중 엄격한 갑상선 기준을 적용했습니다. 요오드 보충제 여부는 반드시 담당의와 상의하세요.',
    msg_en: 'Iodine requirements rise in pregnancy, but with thyroid disease an excess is the greater danger. ' +
            'The stricter thyroid thresholds were applied. Always discuss iodine supplements with your doctor.'
  },
  {
    id: 'preg_energy',
    when: ids => ids.includes('preg') && ids.includes('nafld'),
    winner: null,
    msg: '임신 중에는 체중 감량을 목표로 하지 않습니다. 지방간 기준의 열량 경고가 뜨더라도 ' +
         '임신 중 식사량을 임의로 줄이지 마시고 담당의와 상의하세요.',
    msg_en: 'Weight loss is not a goal during pregnancy. Even if the fatty liver calorie warning appears, do ' +
            'not cut back your food intake on your own — talk to your doctor.'
  }
];

/* ────────────────────────────────────────────────────────────
   판정 실행
   ──────────────────────────────────────────────────────────── */

/** 값을 보기 좋게 반올림 (mg/µg은 정수, g은 소수 1자리) */
function fmt(axis, v) {
  const unit = AXES[axis]?.unit;
  return (unit === 'g') ? Math.round(v * 10) / 10 : Math.round(v);
}

/**
 * 프로필에 맞춰 임계값을 조정한다.
 * 체중이 입력됐고 perKg가 정의된 축이면 체중 비례로 갈아끼우고,
 * 나이가 입력됐으면 연령 계수를 곱한다. 아무것도 없으면 원래 값 그대로.
 */
export function thresholds(rule, prof, lang = 'ko') {
  let c = rule.caution, a = rule.avoid;
  let scaledBy = null;
  const en = lang === 'en';

  if (rule.perKg && prof.weightGiven) {
    c = rule.perKg.caution * prof.weightKg;
    a = rule.perKg.avoid * prof.weightKg;
    scaledBy = en ? `weight ${prof.weightKg}kg` : `체중 ${prof.weightKg}kg`;
  }
  if (rule.ageScaled !== false && prof.ageYears != null) {
    const f = ageFactor(prof.ageYears);
    if (f !== 1) {
      c *= f; a *= f;
      const agePart = en ? `age ${prof.ageYears}` : `나이 ${prof.ageYears}세`;
      scaledBy = scaledBy ? `${scaledBy}·${agePart}` : agePart;
    }
  }
  const r = v => Math.round(v * 10) / 10;
  return { caution: r(c), avoid: r(a), scaledBy };
}

function levelOf(th, value) {
  if (value >= th.avoid) return VERDICT.AVOID;
  if (value >= th.caution) return VERDICT.CAUTION;
  return VERDICT.GOOD;
}

/**
 * @param {object} n  식사 전체의 영양 합계.
 *   { sodium_mg, potassium_mg, ..., textures:[], irritants:[], tags:[], alcohol:bool }
 * @param {string[]} diseaseIds  선택한 질환·상태 id 배열
 * @param {object} [profileInput]  { weightKg, sex, ageYears } — 전부 선택 사항
 * @param {'ko'|'en'} [lang]  출력 문장의 언어. 기본은 한국어 —
 *   인자를 넘기지 않던 기존 호출은 예전과 완전히 같은 결과를 받는다.
 *   판정 로직(임계값·비교·순위)은 언어와 무관하며, 바뀌는 것은 문장뿐이다.
 * @returns {{byDisease, overall, overallComment, tips, conflicts, profile, notes}}
 */
export function evaluate(n, diseaseIds, profileInput = {}, lang = 'ko') {
  const nutri = normalize(n);
  const prof = resolveProfile(profileInput);
  const en = lang === 'en';
  const active = CONFLICTS.filter(c => c.when(diseaseIds));
  const suppressedBonus = new Set(active.flatMap(c => c.suppressBonusOn || []));

  const byDisease = diseaseIds.map(id => {
    const d = DISEASE_BY_ID[id];
    if (!d) return null;

    const triggers = [];
    let verdict = VERDICT.GOOD;

    /* 수치형 룰 */
    for (const r of d.rules) {
      const raw = nutri[r.axis];
      if (raw == null) continue;
      const th = thresholds(r, prof, lang);
      const lv = levelOf(th, raw);
      if (lv === VERDICT.GOOD) continue;
      const shown = fmt(r.axis, raw);
      const msg = (en && r.msg_en) ? r.msg_en : r.msg;
      triggers.push({
        kind: 'numeric', axis: r.axis, label: axisLabel(r.axis, lang), unit: AXES[r.axis].unit,
        value: shown, threshold: lv === VERDICT.AVOID ? th.avoid : th.caution,
        scaledBy: th.scaledBy,
        level: lv, text: msg[lv](shown), rationale: (en && r.rationale_en) ? r.rationale_en : r.rationale
      });
      verdict = worse(verdict, lv);
    }

    /* 플래그형 룰 (알코올·질감·자극성) */
    for (const f of (d.flags || [])) {
      if (!f.when(nutri)) continue;
      triggers.push({
        kind: 'flag', level: f.verdict,
        text: ((en && f.msg_en) ? f.msg_en : f.msg)(nutri),
        rationale: (en && f.rationale_en) ? f.rationale_en : f.rationale
      });
      verdict = worse(verdict, f.verdict);
    }

    /* 긍정 요소 (충돌로 무효화되지 않은 경우만) */
    const positives = [];
    if (d.bonus && !suppressedBonus.has(d.id)) {
      const v = nutri[d.bonus.axis];
      if (v != null && v >= d.bonus.min) {
        positives.push(((en && d.bonus.msg_en) ? d.bonus.msg_en : d.bonus.msg)(fmt(d.bonus.axis, v)));
      }
    }
    if (d.lowNote) {
      const v = nutri[d.lowNote.axis];
      if (v != null && v < d.lowNote.below) {
        positives.push(((en && d.lowNote.msg_en) ? d.lowNote.msg_en : d.lowNote.msg)());
      }
    }

    /* 사람이 읽을 이유 문장 — 가장 심한 트리거 최대 2개 */
    const sorted = [...triggers].sort((a, b) => RANK[b.level] - RANK[a.level]);
    let reason;
    if (sorted.length === 0) {
      reason = positives.length
        ? positives[0]
        : en
          ? `Nothing in this meal crosses the thresholds for ${d.focus_en || d.focus}.`
          : `${d.focus} 기준으로 문제될 만한 수치가 없습니다.`;
    } else {
      reason = sorted.slice(0, 2).map(t => t.text).join(' ');
    }

    /* disease는 늘 한국어 원문이다 — app.js의 질환 매칭이 이 값을 쓴다.
       화면에 영어로 그릴 때 쓰라고 disease_en을 나란히 얹어 준다. */
    return {
      id: d.id, disease: d.name, disease_en: d.name_en || d.name, verdict, reason,
      triggers: sorted, positives, inverted: !!d.inverted,
      note: (en && d.note_en) ? d.note_en : (d.note || null)
    };
  }).filter(Boolean);

  /* overall = 가장 나쁜 판정.
     단 와파린은 성격이 다르므로(금지가 아닌 일관성 경고) overall을 끌어내리지 않는다. */
  const overall = byDisease
    .filter(r => !r.inverted)
    .reduce((acc, r) => worse(acc, r.verdict), VERDICT.GOOD);

  return {
    byDisease,
    overall,
    overallComment: buildComment(overall, byDisease, lang),
    tips: buildTips(byDisease, nutri, lang),
    conflicts: active.map(c => ({ id: c.id, msg: (en && c.msg_en) ? c.msg_en : c.msg, winner: c.winner })),
    profile: prof,
    notes: byDisease.filter(r => r.note).map(r => ({ disease: r.disease, msg: r.note }))
  };
}

/** 입력 누락에 강하게 — 없는 축은 0, 배열은 빈 배열로 채운다 */
export function normalize(n = {}) {
  const out = {};
  for (const axis of Object.keys(AXES)) out[axis] = Number(n[axis]) || 0;
  out.textures  = Array.isArray(n.textures)  ? n.textures  : [];
  out.irritants = Array.isArray(n.irritants) ? n.irritants : [];
  out.tags      = Array.isArray(n.tags)      ? n.tags      : [];
  out.alcohol   = !!n.alcohol;
  return out;
}

function buildComment(overall, byDisease, lang = 'ko') {
  const en = lang === 'en';
  const name = r => (en ? (r.disease_en || r.disease) : r.disease);
  const bad = byDisease.filter(r => r.verdict === VERDICT.AVOID && !r.inverted).map(name);
  const mid = byDisease.filter(r => r.verdict === VERDICT.CAUTION && !r.inverted).map(name);

  if (overall === VERDICT.AVOID)
    return en
      ? `This meal is not recommended because of ${bad.join(', ')}. Read the reasons below and either cut the portion down or swap in a different dish.`
      : `${bad.join('·')} 때문에 이 식사는 권하지 않습니다. 아래 이유를 보시고 양을 줄이거나 다른 반찬으로 바꿔 보세요.`;
  if (overall === VERDICT.CAUTION)
    return en
      ? `${mid.join(', ')} calls for some care here. With the small adjustments below, this meal is fine to eat.`
      : `${mid.join('·')}에 주의가 필요합니다. 아래 방법대로 조금만 조절하시면 드셔도 괜찮습니다.`;
  return en
    ? 'Nothing in this meal stands out as a problem for the conditions you selected.'
    : '고르신 질환 기준으로 특별히 문제될 것이 없는 식사입니다.';
}

/** 트리거를 실천 가능한 문장으로 바꾼다. 중복은 제거한다.
    lang을 넘기면 같은 순서·같은 개수로 영어 문장이 담긴다 — 어떤 팁이 언제 뜨는지는
    언어와 무관하고, 담기는 문장만 바뀐다. */
function buildTips(byDisease, n, lang = 'ko') {
  const tips = new Set();
  const en = lang === 'en';
  const add = (ko, eng) => tips.add(en ? eng : ko);
  const hit = axis => byDisease.some(r => r.triggers.some(t => t.axis === axis));

  if (hit('sodium_mg')) {
    add('국물은 남기고 건더기만 드세요. 국물 한 그릇에 하루 나트륨의 절반이 들어 있습니다.',
        'Eat the solids and leave the broth. One bowl of broth can hold half a day\'s sodium.');
    if (n.textures.includes('mixed'))
      add('김치는 물에 한 번 헹궈 드시면 나트륨이 3분의 1가량 줄어듭니다.',
          'Rinsing kimchi in water once cuts its sodium by about a third.');
  }
  if (hit('potassium_mg'))
    add('채소는 잘게 썰어 물에 30분 담갔다가 데쳐서 그 물을 버리면 칼륨이 절반 가까이 빠집니다.',
        'Chop vegetables small, soak them for 30 minutes, then blanch and discard the water — that removes nearly half the potassium.');
  if (hit('phosphorus_mg'))
    add('가공식품·인스턴트에 든 인은 흡수가 잘 되니 자연식품 위주로 드세요.',
        'Phosphate additives in processed and instant food are absorbed very efficiently, so stick to whole foods.');
  if (hit('sugar_g') || hit('carb_g'))
    add('채소 반찬을 먼저 드시고 밥을 나중에 드시면 혈당이 천천히 오릅니다.',
        'Eat the vegetable side dishes first and the rice last — your blood glucose will rise more slowly.');
  if (hit('satfat_g') || hit('fat_g') || hit('cholesterol_mg'))
    add('고기는 기름 부위를 떼어내고, 국은 식혀서 굳은 기름을 걷어내세요.',
        'Trim the fat off meat, and chill soup so you can lift off the solidified fat.');
  if (hit('purine_mg'))
    add('퓨린은 국물에 많이 녹아 나옵니다. 탕·찌개는 건더기만 드시고 물을 충분히 드세요.',
        'A lot of purine dissolves into the broth. With soups and stews, eat the solids only and drink plenty of water.');
  if (hit('fluid_ml'))
    add('오늘 마신 물·국·음료를 합쳐서 세어 보세요. 컵에 눈금을 표시해 두면 편합니다.',
        'Add up all the water, soup and drinks you have had today. Marking a line on your cup makes it easier.');
  if (hit('vitk_ug'))
    add('녹색채소를 끊지 마시고, 매일 비슷한 양으로 드시는 것이 가장 중요합니다.',
        'Do not give up green vegetables — what matters most is eating a similar amount every day.');
  if (byDisease.some(r => r.id === 'dysph' && r.triggers.length > 0))
    add('식사 중에는 TV를 끄고, 한 입 삼킨 뒤 다음 입을 드세요. 턱을 살짝 당기면 사레가 줄어듭니다.',
        'Turn the TV off while eating and swallow each mouthful before taking the next. Tucking the chin slightly reduces choking.');
  if (hit('iodine_ug'))
    add('미역·다시마·김이 겹치지 않게 하루 한 가지만 드세요. 국물에 요오드가 특히 많이 우러납니다.',
        'Have only one seaweed a day rather than sea mustard, kelp and laver together. Iodine leaches especially heavily into broth.');
  if (hit('caffeine_mg'))
    add('커피·차는 식사와 1시간 이상 띄워서 드세요. 같이 마시면 철분 흡수가 크게 줄어듭니다.',
        'Leave at least an hour between meals and coffee or tea. Drinking them together sharply reduces iron absorption.');
  if (hit('vita_ug'))
    add('간·간유는 레티놀이 몰려 있습니다. 채소의 베타카로틴은 과잉 걱정이 없으니 그쪽으로 드세요.',
        'Liver and cod liver oil are packed with retinol. Beta-carotene from vegetables carries no risk of excess, so get your vitamin A there.');
  if (hit('kcal'))
    add('밥 양을 3분의 2로 줄이고 채소 반찬을 늘리면 포만감은 그대로면서 열량이 줄어듭니다.',
        'Cut the rice to two-thirds and add more vegetable side dishes — just as filling, fewer calories.');
  if (n.tags.includes('raw'))
    add('생식품은 익혀 드시면 감염 위험이 사라집니다. 회는 익힌 생선으로, 젓갈은 조리해서 드세요.',
        'Cooking raw foods removes the infection risk. Have cooked fish instead of sashimi, and cook salted seafood before eating it.');

  if (tips.size === 0)
    add('지금처럼 드시면 됩니다. 다음 끼니도 이 정도 짜기를 유지해 보세요.',
        'Carry on as you are. Try to keep the next meal about this lightly salted too.');
  return [...tips].slice(0, 4);
}

/* ────────────────────────────────────────────────────────────
   음식 목록 → 식사 전체 영양 합계
   ──────────────────────────────────────────────────────────── */
/**
 * @param {Array<{food:object, portion:number}>} items
 *   food는 foods-ko.json의 항목(또는 식약처 API에서 매핑된 동일 형태),
 *   portion은 제공량 배수(1 = 1인분, 0.5 = 반 그릇)
 */
export function sumMeal(items) {
  const total = { textures: [], irritants: [], tags: [], alcohol: false };
  for (const axis of Object.keys(AXES)) total[axis] = 0;

  for (const { food, portion = 1 } of items) {
    for (const axis of Object.keys(AXES)) {
      total[axis] += (Number(food[axis]) || 0) * portion;
    }
    /* 질감·자극성·태그는 합산이 아니라 합집합이다.
       떡이 반 개여도 질식 위험은 반으로 줄지 않는다. */
    if (food.texture && !total.textures.includes(food.texture)) total.textures.push(food.texture);
    for (const ir of (food.irritant || [])) {
      if (!total.irritants.includes(ir)) total.irritants.push(ir);
    }
    for (const tg of (food.tags || [])) {
      if (!total.tags.includes(tg)) total.tags.push(tg);
    }
    if (food.alcohol) total.alcohol = true;
  }
  return total;
}
