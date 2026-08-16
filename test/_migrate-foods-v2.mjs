/**
 * 일회성 마이그레이션 v2 — 전 연령 식단으로 음식 테이블 확장
 *
 * 기존 62종은 한식·노인 식단 위주였다. 대상을 전 연령으로 넓혔으니
 * 양식·분식·중식·일식·편의점·카페 음료·주류·간식을 채운다.
 * 특히 카페인 축을 넣어 두고 급원이 커피뿐이었던 구멍을 메운다
 * (에너지드링크·아메리카노·라떼·버블티·녹차·콜라).
 *
 * 실행: node test/_migrate-foods-v2.mjs   (여러 번 실행해도 안전)
 */
import { readFileSync, writeFileSync } from 'node:fs';

const PATH = new URL('../data/foods-ko.json', import.meta.url);
const db = JSON.parse(readFileSync(PATH, 'utf8'));

/* 위치 인자 순서 — 값은 전부 1회 제공량(g) 기준
   0  id
   1  ko
   2  aliases[]
   3  en (CLIP 후보 라벨)
   4  serving_g
   5  kcal      6  carb_g    7  protein_g  8  fat_g     9  satfat_g
   10 transfat  11 sugar_g   12 sodium_mg  13 chol_mg   14 potassium
   15 phosphor  16 calcium   17 purine     18 vitk_ug   19 fluid_ml
   20 iron_mg   21 iodine    22 caffeine   23 vita_ug(레티놀·동물성만)
   24 texture   25 irritant[]  26 tags[]   27 alcohol
*/
const F = [
// ── 양식·카페 식사 ────────────────────────────────────────────────────────────
['pasta_cream','크림파스타',['까르보나라','알프레도'],'creamy carbonara pasta',
  400, 780, 85, 24, 38, 20, 0.6, 6, 1250, 130, 320, 380, 300, 90, 12, 40, 2.5, 30, 0, 220, 'normal',['greasy','salty'],[],false],
['pasta_tomato','토마토파스타',['스파게티','아라비아타'],'tomato spaghetti pasta',
  400, 520, 78, 17, 15, 4, 0.2, 12, 1100, 20, 620, 200, 90, 70, 25, 30, 2.8, 15, 0, 40, 'normal',['salty','acidic'],[],false],
['pizza','피자',['페퍼로니피자','치즈피자'],'a slice of pepperoni pizza',
  250, 680, 72, 28, 30, 14, 0.7, 8, 1500, 60, 380, 450, 420, 60, 20, 50, 2.5, 25, 0, 180, 'normal',['greasy','salty'],['processed'],false],
['burger','햄버거',['치즈버거','불고기버거'],'a cheeseburger',
  240, 610, 50, 28, 33, 13, 0.9, 9, 1150, 85, 400, 320, 220, 75, 15, 60, 3.5, 20, 0, 100, 'normal',['greasy','salty'],['processed'],false],
['fries','감자튀김',['프렌치프라이'],'french fries',
  120, 380, 48, 4, 19, 3.5, 0.5, 0.5, 380, 0, 690, 110, 15, 12, 25, 35, 1.0, 2, 0, 0, 'dry',['greasy','salty'],['processed'],false],
['steak','스테이크',['등심스테이크','안심스테이크'],'a grilled beef steak',
  200, 480, 2, 45, 32, 13, 0.5, 0, 650, 130, 620, 400, 25, 190, 4, 0, 5.0, 8, 0, 20, 'normal',['greasy'],[],false],
['risotto','리조또',[],'creamy mushroom risotto',
  350, 560, 72, 14, 22, 11, 0.4, 5, 1000, 55, 340, 250, 180, 60, 10, 60, 1.6, 20, 0, 130, 'soft',['salty','greasy'],[],false],
['salad_green','샐러드',['그린샐러드','야채샐러드'],'a fresh green garden salad',
  200, 160, 12, 4, 10, 1.8, 0, 6, 380, 5, 480, 70, 90, 25, 210, 5, 1.5, 4, 0, 10, 'normal',['acidic'],['cruciferous','raw'],false],
['salad_chicken','닭가슴살샐러드',['치킨샐러드'],'grilled chicken breast salad',
  300, 320, 14, 32, 14, 2.5, 0, 6, 620, 75, 620, 320, 100, 45, 190, 5, 1.8, 6, 0, 25, 'normal',['acidic'],['cruciferous','raw'],false],
['sandwich','샌드위치',['클럽샌드위치','햄샌드위치'],'a ham and cheese sandwich',
  200, 400, 42, 18, 17, 7, 0.4, 6, 1000, 55, 260, 260, 190, 45, 35, 20, 2.0, 22, 0, 90, 'normal',['salty'],['processed'],false],
['toast_butter','버터토스트',['식빵','토스트'],'buttered toast bread',
  90, 300, 40, 7, 12, 7, 0.3, 5, 400, 30, 90, 90, 60, 12, 5, 0, 1.2, 8, 0, 90, 'dry',['greasy'],[],false],
['croissant','크루아상',['빵','페이스트리'],'a butter croissant',
  70, 290, 30, 5, 16, 10, 0.4, 6, 350, 40, 70, 70, 30, 10, 6, 0, 1.0, 6, 0, 120, 'dry',['greasy'],[],false],
['cereal_milk','시리얼',['콘플레이크','그래놀라'],'a bowl of breakfast cereal with milk',
  250, 330, 52, 11, 8, 4, 0.1, 22, 320, 25, 420, 300, 320, 20, 2, 200, 6.5, 55, 0, 110, 'soft',[],['processed'],false],
['omelet','오믈렛',['스크램블에그'],'a cheese omelette',
  180, 330, 4, 20, 26, 11, 0.3, 2, 620, 450, 240, 300, 200, 8, 15, 50, 2.4, 40, 0, 320, 'soft',['greasy'],[],false],
['soup_cream','크림스프',['콘스프','양송이스프'],'a bowl of cream soup',
  250, 220, 24, 6, 11, 6, 0.2, 8, 850, 35, 280, 180, 150, 15, 8, 200, 0.8, 30, 0, 90, 'liquid',['salty'],[],false],

// ── 분식·한식 추가 ────────────────────────────────────────────────────────────
['budae_jjigae','부대찌개',['부대찌게'],'budae jjigae, Korean army stew with sausage',
  450, 620, 40, 30, 36, 14, 1.2, 9, 2600, 95, 720, 420, 180, 140, 60, 280, 3.5, 40, 0, 90, 'mixed',['spicy','salty','greasy'],['processed'],false],
['gamjatang','감자탕',['뼈해장국'],'gamjatang, Korean pork bone and potato stew',
  600, 580, 30, 42, 32, 12, 0.5, 6, 2100, 130, 1150, 420, 90, 260, 25, 320, 4.5, 25, 0, 60, 'mixed',['spicy','salty'],[],false],
['jeyuk','제육볶음',['돼지불고기'],'jeyuk bokkeum, spicy stir-fried pork',
  200, 450, 18, 28, 28, 10, 0.4, 12, 1250, 90, 480, 280, 40, 150, 20, 30, 2.0, 8, 0, 15, 'normal',['spicy','salty','greasy'],[],false],
['dakgalbi','닭갈비',[],'dakgalbi, spicy stir-fried chicken',
  300, 520, 32, 34, 26, 7, 0.4, 14, 1600, 110, 620, 340, 70, 190, 30, 40, 2.2, 12, 0, 60, 'normal',['spicy','salty'],[],false],
['yukgaejang','육개장',[],'yukgaejang, spicy Korean beef soup',
  500, 320, 14, 28, 17, 6, 0.3, 3, 1900, 80, 560, 260, 80, 150, 45, 350, 4.0, 20, 0, 40, 'mixed',['spicy','salty'],[],false],
['chueotang','추어탕',[],'chueotang, Korean loach soup',
  500, 340, 16, 30, 16, 5, 0.2, 3, 1700, 120, 500, 320, 380, 200, 70, 340, 4.0, 60, 0, 200, 'mixed',['spicy','salty'],[],false],
['cheonggukjang','청국장',[],'cheonggukjang, fermented soybean stew',
  300, 220, 16, 18, 9, 1.6, 0, 4, 1300, 5, 620, 300, 130, 90, 45, 200, 3.2, 30, 0, 20, 'mixed',['salty'],[],false],
['kongguksu','콩국수',[],'kongguksu, cold soybean noodle soup',
  600, 620, 78, 28, 20, 3, 0.1, 6, 900, 0, 700, 400, 160, 130, 20, 400, 4.5, 10, 0, 0, 'mixed',['salty'],[],false],
['bibim_guksu','비빔국수',['비빔면'],'bibim guksu, spicy cold noodles',
  400, 520, 88, 13, 10, 2, 0.1, 18, 1600, 10, 320, 170, 50, 60, 35, 20, 2.2, 12, 0, 15, 'normal',['spicy','salty','acidic'],[],false],
['tteokguk','떡국',['만둣국'],'tteokguk, Korean rice cake soup',
  500, 480, 78, 20, 10, 3.5, 0.2, 3, 1500, 70, 250, 190, 70, 70, 20, 300, 2.0, 40, 0, 60, 'mixed',['salty'],[],false],
['mandu','만두',['군만두','물만두'],'Korean dumplings, mandu',
  200, 420, 44, 16, 20, 6, 0.6, 3, 900, 40, 300, 180, 60, 70, 30, 30, 2.2, 15, 0, 40, 'normal',['salty','greasy'],['processed'],false],
['sundae','순대',[],'sundae, Korean blood sausage',
  150, 320, 30, 14, 16, 6, 0.3, 1, 700, 100, 200, 180, 40, 200, 5, 20, 7.5, 15, 0, 250, 'normal',['salty'],['organ'],false],
['twigim','튀김',['오징어튀김','야채튀김'],'assorted Korean fritters, twigim',
  120, 380, 34, 9, 23, 4, 0.8, 2, 600, 70, 200, 130, 40, 110, 20, 10, 1.2, 30, 0, 20, 'hard',['greasy','salty'],['processed'],false],
['eomuk','어묵',['오뎅'],'eomuk, Korean fish cake skewers in broth',
  180, 200, 22, 12, 7, 2, 0.3, 4, 1300, 25, 180, 170, 90, 70, 8, 200, 0.8, 90, 0, 10, 'soft',['salty'],['processed'],false],
['donkatsu','돈까스',['돈가스','포크커틀릿'],'tonkatsu, Korean pork cutlet',
  250, 680, 45, 30, 40, 11, 1.1, 6, 1200, 95, 450, 300, 70, 160, 25, 20, 2.0, 20, 0, 70, 'hard',['greasy','salty'],['processed'],false],
['curry_rice','카레라이스',['카레'],'Japanese curry rice',
  450, 620, 95, 18, 18, 7, 0.4, 12, 1400, 40, 620, 220, 60, 90, 20, 60, 2.5, 15, 0, 40, 'soft',['salty'],[],false],
['omurice','오므라이스',[],'omurice, Korean omelette rice',
  400, 640, 85, 20, 23, 8, 0.5, 10, 1300, 300, 420, 300, 120, 80, 20, 30, 2.6, 30, 0, 230, 'soft',['salty'],[],false],
['rabokki','라볶이',['라뽁이'],'rabokki, spicy rice cake with ramen',
  400, 620, 95, 15, 19, 8, 0.3, 20, 1900, 15, 280, 180, 80, 60, 30, 100, 1.8, 20, 0, 15, 'sticky',['spicy','salty'],['processed'],false],
['nakji_bokkeum','낙지볶음',['쭈꾸미볶음'],'nakji bokkeum, spicy stir-fried octopus',
  250, 320, 24, 26, 12, 2, 0.2, 12, 1700, 200, 520, 320, 80, 190, 35, 40, 3.0, 60, 0, 30, 'hard',['spicy','salty'],[],false],
['gopchang','곱창',['막창','대창'],'gopchang, Korean grilled beef intestines',
  180, 520, 4, 24, 45, 18, 0.6, 1, 800, 250, 260, 280, 30, 260, 8, 10, 3.5, 20, 0, 900, 'hard',['greasy','salty'],['organ'],false],
['yukhoe','육회',[],'yukhoe, Korean raw beef tartare',
  150, 260, 8, 28, 12, 5, 0.2, 4, 700, 90, 420, 280, 25, 170, 5, 0, 4.5, 8, 0, 30, 'soft',['salty'],['raw'],false],
['agujjim','아귀찜',['해물찜'],'agujjim, spicy braised monkfish',
  400, 380, 22, 38, 14, 3, 0.2, 8, 2200, 130, 720, 420, 120, 220, 60, 60, 2.5, 90, 0, 40, 'normal',['spicy','salty'],[],false],

// ── 중식·일식 ────────────────────────────────────────────────────────────────
['tangsuyuk','탕수육',[],'tangsuyuk, Korean sweet and sour pork',
  300, 740, 70, 26, 40, 11, 1.3, 32, 900, 80, 380, 260, 50, 140, 20, 30, 1.8, 15, 0, 40, 'normal',['greasy','acidic'],['processed'],false],
['mapo_dubu','마파두부',[],'mapo tofu',
  300, 380, 16, 22, 25, 7, 0.4, 6, 1500, 50, 420, 320, 240, 110, 15, 60, 3.0, 12, 0, 30, 'soft',['spicy','salty'],[],false],
['bokkeumbap','볶음밥',['새우볶음밥','김치볶음밥'],'Korean fried rice',
  400, 660, 88, 18, 25, 6, 0.6, 5, 1500, 150, 320, 240, 80, 70, 25, 20, 2.0, 40, 0, 110, 'normal',['salty','greasy'],[],false],
['maratang','마라탕',[],'maratang, spicy Chinese hotpot soup',
  600, 620, 45, 28, 36, 12, 0.9, 8, 3200, 90, 800, 400, 180, 180, 80, 350, 4.0, 60, 0, 60, 'mixed',['spicy','salty','greasy'],['processed'],false],
['sushi','초밥',['스시','회덮밥'],'assorted nigiri sushi',
  250, 420, 66, 22, 6, 1.2, 0, 12, 1100, 55, 320, 260, 40, 130, 8, 10, 1.2, 40, 0, 25, 'soft',['acidic'],['raw'],false],
['udon','우동',[],'udon noodle soup',
  600, 460, 82, 14, 6, 1.4, 0.1, 6, 2400, 20, 260, 150, 60, 60, 15, 380, 1.5, 120, 0, 15, 'mixed',['salty'],[],false],
['tonkotsu_ramen','돈코츠라멘',['일본라멘'],'tonkotsu ramen',
  650, 700, 78, 30, 30, 11, 0.5, 5, 2800, 120, 480, 350, 90, 220, 20, 340, 2.8, 40, 0, 120, 'mixed',['salty','greasy'],[],false],
['gyudon','규동',['소고기덮밥'],'gyudon, Japanese beef rice bowl',
  450, 660, 92, 26, 20, 8, 0.4, 14, 1600, 75, 420, 280, 40, 150, 8, 20, 3.0, 20, 0, 25, 'soft',['salty'],[],false],

// ── 편의점 ────────────────────────────────────────────────────────────────────
['samgak_kimbap','삼각김밥',[],'a convenience store rice ball, samgak kimbap',
  110, 200, 36, 5, 4, 1, 0.1, 2, 480, 15, 90, 70, 25, 25, 12, 5, 0.7, 40, 0, 15, 'soft',['salty'],['processed'],false],
['dosirak','편의점도시락',['도시락'],'a Korean convenience store lunchbox',
  500, 780, 100, 28, 28, 9, 1.0, 12, 2200, 130, 520, 380, 130, 130, 35, 30, 3.0, 40, 0, 130, 'normal',['salty','greasy'],['processed'],false],
['cup_ramen','컵라면',[],'a cup of instant noodles',
  350, 380, 55, 8, 14, 7, 0.2, 3, 1500, 5, 150, 100, 100, 25, 4, 300, 1.2, 12, 0, 5, 'mixed',['spicy','salty','greasy'],['processed'],false],
['hotbar','핫바',['소시지','비엔나소시지'],'a sausage snack bar',
  90, 240, 14, 9, 16, 6, 0.4, 3, 750, 40, 130, 190, 30, 60, 8, 0, 0.9, 12, 0, 20, 'normal',['salty','greasy'],['processed'],false],
['ham_canned','햄',['스팸','통조림햄'],'canned luncheon meat, spam',
  60, 190, 2, 8, 17, 6, 0.3, 1, 800, 45, 130, 160, 5, 60, 3, 0, 0.6, 8, 0, 15, 'normal',['salty','greasy'],['processed'],false],
['tuna_can','참치캔',[],'canned tuna',
  100, 180, 0, 22, 10, 2, 0, 0, 350, 45, 280, 220, 15, 150, 3, 0, 1.3, 25, 0, 15, 'soft',['salty'],['high_mercury','processed'],false],

// ── 단백질·건강식 ─────────────────────────────────────────────────────────────
['chicken_breast','닭가슴살',['삶은닭가슴살'],'boiled chicken breast',
  150, 190, 0, 40, 3, 0.9, 0, 0, 320, 105, 500, 350, 15, 170, 3, 0, 0.6, 6, 0, 15, 'dry',[],[],false],
['protein_shake','프로틴쉐이크',['단백질보충제'],'a protein shake drink',
  330, 220, 12, 30, 4, 1.5, 0, 6, 250, 40, 420, 380, 450, 5, 0, 320, 4.5, 30, 0, 60, 'liquid',[],['processed'],false],
['boiled_egg','삶은계란',['계란'],'boiled eggs',
  110, 160, 1, 13, 11, 3.5, 0, 1, 130, 400, 140, 190, 55, 5, 0, 0, 1.8, 30, 0, 160, 'dry',[],[],false],
['salmon','연어',['연어구이','훈제연어'],'grilled salmon fillet',
  120, 230, 0, 25, 14, 3, 0, 0, 300, 65, 460, 280, 15, 130, 1, 0, 0.5, 30, 0, 45, 'soft',['salty'],[],false],
['dubu_gangjeong','두부강정',['두부튀김'],'crispy fried tofu bites',
  150, 330, 22, 14, 20, 3, 0.5, 8, 700, 0, 220, 220, 240, 80, 12, 10, 2.0, 5, 0, 0, 'normal',['greasy','salty','spicy'],[],false],
['gimjaban','김자반',['조미김가루'],'seasoned crumbled seaweed, gimjaban',
  10, 50, 3, 3, 3, 0.5, 0, 1, 280, 0, 260, 70, 30, 60, 40, 0, 1.0, 600, 0, 0, 'dry',['salty'],[],false],
['dasima','다시마',['다시마채','미역줄기'],'dried kelp, dasima',
  15, 25, 5, 1, 0.2, 0, 0, 0, 350, 0, 900, 40, 130, 30, 10, 0, 0.8, 5400, 0, 0, 'hard',['salty'],[],false],

// ── 과일·채소 추가 ────────────────────────────────────────────────────────────
['strawberry','딸기',[],'fresh strawberries',
  150, 48, 11, 1, 0.5, 0, 0, 7, 2, 0, 230, 35, 25, 6, 3, 0, 0.6, 1, 0, 0, 'soft',['acidic'],[],false],
['watermelon','수박',[],'watermelon slices',
  300, 90, 22, 1.8, 0.5, 0, 0, 18, 3, 0, 340, 33, 21, 5, 0, 270, 0.7, 1, 0, 0, 'soft',[],[],false],
['tomato','토마토',['방울토마토'],'fresh tomatoes',
  200, 36, 8, 1.8, 0.4, 0, 0, 5, 10, 0, 480, 48, 20, 8, 16, 0, 0.5, 2, 0, 0, 'soft',['acidic'],[],false],
['cucumber','오이',[],'fresh cucumber',
  150, 18, 4, 0.9, 0.2, 0, 0, 2, 3, 0, 220, 36, 24, 5, 25, 0, 0.4, 1, 0, 0, 'normal',[],[],false],
['carrot','당근',[],'raw carrot sticks',
  100, 41, 10, 0.9, 0.2, 0, 0, 5, 69, 0, 320, 35, 33, 8, 13, 0, 0.3, 2, 0, 0, 'hard',[],[],false],
['avocado','아보카도',[],'a ripe avocado',
  140, 230, 12, 3, 21, 3, 0, 1, 10, 0, 690, 75, 17, 12, 30, 0, 0.8, 2, 0, 0, 'soft',[],[],false],
['blueberry','블루베리',[],'fresh blueberries',
  100, 57, 14, 0.7, 0.3, 0, 0, 10, 1, 0, 77, 12, 6, 3, 19, 0, 0.3, 1, 0, 0, 'soft',['acidic'],[],false],
['pear','배',[],'a Korean pear',
  250, 130, 33, 0.8, 0.3, 0, 0, 24, 3, 0, 300, 28, 10, 5, 10, 0, 0.4, 1, 0, 0, 'hard',[],[],false],
['persimmon','감',['홍시','단감'],'a persimmon',
  150, 105, 28, 0.9, 0.3, 0, 0, 20, 2, 0, 240, 25, 12, 6, 4, 0, 0.4, 1, 0, 0, 'soft',[],[],false],
['corn','옥수수',['찰옥수수'],'a steamed corn cob',
  150, 145, 32, 5, 2, 0.3, 0, 6, 20, 0, 400, 130, 5, 15, 1, 0, 0.8, 2, 0, 0, 'hard',[],[],false],

// ── 음료 (카페인 급원 보강) ───────────────────────────────────────────────────
['americano','아메리카노',['커피(아메리카노)'],'a cup of black americano coffee',
  350, 10, 2, 0.6, 0, 0, 0, 0, 10, 0, 180, 10, 5, 0, 0, 350, 0.1, 1, 150, 0, 'liquid',['caffeine','acidic'],[],false],
['cafe_latte','카페라떼',['라떼','카푸치노'],'a cafe latte with milk',
  350, 180, 16, 9, 9, 6, 0.2, 15, 130, 35, 450, 250, 300, 3, 1, 340, 0.2, 70, 130, 90, 'liquid',['caffeine'],[],false],
['energy_drink','에너지드링크',['핫식스','레드불','몬스터'],'a can of energy drink',
  250, 115, 28, 0, 0, 0, 0, 27, 105, 0, 10, 5, 5, 0, 0, 250, 0, 0, 80, 0, 'liquid',['caffeine','acidic'],['processed'],false],
['bubble_tea','버블티',['밀크티','흑당버블티'],'a cup of milk bubble tea',
  500, 400, 78, 6, 8, 5, 0.2, 52, 130, 20, 230, 130, 160, 5, 1, 420, 0.5, 40, 50, 40, 'mixed',['caffeine'],['processed'],false],
['green_tea','녹차',['보리차','현미녹차'],'a cup of green tea',
  250, 2, 0, 0, 0, 0, 0, 0, 3, 0, 30, 2, 3, 0, 0, 250, 0.1, 1, 30, 0, 'liquid',['caffeine'],[],false],
['cola','콜라',['사이다','탄산음료'],'a can of cola soda',
  355, 150, 39, 0, 0, 0, 0, 39, 45, 0, 5, 45, 3, 0, 0, 350, 0.1, 0, 34, 0, 'liquid',['caffeine','acidic'],['processed'],false],
['orange_juice','오렌지주스',['과일주스'],'a glass of orange juice',
  250, 110, 26, 1.7, 0.5, 0, 0, 21, 5, 0, 500, 42, 28, 2, 0, 250, 0.5, 1, 0, 0, 'liquid',['acidic'],[],false],
['sports_drink','이온음료',['포카리스웨트','게토레이'],'a bottle of sports drink',
  500, 130, 32, 0, 0, 0, 0, 30, 200, 0, 100, 0, 10, 0, 0, 500, 0, 0, 0, 0, 'liquid',[],['processed'],false],
['makgeolli','막걸리',['동동주'],'a bowl of makgeolli, Korean rice wine',
  300, 190, 20, 5, 0.5, 0, 0, 5, 30, 0, 90, 60, 20, 30, 0, 300, 0.4, 2, 0, 0, 'liquid',['acidic'],[],true],
['wine','와인',['레드와인','화이트와인'],'a glass of red wine',
  150, 125, 4, 0.1, 0, 0, 0, 1, 6, 0, 190, 30, 12, 8, 0, 150, 0.7, 1, 0, 0, 'liquid',['acidic'],[],true],
['whisky','위스키',['양주','하이볼'],'a glass of whisky',
  50, 115, 0, 0, 0, 0, 0, 0, 1, 0, 1, 1, 0, 0, 0, 50, 0, 0, 0, 0, 'liquid',['acidic'],[],true],

// ── 간식·디저트 ───────────────────────────────────────────────────────────────
['cake','케이크',['생크림케이크','초코케이크'],'a slice of cream cake',
  100, 350, 42, 4, 18, 11, 0.5, 30, 220, 70, 90, 90, 70, 12, 4, 0, 0.8, 15, 5, 130, 'soft',['greasy'],['processed'],false],
['donut','도넛',[],'a glazed donut',
  70, 280, 34, 4, 14, 6, 0.9, 15, 260, 15, 70, 70, 30, 10, 8, 0, 0.9, 8, 0, 30, 'soft',['greasy'],['processed'],false],
['ice_cream','아이스크림',[],'a scoop of vanilla ice cream',
  100, 210, 24, 4, 11, 7, 0.3, 22, 80, 45, 180, 110, 130, 3, 1, 60, 0.1, 25, 0, 90, 'soft',[],['processed'],false],
['chocolate','초콜릿',['다크초콜릿','밀크초콜릿'],'a bar of milk chocolate',
  50, 270, 29, 3.5, 15, 9, 0.2, 25, 40, 10, 190, 110, 100, 5, 3, 0, 1.2, 8, 12, 30, 'hard',['caffeine'],['processed'],false],
['snack_chips','과자',['감자칩','스낵'],'a bag of potato chips',
  60, 330, 32, 3, 21, 7, 0.6, 2, 350, 0, 620, 90, 20, 12, 12, 0, 0.8, 5, 0, 0, 'hard',['greasy','salty'],['processed'],false],
['bungeoppang','붕어빵',['호떡','타코야키'],'bungeoppang, Korean fish-shaped pastry',
  100, 250, 44, 5, 6, 2, 0.3, 18, 200, 15, 130, 70, 40, 12, 3, 0, 1.0, 10, 0, 20, 'soft',['greasy'],[],false],
['popcorn','팝콘',[],'a bowl of popcorn',
  50, 250, 28, 4, 14, 6, 0.4, 1, 350, 5, 90, 80, 10, 10, 3, 0, 0.7, 4, 0, 15, 'hard',['greasy','salty'],['processed'],false],
];

/* 위치 배열 → 객체 */
function toFood(a) {
  const [id, ko, aliases, en, serving_g, kcal, carb_g, protein_g, fat_g, satfat_g,
         transfat_g, sugar_g, sodium_mg, cholesterol_mg, potassium_mg, phosphorus_mg,
         calcium_mg, purine_mg, vitk_ug, fluid_ml, iron_mg, iodine_ug, caffeine_mg,
         vita_ug, texture, irritant, tags, alcohol] = a;
  return { id, ko, aliases, en, serving_g, kcal, carb_g, protein_g, fat_g, satfat_g,
           transfat_g, sugar_g, sodium_mg, cholesterol_mg, potassium_mg, phosphorus_mg,
           calcium_mg, purine_mg, vitk_ug, fluid_ml, texture, irritant, alcohol,
           src: 'est', iron_mg, iodine_ug, caffeine_mg, vita_ug, tags };
}

const FIELD_COUNT = 28;
const bad = F.filter(a => a.length !== FIELD_COUNT);
if (bad.length) {
  console.error(`✗ 필드 수가 맞지 않는 항목 ${bad.length}개:`,
    bad.map(a => `${a[0]}(${a.length}개)`).join(', '));
  process.exit(1);
}

let added = 0, updated = 0;
for (const row of F) {
  const food = toFood(row);
  const i = db.foods.findIndex(f => f.id === food.id);
  if (i >= 0) { db.foods[i] = food; updated++; }
  else { db.foods.push(food); added++; }
}

db._meta.version = '0.3.0';
db._meta.updated = new Date().toISOString().slice(0, 10);
db._meta.scope_note =
  '전 연령 대상이므로 한식뿐 아니라 양식·분식·중식·일식·편의점·카페 음료·주류·간식을 포함한다. ' +
  '카페인 급원을 커피 외에 아메리카노·라떼·에너지드링크·버블티·녹차·콜라·초콜릿으로 넓혔다.';

writeFileSync(PATH, JSON.stringify(db, null, 2) + '\n');

console.log(`추가 ${added}종 · 갱신 ${updated}종 → 전체 ${db.foods.length}종`);

/* 즉시 무결성 확인 */
const ids = db.foods.map(f => f.id);
const dupes = ids.filter((x, i) => ids.indexOf(x) !== i);
if (dupes.length) console.log('⚠️ id 중복:', [...new Set(dupes)].join(', '));

const labels = db.foods.map(f => f.en);
const dupLabels = labels.filter((x, i) => labels.indexOf(x) !== i);
if (dupLabels.length) console.log('⚠️ CLIP 라벨 중복:', [...new Set(dupLabels)].join(' / '));

console.log(dupes.length || dupLabels.length ? '무결성 확인 필요' : '무결성 이상 없음');
