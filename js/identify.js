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

/** 모바일 네트워크는 한 번씩 뚝뚝 끊긴다. fetch()가 응답조차 못 받고 그 자리에서
    거부되는 경우(= 진짜 서버 오류가 아니라 요청 자체가 안 나간 경우)만 다시
    시도한다. 429·403 같은 실제 응답은 서버가 준 신호이므로 재시도하지 않는다 —
    여기서 건드리는 건 fetch()가 아예 throw하는 경우뿐이다.
    사진 업로드(본문 수백KB)는 검증 요청(본문 없음)보다 불안정한 네트워크에서
    끊기기 쉬워, 총 2번 더(최초 시도 포함 3번) 시도하고 대기 시간도 점점 늘린다.

    타임아웃을 직접 건다(45초). 키 검증(본문 없는 GET)은 항상 성공하는데 사진
    분석(본문 있는 POST)만 실패하는 패턴이 실사용에서 반복 관찰됐다 — 구조화
    출력 스키마가 무겁다 보니 응답 생성이 오래 걸려, 브라우저·통신망의 유휴
    타임아웃에 걸려 조용히 끊기는 것으로 추정된다. 직접 타임아웃을 걸면 최소한
    "TIMEOUT"이라는 분명한 신호를 얻어 원인을 추적할 수 있고, 사용자도 무한정
    기다리지 않는다. */
async function fetchWithRetry(url, init, retries = 2, attempt = 0, timeoutMs = 45000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (e) {
    if (e.name === 'AbortError') {
      if (retries <= 0) throw new Error('TIMEOUT');
    } else if (retries <= 0) {
      throw e;
    }
    await new Promise(r => setTimeout(r, 500 * (attempt + 1)));
    return fetchWithRetry(url, init, retries - 1, attempt + 1, timeoutMs);
  } finally {
    clearTimeout(timer);
  }
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
  constructor({ proxyUrl = '', devApiKey = '', model = 'gemini-3.7-flash',
                userToken = '' } = {}) {
    this.proxyUrl = proxyUrl;
    this.devApiKey = devApiKey;
    this.model = model;
    this.userToken = userToken;   // 프록시가 사용자별 쿼터를 세는 데 쓴다
  }

  async available() { return !!(this.proxyUrl || this.devApiKey); }
  async prepare() {}

  /** 판정은 요구하지 않는다. 이름·양과, 이 앱 DB에 없을 때 쓸 예비 영양 추정치만 받는다.
      est는 절대 판정에 그대로 쓰이지 않는다 — matchItems()가 만든 "가상의 음식" 객체에
      들어가 rules.js의 결정적 규칙을 그대로 통과한다. Gemini는 여전히 숫자만 추정하고,
      좋음/주의/피함 판정은 한 번도 Gemini에게 맡기지 않는다. */
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
            confidence: { type: 'NUMBER', description: '0에서 1 사이의 확신도' },
            est: {
              type: 'OBJECT',
              description: '1인분 기준 영양 추정치. 이 앱의 내장 데이터베이스에 이 음식이 ' +
                           '없을 때만 쓰이는 예비값이다. 모르는 항목은 그냥 비워 두어도 된다.',
              /* 축을 17개에서 9개로 줄였다(2026-08-20). 구조화 출력 필드가 많을수록
                 생성 시간이 늘어나는데, 실사용에서 "사진 분석만 매번 Load failed로
                 끊긴다"(키 확인처럼 짧은 요청은 항상 성공)는 패턴이 반복 관찰됐다.
                 응답 생성이 오래 걸려 모바일 네트워크의 유휴 타임아웃에 걸리는
                 것으로 추정된다. 여기 뺀 축(퓨린·비타민K·요오드·철·카페인·레티놀·
                 인·칼슘)은 통풍·와파린·갑상선·빈혈·임신처럼 이미 흔한 음식 위주라
                 우리 DB 매칭 실패가 드문 질환들이라, 예비 추정치의 정확도보다
                 응답 속도가 더 급하다고 판단했다. */
              properties: {
                serving_g:      { type: 'NUMBER', description: '추정 1인분 무게(g)' },
                kcal:           { type: 'NUMBER' },
                carb_g:         { type: 'NUMBER' },
                protein_g:      { type: 'NUMBER' },
                fat_g:          { type: 'NUMBER' },
                satfat_g:       { type: 'NUMBER' },
                sugar_g:        { type: 'NUMBER' },
                sodium_mg:      { type: 'NUMBER' },
                potassium_mg:   { type: 'NUMBER' },
                texture:        { type: 'STRING', enum: ['soft', 'normal', 'mixed', 'hard', 'liquid', 'dry', 'sticky'] },
                spicy:          { type: 'BOOLEAN' },
                greasy:         { type: 'BOOLEAN' },
                alcohol:        { type: 'BOOLEAN' }
              }
              /* 일부러 required를 두지 않는다. Gemini의 구조화 출력은 required 필드를
                 모두 확신 있게 채워야 하는데, 그게 부담스러우면 항목 자체를 통째로
                 items에서 빼 버리는 경향이 있다(관찰된 실패 모드: 애매한 사진에서
                 items가 통째로 빈 배열로 옴). 차라리 헐겁게 두고 아는 만큼만
                 받는 편이, "사진에서 아는 음식을 찾지 못했습니다"처럼 아무것도
                 못 건지는 것보다 훨씬 낫다. */
            }
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
   흔치 않은 음식(외국 음식, 브랜드 제품 등)이라도 최선을 다해 이름을 추정하세요.
2. portion은 흔한 1인분을 1.0으로 보고 눈에 보이는 양의 비율을 적으세요. 반 그릇이면 0.5입니다.
3. confidence는 정말 확신할 때만 0.8 이상을 쓰세요. 애매하면 낮게 쓰세요. 틀린 이름을 자신 있게 쓰는 것이 가장 나쁩니다.
   다만 확신이 낮다고 해서 항목 자체를 빼지는 마세요 — confidence를 낮게 적더라도 반드시 포함하세요.
4. 밥·국·반찬을 각각 따로 항목으로 나누세요. "한식 정식" 같은 뭉뚱그린 이름은 쓰지 마세요.
5. 음식이 아닌 것(그릇, 수저, 손)은 넣지 마세요.
6. est(영양 추정치)는 아는 만큼만 채우면 됩니다. 이 음식이 앱 내장 데이터베이스에 있을지
   없을지는 당신이 알 수 없으니, 없을 경우를 대비해 채워 두면 좋지만, 확신 없는 항목은
   비워 둬도 괜찮습니다. est를 다 못 채운다고 해서 name·portion·confidence까지 포기하지
   마세요 — 이름만이라도 반드시 주는 것이 아무것도 안 주는 것보다 항상 낫습니다.
7. 정말로 사진에 음식이 하나도 안 보일 때만 items를 빈 배열로 두세요. 음식이 보이는데
   확신이 안 선다는 이유로 통째로 비우지 마세요.`;

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
        temperature: 0.1,
        maxOutputTokens: 2048
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

    const res = await fetchWithRetry(url, { method: 'POST', headers, body });

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
   2.5. Gemini가 직접 판정 — 사진 + 질환 목록을 한 번에 넘겨
   식별부터 좋음/주의/피함 판정, 이유, 팁까지 한 번의 호출로 받는다.

   기존 GeminiIdentifier.identify()는 "이름·양·영양 추정치"만 받아서
   그 수치를 rules.js에 넣어 판정했다. 그런데 실사용에서 애매한 사진에
   대해 이 파이프라인이 너무 자주 "못 찾음"으로 끝났고, 사용자는
   자체 규칙 엔진의 정확성보다 "일단 뭔가 답이 나오는 것"을 원했다.
   그래서 이 함수는 판정까지 Gemini에게 맡긴다 — 이 경로를 쓰는 동안은
   "AI는 식별만 한다"는 원칙이 적용되지 않는다는 뜻이다. 대신 화면에는
   이 판정이 AI가 직접 낸 것이며 rules.js처럼 항목별 수치 근거를 보여줄
   수 없다는 것을 분명히 표시해야 한다(app.js의 render() 참고). */
export const GEMINI_JUDGE_SCHEMA = {
  type: 'OBJECT',
  properties: {
    foods: {
      type: 'ARRAY',
      description: '사진에서 식별한 음식들',
      items: { type: 'OBJECT', properties: {
        name: { type: 'STRING', description: '음식의 한국어 이름' },
        portion: { type: 'STRING', description: '눈대중 양(예: "1인분", "반 그릇")' }
      }, required: ['name'] }
    },
    byDisease: {
      type: 'ARRAY',
      description: '요청받은 질환·상태마다 하나씩',
      items: { type: 'OBJECT', properties: {
        id:      { type: 'STRING', description: '요청에 주어진 질환 id를 그대로' },
        verdict: { type: 'STRING', enum: ['good', 'caution', 'avoid'] },
        reason:  { type: 'STRING', description: '왜 이 판정인지 한국어 1~2문장, 구체적 수치 언급 권장' }
      }, required: ['id', 'verdict', 'reason'] }
    },
    overall:        { type: 'STRING', enum: ['good', 'caution', 'avoid'] },
    overallComment: { type: 'STRING', description: '전체 요약 한국어 1~2문장' },
    tips: {
      type: 'ARRAY',
      description: '실천 가능한 조언 2~4개',
      items: { type: 'STRING' }
    }
  },
  required: ['foods', 'byDisease', 'overall', 'overallComment', 'tips']
};

function buildJudgePrompt(diseases, profile) {
  const list = diseases.map(d => `- id:"${d.id}" 이름:"${d.name}" (주의: ${d.focus})`).join('\n');
  const prof = [];
  if (profile?.weightGiven) prof.push(`체중 ${profile.weightKg}kg`);
  if (profile?.ageYears != null) prof.push(`나이 ${profile.ageYears}세`);
  if (profile?.sex) prof.push(profile.sex === 'f' ? '여성' : '남성');
  const profLine = prof.length ? `\n환자 정보: ${prof.join(', ')}` : '';

  return `당신은 임상영양 지식을 갖춘 판정 도우미입니다. 첨부된 음식 사진을 보고, ` +
`아래 질환·상태를 가진 사람에게 이 식사가 적합한지 판정하세요.${profLine}

판정 대상 질환·상태 목록:
${list}

규칙:
1. 사진 속 음식을 각각 한국어로 식별하세요(foods). 확신이 없어도 최선을 다해 이름을 주세요.
   정말 음식이 하나도 안 보일 때만 foods를 빈 배열로 두세요.
2. byDisease는 위 목록의 id 하나당 정확히 하나씩 주세요 — 요청 개수와 정확히 같아야 합니다.
3. verdict는 good(좋음)·caution(주의)·avoid(피함) 중 하나. 일반적인 임상 식이 지침을 기준으로,
   보수적으로(불확실하면 caution 쪽으로) 판정하세요.
4. reason은 딱 한 문장, 최대한 짧게 쓰세요(가능하면 나트륨·당류처럼 어떤 성분이 문제인지만
   짚어서). 길게 설명하지 마세요 — 질환이 여러 개면 항목마다 다 써야 해서 문장이 길수록
   응답이 느려집니다. "~할 수 있습니다"보다는 단정적으로 쓰되, 과장하지 마세요.
5. overall은 byDisease 중 가장 나쁜 판정을 따르세요.
6. tips는 이 식사를 지금보다 낫게 만들 수 있는 구체적 행동(양 줄이기, 국물 남기기 등)을
   짧은 문장으로 2~3개만. 길게 쓰지 마세요.
7. 이것은 의료 진단이 아닌 일반적 식이 참고 정보입니다 — 그렇다고 매번 문장 안에 면책 문구를
   넣지 마세요. 그 안내는 화면에 별도로 이미 표시됩니다.`;
}

/**
 * 사진과 선택한 질환·상태를 Gemini에 한 번에 보내 식별부터 판정까지 받는다.
 * @param {string} imageDataUrl
 * @param {{id:string,name:string,focus:string}[]} diseases  DISEASE_BY_ID에서 뽑은 항목들
 * @param {object} profile  resolveProfile() 결과 (선택)
 * @param {{proxyUrl?:string, devApiKey?:string, model?:string, userToken?:string}} opts
 */
export async function judgeMealWithGemini(imageDataUrl, diseases, profile, opts = {}) {
  const { proxyUrl = '', devApiKey = '', model = 'gemini-3.7-flash', userToken = '' } = opts;
  const [, mime = 'image/jpeg', b64] = imageDataUrl.match(/^data:([^;]+);base64,(.+)$/) || [];
  if (!b64) throw new Error('이미지 형식을 읽지 못했습니다.');

  const body = JSON.stringify({
    contents: [{ parts: [
      { text: buildJudgePrompt(diseases, profile) },
      { inline_data: { mime_type: mime, data: b64 } }
    ] }],
    generationConfig: {
      responseMimeType: 'application/json',
      responseSchema: GEMINI_JUDGE_SCHEMA,
      temperature: 0.2,
      maxOutputTokens: 3072
    }
  });

  let url, headers;
  if (proxyUrl) {
    url = `${proxyUrl}/gemini`;
    headers = { 'Content-Type': 'application/json' };
    if (userToken) headers.Authorization = `Bearer ${userToken}`;
  } else {
    url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;
    headers = { 'Content-Type': 'application/json', 'x-goog-api-key': devApiKey };
  }

  const res = await fetchWithRetry(url, { method: 'POST', headers, body });

  if (res.status === 429) {
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
  if (!Array.isArray(parsed.foods) || !Array.isArray(parsed.byDisease)) throw new Error('PARSE');
  return parsed;
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

const EST_NUMERIC_AXES = [
  'kcal', 'carb_g', 'protein_g', 'fat_g', 'satfat_g', 'sugar_g', 'sodium_mg', 'cholesterol_mg',
  'potassium_mg', 'phosphorus_mg', 'calcium_mg', 'purine_mg', 'vitk_ug', 'iron_mg', 'iodine_ug',
  'caffeine_mg', 'vita_ug'
];
const EST_TEXTURES = ['soft', 'normal', 'mixed', 'hard', 'liquid', 'dry', 'sticky'];

/* Gemini가 이름과 함께 준 est(영양 추정치)로 "가상의 음식" 객체를 만든다.
   판정 자체는 여전히 rules.js가 이 객체의 수치를 그대로 읽어 계산하므로,
   Gemini는 여기서도 숫자만 추정할 뿐 좋음/주의/피함을 정하지 않는다. */
function estimatedFood(name, est) {
  const num = v => (typeof v === 'number' && isFinite(v) && v >= 0) ? v : 0;
  const food = { id: `gemini_est:${name}`, ko: name, en: name, transfat_g: 0, fluid_ml: 0,
                 tags: [], src: 'gemini_est' };
  for (const axis of EST_NUMERIC_AXES) food[axis] = num(est[axis]);
  food.serving_g = num(est.serving_g) || 200;
  food.texture = EST_TEXTURES.includes(est.texture) ? est.texture : 'normal';
  food.alcohol = !!est.alcohol;
  food.irritant = ['spicy', 'acidic', 'greasy', 'salty'].filter(k => !!est[k]);
  return food;
}

/* AI가 준 한국어 이름을 내장 테이블에 매칭한다.
   매칭에 성공하면 우리 데이터베이스의 값(더 정확함)을 그대로 쓰고, 실패하면
   Gemini가 함께 준 est(영양 추정치)로 가상의 음식을 만들어 담는다 — 조용히
   버리지 않는다. 버리면 나트륨이 과소 집계돼 판정이 실제보다 관대해진다.
   est조차 없는 경우(Pollinations 등 est를 안 주는 어댑터)에는 예전처럼
   unmatched로 넘겨 사용자가 직접 고르게 한다. */
function matchItems(items, store) {
  const matched = [], unmatched = [];
  for (const it of items) {
    const name = String(it?.name ?? '').trim();
    if (!name) continue;
    const portion = Number(it.portion) || 1;
    const confidence = Number(it.confidence) || 0.5;
    const hit = store.search(name, 1)[0];
    if (hit) {
      matched.push(candidate(hit, confidence, portion));
    } else if (it.est && typeof it.est === 'object') {
      matched.push(candidate(estimatedFood(name, it.est), confidence, portion));
    } else {
      unmatched.push({ name, portion });
    }
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
   Gemini를 맨 앞에 두는 이유: 온보딩에서 이미 키 등록을 사실상 필수로
   만들었고, 어떤 음식이든(우리 DB에 없는 것까지) 이름과 영양치를 함께
   추정해 주는 유일한 경로다. 자체 모델은 Gemini가 준비되지 않았을 때 쓰는
   차선책(한국 음식 한정, 비용 0)이다. */
export const ADAPTERS = [
  GeminiIdentifier, LocalModelIdentifier, PollinationsIdentifier,
  OnDeviceIdentifier, ManualIdentifier
];

/**
 * 설정에 맞는 어댑터 인스턴스를 만든다.
 *
 * ⚠️ 옵션을 통째로 넘기지 않는다. 어댑터마다 `model`이 뜻하는 바가 다르기 때문이다.
 *    (Gemini는 'gemini-3.7-flash', 온디바이스는 'Xenova/clip-...')
 *    예전에 공통 opts를 그대로 전달했다가 Gemini 모델명이 CLIP 모델명을 덮어써서,
 *    Transformers.js가 허깅페이스에서 'gemini-3.7-flash'를 찾는 오류가 났다.
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
        resolve(c.toDataURL('image/jpeg', 0.7));
      };
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  });
}
