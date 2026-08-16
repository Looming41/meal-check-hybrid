/**
 * 일회성 마이그레이션 v3 — CLIP 라벨을 "이름"에서 "생김새"로 다시 씀
 *
 * 왜 바꾸나
 * ─────────
 * CLIP은 웹 이미지의 영어 alt-text로 학습됐다. 즉 이 모델이 아는 것은
 * "된장찌개라는 요리의 이름"이 아니라 "갈색 국물에 두부가 뜬 뚝배기 사진"이다.
 * 그런데 초기 라벨은 이름 위주였다:
 *
 *   (전) "doenjang jjigae, Korean soybean paste stew"
 *   (후) "a bubbling brown soybean paste stew with tofu and zucchini in an earthenware pot"
 *
 * 프롬프트 템플릿이 "This is a photo of {}" 이므로, 뒤에 붙는 문장이
 * 사진을 묘사할수록 매칭이 잘 된다. 특히 서로 헷갈리는 것들
 * (된장찌개·김치찌개·순두부찌개, 시금치나물·콩나물무침)은
 * 색·그릇·건더기로 구분되도록 일부러 다르게 적었다.
 *
 * ⚠️ 한계: 라벨을 아무리 잘 써도 CLIP이 한국 반찬을 구분하는 데는 한계가 있다.
 *    이건 개선이지 해결이 아니다. 정확도가 정말 필요하면 Gemini 어댑터를 써야 한다.
 *
 * 실행: node test/_migrate-labels-v3.mjs   (여러 번 실행해도 안전)
 */
import { readFileSync, writeFileSync } from 'node:fs';

const PATH = new URL('../data/foods-ko.json', import.meta.url);
const db = JSON.parse(readFileSync(PATH, 'utf8'));

const EN = {
  // ── 밥·죽 ── 그릇 안 알갱이의 색과 질감으로 가른다
  rice_white:       'a bowl of plain white steamed short-grain rice',
  rice_multigrain:  'a bowl of brown and purple multigrain rice with visible grains',
  juk:              'a thick creamy white rice porridge in a wide bowl',
  hobak_juk:        'a smooth bright orange pumpkin porridge in a bowl',

  // ── 찌개·국 ── 국물 색과 건더기가 결정적이다
  doenjang_jjigae:  'a bubbling brown soybean paste stew with tofu and zucchini in an earthenware pot',
  kimchi_jjigae:    'a deep red kimchi stew with pork slices and wilted cabbage in a shallow pot',
  sundubu:          'a bright red bubbling silken tofu stew in a black stone bowl',
  cheonggukjang:    'a thick grey-brown fermented soybean stew with whole beans in a clay pot',
  budae_jjigae:     'a wide red stew pot with sausages, spam slices, baked beans and instant noodles',
  miyeokguk:        'a clear dark broth with slippery dark green seaweed strands',
  seolleongtang:    'a large bowl of milky white opaque beef bone broth with thin noodles',
  galbitang:        'a clear light brown beef rib soup with chunks of bone-in meat',
  samgyetang:       'a whole small chicken sitting in clear broth in a stone pot',
  sundaeguk:        'a cloudy pork broth soup with dark blood sausage slices',
  kongnamulguk:     'a clear pale soup full of yellow bean sprouts',
  yukgaejang:       'a fiery red spicy soup with shredded beef and long scallions',
  chueotang:        'a murky dark green thick soup with ground freshwater fish',
  gamjatang:        'a large red spicy stew with big pork neck bones and whole potatoes',
  tteokguk:         'a clear broth soup with white oval rice cake slices and egg garnish',

  // ── 반찬 ── 색과 형태가 전부다
  kimchi:           'a pile of red chili-coated fermented napa cabbage leaves',
  kkakdugi:         'a small dish of red chili-coated cubed white radish',
  sigeumchi_namul:  'a small dish of dark green wilted spinach dressed with sesame',
  kongnamul_muchim: 'a small dish of pale yellow crunchy bean sprouts with sesame seeds',
  gim:              'a stack of thin black glossy roasted seaweed sheets',
  gimjaban:         'a mound of dark green crumbled seaweed flakes',
  dasima:           'thick dried dark brown kelp sheets',
  myeolchi_bokkeum: 'a small dish of tiny glossy stir-fried dried anchovies',
  jangjorim:        'shredded dark brown soy-braised beef in dark sauce with boiled eggs',
  dubu_jorim:       'flat pan-fried tofu slabs coated in red seasoning sauce',
  dubu_saengsik:    'a plain white block of uncooked soft tofu on a plate',
  gyeranmari:       'a sliced yellow rolled egg omelette in spiral layers',
  gyeran_jjim:      'a fluffy pale yellow steamed egg custard puffed in a stone bowl',
  jeotgal:          'a tiny dish of glistening salted fermented seafood',
  gochujang_sauce:  'a small dollop of thick dark red chili paste',
  cabbage_ssam:     'a plate of fresh green lettuce and perilla leaves for wrapping',
  brocolli:         'bright green steamed broccoli florets',

  // ── 구이·고기 ──
  godeungeo_gui:    'a grilled mackerel fillet with crisp silvery blue skin',
  galchi_gui:       'a grilled silver hairtail fish cut crosswise',
  salmon:           'a pink-orange grilled salmon fillet with visible flakes',
  samgyeopsal:      'strips of grilled pork belly with layers of fat on a grill',
  bulgogi:          'glossy dark brown marinated beef slices with onion',
  jeyuk:            'red chili-coated stir-fried pork with onion and scallion',
  dakgalbi:         'a wide pan of red spicy stir-fried chicken with cabbage and rice cakes',
  jokbal:           'sliced glossy dark braised pig trotter meat with skin',
  chicken_fried:    'crispy golden brown Korean fried chicken pieces',
  gan_jeon:         'dark reddish-brown pan-fried liver slices',
  gopchang:         'chewy grilled beef intestines on a hot pan',
  yukhoe:           'raw red beef strips topped with a raw egg yolk and pear',
  saengseonhoe:     'thin slices of raw white fish sashimi on a plate',
  ojingeo:          'chewy squid rings and tentacles in red sauce',
  nakji_bokkeum:    'red spicy stir-fried octopus with vegetables',
  agujjim:          'a red spicy braised monkfish dish with bean sprouts',
  chicken_breast:   'a plain white boiled chicken breast sliced on a plate',
  sundae:           'dark grey sliced Korean blood sausage with noodle filling',
  steak:            'a thick seared beef steak with grill marks',

  // ── 밥·면 요리 ──
  bibimbap:         'a bowl of rice topped with colourful vegetable strips and a fried egg',
  kimbap:           'round seaweed rice rolls cut into slices showing colourful fillings',
  samgak_kimbap:    'a triangular seaweed wrapped rice ball in plastic packaging',
  bokkeumbap:       'a mound of stir-fried rice with diced vegetables',
  curry_rice:       'white rice covered with thick yellow curry sauce',
  omurice:          'a yellow omelette blanket over rice with ketchup drizzle',
  gyudon:           'a bowl of rice topped with thin simmered beef and onion',
  sushi:            'small oval rice pieces topped with slices of raw fish',
  jajangmyeon:      'noodles buried under glossy thick black bean sauce',
  jjamppong:        'a large bowl of red spicy broth noodles with seafood and squid',
  naengmyeon:       'thin grey buckwheat noodles in icy cold broth with sliced pear',
  kalguksu:         'thick flat handmade wheat noodles in a milky white broth',
  ramyeon:          'curly instant noodles in orange-red spicy broth',
  cup_ramen:        'instant noodles inside a paper cup container',
  udon:             'thick soft white wheat noodles in clear pale broth',
  tonkotsu_ramen:   'ramen noodles in creamy beige pork broth with sliced pork and egg',
  kongguksu:        'white noodles in a thick opaque cold soybean soup',
  bibim_guksu:      'thin noodles coated in bright red spicy sauce with cucumber',
  japchae:          'glossy translucent sweet potato glass noodles with colourful vegetables',
  maratang:         'a deep bowl of dark red oily spicy soup with mixed skewered ingredients',

  // ── 분식 ──
  tteokbokki:       'cylindrical white rice cakes coated in thick bright red sauce',
  rabokki:          'red sauced rice cakes mixed with instant ramen noodles',
  tteok:            'plain white chewy glutinous rice cakes',
  mandu:            'pleated Korean dumplings with thin wrappers',
  twigim:           'assorted golden deep-fried battered fritters',
  eomuk:            'flat brown fish cake sheets folded on skewers in broth',
  donkatsu:         'a large golden breaded pork cutlet sliced into strips',
  jeon:             'a flat golden pan-fried savoury pancake',
  hotbar:           'a golden fried sausage on a stick',

  // ── 양식 ──
  pasta_cream:      'spaghetti coated in thick pale cream sauce with black pepper',
  pasta_tomato:     'spaghetti coated in bright red tomato sauce with basil',
  pizza:            'a triangular pizza slice with melted cheese and pepperoni',
  burger:           'a hamburger with sesame bun, beef patty, cheese and lettuce',
  fries:            'a pile of golden french fries',
  risotto:          'creamy pale rice with mushrooms in a shallow plate',
  salad_green:      'a bowl of mixed fresh green salad leaves and vegetables',
  salad_chicken:    'a green salad topped with sliced grilled chicken breast',
  sandwich:         'a triangular sandwich with ham, cheese and lettuce between bread',
  toast_butter:     'toasted white bread slices with melted butter',
  croissant:        'a golden flaky crescent shaped pastry',
  cereal_milk:      'breakfast cereal flakes floating in milk in a bowl',
  omelet:           'a folded yellow omelette with melted cheese',
  soup_cream:       'a bowl of thick pale cream soup',
  tangsuyuk:        'deep-fried pork chunks in glossy translucent sweet and sour sauce',
  mapo_dubu:        'soft tofu cubes in glossy red oily spicy sauce',

  // ── 편의점·가공 ──
  dosirak:          'a plastic lunchbox tray with rice and several side dishes',
  ham_canned:       'a pink rectangular block of canned luncheon meat',
  tuna_can:         'flaked canned tuna in an open metal tin',
  protein_shake:    'a bottle of thick pale protein shake drink',
  boiled_egg:       'peeled hard boiled eggs cut in half showing yellow yolk',
  dubu_gangjeong:   'crispy fried tofu cubes coated in sticky red sauce',

  // ── 과일·채소 ──
  banana:           'a ripe yellow banana',
  orange:           'small orange mandarin fruits with loose peel',
  apple:            'a shiny red apple',
  grape:            'a bunch of round green or purple grapes',
  strawberry:       'bright red fresh strawberries',
  watermelon:       'triangular slices of red watermelon with black seeds',
  tomato:           'round shiny red tomatoes',
  cucumber:         'a long green cucumber',
  carrot:           'orange carrot sticks',
  avocado:          'a halved green avocado showing the large pit',
  blueberry:        'small round dark blue blueberries',
  pear:             'a large round golden brown Korean pear',
  persimmon:        'a round bright orange persimmon',
  corn:             'a steamed yellow corn cob',
  sweet_potato:     'a roasted sweet potato with purple skin and orange flesh',
  potato:           'a plain steamed potato',
  nuts:             'a small pile of mixed almonds and walnuts',

  // ── 음료 ──
  milk:             'a tall glass of white milk',
  yogurt:           'a cup of thick white plain yogurt',
  coffee:           'a mug of light brown instant coffee',
  americano:        'a tall glass of black iced americano coffee',
  cafe_latte:       'a cup of latte with brown coffee and white milk layers',
  energy_drink:     'a slim tall metal energy drink can',
  bubble_tea:       'a clear cup of milky tea with black tapioca pearls at the bottom',
  green_tea:        'a cup of pale green tea',
  cola:             'a glass of dark fizzy cola with ice',
  orange_juice:     'a glass of bright orange juice',
  sports_drink:     'a bottle of pale blue sports drink',
  sikhye:           'a bowl of cloudy sweet rice drink with floating rice grains',
  soju:             'a small clear glass of soju next to a green bottle',
  beer:             'a tall glass of golden beer with white foam',
  makgeolli:        'a bowl of cloudy milky white rice wine',
  wine:             'a wine glass with dark red wine',
  whisky:           'a short glass of amber whisky',

  // ── 간식 ──
  cake:             'a slice of layered cake with white cream frosting',
  donut:            'a ring shaped glazed donut',
  ice_cream:        'a scoop of pale vanilla ice cream',
  chocolate:        'a bar of brown chocolate broken into squares',
  snack_chips:      'thin crispy golden potato chips',
  bungeoppang:      'a fish shaped golden brown pastry',
  popcorn:          'a bowl of white fluffy popcorn',
  yakgwa:           'a small dark golden brown honey glazed Korean cookie'
};

let updated = 0;
const missing = [];
for (const f of db.foods) {
  if (!EN[f.id]) { missing.push(f.id); continue; }
  f.en = EN[f.id];
  updated++;
}
const unknown = Object.keys(EN).filter(id => !db.foods.some(f => f.id === id));

/* 라벨이 겹치면 CLIP 결과를 원래 음식으로 되돌릴 수 없다 (byClipLabel 실패) */
const labels = db.foods.map(f => f.en);
const dupes = [...new Set(labels.filter((x, i) => labels.indexOf(x) !== i))];

db._meta.version = '0.4.0';
db._meta.updated = new Date().toISOString().slice(0, 10);
db._meta.label_note =
  'en은 CLIP 제로샷 분류의 후보 라벨이다. 요리 이름이 아니라 사진에 보이는 것' +
  '(색·그릇·건더기·질감)을 묘사한다. CLIP이 웹 alt-text로 학습돼 이름보다 생김새에 반응하기 때문이다. ' +
  '서로 헷갈리는 항목은 일부러 다른 시각적 특징을 앞세워 적었다.';

writeFileSync(PATH, JSON.stringify(db, null, 2) + '\n');

console.log(`라벨 갱신 ${updated}종 / 전체 ${db.foods.length}종`);
if (missing.length) console.log('⚠️ 새 라벨 없음:', missing.join(', '));
if (unknown.length) console.log('⚠️ 테이블에 없는 id:', unknown.join(', '));
if (dupes.length) console.log('⚠️ 라벨 중복:', dupes.join(' / '));

const avg = (labels.reduce((s, l) => s + l.split(' ').length, 0) / labels.length).toFixed(1);
console.log(`평균 라벨 길이 ${avg}단어`);
console.log(missing.length || unknown.length || dupes.length ? '확인 필요' : '이상 없음');
