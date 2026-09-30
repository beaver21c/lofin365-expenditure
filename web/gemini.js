/*
 * gemini.js — 사용자 개인 Gemini API 키로 하는 LLM 호출.
 *
 * beaver21c/rssp_help 의 app/assets/gemini.js 를 물려받았다. 논리는 그대로 두고
 * ES 모듈 대신 전역 하나(LFGemini)로 감쌌다.
 *
 * 키는 브라우저 저장소에만 둔다. 서버로 보내지 않고 주소에도 싣지 않으며
 * 오직 x-goog-api-key 헤더로만 나간다(주소창·리퍼러·프록시 기록에 남지 않게).
 *
 * 저장 이름은 rssp_help 와 같게 둔다 — 두 도구가 같은 주소에 올라가 저장소를
 * 공유하므로, 키를 한 번만 넣으면 양쪽에서 쓰인다.
 */
(function (global) {
  'use strict';

  const G = {};
  const quota = global.LFQuota;

  G.BASE = 'https://generativelanguage.googleapis.com/v1beta';

  /** 429(할당량 초과)를 만났을 때 다음 모델로 넘어가기 전 쉬는 시간. */
  const RETRY_MS = 2000;
  G.RETRY_MS = RETRY_MS;

  /**
   * 기본은 **flash-lite 계열 중 가장 높은 판**이다. 이름을 박지 않는다.
   * 특정 이름을 기본으로 박아 두면 구글이 판을 올릴 때마다 도구가 멈춘다.
   * 그래서 계열만 정하고 판은 실행 시점 목록에서 고른다.
   */
  const DEFAULT_FAMILY = /flash-lite/i;

  /**
   * 모델 목록 창구까지 막혔을 때만 쓰는 이름들. 여기 적힌 이름도 언제든
   * 죽는다는 전제로 여러 개를 둔다. **정상 경로는 실행 시점 목록 조회다.**
   */
  const FALLBACK_MODELS = [
    'gemini-3.5-flash-lite', 'gemini-3.1-flash-lite', 'gemini-3.5-flash', 'gemini-2.5-flash-lite',
  ];
  G.FALLBACK_MODELS = FALLBACK_MODELS;

  /** 이름만 보고 걸러 내는 모델. 실험·미리보기·음성·그림·임베딩 계열은 맞지 않는다. */
  const SKIP_RE = /exp|experimental|preview|tts|image|embed|live|audio|thinking/i;

  /**
   * 모델 이름에 허용하는 글자. 이름은 주소에 그대로 끼워 넣는 값이라
   * `/`·`?`·`&`·공백이 섞이면 경로나 쿼리스트링이 뒤틀린다(키가 주소로 새는 길이 열린다).
   */
  const SAFE_MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

  /**
   * 글자 종류만 보면 `..` 가 통과해 상위 경로로 빠져나갈 수 있다. 첫 글자를
   * 영숫자로 못박고 점 두 개를 따로 물리친다.
   */
  const safeModel = n => SAFE_MODEL_RE.test(String(n)) && !String(n).includes('..');

  const KEY_NAME = 'gemini_key';
  const PREF_NAME = 'gemini_model';

  // ── 키 보관 — 저장소가 없거나 막혀도 죽지 않게 감싼다 ────
  const memory = { local: '', session: '', pref: '' };
  let memoryOnly = false;

  function store(kind) {
    try {
      const s = kind === 'local' ? global.localStorage : global.sessionStorage;
      if (!s || typeof s.getItem !== 'function') return null;
      return s;
    } catch (e) {
      // 사생활 보호 모드나 저장소 차단 설정이면 접근 자체가 튄다. 조용히 메모리로 간다.
      return null;
    }
  }

  function readSlot(kind) {
    const s = store(kind);
    if (!s) { memoryOnly = true; return memory[kind] || ''; }
    try { return s.getItem(KEY_NAME) || ''; }
    catch (e) { memoryOnly = true; return memory[kind] || ''; }
  }

  function writeSlot(kind, value) {
    memory[kind] = value || '';
    const s = store(kind);
    if (!s) { memoryOnly = true; return; }
    try {
      if (value) s.setItem(KEY_NAME, value);
      else s.removeItem(KEY_NAME);
    } catch (e) { memoryOnly = true; }
  }

  /** 저장소가 막혀 메모리에만 키가 있는 상태인가. */
  G.storageBlocked = function () { return memoryOnly; };

  /** 설정된 키. 없으면 빈 문자열. session 이 local 보다 앞선다. */
  G.getKey = function () { return readSlot('session') || readSlot('local') || ''; };

  /** 키를 어디에 두고 있는지. 'local'=이 브라우저에 저장 / 'session'=이 탭에서만 / ''=없음. */
  G.keyScope = function () {
    if (readSlot('local')) return 'local';
    if (readSlot('session')) return 'session';
    return '';
  };

  /** 키 설정. persist=true 면 localStorage, 아니면 sessionStorage. 빈 값이면 지운다. */
  G.setKey = function (key, persist) {
    writeSlot('session', '');
    writeSlot('local', '');
    const k = String(key || '').trim();
    if (k) writeSlot(persist ? 'local' : 'session', k);
    G.clearModelCache();
  };

  function needKey(key) {
    const k = String(key || '').trim() || G.getKey();
    if (!k) throw new Error('Gemini API 키가 없습니다. 먼저 키를 설정하십시오.');
    return k;
  }

  /** 키는 헤더로만 보낸다. */
  const authHeader = key => ({ 'x-goog-api-key': key });

  // ── 모델 목록·우선순위 ───────────────────────────────────
  /**
   * 정렬 기준값 **[flash 여부, lite 여부, 판 번호]** — 이 차례가 중요하다.
   * 판 번호를 lite 보다 먼저 보면 새로 나온 상위 모델이 기본이 되어 무료 등급에서
   * 곧바로 한도에 걸린다. 이 기능의 기본은 **무료로 오래 돌아가는 것**이다.
   */
  function rankModel(name) {
    const n = String(name || '');
    const v = n.match(/(\d+)\.(\d+)/) || [0, 0, 0];
    const ver = (+v[1]) * 100 + (+v[2]);
    return [n.includes('flash') ? 1 : 0, n.includes('lite') ? 1 : 0, ver];
  }
  G.rankModel = rankModel;

  const byRank = (a, b) => {
    const x = rankModel(a);
    const y = rankModel(b);
    return y[0] - x[0] || y[1] - x[1] || y[2] - x[2] || a.localeCompare(b);
  };

  /** 이름 목록을 걸러 내고 정렬한다. */
  G.orderModels = function (names) {
    const all = (Array.isArray(names) ? names : [])
      .map(n => String(n || '').replace(/^models\//, ''))
      .filter(n => n && safeModel(n) && !SKIP_RE.test(n));
    const flash = all.filter(n => n.includes('flash')).sort(byRank);
    const rest = all.filter(n => !n.includes('flash'));
    return [...flash, ...rest];
  };

  /** 살아 있는 목록에서 기본으로 삼을 이름(가장 높은 판의 flash-lite). */
  G.defaultModel = function (models) {
    return (Array.isArray(models) ? models : []).find(n => DEFAULT_FAMILY.test(n)) || '';
  };

  /* 마지막으로 성공한 모델. 구글이 목록을 바꿔도 어제 되던 것부터 다시 해 본다.
     반대로 그 모델이 사라지면(404) 곧바로 버려서 묵은 이름에 매이지 않는다. */
  G.getPreferred = function () {
    const s = store('local');
    // 저장소가 멀쩡하면 그것만 믿는다. 메모리로 되살리면 다른 탭에서 지운 값이 살아 돌아온다.
    if (!s) return memory.pref || '';
    try { return s.getItem(PREF_NAME) || ''; }
    catch (e) { return memory.pref || ''; }
  };

  G.setPreferred = function (name) {
    const one = String(name || '').replace(/^models\//, '');
    // 주소를 비틀 수 있는 이름은 기억하지 않는다(모델 이름은 URL 경로에 그대로 들어간다)
    const ok = one && safeModel(one) ? one : '';
    memory.pref = ok;
    const s = store('local');
    if (!s) return;
    try {
      if (ok) s.setItem(PREF_NAME, ok);
      else s.removeItem(PREF_NAME);
    } catch (e) { /* 저장소가 막혀 있으면 메모리에만 둔다 */ }
  };

  let modelCache = null;   // { key, models }
  let inflight = null;     // { key, promise } — 같은 키로 동시에 물으면 그물은 한 번만 탄다

  G.clearModelCache = function () { modelCache = null; inflight = null; };

  async function fetchModels(k) {
    const r = await fetch(`${G.BASE}/models?pageSize=1000`, { headers: authHeader(k) });
    if (!r.ok) throw await httpError(r);
    const j = await readJson(r, '모델 목록');
    const listed = Array.isArray(j && j.models) ? j.models : [];
    const ok = listed
      .filter(m => (Array.isArray(m && m.supportedGenerationMethods)
        ? m.supportedGenerationMethods : []).includes('generateContent'))
      .map(m => m.name);
    const models = G.orderModels(ok);
    return models.length ? models : [...FALLBACK_MODELS];
  }

  /** 쓸 수 있는 모델 이름 목록. 같은 키로 두 번째 부르면 캐시를 준다. */
  G.listModels = async function (key) {
    const k = needKey(key);
    if (modelCache && modelCache.key === k) return modelCache.models;
    if (inflight && inflight.key === k) return inflight.promise;
    const promise = fetchModels(k).then(
      models => {
        modelCache = { key: k, models };
        if (inflight && inflight.promise === promise) inflight = null;
        return models;
      },
      e => {
        if (inflight && inflight.promise === promise) inflight = null;
        throw e;
      },
    );
    inflight = { key: k, promise };
    return promise;
  };

  /** 응답 본문에서 구글이 준 사유를 캐낸다. 못 캐면 상태 코드만 남긴다. */
  async function httpError(r) {
    let msg = `HTTP ${r.status}`;
    try {
      const j = await r.json();
      msg = (j && j.error && j.error.message) || msg;
    } catch (e) { /* 본문이 JSON 이 아니면 상태 코드로 만족한다 */ }
    const e = new Error(msg);
    e.status = r.status;
    return e;
  }

  /** 키 자체가 잘못된 경우인가. 이러면 다른 모델로 넘어가 봐야 똑같이 막힌다. */
  const isKeyFault = msg => /api key|permission|expired/i.test(String(msg || ''));

  /**
   * 계정의 선불 크레딧이 바닥난 경우인가. 이것도 계정 단위라 모델을 바꿔도 막힌다.
   * 모델별 일일 한도와는 다르다 — 그쪽은 다른 모델로 넘어가면 통할 때가 있다.
   */
  const isBillingFault = msg => /prepay|credits?\s+(are|is)\s+depleted|out of credits/i
    .test(String(msg || ''));

  /** 429 가 **하루 몫**을 다 쓴 것인가(분당 몫이 아니라). */
  const isDailyQuota = msg => /per\s*day|PerDay|requests_per_day|free_tier_requests/i
    .test(String(msg || ''));

  /** 구글이 429 본문에 적어 준 한도 값(있을 때만). 관측값이라 참고값보다 앞선다. */
  function limitInMessage(msg) {
    const m = String(msg || '').match(/limit:\s*(\d+)/i);
    return m ? Number(m[1]) : 0;
  }

  /** 그 이름이 내려간 모델인가(신규 사용자 차단·지원 종료). */
  const isRetired = msg => /no longer available|not available to new users|deprecated|discontinued/i
    .test(String(msg || ''));

  /** 구글이 오류 본문에서 대신 쓰라고 지목한 모델 이름. */
  G.replacementIn = function (msg) {
    const m = String(msg || '').match(/use\s+models\/([A-Za-z0-9._-]+)/i);
    const one = m ? m[1] : '';
    return one && safeModel(one) && !SKIP_RE.test(one) ? one : '';
  };

  /**
   * 200 이어도 본문이 JSON 이 아닐 수 있다(프록시가 끼워 넣은 안내 쪽, 잘린 응답).
   * 날 SyntaxError 를 그대로 흘리면 폴백 고리가 통째로 끊긴다.
   */
  async function readJson(r, what) {
    try { return await r.json(); }
    catch (e) { throw new Error(`${what} 응답을 JSON 으로 읽지 못했습니다.`); }
  }

  /** 빈 응답이 왔을 때 구글이 남긴 사유(안전 차단·길이 초과 등)를 캐낸다. */
  function emptyReason(j) {
    const c = j && j.candidates && j.candidates[0];
    return (j && j.promptFeedback && j.promptFeedback.blockReason)
      || (c && c.finishReason) || '';
  }

  // ── 요청 본문 ────────────────────────────────────────────
  function buildBody(opts) {
    const o = opts || {};
    const prompt = String(o.prompt == null ? '' : o.prompt);
    if (!prompt.trim()) throw new Error('보낼 프롬프트가 비었습니다.');
    const body = { contents: [{ role: 'user', parts: [{ text: prompt }] }] };
    if (o.system) body.systemInstruction = { parts: [{ text: String(o.system) }] };
    const gen = { temperature: typeof o.temperature === 'number' ? o.temperature : 0.3 };
    if (typeof o.maxOutputTokens === 'number') gen.maxOutputTokens = o.maxOutputTokens;
    body.generationConfig = gen;
    return body;
  }
  G.buildBody = buildBody;

  /**
   * 첫 시도에 실제로 나가는 요청 본문의 바이트 수.
   * 어림짐작한 토큰 수가 아니라 잰 값이다. 화면에서 "이만큼 보낸다"를 보여 줄 때 쓴다.
   */
  G.requestSize = function (opts) {
    return new TextEncoder().encode(JSON.stringify(buildBody(opts))).length;
  };

  /** 응답에서 본문 텍스트만 이어 붙인다. */
  G.answerText = function (j) {
    const parts = j && j.candidates && j.candidates[0]
      && j.candidates[0].content && j.candidates[0].content.parts;
    if (!Array.isArray(parts)) return '';
    return parts.map(p => p.text || '').join('');
  };

  const sleep = ms => new Promise(done => setTimeout(done, ms));

  // ── 호출 — 429는 쉬었다 다음 모델, 404는 바로 다음 모델, 키 오류는 즉시 중단 ──
  /**
   * opts = { system, prompt, temperature, maxOutputTokens, key, model }
   * 돌려주는 값 { model, text }.
   */
  G.generate = async function (opts) {
    const o = opts || {};
    const key = needKey(o.key);
    let models;
    if (o.model) {
      const one = String(o.model).replace(/^models\//, '');
      if (!safeModel(one)) throw new Error(`모델 이름에 못 쓰는 글자가 있습니다: ${one}`);
      models = [one];
    } else {
      let listErr = null;
      try {
        models = await G.listModels(key);
      } catch (e) {
        // 목록 창구가 막히거나 모양이 바뀌어도 멈추지 않는다. 아는 이름으로 밀어붙인다.
        if (isKeyFault(e && e.message)) throw Object.assign(e, { fatal: true });
        listErr = e;
        models = [...FALLBACK_MODELS];
      }
      // 어제 되던 모델을 맨 앞에 세운다(없어졌으면 아래 고리가 알아서 버린다)
      const pref = G.getPreferred();
      if (pref) models = [pref, ...models.filter(m => m !== pref)];
      if (listErr) o._listError = listErr.message;
    }
    // 오늘 하루 몫을 이미 다 쓴 모델은 빼고 간다. 남은 것이 없으면 여기서 조용히 끝낸다.
    const left = quota.usable(models);
    if (!left.length) {
      const e = new Error('오늘 쓸 수 있는 무료 몫을 다 썼습니다. 태평양 자정에 되돌아옵니다.');
      e.quota = true;
      e.fatal = true;
      throw e;
    }
    models = left;
    const headers = { 'Content-Type': 'application/json', ...authHeader(key) };
    let last = null;

    for (let i = 0; i < models.length; i += 1) {
      const model = models[i];
      const isLast = i === models.length - 1;
      const body = JSON.stringify(buildBody(o));
      let r;
      try {
        r = await fetch(`${G.BASE}/models/${model}:generateContent`,
          { method: 'POST', headers, body });
      } catch (e) {
        last = e;               // 그물이 끊긴 것이니 이 모델은 접고 다음으로
        continue;
      }
      if (r.ok) {
        quota.bump(model);      // 200 이면 하루 몫을 한 칸 쓴 것이다
        let j;
        try { j = await readJson(r, model); }
        catch (e) { last = e; continue; }
        const text = G.answerText(j);
        if (text) { G.setPreferred(model); return { model, text }; }
        // 200 이어도 알맹이가 없으면 실패로 친다. 빈 답을 성공이라고 넘기면
        // 화면에는 "완료"가 뜨고 상자만 비는 꼴이 된다.
        const why = emptyReason(j);
        last = new Error(`${model} 이 빈 응답을 냈습니다${why ? ` (${why})` : ''}.`);
        continue;
      }
      last = await httpError(r);
      if (isKeyFault(last.message)) throw Object.assign(last, { fatal: true });
      // 크레딧이 바닥난 것이면 다음 모델을 두들겨 봐야 똑같이 막힌다.
      if (isBillingFault(last.message)) throw Object.assign(last, { fatal: true, billing: true });
      // 없어진 이름을 계속 물고 있지 않는다
      if (last.status === 404 && model === G.getPreferred()) G.setPreferred('');
      // 내려간 모델이면 기억에서 지우고, 구글이 지목한 대체 이름을 그 자리에서 이어 붙인다
      if (isRetired(last.message)) {
        if (model === G.getPreferred()) G.setPreferred('');
        const next = G.replacementIn(last.message);
        last.retired = model;
        last.replacement = next;
        if (next && !models.includes(next) && !quota.isExhausted(next)) models.push(next);
        continue;
      }
      if (last.status === 429) {
        if (isDailyQuota(last.message)) {
          // 오늘 이 모델은 끝났다. 장부에 적어 두고 쉬지 않고 다음 모델로 간다.
          quota.markExhausted(model, limitInMessage(last.message));
          last.quota = true;
          continue;
        }
        // 분당 몫이면 잠깐 쉬었다 다음 모델로. 마지막이면 쉬어 봐야 헛기다림이다.
        if (!isLast) await sleep(RETRY_MS);
      }
    }
    if (last && o._listError) {
      last.message += ` (모델 목록도 받지 못했습니다: ${o._listError})`;
    }
    // 모든 모델이 하루 몫으로 막힌 것이면 그 사실을 분명히 해서 화면이 멈출 수 있게 한다
    if (last && last.quota && !quota.usable(models).length) {
      last.fatal = true;
      last.message = `오늘 쓸 수 있는 무료 몫을 다 썼습니다 (${last.message})`;
    }
    throw last || new Error('쓸 수 있는 모델이 없습니다.');
  };

  /** 연결 확인에 쓰는 최소 프롬프트. 토큰을 거의 안 먹는다. */
  const PING = '연결 확인입니다. 다른 말 없이 정확히 OK 라고만 답하십시오.';
  G.PING = PING;

  /**
   * 키가 **실제로 글을 만들 수 있는지**까지 본다.
   *
   * 목록 조회만으로는 두 가지를 못 걸러낸다.
   *   ① 목록은 되는데 generateContent 만 막힌 키(결제·지역 제한)
   *   ② 구글이 모델 이름을 갈아 치워 우리가 아는 이름이 하나도 안 남은 경우
   * 그래서 목록을 받아 본 뒤 진짜 생성 호출을 한 번 때려 본다.
   */
  G.verifyKey = async function (opts) {
    const o = opts || {};
    const out = {
      ok: false, model: '', models: [], listed: false, listError: '',
      error: '', fatal: false, billing: false, quota: false, retired: '', replacement: '',
      switchedFrom: '', sample: '', scope: G.keyScope(),
    };
    let key;
    try { key = needKey(o.key); }
    catch (e) { out.error = e.message; return out; }

    try {
      out.models = await G.listModels(key);
      out.listed = true;
    } catch (e) {
      // 키가 거부됐거나 크레딧이 바닥난 것이면 생성도 볼 것 없다(둘 다 계정 단위).
      if (isKeyFault(e && e.message)) { out.error = e.message; out.fatal = true; return out; }
      if (isBillingFault(e && e.message)) {
        out.error = e.message; out.fatal = true; out.billing = true; return out;
      }
      out.models = [...FALLBACK_MODELS];
      out.listError = e.message;
    }
    try {
      const r = await G.generate({ key, model: o.model || '', prompt: PING, temperature: 0 });
      out.ok = true;
      out.model = r.model;
      // 고정해 둔 이름이 내려가 다른 모델이 답했으면 화면이 그 사실을 알 수 있게 한다
      if (o.model && r.model !== o.model.replace(/^models\//, '')) out.switchedFrom = o.model;
      out.sample = String(r.text || '').trim().slice(0, 40);
      // 오늘 이 키는 확인을 마쳤다. 다음에 페이지를 열 때 같은 몫을 또 쓰지 않는다.
      quota.setVerified(key);
    } catch (e) {
      out.error = e.message;
      out.fatal = !!e.fatal;
      out.billing = !!e.billing;
      out.quota = !!e.quota;
      out.retired = e.retired || '';
      out.replacement = e.replacement || '';
    }
    return out;
  };

  global.LFGemini = G;
})(window);
