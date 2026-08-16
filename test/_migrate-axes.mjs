/**
 * 일회성 마이그레이션 — 전 연령 대응을 위한 신규 영양축 추가
 *   iron_mg    철        (빈혈)
 *   iodine_ug  요오드    (갑상선)
 *   caffeine_mg 카페인   (임신·빈혈·역류)
 *   vita_ug    레티놀    (임신 — 동물성 비타민A만. 베타카로틴은 과잉 독성이 없어 제외)
 *   tags       분류 태그 (raw / high_mercury / cruciferous / organ / processed)
 *
 * 실행: node test/_migrate-axes.mjs
 */
import { readFileSync, writeFileSync } from 'node:fs';

const PATH = new URL('../data/foods-ko.json', import.meta.url);
const db = JSON.parse(readFileSync(PATH, 'utf8'));

/* [iron_mg, iodine_ug, caffeine_mg, vita_ug, tags] — 1회 제공량 기준 */
const ADD = {
  rice_white:        [0.5,    0,   0,    0, []],
  rice_multigrain:   [1.5,    0,   0,    0, []],
  juk:               [0.4,    5,   0,   20, []],

  doenjang_jjigae:   [1.8,   40,   0,   30, []],
  kimchi_jjigae:     [2.2,   25,   0,   50, ['cruciferous']],
  sundubu:           [2.5,   40,   0,   40, []],
  // 미역국은 이 테이블에서 가장 중요한 항목이다. 건미역의 요오드 농도가 극단적으로 높아
  // 한 그릇으로 한국 성인 상한(2,400µg)을 넘길 수 있다. 갑상선 룰의 핵심 근거.
  miyeokguk:         [2.0, 2500,   0,   60, []],
  seolleongtang:     [3.5,   15,   0,   10, []],
  galbitang:         [4.0,   15,   0,   20, []],
  samgyetang:        [4.5,   10,   0,   80, []],
  // 순대에는 선지와 간이 들어가 철분과 레티놀이 함께 높다
  sundaeguk:         [6.0,   20,   0,  300, ['organ']],
  kongnamulguk:      [0.8,   10,   0,    0, []],

  kimchi:            [0.5,   10,   0,    0, ['cruciferous', 'raw']],
  kkakdugi:          [0.3,    8,   0,    0, ['cruciferous', 'raw']],
  // 시금치는 비타민A가 많아 보이지만 전량 베타카로틴이다. 레티놀은 0으로 둔다.
  sigeumchi_namul:   [1.7,    5,   0,    0, []],
  kongnamul_muchim:  [0.7,    5,   0,    0, []],
  gim:               [0.5,  300,   0,    0, []],
  myeolchi_bokkeum:  [3.5,   60,   0,   10, []],
  jangjorim:         [2.2,    5,   0,    5, []],
  dubu_jorim:        [1.5,    3,   0,    0, []],
  gyeranmari:        [1.8,   25,   0,  180, []],

  godeungeo_gui:     [1.5,   40,   0,   30, []],
  galchi_gui:        [1.0,   30,   0,   25, []],
  samgyeopsal:       [1.2,    3,   0,   10, []],
  bulgogi:           [3.5,    5,   0,   10, []],
  jokbal:            [2.5,    5,   0,   15, []],
  chicken_fried:     [1.8,    5,   0,   30, ['processed']],
  // 소간 100g의 레티놀은 약 9,000µg으로 임신 중 1일 상한(3,000µg)의 세 배다.
  // 임신 중 간 섭취 금기의 직접 근거가 되는 항목.
  gan_jeon:          [8.0,   10,   0, 8000, ['organ']],

  bibimbap:          [3.0,   20,   0,   60, []],
  kimbap:            [2.0,   90,   0,   80, []],
  jajangmyeon:       [2.5,   10,   0,   20, ['processed']],
  jjamppong:         [4.5,  120,   0,   40, []],
  naengmyeon:        [3.0,   30,   0,   30, []],
  kalguksu:          [2.5,   40,   0,   20, []],
  ramyeon:           [1.5,   15,   0,    5, ['processed']],
  tteokbokki:        [1.2,   10,   0,   10, ['processed']],
  tteok:             [0.6,    0,   0,    0, []],

  // 바나나의 비타민A는 전량 베타카로틴이다. 레티놀 축 정의상 0이어야 한다.
  banana:            [0.3,    2,   0,    0, []],
  orange:            [0.2,    1,   0,    0, []],
  apple:             [0.2,    1,   0,    0, []],
  grape:             [0.5,    1,   0,    0, []],
  sweet_potato:      [0.9,    2,   0,    0, []],
  potato:            [1.1,    3,   0,    0, []],
  nuts:              [1.2,    2,   0,    0, []],
  milk:              [0.1,   50,   0,   60, []],
  yogurt:            [0.1,   30,   0,   30, []],
  // 커피 한 잔의 카페인. 임신 1일 권장 상한(200mg)의 절반을 한 잔이 채운다.
  coffee:            [0.2,    2, 100,    2, []],
  soju:              [0.0,    0,   0,    0, []],
  beer:              [0.1,    2,   0,    0, []],

  jeon:              [2.0,   30,   0,   60, []],
  japchae:           [1.5,    8,   0,   20, []],
  sikhye:            [0.2,    1,   0,    0, []],
  yakgwa:            [0.5,    2,   0,    5, ['processed']],
  brocolli:          [0.6,    3,   0,    0, ['cruciferous']],
  cabbage_ssam:      [0.5,    2,   0,    0, ['cruciferous']],
  jeotgal:           [0.8,   80,   0,   10, ['raw']],
  ojingeo:           [0.5,   40,   0,   10, []],
  // 회는 비가열 식품이고 어종에 따라 수은이 높을 수 있어 임신 시 보수적으로 본다
  saengseonhoe:      [1.0,   50,   0,   20, ['raw', 'high_mercury']],
  dubu_saengsik:     [1.6,    2,   0,    0, []],
  gyeran_jjim:       [1.5,   20,   0,  150, []],
  hobak_juk:         [0.8,    3,   0,    0, []],
  gochujang_sauce:   [0.3,    2,   0,    0, []]
};

let touched = 0, missing = [];
for (const f of db.foods) {
  const row = ADD[f.id];
  if (!row) { missing.push(f.id); continue; }
  const [iron, iodine, caffeine, vita, tags] = row;
  f.iron_mg = iron;
  f.iodine_ug = iodine;
  f.caffeine_mg = caffeine;
  f.vita_ug = vita;
  f.tags = tags;
  touched++;
}

const unknown = Object.keys(ADD).filter(id => !db.foods.some(f => f.id === id));

db._meta.version = '0.2.0';
db._meta.updated = new Date().toISOString().slice(0, 10);
db._meta.axis_note =
  'vita_ug는 동물성 레티놀만 계상한다. 식물성 베타카로틴은 체내 전환이 조절돼 과잉 독성이 없으므로 ' +
  '임신 중 상한 판정에 포함하면 시금치·당근이 부당하게 경고를 받는다. iodine_ug·iron_mg·caffeine_mg는 ' +
  '식약처 DB가 제공하지 않아 전량 문헌 추정치다.';
db._meta.tag_legend = {
  raw: '비가열 식품 — 임신 중 리스테리아·톡소플라스마 위험',
  high_mercury: '수은 축적 가능 어종',
  cruciferous: '십자화과 — 갑상선 고이트로겐(조리 시 대부분 파괴)',
  organ: '내장류 — 레티놀·퓨린·콜레스테롤이 동시에 높음',
  processed: '가공식품 — 무기인 첨가물 흡수율이 높음'
};

writeFileSync(PATH, JSON.stringify(db, null, 2) + '\n');

console.log(`갱신 ${touched}종 / 전체 ${db.foods.length}종`);
if (missing.length) console.log('⚠️ 값이 없는 음식:', missing.join(', '));
if (unknown.length) console.log('⚠️ 테이블에 없는 id:', unknown.join(', '));
console.log(missing.length || unknown.length ? '실패' : '전 항목 갱신 완료');
