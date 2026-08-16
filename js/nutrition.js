/**
 * nutrition.js — 2계층 영양 데이터 계층
 *
 * 왜 2계층인가
 * ────────────
 * 식약처 식품영양성분DB는 에너지·탄수화물·단백질·지방·당류·나트륨·콜레스테롤·
 * 포화지방·트랜스지방을 제공한다. 그런데 이 앱이 판정에 쓰는 축 중
 *
 *   · 퓨린   → 식약처 DB에 항목 자체가 없다 (통풍 판정에 필수)
 *   · 비타민K → 커버가 불완전하다 (와파린 판정에 필수)
 *   · 칼륨·인 → 품목에 따라 누락이 있다 (만성콩팥병 판정에 필수)
 *   · 질감·자극성 → 영양 DB의 개념이 아니다 (연하곤란·역류 판정에 필수)
 *
 * 이 넷은 공공 API로 채울 수 없다. 그래서 내장 테이블(foods-ko.json)을
 * 항상 기반으로 깔고, 식약처 값이 있으면 겹치는 축만 덮어쓴다.
 *
 *   내장 테이블 (전 축 보장, 추정치)  ←  식약처 API (일부 축, 공신력)
 *
 * 이 구조 덕분에 오프라인에서도 판정이 되고, 온라인이면 정확도가 올라간다.
 */

const LOCAL_DB_URL = new URL('../data/foods-ko.json', import.meta.url);

/* ────────────────────────────────────────────────────────────
   식약처 API 필드 매핑
   ────────────────────────────────────────────────────────────
   ⚠️ 중요: I2790은 2023년으로 신규 제공이 끝났고 후속이 I0750이다.
   두 서비스의 응답 필드명이 다르므로 프로파일로 분리해 두었다.
   I0750 프로파일의 필드명과 basis는 실제 키로 한 번 호출해 확인한 뒤
   확정해야 한다. 확인 방법은 README의 "식약처 API 검증" 절 참조.
*/
export const MFDS_PROFILES = {
  /* 구 서비스 — 2023년에 신규 제공이 끝났다. 실제로 호출하면 죽어 있는 게 확인됐다(2026-08).
     그래도 코드·테스트는 남겨 둔다. 필드명 자체는 문서·예제로 널리 검증돼 있었다. */
  I2790: {
    service: 'I2790',
    envelope: 'legacy',            // { I2790: { RESULT:{...}, row:[...] } }
    listKey: 'I2790',
    basis: 'per_serving',          // NUTR_CONT는 SERVING_WT(1회 제공량) 기준
    nameField: 'DESC_KOR',
    servingField: 'SERVING_WT',
    searchParam: 'DESC_KOR',
    map: {
      kcal:           'NUTR_CONT1',
      carb_g:         'NUTR_CONT2',
      protein_g:      'NUTR_CONT3',
      fat_g:          'NUTR_CONT4',
      sugar_g:        'NUTR_CONT5',
      sodium_mg:      'NUTR_CONT6',
      cholesterol_mg: 'NUTR_CONT7',
      satfat_g:       'NUTR_CONT8',
      transfat_g:     'NUTR_CONT9'
      // 칼륨·인·퓨린·비타민K 없음 → 내장 테이블 값 유지
    }
  },

  /* 신 서비스 — 2026-08-13 실제 키로 검증 완료.
     I2790과 URL·응답 껍데기가 완전히 다르다(data.go.kr 표준 REST 포맷으로 이전됨).
     검증 방법: worker/proxy.js의 handleMfds 주석, tools/verify-mfds.mjs 참조. */
  I0750: {
    service: 'I0750',
    envelope: 'datago',            // { header:{resultCode,resultMsg}, body:{items:[...]} }
    basis: 'per_100g',             // ✅ 검증됨 — 응답의 SERVING_SIZE 필드가 "100g"으로 명시됨
    nameField: 'FOOD_NM_KR',
    servingField: 'SERVING_SIZE',
    searchParam: 'FOOD_NM_KR',
    map: {
      kcal:           'AMT_NUM1',
      carb_g:         'AMT_NUM6',
      protein_g:      'AMT_NUM3',
      fat_g:          'AMT_NUM4',
      sugar_g:        'AMT_NUM7',
      sodium_mg:      'AMT_NUM13',
      cholesterol_mg: 'AMT_NUM23',
      satfat_g:       'AMT_NUM24',
      transfat_g:     'AMT_NUM25',
      potassium_mg:   'AMT_NUM12',
      phosphorus_mg:  'AMT_NUM11',
      calcium_mg:     'AMT_NUM9',
      /* ⚠️ AMT_NUM10 = 철분으로 추정. 된장찌개·국밥 실측치에서 표준 식품성분표
         항목 순서(열량-수분-단백질-지방-회분-탄수화물-당류-식이섬유-칼슘-철-인-칼륨-나트륨)와
         이미 검증된 9개 필드가 정확히 일치해 위치로 추정했다. 철 항목만 별도로 대조하지는
         않았으니 판정값이 이상하면 이 줄부터 의심할 것. */
      iron_mg:        'AMT_NUM10'
    }
    /* kcal(AMT_NUM1)이 protein·fat·carb(AMT_NUM3·4·6)의 아트워터 계산과 일치하는 것으로
       나머지 필드명도 교차검증됨. 2026-08-13, 된장찌개 실데이터로 확인. */
  }
};

/* 식약처가 절대 제공하지 않는 축. 항상 내장 테이블 값을 쓴다. */
const LOCAL_ONLY_AXES = ['purine_mg', 'vitk_ug', 'fluid_ml'];

/* 원격(식약처) 음식에서 0으로 남는 축. 이 축에 의존하는 판정은 과소평가된다.
   purine → 통풍, vitk → 와파린, iodine → 갑상선, iron/caffeine → 빈혈·임신 */
const MFDS_MISSING_AXES = [
  'purine_mg', 'vitk_ug', 'iodine_ug', 'iron_mg', 'caffeine_mg', 'vita_ug', 'fluid_ml'
];

/* 원격 음식 객체를 만들 때 0으로 초기화할 축 목록.
   rules.js의 AXES와 같은 키를 쓴다(순환 import를 피하려 여기서 다시 적는다). */
const AXES_ZERO = {
  sodium_mg: 0, potassium_mg: 0, phosphorus_mg: 0, protein_g: 0, carb_g: 0,
  sugar_g: 0, fat_g: 0, satfat_g: 0, transfat_g: 0, cholesterol_mg: 0,
  calcium_mg: 0, purine_mg: 0, vitk_ug: 0, fluid_ml: 0, kcal: 0,
  iron_mg: 0, iodine_ug: 0, caffeine_mg: 0, vita_ug: 0
};

/* 프로파일마다 응답 껍데기가 다르다(구 서비스 vs data.go.kr 신 REST 포맷).
   여기서 한 번만 흡수해 나머지 코드는 껍데기를 몰라도 되게 한다. */
function extractRows(data, p) {
  if (p.envelope === 'datago') {
    const items = data?.body?.items;
    return Array.isArray(items) ? items : (items ? [items] : []);
  }
  return data?.[p.listKey]?.row || [];
}

export class NutritionStore {
  /**
   * @param {object} opts
   * @param {string} opts.proxyUrl   Cloudflare Worker 주소. 비우면 내장 테이블만 사용.
   * @param {string} opts.profile    'I2790' | 'I0750'
   */
  constructor({ proxyUrl = '', profile = 'I2790' } = {}) {
    this.proxyUrl = proxyUrl;
    this.profile = MFDS_PROFILES[profile] || MFDS_PROFILES.I2790;
    this.foods = [];
    this.meta = null;
    this._cache = new Map();       // 이름 → 식약처 조회 결과 (세션 내 재사용)
    this._ready = null;
  }

  async ready() {
    if (!this._ready) {
      this._ready = fetch(LOCAL_DB_URL)
        .then(r => {
          if (!r.ok) throw new Error(`영양 테이블을 불러오지 못했습니다 (HTTP ${r.status})`);
          return r.json();
        })
        .then(db => { this.foods = db.foods; this.meta = db._meta; return this; });
    }
    return this._ready;
  }

  /** 내장 테이블 검색. 한글명·별칭·id 모두 매칭한다. */
  search(query, limit = 8) {
    const q = String(query || '').trim().toLowerCase().replace(/\s+/g, '');
    if (!q) return [];
    const scored = [];
    for (const f of this.foods) {
      const names = [f.ko, ...(f.aliases || []), f.id];
      let best = -1;
      for (const nm of names) {
        const s = String(nm).toLowerCase().replace(/\s+/g, '');
        if (s === q) { best = 100; break; }
        if (s.startsWith(q)) best = Math.max(best, 70);
        else if (s.includes(q)) best = Math.max(best, 40);
        else if (q.includes(s) && s.length >= 2) best = Math.max(best, 30);
      }
      if (best > 0) scored.push({ food: f, score: best });
    }
    return scored.sort((a, b) => b.score - a.score).slice(0, limit).map(x => x.food);
  }

  byId(id) { return this.foods.find(f => f.id === id) || null; }

  /** CLIP 제로샷 분류에 넘길 후보 라벨 (영문 설명문) */
  clipLabels() { return this.foods.map(f => f.en); }
  byClipLabel(label) { return this.foods.find(f => f.en === label) || null; }

  /**
   * 내장 값 + 식약처 값을 병합해 최종 영양 레코드를 만든다.
   * 식약처 조회에 실패해도 내장 값으로 정상 동작한다(fail-soft).
   * @returns {{...food, _sources: {axis: 'mfds'|'builtin'}, _mfdsName: string|null}}
   */
  async resolve(food, { useMfds = true } = {}) {
    const base = { ...food };
    const sources = {};
    for (const k of Object.keys(base)) sources[k] = 'builtin';

    if (!useMfds || !this.proxyUrl) return { ...base, _sources: sources, _mfdsName: null };

    let rec;
    try {
      rec = await this._fetchMfds(food.ko);
    } catch {
      return { ...base, _sources: sources, _mfdsName: null, _mfdsError: true };
    }
    if (!rec) return { ...base, _sources: sources, _mfdsName: null };

    const p = this.profile;
    const servingFromApi = Number(rec[p.servingField]) || null;
    /* 스케일 계산:
       - basis가 per_100g면 API 값은 100g 기준 → 내장 serving_g에 맞춰 환산
       - basis가 per_serving이면 API의 SERVING_WT 기준 → 내장 serving_g에 맞춰 환산 */
    const apiBasisGrams = p.basis === 'per_100g' ? 100 : (servingFromApi || food.serving_g);
    const scale = food.serving_g / apiBasisGrams;

    for (const [axis, field] of Object.entries(p.map)) {
      if (LOCAL_ONLY_AXES.includes(axis)) continue;
      const raw = rec[field];
      if (raw === undefined || raw === null || raw === '') continue;
      const num = Number(String(raw).replace(/[^0-9.\-]/g, ''));
      if (!Number.isFinite(num)) continue;
      base[axis] = Math.round(num * scale * 100) / 100;
      sources[axis] = 'mfds';
    }

    return { ...base, _sources: sources, _mfdsName: rec[p.nameField] || null };
  }

  async _fetchMfds(name, rows = 1) {
    const key = `${name}::${rows}`;
    if (this._cache.has(key)) return this._cache.get(key);
    const p = this.profile;
    const res = await fetch(`${this.proxyUrl}/mfds`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ service: p.service, param: p.searchParam, value: name, rows })
    });
    if (!res.ok) throw new Error(`MFDS HTTP ${res.status}`);
    const data = await res.json();
    const list = extractRows(data, p);
    const out = rows === 1 ? (list[0] || null) : list;
    this._cache.set(key, out);
    return out;
  }

  /* ────────────────────────────────────────────────────────────
     식약처 DB로 검색 범위를 넓힌다
     ────────────────────────────────────────────────────────────
     내장 테이블은 148종뿐이다. 검색을 주력 입력 수단으로 쓰려면
     "찾으면 없다"가 자주 나오면 안 된다. 그래서 내장에서 못 찾으면
     식약처 DB(수만 종)를 조회한다.

     ⚠️ 식약처 값에는 퓨린·비타민K·요오드·질감이 없다. 그래서 이 경로로
        들어온 음식은 해당 축이 0이 되고, 통풍·와파린·갑상선·연하곤란
        판정에서 과소평가된다. 이 사실을 항목에 표시해 UI가 경고할 수 있게 한다.
  */
  async searchRemote(query, limit = 6) {
    if (!this.proxyUrl) return [];
    const q = String(query || '').trim();
    if (q.length < 2) return [];

    let rows;
    try {
      rows = await this._fetchMfds(q, limit);
    } catch {
      return [];   // 원격 검색 실패는 조용히 무시한다. 내장 결과만으로도 앱은 돈다.
    }
    if (!Array.isArray(rows)) rows = rows ? [rows] : [];

    const p = this.profile;
    return rows.map(row => this._rowToFood(row, p)).filter(Boolean);
  }

  /** 식약처 응답 한 줄을 내장 테이블과 같은 모양의 음식 객체로 바꾼다 */
  _rowToFood(row, p) {
    const name = row?.[p.nameField];
    if (!name) return null;

    const servingFromApi = Number(row[p.servingField]) || 100;
    const basisGrams = p.basis === 'per_100g' ? 100 : servingFromApi;
    const scale = servingFromApi / basisGrams;

    const food = {
      id: `mfds:${String(name).replace(/\s+/g, '_')}`,
      ko: String(name).trim(),
      aliases: [],
      en: '',                    // CLIP 후보로는 쓰지 않는다 (묘사가 없으므로)
      serving_g: Math.round(servingFromApi),
      texture: 'normal',         // 식약처는 질감을 모른다 → 중립값
      irritant: [],
      tags: [],
      alcohol: false,
      src: 'mfds',
      remote: true               // 내장이 아닌 원격 출처임을 표시
    };

    for (const axis of Object.keys(AXES_ZERO)) food[axis] = 0;

    for (const [axis, field] of Object.entries(p.map)) {
      const raw = row[field];
      if (raw === undefined || raw === null || raw === '') continue;
      const num = Number(String(raw).replace(/[^0-9.\-]/g, ''));
      if (!Number.isFinite(num)) continue;
      food[axis] = Math.round(num * scale * 100) / 100;
    }

    /* 식약처가 주지 않는 축. 0으로 남으므로 해당 질환 판정이 관대해진다.
       숨기지 않고 목록으로 넘겨 UI가 "이 항목은 통풍 판정이 부정확합니다"를
       띄울 수 있게 한다. */
    food.missingAxes = MFDS_MISSING_AXES.filter(a => !(a in p.map));
    return food;
  }

  /** 이 식사의 값 중 몇 %가 공신력 있는 출처에서 왔는지 — 화면에 정직하게 표시하기 위한 값 */
  static provenance(resolvedFoods) {
    const axes = ['kcal','carb_g','protein_g','fat_g','sugar_g','sodium_mg',
                  'cholesterol_mg','satfat_g','transfat_g','potassium_mg','phosphorus_mg'];
    let mfds = 0, total = 0;
    for (const f of resolvedFoods) {
      for (const a of axes) {
        if (f[a] == null) continue;
        total++;
        if (f._sources?.[a] === 'mfds') mfds++;
      }
    }
    return { mfds, total, pct: total ? Math.round(mfds / total * 100) : 0 };
  }
}
