/*
 * core.js — 데이터 적재와 계산.
 *
 * 화면 코드와 분리해 둔다. 여기 있는 계산이 틀리면 그래프는 멀쩡해 보이는데
 * 값만 틀리기 때문에, 다음 세 가지를 특히 조심해서 다룬다.
 *
 *   1. 비중(%)의 분모는 선택 항목의 한 단계 위다.
 *      분야를 고르면 전 분야 세출, 부문을 고르면 상위 분야가 분모다.
 *   2. 분위 밴드를 %로 볼 때는 지자체별 비율을 먼저 구하고 그 분포의
 *      분위를 취한다. 합계끼리 나누면 분포가 아니라 시도 평균 하나가 나온다.
 *   3. 데이터가 없는 연도는 0이 아니라 결측이다. 선을 끊고 분위 계산에서도 뺀다.
 */
(function (global) {
  'use strict';

  const LF = {};

  // ── 단위 ────────────────────────────────────────────────
  LF.UNITS = {
    won:     { label: '원',     divisor: 1,     decimals: 0 },
    thousand:{ label: '천원',   divisor: 1e3,   decimals: 0 },
    million: { label: '백만원', divisor: 1e6,   decimals: 1 },
    billion: { label: '억원',   divisor: 1e8,   decimals: 1 },
    percent: { label: '%',      divisor: null,  decimals: 1 },
  };
  // 기본값은 억원이다. 집계 금액을 천원으로 표시하면 축 눈금이
  // 10,000,000,000 처럼 길어져 읽히지 않는다. 천원은 선택지로 남겨 두고,
  // 세부 표와 내보내기에서 필요할 때 쓴다.
  LF.DEFAULT_UNIT = 'billion';

  // 분위 밴드를 그리기 위한 최소 모집단.
  // 세종은 시군구가 없고 제주는 두 곳뿐이라 분위수가 의미를 갖지 못한다.
  LF.MIN_BAND_POPULATION = 5;

  // ── 적재 ────────────────────────────────────────────────
  const cache = { manifest: null, agg: new Map(), biz: new Map() };

  async function getJSON(url) {
    const res = await fetch(url, { cache: 'no-cache' });
    if (!res.ok) {
      const err = new Error(`${url} 을 불러오지 못했습니다 (HTTP ${res.status})`);
      err.status = res.status;
      throw err;
    }
    return res.json();
  }

  LF.loadManifest = async function () {
    if (cache.manifest) return cache.manifest;
    const m = await getJSON('data/manifest.json');
    // 파생 색인 — 화면에서 반복 조회하므로 한 번만 만든다.
    m._regionByCd = new Map(m.regions.map(r => [r.cd, r]));
    m._sidoByCd = new Map(m.sido.map(s => [s.cd, s]));
    m._fieldByCd = new Map(m.fields.map(f => [f.cd, f]));
    m._partByCd = new Map(m.parts.map(p => [p.cd, p]));
    m._accountByCd = new Map(m.accounts.map(a => [a.cd, a]));
    m._partsOfField = new Map();
    m.parts.forEach(p => {
      if (!m._partsOfField.has(p.fld)) m._partsOfField.set(p.fld, []);
      m._partsOfField.get(p.fld).push(p);
    });
    m._regionsOfSido = new Map();
    m.regions.forEach(r => {
      if (!m._regionsOfSido.has(r.sido)) m._regionsOfSido.set(r.sido, []);
      m._regionsOfSido.get(r.sido).push(r);
    });
    cache.manifest = m;
    return m;
  };

  LF.loadAgg = async function (sidoCd) {
    if (cache.agg.has(sidoCd)) return cache.agg.get(sidoCd);
    const raw = await getJSON(`data/agg/${sidoCd}.json`);
    const a = prepareAgg(raw);
    cache.agg.set(sidoCd, a);
    return a;
  };

  LF.loadBiz = async function (regionCd) {
    if (cache.biz.has(regionCd)) return cache.biz.get(regionCd);
    const raw = await getJSON(`data/biz/${regionCd}.json`);
    const b = prepareBiz(raw);
    cache.biz.set(regionCd, b);
    return b;
  };

  LF.hasBiz = regionCd => cache.biz.has(regionCd);

  function prepareAgg(raw) {
    // 파일 안의 정수 색인을 코드 문자열로 되돌리는 표를 만든다.
    raw._rIdx = new Map(raw.regions.map((v, i) => [v, i]));
    raw._fIdx = new Map(raw.fields.map((v, i) => [v, i]));
    raw._pIdx = new Map(raw.parts.map((v, i) => [v, i]));
    raw._aIdx = new Map(raw.accounts.map((v, i) => [v, i]));
    return raw;
  }

  function prepareBiz(raw) {
    // 공백을 지운 사본은 저장하지 않고 여기서 만든다.
    // "노인 일자리" 와 "노인일자리" 가 섞여 있어 그대로 비교하면 놓친다.
    raw._norm = raw.names.map(n => n.replace(/\s+/g, ''));
    raw._pIdx = new Map(raw.parts.map((v, i) => [v, i]));
    raw._aIdx = new Map(raw.accounts.map((v, i) => [v, i]));
    return raw;
  }

  // ── 선택 상태 → 색인 집합 ────────────────────────────────
  /**
   * 화면의 선택 상태를 파일 내부 색인으로 바꾼다.
   * 선택한 코드가 이 시도 파일에 아예 없을 수도 있으므로
   * 없는 것은 조용히 빼되, 전부 없으면 빈 집합이 된다.
   */
  function idxSet(map, codes) {
    const out = new Set();
    (codes || []).forEach(c => {
      const i = map.get(c);
      if (i !== undefined) out.add(i);
    });
    return out;
  }

  /**
   * 선택 조건으로 걸러 (연도, 지자체) 별 금액 합계를 만든다.
   *
   * @param store  agg.tot 또는 agg.det
   * @param opts   { accounts:Set<idx>, fields:Set<idx>, parts:Set<idx>|null,
   *                 regions:Set<idx>|null, measure:string }
   * @returns Map<regionIdx, Map<year, number>>
   */
  function sumByRegionYear(store, opts) {
    const { accounts, fields, parts, regions, measure } = opts;
    const vals = store[measure || 'bdg'];
    if (!vals) return new Map();
    const out = new Map();
    const n = store.n;
    const hasParts = parts && store.p;
    for (let i = 0; i < n; i++) {
      if (accounts && !accounts.has(store.a[i])) continue;
      if (fields && !fields.has(store.f[i])) continue;
      if (hasParts && !parts.has(store.p[i])) continue;
      if (regions && !regions.has(store.r[i])) continue;
      const r = store.r[i], y = store.y[i];
      let byYear = out.get(r);
      if (!byYear) { byYear = new Map(); out.set(r, byYear); }
      byYear.set(y, (byYear.get(y) || 0) + vals[i]);
    }
    return out;
  }
  LF._sumByRegionYear = sumByRegionYear;

  /**
   * 선택 상태를 해석해 분자와 분모를 함께 계산한다.
   *
   * 분모 규칙 — 요구사항 그대로다.
   *   · 분야(080/090)를 고르면  → 분모는 전 분야 세출 총액
   *   · 부문(081, 082…)을 고르면 → 분모는 그 부문의 상위 분야 총액
   *
   * 분모는 언제나 tot(전 분야 집계)에서 가져온다. det 에서 부문을 다 더해도
   * 같은 값이 나오지만, 한 곳에서만 가져와야 두 경로가 어긋날 일이 없다.
   */
  LF.series = function (agg, sel) {
    const accounts = sel.accounts && sel.accounts.length
      ? idxSet(agg._aIdx, sel.accounts) : null;
    const partLevel = !!(sel.parts && sel.parts.length);

    // 분자
    let numFields, numParts;
    if (partLevel) {
      numParts = idxSet(agg._pIdx, sel.parts);
      // 고른 부문들의 상위 분야
      const parentCodes = new Set(sel.parts.map(p => sel.partParent[p]).filter(Boolean));
      numFields = idxSet(agg._fIdx, [...parentCodes]);
    } else {
      numParts = null;
      numFields = idxSet(agg._fIdx, sel.fields || []);
    }
    const num = sumByRegionYear(agg.det, {
      accounts, fields: numFields, parts: numParts,
      regions: null, measure: sel.measure || 'bdg',
    });

    // 분모 — 부문 선택이면 상위 분야, 분야 선택이면 전 분야
    const denFields = partLevel ? numFields : null;
    const den = sumByRegionYear(agg.tot, {
      accounts, fields: denFields, parts: null, regions: null, measure: 'bdg',
    });

    return { num, den, partLevel };
  };

  /** 한 지자체의 연도별 값. 단위가 %면 분모로 나눈다. */
  LF.regionSeries = function (agg, sel, regionCd, years, unit) {
    const ri = agg._rIdx.get(regionCd);
    if (ri === undefined) return years.map(() => null);
    const { num, den } = LF.series(agg, sel);
    const nm = num.get(ri), dm = den.get(ri);
    return years.map(y => {
      const v = nm ? nm.get(y) : undefined;
      if (v === undefined) return null;          // 결측 — 0으로 채우지 않는다
      if (unit !== 'percent') return v / LF.UNITS[unit].divisor;
      const d = dm ? dm.get(y) : undefined;
      if (!d) return null;                        // 분모 0 — 0%가 아니라 표시 불가
      return (v / d) * 100;
    });
  };

  // ── 분위 밴드 ────────────────────────────────────────────
  function quantile(sorted, q) {
    if (!sorted.length) return null;
    if (sorted.length === 1) return sorted[0];
    const pos = (sorted.length - 1) * q;
    const lo = Math.floor(pos), hi = Math.ceil(pos);
    if (lo === hi) return sorted[lo];
    return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
  }
  LF.quantile = quantile;

  /**
   * 시도 안 시군구 분포의 1분위·중위·3분위를 연도별로 낸다.
   *
   * 두 가지를 지킨다.
   *   · 광역 본청은 모집단에서 뺀다. 예산 성격이 시군구와 달라
   *     한 분포에 넣으면 분위가 통째로 왜곡된다.
   *   · %일 때는 지자체별 비율을 먼저 구하고 그 분포의 분위를 취한다.
   *     합계끼리 나누면 분포가 아니라 시도 평균 하나가 된다.
   */
  LF.band = function (agg, manifest, sel, sidoCd, years, unit, opts) {
    opts = opts || {};
    const pool = (manifest._regionsOfSido.get(sidoCd) || [])
      .filter(r => !r.head)
      .filter(r => !opts.sameTypeAs || r.type === opts.sameTypeAs);

    if (pool.length < LF.MIN_BAND_POPULATION) {
      return {
        available: false,
        population: pool.length,
        reason: `모집단이 ${pool.length}곳이라 분위수가 의미를 갖지 못합니다 ` +
                `(최소 ${LF.MIN_BAND_POPULATION}곳 필요)`,
      };
    }

    const { num, den } = LF.series(agg, sel);
    const poolIdx = pool
      .map(r => ({ r, i: agg._rIdx.get(r.cd) }))
      .filter(x => x.i !== undefined);

    const q1 = [], med = [], q3 = [], counts = [];
    years.forEach(y => {
      const vals = [];
      poolIdx.forEach(({ i }) => {
        const nm = num.get(i);
        const v = nm ? nm.get(y) : undefined;
        if (v === undefined) return;              // 그 해에 없는 지자체는 제외
        if (unit !== 'percent') {
          vals.push(v / LF.UNITS[unit].divisor);
        } else {
          const dm = den.get(i);
          const d = dm ? dm.get(y) : undefined;
          if (!d) return;
          vals.push((v / d) * 100);               // 비율을 먼저 — 이 순서가 중요하다
        }
      });
      vals.sort((a, b) => a - b);
      counts.push(vals.length);
      if (vals.length < LF.MIN_BAND_POPULATION) {
        q1.push(null); med.push(null); q3.push(null);
      } else {
        q1.push(quantile(vals, 0.25));
        med.push(quantile(vals, 0.50));
        q3.push(quantile(vals, 0.75));
      }
    });

    return { available: true, population: pool.length, q1, med, q3, counts };
  };

  /** 비교군 안에서 대상 지자체의 백분위. 순위를 숫자로 보여줄 때 쓴다. */
  LF.percentileOf = function (value, sortedVals) {
    if (value == null || !sortedVals.length) return null;
    let below = 0;
    for (const v of sortedVals) { if (v < value) below++; else break; }
    return (below / sortedVals.length) * 100;
  };

  // ── 단년 구성 (기능2) ────────────────────────────────────
  /**
   * 한 해의 구성을 낸다.
   *   byField — 전 분야 총액. 도넛 안쪽 링과 % 분모.
   *   byPart  — 080·090 부문별. 도넛 바깥 링과 막대.
   */
  LF.composition = function (agg, manifest, regionCd, year, accounts) {
    const ri = agg._rIdx.get(regionCd);
    if (ri === undefined) return null;
    const aset = accounts && accounts.length ? idxSet(agg._aIdx, accounts) : null;

    const byField = new Map();
    for (let i = 0; i < agg.tot.n; i++) {
      if (agg.tot.r[i] !== ri || agg.tot.y[i] !== year) continue;
      if (aset && !aset.has(agg.tot.a[i])) continue;
      const cd = agg.fields[agg.tot.f[i]];
      byField.set(cd, (byField.get(cd) || 0) + agg.tot.bdg[i]);
    }

    const byPart = new Map();
    for (let i = 0; i < agg.det.n; i++) {
      if (agg.det.r[i] !== ri || agg.det.y[i] !== year) continue;
      if (aset && !aset.has(agg.det.a[i])) continue;
      const cd = agg.parts[agg.det.p[i]];
      const cur = byPart.get(cd) || { bdg: 0, nrow: 0, fld: agg.fields[agg.det.f[i]] };
      cur.bdg += agg.det.bdg[i];
      cur.nrow += (agg.det.nrow ? agg.det.nrow[i] : 0);
      byPart.set(cd, cur);
    }

    let total = 0;
    byField.forEach(v => { total += v; });
    return { byField, byPart, total, year, regionCd };
  };

  // ── 세부사업 검색 (기능3) ────────────────────────────────
  /**
   * 사업명 검색.
   *
   * 사전을 먼저 훑는다. 수천 행 대신 수백 건짜리 고유 이름만 비교하면 되므로
   * 입력할 때마다 다시 계산해도 즉시 반응한다.
   *
   * 사업 수는 반드시 사업코드 기준으로 중복을 제거하고 센다.
   * 같은 사업이 회계·부문별로 여러 행에 나타나므로 행 수를 그대로 세면 부풀려진다.
   */
  LF.search = function (biz, opts) {
    const terms = (opts.terms || []).map(t => t.replace(/\s+/g, '')).filter(Boolean);
    const exclude = (opts.exclude || []).map(t => t.replace(/\s+/g, '')).filter(Boolean);
    const requireAll = opts.matchAll !== false;
    const years = opts.years ? new Set(opts.years) : null;
    const partIdx = opts.parts && opts.parts.length
      ? new Set(opts.parts.map(p => biz._pIdx.get(p)).filter(v => v !== undefined))
      : null;
    const acctIdx = opts.accounts && opts.accounts.length
      ? new Set(opts.accounts.map(a => biz._aIdx.get(a)).filter(v => v !== undefined))
      : null;

    // 1단계 — 사전에서 일치하는 이름 색인
    const hit = new Uint8Array(biz.names.length);
    for (let i = 0; i < biz._norm.length; i++) {
      const s = biz._norm[i];
      if (exclude.some(x => s.includes(x))) continue;
      if (!terms.length) { hit[i] = 1; continue; }
      const ok = requireAll
        ? terms.every(t => s.includes(t))
        : terms.some(t => s.includes(t));
      if (ok) hit[i] = 1;
    }

    // 2단계 — 일치한 이름의 행만 모은다
    const rows = [];
    const codeSet = new Set();
    let bdgSum = 0;
    for (let i = 0; i < biz.n; i++) {
      if (!hit[biz.nm[i]]) continue;
      if (years && !years.has(biz.y[i])) continue;
      if (partIdx && !partIdx.has(biz.p[i])) continue;
      if (acctIdx && !acctIdx.has(biz.a[i])) continue;
      rows.push(i);
      codeSet.add(biz.bc[i]);
      bdgSum += biz.bdg[i];
    }

    // 연도별 합계 — 검색 결과만의 추이
    const byYear = new Map();
    const codesByYear = new Map();
    rows.forEach(i => {
      const y = biz.y[i];
      byYear.set(y, (byYear.get(y) || 0) + biz.bdg[i]);
      if (!codesByYear.has(y)) codesByYear.set(y, new Set());
      codesByYear.get(y).add(biz.bc[i]);
    });

    return {
      rows, byYear,
      bizCount: codeSet.size,                     // 사업코드 고유 개수
      rowCount: rows.length,
      bdgSum,
      countByYear: new Map([...codesByYear].map(([y, s]) => [y, s.size])),
    };
  };

  /** 선택 지자체의 정확한 사업 수. 집계 파일의 값과 달리 필터 조합에 정확하다. */
  LF.bizCount = function (biz, opts) {
    return LF.search(biz, { ...opts, terms: [] }).bizCount;
  };

  // ── 표시 보조 ────────────────────────────────────────────
  LF.formatNumber = function (v, unit) {
    if (v == null || !isFinite(v)) return '—';
    const u = LF.UNITS[unit] || LF.UNITS.won;
    return v.toLocaleString('ko-KR', {
      minimumFractionDigits: u.decimals,
      maximumFractionDigits: u.decimals,
    });
  };

  /** 퍼센트 모드에서 분모가 무엇인지 화면에 적기 위한 문구. */
  LF.denominatorLabel = function (manifest, sel) {
    if (!sel.parts || !sel.parts.length) return '전체 세출 대비';
    const parents = [...new Set(sel.parts.map(p => sel.partParent[p]))];
    const names = parents.map(f => {
      const fld = manifest._fieldByCd.get(f);
      return fld ? `${fld.nm}(${f})` : f;
    });
    return `${names.join(' · ')} 대비`;
  };

  LF.axisLabel = function (unit, manifest, sel) {
    return unit === 'percent'
      ? `% (${LF.denominatorLabel(manifest, sel)})`
      : LF.UNITS[unit].label;
  };

  global.LF = LF;
})(window);
