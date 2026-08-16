/**
 * 통합 검증 — node test/integration.test.mjs
 *
 * 데이터 계층(NutritionStore) → 합산(sumMeal) → 판정(evaluate)까지
 * 실제 앱과 같은 경로로 흘려 본다. 브라우저 fetch만 파일 읽기로 대체한다.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// NutritionStore가 쓰는 fetch를 로컬 파일 읽기로 대체
globalThis.fetch = async (url) => {
  const p = fileURLToPath(url);
  return { ok: true, status: 200, json: async () => JSON.parse(readFileSync(p, 'utf8')) };
};

const { NutritionStore, MFDS_PROFILES } = await import('../js/nutrition.js');
const { evaluate, sumMeal, verdictKo } = await import('../js/rules.js');

let pass = 0, fail = 0;
const check = (name, a, b) => {
  const ok = a === b; ok ? pass++ : fail++;
  console.log(`${ok ? '  ✓' : '  ✗'} ${name}${ok ? '' : `  →  기대 ${b}, 실제 ${a}`}`);
};

const store = new NutritionStore({ proxyUrl: '' });   // 프록시 없이 = 오프라인 모드
await store.ready();

console.log('\n── 검색');
check('"된장" 검색 시 된장찌개 매칭', store.search('된장')[0]?.id, 'doenjang_jjigae');
check('별칭 "밥"으로 흰쌀밥 매칭', store.search('밥')[0]?.id, 'rice_white');
check('별칭 "김치"로 배추김치 매칭', store.search('김치')[0]?.id, 'kimchi');
check('별칭 "술"로 소주 매칭', store.search('술')[0]?.id, 'soju');
check('별칭 "돼지국밥"으로 순대국 매칭', store.search('돼지국밥')[0]?.id, 'sundaeguk');
check('없는 음식은 빈 배열', store.search('푸아그라').length, 0);
check('빈 검색어는 빈 배열', store.search('').length, 0);
check('신규 음식도 검색됨 (에너지드링크)', store.search('에너지드링크')[0]?.id, 'energy_drink');
check('브랜드명 별칭으로도 검색 (핫식스)', store.search('핫식스')[0]?.id, 'energy_drink');
check('양식도 검색됨 (파스타)', store.search('파스타').length > 0, true);
/* 부분 포함 매칭은 의도된 동작이다. AI가 "김치찌개 백반"처럼 수식어를 붙여
   돌려주는 일이 흔한데, 이걸 못 잡으면 그 음식이 통째로 누락돼 판정이 관대해진다. */
check('수식어가 붙어도 매칭 ("얼큰 김치찌개")', store.search('얼큰 김치찌개')[0]?.id, 'kimchi_jjigae');

console.log('\n── CLIP 라벨');
const labels = store.clipLabels();
check('라벨 수 = 음식 수', labels.length, store.foods.length);
check('라벨 중복 없음', new Set(labels).size, labels.length);
check('라벨 역매핑 동작', store.byClipLabel(labels[3])?.id, store.foods[3].id);
check('라벨이 모두 영문 설명문', labels.every(l => /^[\x20-\x7E]+$/.test(l)), true);

console.log('\n── 프록시 없는 resolve (오프라인 모드)');
const rice = await store.resolve(store.byId('rice_white'));
check('내장값 그대로 반환', rice.sodium_mg, 3);
check('출처가 builtin으로 표시', rice._sources.sodium_mg, 'builtin');
check('식약처 조회 안 함', rice._mfdsName, null);

console.log('\n── 실사용 시나리오: 고혈압+당뇨 어르신의 한식 정식');
{
  const items = ['rice_white', 'doenjang_jjigae', 'kimchi', 'godeungeo_gui', 'sigeumchi_namul']
    .map(id => ({ food: store.byId(id), portion: 1 }));
  const meal = sumMeal(items);
  const res = evaluate(meal, ['htn', 'dm']);

  console.log(`     나트륨 합계 ${Math.round(meal.sodium_mg)}mg / 판정 ${verdictKo(res.overall)}`);
  check('나트륨 합산이 개별 합과 일치',
    Math.round(meal.sodium_mg), 3 + 1150 + 320 + 480 + 220);
  check('고혈압 avoid (나트륨 2173mg)', res.byDisease.find(d => d.id === 'htn').verdict, 'avoid');
  check('당뇨 good (탄수 82g은 caution 미만... 확인)',
    ['good', 'caution'].includes(res.byDisease.find(d => d.id === 'dm').verdict), true);
  check('팁에 국물 안내 포함', res.tips.some(t => t.includes('국물')), true);
  check('모든 근거가 UI에 표시 가능한 형태',
    res.byDisease.every(d => d.triggers.every(t => t.text && t.rationale)), true);
}

console.log('\n── 실사용 시나리오: 콩팥병+고혈압 어르신이 바나나와 감자를 드심');
{
  const items = [{ food: store.byId('banana'), portion: 1 },
                 { food: store.byId('potato'), portion: 1 }];
  const meal = sumMeal(items);
  const res = evaluate(meal, ['ckd', 'htn']);
  console.log(`     칼륨 합계 ${Math.round(meal.potassium_mg)}mg / 판정 ${verdictKo(res.overall)}`);
  check('칼륨 1050mg → 콩팥병 avoid', res.byDisease.find(d => d.id === 'ckd').verdict, 'avoid');
  check('충돌 안내 노출', res.conflicts.some(c => c.id === 'potassium'), true);
  check('칼륨 저감 팁 제공', res.tips.some(t => t.includes('데쳐')), true);
}

console.log('\n── 실사용 시나리오: 연하곤란 어르신께 떡과 견과류');
{
  const items = [{ food: store.byId('tteok'), portion: 1 },
                 { food: store.byId('nuts'), portion: 1 }];
  const res = evaluate(sumMeal(items), ['dysph']);
  check('연하곤란 avoid', res.byDisease[0].verdict, 'avoid');
  check('질식 경고 문구 포함', /질식|끈적/.test(res.byDisease[0].reason), true);
}

console.log('\n── 출처 통계');
{
  const foods = [store.byId('rice_white'), store.byId('kimchi')];
  const pv = NutritionStore.provenance(foods);
  check('프록시 미사용 시 식약처 비율 0%', pv.pct, 0);
  check('집계 대상 축이 존재', pv.total > 0, true);
}

console.log('\n── 실사용 시나리오: 임신 34주 직장인의 점심 (커피 포함)');
{
  const items = ['kimbap', 'coffee'].map(id => ({ food: store.byId(id), portion: 1 }));
  const meal = sumMeal(items);
  const res = evaluate(meal, ['preg'], { weightKg: 63, ageYears: 31, sex: 'f' });
  console.log(`     카페인 ${Math.round(meal.caffeine_mg)}mg / 판정 ${verdictKo(res.overall)}`);
  check('커피 포함 시 임신 caution', res.byDisease[0].verdict, 'caution');
  check('카페인 팁 제공', res.tips.some(t => t.includes('커피')), true);
  check('프로필이 결과에 반영', res.profile.weightGiven, true);
}

console.log('\n── 실사용 시나리오: 산후조리 미역국 (임신·수유 + 갑상선)');
{
  // 산후 미역국을 매 끼 먹는 관습이 실제로 요오드 상한을 넘긴다
  const res = evaluate(sumMeal([{ food: store.byId('miyeokguk'), portion: 1 }]),
                       ['preg', 'thyroid']);
  check('미역국 한 그릇으로 임신 avoid', res.byDisease.find(d => d.id === 'preg').verdict, 'avoid');
  check('갑상선도 avoid', res.byDisease.find(d => d.id === 'thyroid').verdict, 'avoid');
  check('요오드 충돌 안내 노출', res.conflicts.some(c => c.id === 'iodine_preg'), true);
  check('해조류 저감 팁 제공', res.tips.some(t => t.includes('미역')), true);
}

console.log('\n── 실사용 시나리오: 8세 아동의 라면 한 그릇');
{
  const meal = sumMeal([{ food: store.byId('ramyeon'), portion: 1 }]);
  const kid = evaluate(meal, ['htn'], { ageYears: 8, weightKg: 26 });
  const adult = evaluate(meal, ['htn']);
  const kt = kid.byDisease[0].triggers.find(t => t.axis === 'sodium_mg');
  const at = adult.byDisease[0].triggers.find(t => t.axis === 'sodium_mg');
  console.log(`     나트륨 임계값 — 성인 ${at.threshold}mg / 8세 ${kt.threshold}mg`);
  check('아동 임계값이 성인보다 낮음', kt.threshold < at.threshold, true);
  check('아동 근거에 나이 보정 표기', kt.scaledBy?.includes('8세'), true);
}

console.log('\n── 신규 축 합산');
{
  const meal = sumMeal([
    { food: store.byId('miyeokguk'), portion: 1 },
    { food: store.byId('gim'), portion: 1 }
  ]);
  check('요오드 합산 (2500+300)', Math.round(meal.iodine_ug), 2800);
  check('tags는 합집합으로 누적', Array.isArray(meal.tags), true);
  const withTags = sumMeal([
    { food: store.byId('saengseonhoe'), portion: 1 },
    { food: store.byId('kimchi'), portion: 1 }
  ]);
  check('생식품 태그 누적', withTags.tags.includes('raw'), true);
  check('수은 태그 누적', withTags.tags.includes('high_mercury'), true);
  check('태그 중복 없음', new Set(withTags.tags).size, withTags.tags.length);
}

console.log('\n── 온디바이스 식별: 상위 N개를 음식 N개로 착각하지 않는가');
{
  /* 분류 모델의 상위 5개는 "사진 속 음식 5개"가 아니라 "같은 사진에 대한 5개 추측"이다.
     전부 목록에 담으면 밥 한 공기가 다섯 배 영양으로 합산돼 판정이 통째로 틀어진다.
     실제로 있었던 버그라 회귀 테스트로 고정한다. */
  const { OnDeviceIdentifier } = await import('../js/identify.js');
  const ident = new OnDeviceIdentifier();

  // CLIP 파이프라인을 가짜로 대체한다 (모델 다운로드 없이 반환 형태만 재현)
  const ranked = ['rice_white', 'juk', 'rice_multigrain', 'tteok', 'bibimbap']
    .map((id, i) => ({ label: store.byId(id).en, score: 0.5 - i * 0.08 }));
  ident._pipe = async () => ranked;
  ident.prepare = async () => {};

  const found = await ident.identify('data:image/jpeg;base64,xxx', store);
  check('목록에 담기는 음식은 1개뿐', found.length, 1);
  check('1등이 선택됨', found[0].food.id, 'rice_white');
  check('나머지는 alternatives로 분리', found.alternatives.length, 4);
  check('alternatives에 2등 포함', found.alternatives[0].id, 'juk');
  check('한 장에서 하나만 집었음을 표시', found.singlePick, true);

  // 합산 결과가 부풀지 않는지 직접 확인
  const meal = sumMeal(found.map(c => ({ food: c.food, portion: c.portion })));
  check('열량이 밥 한 공기 그대로 (5개 합산 아님)', Math.round(meal.kcal), 310);

  // 1·2등 격차가 작으면 신뢰도가 깎여야 한다
  ident._pipe = async () => [
    { label: store.byId('rice_white').en, score: 0.21 },
    { label: store.byId('juk').en, score: 0.20 }
  ];
  const unsure = await ident.identify('data:image/jpeg;base64,xxx', store);
  check('격차가 작으면 신뢰도 0.3 미만 ("확인 필요"로 표시됨)', unsure[0].confidence < 0.3, true);
}

console.log('\n── CLIP 라벨: 이름이 아니라 생김새를 묘사하는가');
{
  /* CLIP은 웹 alt-text로 학습돼 요리 이름보다 사진의 생김새에 반응한다.
     라벨이 이름 위주면 한국 음식 인식률이 특히 떨어진다. */
  const labels = store.foods.map(f => f.en);
  check('라벨 중복 없음 (중복이면 역매핑 실패)', new Set(labels).size, labels.length);
  check('전부 영문·ASCII', labels.every(l => /^[\x20-\x7E]+$/.test(l)), true);
  check('평균 6단어 이상 (묘사가 충분한가)',
    labels.reduce((s, l) => s + l.split(' ').length, 0) / labels.length > 6, true);
  check('"Korean ... stew" 같은 이름만 나열한 라벨 없음',
    labels.some(l => /^[a-z]+ [a-z]+, Korean/.test(l)), false);

  // 헷갈리는 찌개 3종은 색·그릇으로 갈려야 한다
  const stew = ['doenjang_jjigae', 'kimchi_jjigae', 'sundubu'].map(id => store.byId(id).en);
  check('된장찌개 라벨에 색(brown) 포함', /brown/.test(stew[0]), true);
  check('김치찌개 라벨에 색(red) 포함', /red/.test(stew[1]), true);
  check('순두부 라벨에 그릇(stone bowl) 포함', /stone bowl/.test(stew[2]), true);
  check('세 찌개 라벨이 서로 다름', new Set(stew).size, 3);

  // 나물 2종도 마찬가지
  const namul = ['sigeumchi_namul', 'kongnamul_muchim'].map(id => store.byId(id).en);
  check('시금치나물은 dark green', /dark green/.test(namul[0]), true);
  check('콩나물무침은 pale yellow', /pale yellow/.test(namul[1]), true);
}

console.log('\n── 클라우드 AI 어댑터 (Pollinations, 토큰 필요)');
{
  const { PollinationsIdentifier, ADAPTERS, makeIdentifier } = await import('../js/identify.js');
  const ident = new PollinationsIdentifier();

  check('어댑터 목록에 등록', ADAPTERS.some(A => A.id === 'cloud'), true);
  check('makeIdentifier로 생성됨', makeIdentifier('cloud') instanceof PollinationsIdentifier, true);
  check('사진 전송 사실을 blurb에 명시',
    PollinationsIdentifier.blurb.includes('외부 서버로 전송'), true);
  /* Pollinations가 크레딧제로 바뀐 뒤 토큰 없이는 402가 난다.
     "설정 불필요"라고 적어 두면 사용자가 눌렀다가 그냥 실패한다.
     실제로 그 버그를 냈으므로 문구를 테스트로 고정한다. */
  check('토큰이 필요하다는 사실을 blurb에 명시',
    PollinationsIdentifier.blurb.includes('무료 토큰이 필요'), true);
  check('토큰 없을 때 실패한다는 것도 명시',
    PollinationsIdentifier.blurb.includes('402'), true);
  check('토큰 발급처 안내', PollinationsIdentifier.blurb.includes('auth.pollinations.ai'), true);
  check('프롬프트가 판정을 금지', PollinationsIdentifier.PROMPT.includes('판정이나 건강 조언은 하지'), true);
  check('프롬프트가 반찬 분리를 요구', PollinationsIdentifier.PROMPT.includes('따로 항목으로'), true);

  /* 응답 파싱 방어 — responseSchema로 형식을 강제할 수 없는 엔드포인트라
     모델이 코드펜스나 설명을 덧붙여도 뽑아낼 수 있어야 한다. */
  const shapes = {
    '순수 JSON': '{"items":[{"name":"김치찌개","portion":1,"confidence":0.9}]}',
    '코드펜스로 감싼 경우': '```json\n{"items":[{"name":"김치찌개","portion":1,"confidence":0.9}]}\n```',
    '앞뒤에 설명이 붙은 경우': '사진을 보니 다음과 같습니다.\n{"items":[{"name":"김치찌개","portion":1,"confidence":0.9}]}\n도움이 되었길 바랍니다.'
  };
  for (const [label, text] of Object.entries(shapes)) {
    const fake = new PollinationsIdentifier();
    globalThis.fetch = async () => ({
      ok: true, status: 200,
      json: async () => ({ choices: [{ message: { content: text } }] })
    });
    const out = await fake.identify('data:image/jpeg;base64,x', store);
    check(`파싱: ${label}`, out[0]?.food?.id, 'kimchi_jjigae');
  }

  // 테이블에 없는 음식은 버리지 않고 넘겨야 한다 (버리면 판정이 관대해짐)
  globalThis.fetch = async () => ({
    ok: true, status: 200,
    json: async () => ({ choices: [{ message: { content:
      '{"items":[{"name":"김치찌개","portion":1,"confidence":0.9},' +
      '{"name":"아귀수육","portion":1,"confidence":0.8}]}' } }] })
  });
  const mixed = await new PollinationsIdentifier().identify('data:image/jpeg;base64,x', store);
  check('아는 음식은 담김', mixed.length, 1);
  check('모르는 음식은 조용히 버리지 않고 unmatched로', mixed.unmatched.length, 1);
  check('unmatched에 이름 보존', mixed.unmatched[0].name, '아귀수육');

  // 상태 코드별로 다른 신호를 올려야 UI가 맞는 안내를 띄운다
  const statusOf = async (status) => {
    globalThis.fetch = async () => ({ ok: false, status });
    try { await new PollinationsIdentifier().identify('data:image/jpeg;base64,x', store); return null; }
    catch (e) { return e.message; }
  };
  check('429는 RATE_LIMIT으로 구분', await statusOf(429), 'RATE_LIMIT');
  /* 402는 실제로 사용자가 겪은 오류다. 일반 오류로 뭉뚱그리면
     "HTTP 402"만 보이고 다음에 뭘 해야 할지 알 수 없다. */
  check('402는 NO_CREDIT으로 구분 (크레딧 부족)', await statusOf(402), 'NO_CREDIT');
  check('401은 BAD_TOKEN으로 구분', await statusOf(401), 'BAD_TOKEN');
  check('403도 BAD_TOKEN으로 구분', await statusOf(403), 'BAD_TOKEN');

  // 토큰이 있으면 Authorization 헤더로 보낸다
  let sentHeaders = {};
  globalThis.fetch = async (u, opt) => {
    sentHeaders = opt.headers;
    return { ok: true, status: 200, json: async () => ({
      choices: [{ message: { content: '{"items":[{"name":"김치찌개","portion":1,"confidence":0.9}]}' } }]
    }) };
  };
  await new PollinationsIdentifier({ token: 'pk_test' }).identify('data:image/jpeg;base64,x', store);
  check('토큰이 Bearer로 전달', sentHeaders.Authorization, 'Bearer pk_test');
  await new PollinationsIdentifier().identify('data:image/jpeg;base64,x', store);
  check('토큰 없으면 Authorization 없음', sentHeaders.Authorization, undefined);

  let err = null;

  // 깨진 응답도 죽지 않고 신호를 준다
  globalThis.fetch = async () => ({
    ok: true, status: 200,
    json: async () => ({ choices: [{ message: { content: '음식을 알아볼 수 없습니다' } }] })
  });
  err = null;
  try { await new PollinationsIdentifier().identify('data:image/jpeg;base64,x', store); }
  catch (e) { err = e.message; }
  check('JSON이 아니면 PARSE로 구분', err, 'PARSE');
}

console.log('\n── Gemini 어댑터: 프록시 없이 임시 키로도 동작');
{
  const { GeminiIdentifier } = await import('../js/identify.js');
  check('프록시도 키도 없으면 사용 불가',
    await new GeminiIdentifier().available(), false);
  check('임시 키만 있어도 사용 가능',
    await new GeminiIdentifier({ devApiKey: 'AIzaTEST' }).available(), true);
  check('프록시만 있어도 사용 가능',
    await new GeminiIdentifier({ proxyUrl: 'https://x.workers.dev' }).available(), true);

  // 임시 키 모드는 구글로 직접 간다
  let calledUrl = '', calledHeaders = {};
  globalThis.fetch = async (url, opt) => {
    calledUrl = url; calledHeaders = opt.headers;
    return { ok: true, status: 200, json: async () => ({
      candidates: [{ content: { parts: [{ text: '{"items":[{"name":"비빔밥","portion":1,"confidence":0.9}]}' }] } }]
    }) };
  };
  const out = await new GeminiIdentifier({ devApiKey: 'AIzaTEST' })
    .identify('data:image/jpeg;base64,x', store);
  check('구글 엔드포인트로 직접 호출', calledUrl.includes('generativelanguage.googleapis.com'), true);
  check('키가 헤더로 전달', calledHeaders['x-goog-api-key'], 'AIzaTEST');
  check('결과가 테이블에 매칭', out[0]?.food?.id, 'bibimbap');

  // 프록시가 있으면 프록시 우선 (키가 브라우저에 안 남는 배포 경로)
  await new GeminiIdentifier({ proxyUrl: 'https://x.workers.dev', devApiKey: 'AIzaTEST' })
    .identify('data:image/jpeg;base64,x', store);
  check('프록시가 있으면 프록시 우선', calledUrl.includes('x.workers.dev'), true);
  check('프록시 경로엔 키를 싣지 않음', calledHeaders['x-goog-api-key'], undefined);

  globalThis.fetch = async () => ({ ok: false, status: 403 });
  let err = null;
  try { await new GeminiIdentifier({ devApiKey: 'bad' }).identify('data:image/jpeg;base64,x', store); }
  catch (e) { err = e.message; }
  check('잘못된 키는 BAD_KEY로 구분', err, 'BAD_KEY');
}

console.log('\n── 자체 학습 모델 어댑터');
{
  const { LocalModelIdentifier, ADAPTERS, makeIdentifier } = await import('../js/identify.js');

  check('어댑터 목록에 등록', ADAPTERS.some(A => A.id === 'local'), true);
  check('목록 맨 앞 (가장 정확·무료)', ADAPTERS[0].id, 'local');
  check('makeIdentifier로 생성', makeIdentifier('local') instanceof LocalModelIdentifier, true);
  check('모델 주소 없으면 사용 불가', await new LocalModelIdentifier().available(), false);
  check('모델 주소가 있으면 사용 가능',
    await new LocalModelIdentifier({ modelUrl: './models' }).available(), true);
  check('주소 끝 슬래시 정리',
    new LocalModelIdentifier({ modelUrl: './models///' }).modelUrl, './models');
  check('사진이 기기 밖으로 안 나감을 명시',
    LocalModelIdentifier.blurb.includes('기기에서 돌아'), true);
  check('비용·한도 없음을 명시',
    LocalModelIdentifier.blurb.includes('한도도 없습니다'), true);

  // localModelUrl로만 전달돼야 한다 (다른 어댑터 옵션과 섞이면 안 됨)
  const made = makeIdentifier('local', {
    localModelUrl: 'https://cdn.example/models',
    devApiKey: 'AIzaTEST', geminiModel: 'gemini-flash-latest'
  });
  check('자체 모델 주소 전달', made.modelUrl, 'https://cdn.example/models');
  check('Gemini 키가 새지 않음', made.devApiKey, undefined);
  check('Gemini 모델명이 새지 않음', made.model, undefined);

  /* 모델 파일이 없으면 조용히 실패하지 않고 NO_MODEL을 올려야
     UI가 "학습부터 하세요"를 안내할 수 있다. */
  globalThis.fetch = async () => ({ ok: false, status: 404 });
  let err = null;
  try { await new LocalModelIdentifier({ modelUrl: './models' }).prepare(); }
  catch (e) { err = e.message; }
  check('모델 파일 없으면 NO_MODEL', err, 'NO_MODEL');

  err = null;
  try { await new LocalModelIdentifier().prepare(); }
  catch (e) { err = e.message; }
  check('주소 미설정도 NO_MODEL', err, 'NO_MODEL');
}

console.log('\n── 어댑터 옵션 격리 (모델명이 섞이면 안 된다)');
{
  /* 실제로 났던 버그: 공통 opts에 model: 'gemini-flash-latest'를 담아
     모든 어댑터에 넘겼더니 온디바이스 CLIP 모델명이 덮어써졌다.
     Transformers.js가 허깅페이스에서 'gemini-flash-latest'를 찾다가
     "Unauthorized access to file" 오류를 냈다. */
  const { makeIdentifier, ONDEVICE_MODELS } = await import('../js/identify.js');

  const opts = {
    proxyUrl: 'https://x.workers.dev',
    devApiKey: 'AIzaTEST',
    geminiModel: 'gemini-flash-latest',
    token: 'pk_test',
    userToken: 'devicetoken'
  };

  const od = makeIdentifier('ondevice', opts);
  check('온디바이스는 CLIP 모델을 유지', od.model, ONDEVICE_MODELS.clip_base.id);
  check('온디바이스에 Gemini 모델명이 새지 않음',
    od.model.includes('gemini'), false);
  check('온디바이스에 API 키가 새지 않음', od.devApiKey, undefined);
  check('온디바이스에 프록시 주소가 새지 않음', od.proxyUrl, undefined);

  const gm = makeIdentifier('gemini', opts);
  check('Gemini는 지정한 모델을 씀', gm.model, 'gemini-flash-latest');
  check('Gemini에 프록시 전달', gm.proxyUrl, 'https://x.workers.dev');
  check('Gemini에 사용자 토큰 전달', gm.userToken, 'devicetoken');

  const cl = makeIdentifier('cloud', opts);
  check('클라우드에 Pollinations 토큰 전달', cl.token, 'pk_test');
  check('클라우드에 Gemini 키가 새지 않음', cl.devApiKey, undefined);
  /* 클라우드의 model은 Pollinations 모델명이지 Gemini 것이 아니다 */
  check('클라우드는 자기 기본 모델 유지', cl.model, 'openai');

  // 명시적으로 지정하면 바뀌어야 한다
  const od2 = makeIdentifier('ondevice', { onDeviceModel: ONDEVICE_MODELS.siglip.id });
  check('온디바이스 모델은 onDeviceModel로 지정', od2.model, ONDEVICE_MODELS.siglip.id);
}

console.log('\n── 온디바이스 모델 선택지');
{
  const { ONDEVICE_MODELS } = await import('../js/identify.js');
  check('모델 3종 등록', Object.keys(ONDEVICE_MODELS).length, 3);
  check('기본값이 clip_base', ONDEVICE_MODELS.clip_base.id, 'Xenova/clip-vit-base-patch32');
  check('전부 Xenova ONNX 변환본 (transformers.js 호환)',
    Object.values(ONDEVICE_MODELS).every(m => m.id.startsWith('Xenova/')), true);
  check('각 모델에 용량 표기', Object.values(ONDEVICE_MODELS).every(m => m.size), true);
}

console.log('\n── 식약처 검색 확장 (내장 148종 밖의 음식)');
{
  /* 검색을 주력 입력 수단으로 쓰려면 "없다"가 자주 나오면 안 된다.
     내장에서 못 찾으면 식약처 DB(수만 종)로 넓힌다. */
  // 앞선 테스트들이 fetch를 바꿔 놨다. 테이블 로드를 위해 파일 읽기로 되돌린다.
  globalThis.fetch = async (url) => ({
    ok: true, status: 200, json: async () => JSON.parse(readFileSync(fileURLToPath(url), 'utf8'))
  });
  const remoteStore = new NutritionStore({ proxyUrl: 'https://x.workers.dev' });
  await remoteStore.ready();

  const row = {
    DESC_KOR: '아귀수육', SERVING_WT: '200',
    NUTR_CONT1: '180', NUTR_CONT2: '5', NUTR_CONT3: '30', NUTR_CONT4: '4',
    NUTR_CONT5: '1', NUTR_CONT6: '600', NUTR_CONT7: '70', NUTR_CONT8: '1', NUTR_CONT9: '0'
  };
  globalThis.fetch = async () => ({
    ok: true, status: 200, json: async () => ({ I2790: { row: [row] } })
  });

  const hits = await remoteStore.searchRemote('아귀수육');
  check('원격 검색 결과 반환', hits.length, 1);
  check('이름 파싱', hits[0].ko, '아귀수육');
  check('제공량 파싱', hits[0].serving_g, 200);
  check('나트륨 파싱', hits[0].sodium_mg, 600);
  check('원격 출처 표시', hits[0].remote, true);
  check('src가 mfds', hits[0].src, 'mfds');
  check('id가 내장과 충돌하지 않음', hits[0].id.startsWith('mfds:'), true);

  /* 식약처는 퓨린·요오드 등을 주지 않는다. 0으로 남는 축을 숨기면
     통풍·갑상선 판정이 조용히 관대해진다. 반드시 목록으로 넘겨야 한다. */
  check('빠진 축을 명시', Array.isArray(hits[0].missingAxes), true);
  check('퓨린이 빠진 축에 포함', hits[0].missingAxes.includes('purine_mg'), true);
  check('요오드가 빠진 축에 포함', hits[0].missingAxes.includes('iodine_ug'), true);
  check('퓨린 값은 0', hits[0].purine_mg, 0);

  // 판정에 넣어도 죽지 않아야 한다
  const res = evaluate(sumMeal([{ food: hits[0], portion: 1 }]), ['htn', 'gout']);
  check('원격 음식으로도 판정 가능', res.byDisease.length, 2);
  check('나트륨은 정상 판정', res.byDisease.find(d => d.id === 'htn').verdict, 'caution');
  check('퓨린 0이라 통풍은 good (과소평가 — 그래서 UI가 경고)',
    res.byDisease.find(d => d.id === 'gout').verdict, 'good');

  // 방어
  check('짧은 검색어는 원격 조회 안 함', (await remoteStore.searchRemote('아')).length, 0);
  globalThis.fetch = async () => { throw new Error('network'); };
  check('원격 실패해도 빈 배열 (앱은 계속 동작)',
    (await remoteStore.searchRemote('아귀수육2')).length, 0);
  check('프록시 없으면 원격 검색 안 함', (await store.searchRemote('아귀수육')).length, 0);
}

console.log('\n── 식약처 I0750(신) — data.go.kr 포맷 파싱');
{
  /* I2790과 완전히 다른 응답 껍데기({header, body:{items}})를 쓴다.
     2026-08-13 실제 키로 확인한 된장찌개 값을 그대로 목업으로 쓴다(회귀 방지). */
  globalThis.fetch = async (url) => ({
    ok: true, status: 200, json: async () => JSON.parse(readFileSync(fileURLToPath(url), 'utf8'))
  });
  const i0750Store = new NutritionStore({ proxyUrl: 'https://x.workers.dev', profile: 'I0750' });
  await i0750Store.ready();

  const item = {
    FOOD_NM_KR: '된장찌개', SERVING_SIZE: '100g',
    AMT_NUM1: '46.00', AMT_NUM3: '3.38', AMT_NUM4: '1.63', AMT_NUM6: '4.44',
    AMT_NUM7: '0.00', AMT_NUM9: '21.00', AMT_NUM10: '0.70', AMT_NUM11: '55.00',
    AMT_NUM12: '151.000', AMT_NUM13: '318.000', AMT_NUM23: '0.00',
    AMT_NUM24: '0.27', AMT_NUM25: '0.00'
  };
  globalThis.fetch = async () => ({
    ok: true, status: 200,
    json: async () => ({
      header: { resultCode: '00', resultMsg: 'NORMAL SERVICE.' },
      body: { pageNo: 1, numOfRows: 1, totalCount: 1, items: [item] }
    })
  });

  const hits = await i0750Store.searchRemote('된장찌개');
  check('data.go.kr 껍데기에서도 결과 반환', hits.length, 1);
  check('이름 파싱 (FOOD_NM_KR)', hits[0].ko, '된장찌개');
  check('100g 기준 제공량 파싱', hits[0].serving_g, 100);
  check('나트륨 파싱 (AMT_NUM13)', hits[0].sodium_mg, 318);
  check('칼륨 파싱 (AMT_NUM12, 콩팥병 판정 필수)', hits[0].potassium_mg, 151);
  check('인 파싱 (AMT_NUM11, 콩팥병 판정 필수)', hits[0].phosphorus_mg, 55);
  check('철분 파싱 (AMT_NUM10, 위치 추정 필드)', hits[0].iron_mg, 0.7);
  check('칼륨·인이 빠진 축에 없음 (I0750은 제공함)',
    hits[0].missingAxes.includes('potassium_mg') || hits[0].missingAxes.includes('phosphorus_mg'), false);

  // resolve()는 별도 코드 경로(내장 값과 병합)라 따로 확인한다
  const merged = await i0750Store.resolve({ ko: '된장찌개', serving_g: 100, sodium_mg: 999 });
  check('resolve()도 새 껍데기를 파싱', merged.sodium_mg, 318);
  check('출처가 mfds로 표시', merged._sources.sodium_mg, 'mfds');
}

console.log('\n── 식약처 프로파일 설정');
{
  check('I2790 프로파일 존재', !!MFDS_PROFILES.I2790, true);
  check('I0750은 검증 완료 상태 (2026-08-13, unverified 플래그 제거됨)',
    MFDS_PROFILES.I0750.unverified, undefined);
  check('두 프로파일 모두 나트륨 매핑 보유',
    !!MFDS_PROFILES.I2790.map.sodium_mg && !!MFDS_PROFILES.I0750.map.sodium_mg, true);
  check('퓨린은 어느 프로파일에도 없음 (내장 전용)',
    !MFDS_PROFILES.I2790.map.purine_mg && !MFDS_PROFILES.I0750.map.purine_mg, true);
}

console.log(`\n${'═'.repeat(50)}\n통과 ${pass} · 실패 ${fail}\n${'═'.repeat(50)}`);
process.exit(fail ? 1 : 0);
