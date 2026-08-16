/**
 * identify.js — 음식 식별 어댑터
 *
 * 이 앱에서 AI가 하는 일은 오직 하나, "사진 속에 무슨 음식이 있는가"다.
 * 좋다·나쁘다 판정은 절대 AI에게 맡기지 않는다. 그 이유:
 *
 *   1. 판정은 검증 가능해야 한다. 룰 엔진은 임계값과 근거를 추적할 수 있지만
 *      AI 답변은 왜 그렇게 나왔는지 재현·설명할 수 없다.
 *   2. 판정은 결정적이어야 한다. 같은 밥상에 오늘과 내일 다른 답이 나오면 안 된다.
 *   3. 식별은 틀려도 사용자가 눈으로 보고 고칠 수 있다. 판정 오류는 못 고친다.
 *
 * 그래서 어떤 어댑터를 쓰든 결과는 반드시 사용자 확인 단계를 거친다.
 *
 * 공통 인터페이스
 * ───────────────
 *   static id, label, blurb
 *   async available()                  → 이 환경에서 쓸 수 있는가
 *   async prepare(onProgress)          → 모델 로드 등 사전 준비
 *   async identify(imageDataUrl, store) → [{ food, portion, confidence }]
 */

/** 모든 어댑터가 반환하는 후보 항목 */
function candidate(food, confidence, portion = 1) {
  return { food, portion, confidence: Math.max(0, Math.min(1, confidence)) };
}

/* ═══════════════════════════════════════════════════════════
   1. 온디바이스 — Transformers.js + CLIP 제로샷 분류
   ═══════════════════════════════════════════════════════════
   사진이 기기 밖으로 나가지 않는다. 키도 서버도 한도도 없다.
   대신 CLIP은 한국 음식으로 학습된 모델이 아니라 정확도가 낮다.
   내장 테이블의 영문 설명문(en)을 후보 라벨로 주는 제로샷 방식이라
   테이블에 없는 음식은 원리적으로 절대 맞힐 수 없다.
*/
/* 쓸 수 있는 모델. 정확도가 아쉬우면 여기를 바꿔 비교해 보면 된다.
   전부 같은 파이프라인(zero-shot-image-classification)을 쓰므로 이름만 갈아 끼우면 된다.
   ⚠️ 어느 것도 한국 음식으로 학습되지 않았다. 모델을 키운다고 된장찌개와 김치찌개를
      확실히 가르게 되지는 않는다. 정확도가 정말 필요하면 GeminiIdentifier를 써야 한다. */
export const ONDEVICE_MODELS = {
  clip_base:  { id: 'Xenova/clip-vit-base-patch32',   size: '약 150MB', note: '기본값. 가장 가볍고 빠름' },
  siglip:     { id: 'Xenova/siglip-base-patch16-224', size: '약 200MB', note: '제로샷 성능이 CLIP보다 대체로 나음' },
  clip_large: { id: 'Xenova/clip-vit-large-patch14',  size: '약 900MB', note: '가장 정확하지만 모바일엔 무거움' }
};

export class OnDeviceIdentifier {
  static id = 'ondevice';
  static label = '기기에서 인식';
  static blurb = '사진이 기기 밖으로 나가지 않습니다. 인터넷·키 불필요. 처음 한 번 모델을 내려받습니다(약 150MB).';

  constructor({ model = ONDEVICE_MODELS.clip_base.id, topK = 5 } = {}) {
    this.model = model;
    this.topK = topK;
    this._pipe = null;
  }

  async available() {
    // WebGPU가 없어도 WASM으로 돌아간다. 다만 매우 느리므로 알려준다.
    return typeof navigator !== 'undefined';
  }

  hasWebGPU() { return typeof navigator !== 'undefined' && 'gpu' in navigator; }

  async prepare(onProgress = () => {}) {
    if (this._pipe) return;
    /* 버전을 3.7.5로 고정한 이유: test/clip-smoke.mjs로 이 버전의 API 계약을
       (태스크명·호출 시그니처·반환 형태·정렬) 직접 확인했다. 최신은 4.x지만
       계약을 재확인하기 전에는 올리지 않는다. 올릴 때는 smoke 테스트를 먼저 돌릴 것. */
    const { pipeline, env } = await import(
      'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.7.5'
    );
    env.allowLocalModels = false;
    this._pipe = await pipeline('zero-shot-image-classification', this.model, {
      device: this.hasWebGPU() ? 'webgpu' : 'wasm',
      progress_callback: p => {
        if (p.status === 'progress' && p.total) {
          onProgress({ pct: Math.round(p.loaded / p.total * 100), file: p.file });
        } else if (p.status === 'ready') {
          onProgress({ pct: 100, done: true });
        }
      }
    });
  }

  async identify(imageDataUrl, store) {
    await this.prepare();
    const labels = store.clipLabels();
    const out = await this._pipe(imageDataUrl, labels);

    /* ⚠️ 중요: 분류 모델의 상위 N개는 "사진 속 음식 N개"가 아니라
       "같은 사진에 대한 N개의 경쟁 추측"이다. 이걸 전부 목록에 담으면
       밥 한 공기가 밥+죽+잡곡밥+떡+비빔밥으로 잡혀 영양이 다섯 배로 합산되고
       판정이 통째로 틀어진다. 그래서 1등만 후보로 내보내고
       나머지는 사용자가 갈아 끼울 수 있게 alternatives로 따로 전달한다. */
    const ranked = out
      .map(r => ({ food: store.byClipLabel(r.label), score: r.score }))
      .filter(x => x.food);
    if (ranked.length === 0) return [];

    /* CLIP 점수는 후보 집합 전체에 대한 softmax라 절대적인 신뢰도가 아니다.
       1등과 2등의 격차가 작으면 사실상 모르는 것이므로 신뢰도를 깎는다. */
    const margin = ranked.length > 1 ? ranked[0].score - ranked[1].score : ranked[0].score;
    const damp = Math.min(1, margin * 4);

    const result = [candidate(ranked[0].food, ranked[0].score * damp)];
    result.alternatives = ranked.slice(1, this.topK).map(x => x.food);
    /* 이 어댑터는 한 장에서 음식 하나만 집어낸다. 반찬이 여러 개인 밥상은
       사용자가 3단계에서 직접 더해야 한다. UI가 이 사실을 안내한다. */
    result.singlePick = true;
    return result;
  }
}

/* ═══════════════════════════════════════════════════════════
   2. Gemini 프록시 — 사용자는 키를 입력하지 않는다
   ═══════════════════════════════════════════════════════════
   키는 Cloudflare Worker가 들고 있다. 정확도가 가장 높지만
   사진이 외부로 전송되고 무료 등급 한도가 있다.

   프롬프트는 "식별만" 요구한다. 판정을 시키지 않는 것이 이 설계의 핵심이다.
*/
export class GeminiIdentifier {
  static id = 'gemini';
  static label = 'AI로 인식 (정확도 높음)';
  static blurb = '가장 정확합니다. 사진이 서버로 전송되며 하루 사용 한도가 있습니다.';

  /**
   * @param {string} proxyUrl  Cloudflare Worker 주소 (배포용, 권장)
   * @param {string} devApiKey 내 컴퓨터에서만 쓰는 임시 키 (테스트용)
   *   ⚠️ devApiKey가 든 파일을 인터넷에 올리면 누구나 키를 훔쳐 쓴다.
   *      품질만 확인하고 반드시 지운 뒤 proxyUrl로 배포할 것.
   */
  constructor({ proxyUrl = '', devApiKey = '', model = 'gemini-flash-latest',
                userToken = '' } = {}) {
    this.proxyUrl = proxyUrl;
    this.devApiKey = devApiKey;
    this.model = model;
    this.userToken = userToken;   // 프록시가 사용자별 쿼터를 세는 데 쓴다
  }

  async available() { return !!(this.proxyUrl || this.devApiKey); }
  async prepare() {}

  /** 판정은 요구하지 않는다. 오직 음식 이름과 대략적인 양만. */
  static SCHEMA = {
    type: 'OBJECT',
    properties: {
      items: {
        type: 'ARRAY',
        items: {
          type: 'OBJECT',
          properties: {
            name:       { type: 'STRING', description: '음식의 한국어 이름' },
            portion:    { type: 'NUMBER', description: '1인분을 1.0으로 본 상대적인 양' },
            confidence: { type: 'NUMBER', description: '0에서 1 사이의 확신도' }
          },
          required: ['name', 'portion', 'confidence']
        }
      }
    },
    required: ['items']
  };

  static PROMPT =
`이 사진에 담긴 음식을 식별하세요. 판정이나 조언은 하지 마세요. 식별만 하면 됩니다.

규칙:
1. 보이는 음식마다 한국어 이름을 쓰세요. 한국 가정식 이름을 우선 쓰세요(예: "된장찌개", "시금치나물").
2. portion은 흔한 1인분을 1.0으로 보고 눈에 보이는 양의 비율을 적으세요. 반 그릇이면 0.5입니다.
3. confidence는 정말 확신할 때만 0.8 이상을 쓰세요. 애매하면 낮게 쓰세요. 틀린 이름을 자신 있게 쓰는 것이 가장 나쁩니다.
4. 밥·국·반찬을 각각 따로 항목으로 나누세요. "한식 정식" 같은 뭉뚱그린 이름은 쓰지 마세요.
5. 음식이 아닌 것(그릇, 수저, 손)은 넣지 마세요.`;

  async identify(imageDataUrl, store) {
    const [, mime = 'image/jpeg', b64] = imageDataUrl.match(/^data:([^;]+);base64,(.+)$/) || [];
    if (!b64) throw new Error('이미지 형식을 읽지 못했습니다.');

    const body = JSON.stringify({
      contents: [{ parts: [
        { text: GeminiIdentifier.PROMPT },
        { inline_data: { mime_type: mime, data: b64 } }
      ] }],
      generationConfig: {
        responseMimeType: 'application/json',
        responseSchema: GeminiIdentifier.SCHEMA,
        temperature: 0.1
      }
    });

    /* 프록시가 있으면 프록시로, 없고 임시 키만 있으면 구글로 직접. */
    let url, headers;
    if (this.proxyUrl) {
      url = `${this.proxyUrl}/gemini`;
      headers = { 'Content-Type': 'application/json' };
      if (this.userToken) headers.Authorization = `Bearer ${this.userToken}`;
    } else {
      url = `https://generativelanguage.googleapis.com/v1beta/models/${this.model}:generateContent`;
      headers = { 'Content-Type': 'application/json', 'x-goog-api-key': this.devApiKey };
    }

    const res = await fetch(url, { method: 'POST', headers, body });

    if (res.status === 429) {
      /* 프록시의 쿼터 초과와 구글의 rate limit을 구분한다.
         전자는 "구독 등급 한도", 후자는 "잠시 기다리면 됨"으로 안내가 달라진다. */
      let info = null;
      try { info = await res.clone().json(); } catch { /* 무시 */ }
      if (info?.error === 'QUOTA_EXCEEDED') {
        const e = new Error('QUOTA_EXCEEDED');
        e.quota = info;
        throw e;
      }
      throw new Error('RATE_LIMIT');
    }
    if (res.status === 400 || res.status === 403) throw new Error('BAD_KEY');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    const data = await res.json();
    const text = (data?.candidates?.[0]?.content?.parts || []).map(p => p.text || '').join('');
    if (!text) throw new Error('EMPTY');
    const parsed = JSON.parse(text.replace(/```json|```/g, '').trim());

    return matchItems(parsed.items || [], store);
  }
}

/* ═══════════════════════════════════════════════════════════
   3. Pollinations — 키도 가입도 없이 쓰는 클라우드 비전
   ═══════════════════════════════════════════════════════════
   베를린 기반 오픈소스 GenAI 게이트웨이. 익명 등급은 회원가입 없이 쓸 수 있고
   OpenAI 호환 형식으로 base64 이미지를 그대로 받는다.
   즉 프록시도 API 키도 없이 "제대로 된 비전 모델"을 브라우저에서 쓸 수 있다.

   대가:
     · 익명 등급은 15초에 1회 제한 (연타하면 429)
     · 사진이 Pollinations 서버로 전송된다
     · 서비스 가용성 보장(SLA)이 없다
   그래도 CLIP이 한국 음식을 못 맞히는 상황에서 설정 없이 쓸 수 있는
   유일한 실용적 대안이다.
*/
export class PollinationsIdentifier {
  static id = 'cloud';
  static label = '클라우드 AI로 인식 (Pollinations)';
  static blurb = '무료 토큰이 필요합니다. auth.pollinations.ai에서 가입하면 pk_ 토큰을 받을 수 있습니다. ' +
                 '토큰 없이 쓰면 크레딧 부족(402)으로 실패합니다. 사진이 외부 서버로 전송됩니다.';

  static ENDPOINT = 'https://text.pollinations.ai/openai';

  /**
   * @param {string} token  auth.pollinations.ai에서 받는 pk_ 퍼블리셔블 토큰.
   *   비워 두면 익명으로 시도하는데, 지금은 크레딧제라 대부분 402가 난다.
   */
  constructor({ model = 'openai', referrer = 'meal-check', token = '' } = {}) {
    this.model = model;
    this.referrer = referrer;
    this.token = token;
  }

  async available() { return true; }
  async prepare() {}

  static PROMPT =
`이 사진에 담긴 음식을 식별하세요. 판정이나 건강 조언은 하지 마세요. 식별만 하면 됩니다.

규칙:
1. 보이는 음식마다 한국어 이름을 쓰세요. 한국 음식이면 한국 이름을 그대로 쓰세요(예: 된장찌개, 시금치나물).
2. 밥·국·반찬을 각각 따로 항목으로 나누세요. "한식 정식" 같이 뭉뚱그리지 마세요.
3. portion은 흔한 1인분을 1.0으로 보고 눈에 보이는 양의 비율을 쓰세요. 반 그릇이면 0.5.
4. confidence는 0~1. 확신할 때만 0.8 이상을 쓰세요. 애매하면 낮게. 틀린 이름을 자신 있게 쓰는 것이 가장 나쁩니다.
5. 음식이 아닌 것(그릇, 수저, 손, 식탁)은 넣지 마세요.

반드시 아래 JSON 형식으로만 답하세요. 설명 문장을 덧붙이지 마세요.
{"items":[{"name":"음식이름","portion":1.0,"confidence":0.9}]}`;

  async identify(imageDataUrl, store) {
    const url = `${PollinationsIdentifier.ENDPOINT}?referrer=${encodeURIComponent(this.referrer)}`;
    const headers = { 'Content-Type': 'application/json' };
    // pk_ 토큰은 브라우저에 노출돼도 되는 퍼블리셔블 키다(발급처 정책).
    if (this.token) headers.Authorization = `Bearer ${this.token}`;

    let res;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          model: this.model,
          messages: [{
            role: 'user',
            content: [
              { type: 'text', text: PollinationsIdentifier.PROMPT },
              { type: 'image_url', image_url: { url: imageDataUrl } }
            ]
          }],
          max_tokens: 600,
          temperature: 0.1
        })
      });
    } catch {
      throw new Error('NETWORK');
    }

    if (res.status === 429) throw new Error('RATE_LIMIT');
    /* 402 = 크레딧 부족. Pollinations가 텍스트·비전 모델을 Pollen 크레딧제로
       바꾸면서 익명 호출은 대부분 여기서 걸린다. 일반 오류와 구분해
       "토큰을 받으라"고 안내해야 사용자가 다음 행동을 할 수 있다. */
    if (res.status === 402) throw new Error('NO_CREDIT');
    if (res.status === 401 || res.status === 403) throw new Error('BAD_TOKEN');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    const data = await res.json();
    const text = data?.choices?.[0]?.message?.content;
    if (!text) throw new Error('EMPTY');

    return matchItems(parseItems(text), store);
  }
}

/* 모델이 코드펜스나 설명을 덧붙여도 JSON만 뽑아낸다.
   responseSchema로 형식을 강제할 수 없는 엔드포인트라 방어가 필요하다. */
function parseItems(text) {
  const cleaned = text.replace(/```json|```/g, '').trim();
  const tryParse = s => { try { return JSON.parse(s); } catch { return null; } };

  let obj = tryParse(cleaned);
  if (!obj) {
    // 앞뒤에 말이 붙은 경우 가장 바깥 중괄호만 잘라 본다
    const a = cleaned.indexOf('{'), b = cleaned.lastIndexOf('}');
    if (a >= 0 && b > a) obj = tryParse(cleaned.slice(a, b + 1));
  }
  if (!obj) throw new Error('PARSE');
  const items = Array.isArray(obj) ? obj : obj.items;
  if (!Array.isArray(items)) throw new Error('PARSE');
  return items;
}

/* AI가 준 한국어 이름을 내장 테이블에 매칭한다.
   매칭 실패한 것은 조용히 버리지 않고 unmatched로 넘겨 사용자가 직접 고르게 한다.
   버리면 나트륨이 과소 집계돼 판정이 실제보다 관대해진다. */
function matchItems(items, store) {
  const matched = [], unmatched = [];
  for (const it of items) {
    const name = String(it?.name ?? '').trim();
    if (!name) continue;
    const hit = store.search(name, 1)[0];
    if (hit) matched.push(candidate(hit, Number(it.confidence) || 0.5, Number(it.portion) || 1));
    else unmatched.push({ name, portion: Number(it.portion) || 1 });
  }
  matched.unmatched = unmatched;
  return matched;
}

/* ═══════════════════════════════════════════════════════════
   4. 자체 학습 모델 — 우리가 만든 한국 음식 분류기
   ═══════════════════════════════════════════════════════════
   train/ 폴더의 파이프라인으로 학습해 ONNX로 내보낸 모델을 브라우저에서 돌린다.

   왜 이게 최선인가
     · CLIP은 한국 음식을 못 봤지만 이 모델은 한국 음식만 배웠다
     · 호출 비용 0원 — 구독제 원가 문제가 사라진다
     · 사진이 기기 밖으로 나가지 않는다
     · 모델이 작다(약 10MB). CLIP 150MB의 1/15

   전제: models/food-classifier.onnx 와 food-classes.json 이 배포돼 있어야 한다.
   없으면 이 어댑터는 못 쓰고, 앱은 다른 어댑터로 계속 동작한다.
*/
export class LocalModelIdentifier {
  static id = 'local';
  static label = '자체 모델로 인식 (한국 음식 특화)';
  static blurb = '우리가 한국 음식으로 직접 학습시킨 모델입니다. ' +
                 '기기에서 돌아 사진이 밖으로 나가지 않고, 호출 비용도 한도도 없습니다.';

  constructor({ modelUrl = '', topK = 5 } = {}) {
    this.modelUrl = modelUrl.replace(/\/+$/, '');
    this.topK = topK;
    this._session = null;
    this._meta = null;
  }

  async available() { return !!this.modelUrl; }

  async prepare(onProgress = () => {}) {
    if (this._session) return;
    if (!this.modelUrl) throw new Error('NO_MODEL');

    onProgress({ pct: 0 });
    /* 메타데이터를 먼저 받는다. 전처리 값(mean/std/크기)이 학습 때와
       하나라도 어긋나면 정확도가 통째로 무너지므로, 코드에 박지 않고
       학습이 내보낸 값을 그대로 쓴다. */
    const metaRes = await fetch(`${this.modelUrl}/food-classes.json`);
    if (!metaRes.ok) throw new Error('NO_MODEL');
    this._meta = await metaRes.json();

    const ort = await import(
      'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.20.1/dist/ort.webgpu.min.mjs'
    );
    ort.env.wasm.wasmPaths =
      'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.20.1/dist/';

    onProgress({ pct: 30 });
    this._session = await ort.InferenceSession.create(
      `${this.modelUrl}/food-classifier.onnx`,
      { executionProviders: ['webgpu', 'wasm'], graphOptimizationLevel: 'all' }
    );
    this._ort = ort;
    onProgress({ pct: 100, done: true });
  }

  /** 사진을 모델 입력 텐서로 바꾼다. 학습 때와 같은 방식이어야 한다. */
  _toTensor(img) {
    const S = this._meta.img_size;
    const c = document.createElement('canvas');
    c.width = c.height = S;
    const ctx = c.getContext('2d');

    // 학습은 CenterCrop을 썼다. 같은 방식으로 가운데를 정사각으로 잘라 맞춘다.
    const side = Math.min(img.width, img.height);
    ctx.drawImage(img, (img.width - side) / 2, (img.height - side) / 2,
                  side, side, 0, 0, S, S);

    const { data } = ctx.getImageData(0, 0, S, S);
    const [mR, mG, mB] = this._meta.mean;
    const [sR, sG, sB] = this._meta.std;
    const out = new Float32Array(3 * S * S);
    const plane = S * S;

    for (let i = 0; i < plane; i++) {
      out[i]             = (data[i * 4]     / 255 - mR) / sR;   // NCHW
      out[i + plane]     = (data[i * 4 + 1] / 255 - mG) / sG;
      out[i + plane * 2] = (data[i * 4 + 2] / 255 - mB) / sB;
    }
    return new this._ort.Tensor('float32', out, [1, 3, S, S]);
  }

  async identify(imageDataUrl, store) {
    await this.prepare();

    const img = await new Promise((resolve, reject) => {
      const im = new Image();
      im.onload = () => resolve(im);
      im.onerror = () => reject(new Error('IMAGE'));
      im.src = imageDataUrl;
    });

    const feeds = { [this._session.inputNames[0]]: this._toTensor(img) };
    const out = await this._session.run(feeds);
    const logits = out[this._session.outputNames[0]].data;

    // softmax — 학습 모델은 확률이 아니라 로짓을 낸다
    const max = Math.max(...logits);
    const exp = Array.from(logits, v => Math.exp(v - max));
    const sum = exp.reduce((a, b) => a + b, 0);
    const probs = exp.map(v => v / sum);

    const ranked = probs
      .map((p, i) => ({ p, id: this._meta.food_ids[i], name: this._meta.classes[i] }))
      .sort((a, b) => b.p - a.p)
      .slice(0, this.topK)
      .map(r => ({ ...r, food: store.byId(r.id) || store.search(r.name, 1)[0] }))
      .filter(r => r.food);

    if (!ranked.length) return [];

    /* 분류기의 상위 N개는 같은 사진에 대한 경쟁 추측이다.
       1등만 담고 나머지는 후보로 넘긴다(OnDeviceIdentifier와 같은 이유). */
    const result = [candidate(ranked[0].food, ranked[0].p)];
    result.alternatives = ranked.slice(1).map(r => r.food);
    result.singlePick = true;
    return result;
  }
}

/* ═══════════════════════════════════════════════════════════
   5. 수동 선택 — AI 없이도 앱이 완전히 동작한다
   ═══════════════════════════════════════════════════════════
   정확도 100%. 모델 다운로드도 네트워크도 필요 없다.
   다른 두 어댑터가 실패했을 때의 최종 폴백이기도 하다.
*/
export class ManualIdentifier {
  static id = 'manual';
  static label = '직접 고르기';
  static blurb = 'AI를 쓰지 않습니다. 정확도가 가장 높고 인터넷 없이도 됩니다.';

  async available() { return true; }
  async prepare() {}
  async identify() { return []; }   // UI의 검색창이 대신 채운다
}

/* 정확도가 높은 순서로 둔다. 설정 화면에 이 순서로 표시된다.
   자체 모델을 맨 앞에 두는 이유: 학습만 되면 한국 음식에서 가장 정확하고,
   비용도 0이라 다른 선택지를 고를 이유가 없어진다. */
export const ADAPTERS = [
  LocalModelIdentifier, GeminiIdentifier, PollinationsIdentifier,
  OnDeviceIdentifier, ManualIdentifier
];

/**
 * 설정에 맞는 어댑터 인스턴스를 만든다.
 *
 * ⚠️ 옵션을 통째로 넘기지 않는다. 어댑터마다 `model`이 뜻하는 바가 다르기 때문이다.
 *    (Gemini는 'gemini-flash-latest', 온디바이스는 'Xenova/clip-...')
 *    예전에 공통 opts를 그대로 전달했다가 Gemini 모델명이 CLIP 모델명을 덮어써서,
 *    Transformers.js가 허깅페이스에서 'gemini-flash-latest'를 찾는 오류가 났다.
 *    그래서 어댑터별로 필요한 키만 골라 넘긴다.
 */
export function makeIdentifier(id, opts = {}) {
  const { proxyUrl, devApiKey, userToken, token,
          geminiModel, onDeviceModel, localModelUrl, topK, referrer } = opts;

  switch (id) {
    case 'local':
      return new LocalModelIdentifier({ modelUrl: localModelUrl, topK });
    case 'cloud':
      return new PollinationsIdentifier({ token, referrer });
    case 'gemini':
      return new GeminiIdentifier({ proxyUrl, devApiKey, userToken, model: geminiModel });
    case 'ondevice':
      return new OnDeviceIdentifier({ model: onDeviceModel, topK });
    default:
      return new ManualIdentifier();
  }
}

/** 사진을 축소해 dataURL로 만든다. 전송량과 토큰을 줄이고 HEIC를 JPEG으로 통일한다. */
export function shrinkImage(file, maxSide = 1024) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('사진을 읽지 못했습니다.'));
    reader.onload = () => {
      const img = new Image();
      img.onerror = () => reject(new Error('사진 형식을 인식하지 못했습니다.'));
      img.onload = () => {
        let { width: w, height: h } = img;
        const scale = Math.min(1, maxSide / Math.max(w, h));
        w = Math.round(w * scale); h = Math.round(h * scale);
        const c = document.createElement('canvas');
        c.width = w; c.height = h;
        c.getContext('2d').drawImage(img, 0, 0, w, h);
        resolve(c.toDataURL('image/jpeg', 0.85));
      };
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  });
}
