/*
 * quota.js — 무료 등급 사용량 장부.
 *
 * beaver21c/rssp_help 의 app/assets/quota.js 를 그대로 물려받되, 이 저장소는
 * ES 모듈을 쓰지 않으므로 전역 하나(LFQuota)로 감쌌다. 논리는 건드리지 않았다.
 *
 * 무료 등급은 하루 요청 수가 정해져 있고 그 몫은 **태평양 자정에 되돌아온다**.
 * 여기서는 ①오늘 몇 번 썼는지 ②어느 모델이 오늘 한도를 넘겼는지 ③언제 풀리는지를
 * 브라우저 저장소에 적어 둔다. 날짜가 바뀌면 장부는 저절로 새 장으로 넘어간다.
 *
 * 원칙 — **적어 둔 한도 숫자를 믿지 않는다.**
 * 구글이 공지하는 한도는 바뀌고 계정 등급에 따라도 다르다. 그래서
 *   · 화면에 보여 주는 한도는 출처를 밝힌 **참고값**이고
 *   · 실제로 막을지 말지는 **구글이 돌려준 429 응답**으로 판정하며
 *   · 429 본문에 limit 값이 들어 있으면 그 관측값을 적어 두고 그다음부터 그걸 쓴다.
 *
 * 이 파일은 DOM 을 건드리지 않는다. 화면 표시는 쓰는 쪽(ai.js)이 맡는다.
 */
(function (global) {
  'use strict';

  const Q = {};

  /** 구글의 일일 한도가 되돌아오는 기준 시간대. */
  const TZ = 'America/Los_Angeles';
  Q.TZ = TZ;

  /*
   * 장부 이름은 rssp_help 와 **일부러 같게** 둔다. 두 도구가 같은 주소
   * (beaver21c.github.io)에 올라가 브라우저 저장소를 공유하고, 무엇보다
   * 같은 구글 계정의 같은 몫을 쓰기 때문이다. 이름을 갈라 두면 한쪽에서
   * 쓴 몫이 다른 쪽 장부에 안 잡혀 남은 몫을 잘못 알려 주게 된다.
   */
  const NAME = 'gemini_usage';

  /**
   * 무료 등급 한도 참고값 — **판 번호가 아니라 계열로** 잡는다.
   * 모델 이름은 자주 바뀌므로 하나하나 적어 두면 새 판이 나올 때마다 표가 비어 버린다.
   *
   * 이 값은 rssp_help 에서 그대로 가져왔고, 그쪽에도 「검색 결과로 확인했을 뿐
   * 원문을 직접 열지는 못했다」는 단서가 붙어 있다. 여기서도 확인하지 못했다.
   * 화면에는 반드시 「참고값」과 출처를 함께 적는다. **차단 판정에는 쓰지 않는다.**
   */
  Q.FREE_TIER = [
    { family: /flash-lite/i, label: 'Flash-Lite', rpm: 15, tpm: 250000, rpd: 1000 },
    { family: /flash/i, label: 'Flash', rpm: 10, tpm: 250000, rpd: 250 },
    { family: /pro/i, label: 'Pro', rpm: 5, tpm: 250000, rpd: 100 },
  ];

  Q.FREE_TIER_SOURCE = {
    url: 'https://ai.google.dev/gemini-api/docs/rate-limits',
    note: '구글 「Rate limits」 문서 기준 참고값(원문을 직접 확인하지는 못했습니다). '
      + '한도는 구글 공지·계정 등급에 따라 바뀔 수 있습니다.',
  };

  /** 그 이름이 어느 계열인가. 못 찾으면 null. */
  Q.familyOf = function (model) {
    const n = String(model || '');
    return Q.FREE_TIER.find(f => f.family.test(n)) || null;
  };

  // ── 저장소 — 막혀 있어도 죽지 않는다 ─────────────────────
  let mem = null;
  let memoryOnly = false;

  function box() {
    try {
      const s = global.localStorage;
      if (!s || typeof s.getItem !== 'function') return null;
      return s;
    } catch (e) { return null; }
  }

  /** 저장소가 막혀 장부가 메모리에만 있는 상태인가. */
  Q.storageBlocked = function () { return memoryOnly; };

  // ── 태평양 시각 — 날짜 갈이와 리셋 시점 ──────────────────
  function parts(t) {
    const f = new Intl.DateTimeFormat('en-CA', {
      timeZone: TZ,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
    });
    const o = {};
    for (const p of f.formatToParts(t)) if (p.type !== 'literal') o[p.type] = p.value;
    // hour 가 '24' 로 나오는 구현이 있어(자정) 0 으로 눕힌다
    const h = Number(o.hour) % 24;
    return { y: +o.year, mo: +o.month, d: +o.day, h, mi: +o.minute, s: +o.second };
  }

  /** 그 순간 태평양이 UTC 보다 얼마나 뒤인지(ms, 음수). */
  function offsetOf(t) {
    const p = parts(t);
    return Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi, p.s) - t.getTime();
  }

  /** 태평양 기준 날짜. 장부의 한 장이 이 값 하나에 대응한다. */
  Q.ptDay = function (now) {
    const p = parts(now || new Date());
    const two = n => String(n).padStart(2, '0');
    return `${p.y}-${two(p.mo)}-${two(p.d)}`;
  };

  /**
   * 다음 리셋 시각(다음 태평양 자정)을 실제 시각으로 돌려준다.
   * 서머타임이 걸린 날에는 벽시계 자정과 UTC 간격이 달라지므로 두 번 맞춘다.
   */
  Q.nextResetAt = function (now) {
    const t = now || new Date();
    const p = parts(t);
    const wall = Date.UTC(p.y, p.mo - 1, p.d + 1, 0, 0, 0);
    let at = wall - offsetOf(t);
    at = wall - offsetOf(new Date(at));
    return new Date(at);
  };

  /** 리셋까지 남은 시간. { ms, hours, minutes, at } */
  Q.untilReset = function (now) {
    const t = now || new Date();
    const at = Q.nextResetAt(t);
    const ms = Math.max(0, at.getTime() - t.getTime());
    return { ms, hours: Math.floor(ms / 3600000), minutes: Math.floor((ms % 3600000) / 60000), at };
  };

  /** 리셋 시각을 보는 사람의 시간대로 적는다(한국이면 한국시간). */
  Q.resetText = function (now) {
    const at = Q.nextResetAt(now || new Date());
    try {
      return new Intl.DateTimeFormat('ko-KR', {
        month: 'numeric', day: 'numeric', hour: 'numeric', minute: '2-digit',
      }).format(at);
    } catch (e) { return at.toISOString(); }
  };

  // ── 장부 ─────────────────────────────────────────────────
  const blank = day => ({ day, total: 0, models: {}, verified: '' });

  function read() {
    const s = box();
    if (!s) { memoryOnly = true; return mem; }
    try {
      const raw = s.getItem(NAME);
      return raw ? JSON.parse(raw) : null;
    } catch (e) { memoryOnly = true; return mem; }
  }

  function write(led) {
    mem = led;
    const s = box();
    if (!s) { memoryOnly = true; return; }
    try { s.setItem(NAME, JSON.stringify(led)); }
    catch (e) { memoryOnly = true; }
  }

  /** 오늘 장부. 날짜가 바뀌었으면 새 장을 편다. */
  Q.load = function (now) {
    const day = Q.ptDay(now);
    const got = read();
    if (!got || got.day !== day || typeof got.total !== 'number') {
      const fresh = blank(day);
      write(fresh);
      return fresh;
    }
    if (!got.models || typeof got.models !== 'object') got.models = {};
    return got;
  };

  /** 장부를 비운다(키를 지울 때 함께 부른다). */
  Q.clearUsage = function () {
    mem = null;
    const s = box();
    if (!s) return;
    try { s.removeItem(NAME); } catch (e) { /* 막혀 있으면 메모리만 비운 것으로 족하다 */ }
  };

  /** 성공한 호출 1회를 적는다. 돌려주는 값은 오늘 누적 횟수. */
  Q.bump = function (model, now) {
    const led = Q.load(now);
    const key = String(model || '(이름 없음)');
    const m = led.models[key] || (led.models[key] = { n: 0, exhausted: false, limit: 0 });
    m.n += 1;
    led.total += 1;
    write(led);
    return led.total;
  };

  /**
   * 그 모델의 오늘 몫이 끝났음을 적는다.
   * limit 은 구글이 429 본문에 적어 준 값(있을 때만). 관측값이라 참고값보다 앞선다.
   */
  Q.markExhausted = function (model, limit, now) {
    const led = Q.load(now);
    const key = String(model || '(이름 없음)');
    const m = led.models[key] || (led.models[key] = { n: 0, exhausted: false, limit: 0 });
    m.exhausted = true;
    if (Number.isFinite(limit) && limit > 0) m.limit = limit;
    write(led);
  };

  /** 그 모델이 오늘 이미 한도에 걸렸는가. */
  Q.isExhausted = function (model, now) {
    const m = Q.load(now).models[String(model || '')];
    return !!(m && m.exhausted);
  };

  /** 오늘 쓸 수 있는 이름만 남긴다. */
  Q.usable = function (models, now) {
    return (Array.isArray(models) ? models : []).filter(m => !Q.isExhausted(m, now));
  };

  /** 화면에 뿌릴 오늘 사용 현황. */
  Q.usage = function (now) {
    const led = Q.load(now);
    return {
      day: led.day,
      total: led.total,
      models: led.models,
      exhausted: Object.keys(led.models).filter(k => led.models[k].exhausted),
    };
  };

  /**
   * 그 모델의 하루 한도. 관측값(429 가 알려 준 limit)이 있으면 그것을,
   * 없으면 참고값을 돌려준다. source 로 어느 쪽인지 밝힌다.
   */
  Q.limitOf = function (model, now) {
    const key = String(model || '');
    const m = Q.load(now).models[key];
    if (m && m.limit) {
      return { rpd: m.limit, source: 'observed', label: (Q.familyOf(key) || {}).label || '' };
    }
    const ref = Q.familyOf(key);
    if (ref) return { rpd: ref.rpd, rpm: ref.rpm, tpm: ref.tpm, source: 'reference', label: ref.label };
    return { rpd: 0, source: 'unknown', label: '' };
  };

  // ── 키 확인 캐시 — 페이지를 열 때마다 한 번씩 쓰는 몫을 아낀다 ──
  /** 키를 그대로 두지 않기 위한 짧은 지문(djb2). 되돌릴 수 없다. */
  Q.fingerprint = function (key) {
    const s = String(key || '');
    if (!s) return '';
    let h = 5381;
    for (let i = 0; i < s.length; i += 1) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0;
    return `${s.length}:${h.toString(36)}`;
  };

  /** 오늘 이 키로 실호출 확인을 이미 마쳤다고 적는다. */
  Q.setVerified = function (key, now) {
    const led = Q.load(now);
    led.verified = Q.fingerprint(key);
    write(led);
  };

  /** 오늘 이 키가 이미 확인된 적 있는가(부팅 자동 확인을 건너뛸지 판단). */
  Q.isVerified = function (key, now) {
    const fp = Q.fingerprint(key);
    return !!fp && Q.load(now).verified === fp;
  };

  /** 확인 기록만 지운다(키를 바꿨을 때). */
  Q.clearVerified = function (now) {
    const led = Q.load(now);
    led.verified = '';
    write(led);
  };

  global.LFQuota = Q;
})(window);
