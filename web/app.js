/*
 * app.js — 화면과 조작.
 *
 * 선택지를 코드에 적지 않는다. 연도·지역·분야·부문·회계는 전부 매니페스트에서
 * 만들어지므로, 수집된 원자료가 늘거나 줄면 화면이 저절로 따라간다.
 */
(function () {
  'use strict';

  const $ = s => document.querySelector(s);
  const $$ = s => Array.from(document.querySelectorAll(s));

  let M = null, agg = null, biz = null, geo = null;
  const aggBySido = new Map();
  const lastRender = {};

  const TABS = [
    { id: 'trend',  nm: '추이',      desc: '연도별 변화와 시도 분포 비교' },
    { id: 'comp',   nm: '구성',      desc: '한 해의 분야·부문별 구성' },
    { id: 'map',    nm: '지도',      desc: '지역별 많고 적음을 색으로' },
    { id: 'search', nm: '사업 검색', desc: '특정 단어가 든 사업의 수와 예산' },
  ];

  const state = {
    tab: 'trend', sido: null, region: null,
    accounts: [], unit: LF.DEFAULT_UNIT,
    fields: ['080', '090'], part: '', compare: [], band: false,
    year: null, qTerms: '', qExclude: '', qMode: 'all', qPart: '',
    mapYear: null, mapField: 'both', mapPart: '', mapScope: 'sido',
    theme: 'auto',
  };

  // ── 색 ──────────────────────────────────────────────────
  function css(n) { return getComputedStyle(document.documentElement).getPropertyValue(n).trim(); }
  function palette() {
    return {
      self: css('--c-self') || '#1E4B76',
      median: css('--c-median') || '#8A94A2',
      band: css('--c-band') || 'rgba(138,148,162,.18)',
      compare: [css('--c-cmp1'), css('--c-cmp2'), css('--c-cmp3')],
      compareDash: ['dash', 'dot', 'dashdot'],
      // 사회복지와 보건은 색상 자체를 달리해야 부문이 12종이어도 구분된다
      f080: ['#1F4E79', '#2E6DA4', '#4A90C4', '#6BA3D0', '#8FBBDD', '#A8CCE4',
             '#BFD9EA', '#CFE2EF', '#DCEAF4', '#E8F1F8'],
      f090: ['#7A4419', '#A9662B', '#C98A4B', '#DDAE7C', '#EBCBA8', '#F2DDC6'],
      other: css('--c-other') || '#C3CAD3',
      inside: css('--c-inside') || '#fff',
    };
  }
  let C = palette();

  function baseLayout(extra) {
    const ink = css('--ink'), ink3 = css('--ink-3'), rule = css('--rule-2');
    return Object.assign({
      paper_bgcolor: 'rgba(0,0,0,0)', plot_bgcolor: 'rgba(0,0,0,0)',
      font: { family: css('--sans') || 'sans-serif', size: 12, color: ink },
      margin: { l: 68, r: 24, t: 16, b: 48 },
      hovermode: 'x unified', hoverlabel: { namelength: -1 },
      legend: { orientation: 'h', y: -0.16, font: { size: 11.5 } },
      xaxis: { gridcolor: rule, zerolinecolor: rule, tickfont: { color: ink3 } },
      // Plotly 기본값은 큰 수를 30B 처럼 영문 약어로 줄인다. 한글 단위 화면에서
      // B·M 이 섞이면 오히려 못 읽으므로 전부 펼쳐 쓴다.
      yaxis: { gridcolor: rule, zerolinecolor: rule, tickfont: { color: ink3 },
               separatethousands: true, exponentformat: 'none', automargin: true },
    }, extra || {});
  }
  const CFG = { displaylogo: false, responsive: true,
                modeBarButtonsToRemove: ['toImage', 'lasso2d', 'select2d'] };

  function setStatus(kind, text) {
    $('#status').className = 'status' + (kind ? ' ' + kind : '');
    $('#statusText').textContent = text;
  }

  // ── 테마 ────────────────────────────────────────────────
  // 표시 취향이라 브라우저에 남긴다. 민감한 값이 아니고, 매번 다시 고르게
  // 하는 편이 오히려 불편하다.
  function applyTheme(mode) {
    state.theme = mode;
    const root = document.documentElement;
    if (mode === 'auto') root.removeAttribute('data-theme');
    else root.setAttribute('data-theme', mode);
    try { localStorage.setItem('lofin-theme', mode); } catch (e) { /* 사생활 모드 */ }
    $$('#themeGroup button').forEach(b =>
      b.setAttribute('aria-pressed', String(b.dataset.theme === mode)));
    C = palette();
    render();
  }
  function initTheme() {
    let saved = 'auto';
    try { saved = localStorage.getItem('lofin-theme') || 'auto'; } catch (e) { /* noop */ }
    applyThemeQuiet(['light', 'dark', 'auto'].includes(saved) ? saved : 'auto');
  }
  function applyThemeQuiet(mode) {
    state.theme = mode;
    const root = document.documentElement;
    if (mode === 'auto') root.removeAttribute('data-theme');
    else root.setAttribute('data-theme', mode);
    $$('#themeGroup button').forEach(b =>
      b.setAttribute('aria-pressed', String(b.dataset.theme === mode)));
    C = palette();
  }

  // ── URL 해시 ────────────────────────────────────────────
  function writeHash() {
    const p = new URLSearchParams();
    if (state.region) p.set('r', state.region);
    if (state.tab !== 'trend') p.set('t', state.tab);
    if (state.unit !== LF.DEFAULT_UNIT) p.set('u', state.unit);
    if (state.accounts.length) p.set('a', state.accounts.join(','));
    if (state.fields.join(',') !== '080,090') p.set('f', state.fields.join(','));
    if (state.part) p.set('p', state.part);
    if (state.compare.length) p.set('c', state.compare.join(','));
    if (state.band) p.set('b', '1');
    if (state.year) p.set('y', state.year);
    if (state.qTerms) p.set('q', state.qTerms);
    if (state.mapScope !== 'sido') p.set('ms', state.mapScope);
    if (state.mapField !== 'both') p.set('mf', state.mapField);
    history.replaceState(null, '', '#' + p.toString());
  }
  function readHash() {
    const p = new URLSearchParams(location.hash.slice(1));
    const g = (k, d) => (p.has(k) ? p.get(k) : d);
    const r = g('r', null);
    if (r && M._regionByCd.has(r)) { state.region = r; state.sido = M._regionByCd.get(r).sido; }
    state.tab = TABS.some(t => t.id === g('t', '')) ? g('t') : 'trend';
    state.unit = LF.UNITS[g('u', '')] ? g('u') : LF.DEFAULT_UNIT;
    state.accounts = g('a', '') ? g('a').split(',') : [];
    state.fields = g('f', '') ? g('f').split(',') : ['080', '090'];
    state.part = g('p', '');
    state.compare = g('c', '') ? g('c').split(',').slice(0, 3) : [];
    state.band = g('b', '') === '1';
    const y = parseInt(g('y', ''), 10); if (!isNaN(y)) state.year = y;
    state.qTerms = g('q', '');
    state.mapScope = g('ms', 'sido') === 'nation' ? 'nation' : 'sido';
    state.mapField = ['both', '080', '090'].includes(g('mf', '')) ? g('mf') : 'both';
  }

  // ── 초기화 ──────────────────────────────────────────────
  async function init() {
    initTheme();
    try { M = await LF.loadManifest(); }
    catch (e) {
      $('#emptyState').hidden = false;
      $('#emptyDetail').textContent = e.status === 404
        ? '(data/manifest.json 이 없습니다 — 아직 빌드되지 않았습니다)' : `(${e.message})`;
      return;
    }
    if (!M.regions.length || !M.years.length) {
      $('#emptyState').hidden = false;
      $('#emptyDetail').textContent = '(매니페스트는 있으나 내용이 비어 있습니다)';
      return;
    }
    readHash();
    buildControls();
    $('#app').hidden = false;

    if (!state.region) {
      const s0 = M.sido[0];
      state.sido = s0.cd;
      const pool = (M._regionsOfSido.get(s0.cd) || []).filter(r => !r.head);
      state.region = (pool[0] || M.regions[0]).cd;
    }
    const lastY = M.years[M.years.length - 1].y;
    if (!state.year) state.year = lastY;
    state.mapYear = lastY;

    renderFooter(); fillGuide(); syncControls();
    await loadRegionData();
    loadGeo();
    selectTab(state.tab);
  }

  function buildControls() {
    $('#selSido').innerHTML = M.sido
      .map(s => `<option value="${s.cd}">${esc(s.nm)} (${s.n_region})</option>`).join('');
    $('#selAccount').innerHTML = '<option value="">전체 (일반+특별+기금)</option>'
      + M.accounts.map(a => `<option value="${a.cd}">${esc(a.nm)}</option>`).join('');
    $('#unitGroup').innerHTML = Object.entries(LF.UNITS)
      .map(([k, u]) => `<button type="button" data-unit="${k}" aria-pressed="false">${u.label}</button>`).join('');
    $('#fieldChecks').innerHTML = M.focus_fields.map(cd => {
      const f = M._fieldByCd.get(cd);
      return `<label><input type="checkbox" value="${cd}" checked> ${esc(f ? f.nm : cd)} (${cd})</label>`;
    }).join('');

    const partOpts = M.focus_fields.map(fcd => {
      const ps = M._partsOfField.get(fcd) || [];
      if (!ps.length) return '';
      const f = M._fieldByCd.get(fcd);
      return `<optgroup label="${esc(f ? f.nm : fcd)}">`
        + ps.map(p => `<option value="${p.cd}">${esc(p.nm)} (${p.cd})</option>`).join('')
        + '</optgroup>';
    }).join('');
    ['#selPart', '#qPart', '#mapPart'].forEach(sel => {
      $(sel).innerHTML = '<option value="">전체</option>' + partOpts;
    });

    const yearOpts = M.years.map(y => `<option value="${y.y}">${y.y}년</option>`).join('');
    $('#selYear').innerHTML = yearOpts;
    $('#mapYear').innerHTML = yearOpts;

    // 좌측 탭 — 이름 밑에 무엇을 보는 화면인지 한 줄
    $('#navTabs').innerHTML = TABS.map(t =>
      `<button role="tab" id="tab-${t.id}" data-tab="${t.id}" aria-controls="panel-${t.id}"`
      + ` aria-selected="false"><strong>${esc(t.nm)}</strong><small>${esc(t.desc)}</small></button>`
    ).join('');

    bindEvents();
  }

  function fillRegionSelect() {
    const pool = M._regionsOfSido.get(state.sido) || [];
    const basic = pool.filter(r => !r.head), heads = pool.filter(r => r.head);
    let html = basic.map(r => `<option value="${r.cd}">${esc(r.nm)}</option>`).join('');
    if (heads.length) html += `<optgroup label="본청">`
      + heads.map(r => `<option value="${r.cd}">${esc(r.nm)}</option>`).join('') + '</optgroup>';
    $('#selRegion').innerHTML = html;

    $('#selCompare').innerHTML = '<option value="">＋ 지역 추가</option>' + M.sido.map(s => {
      const rs = (M._regionsOfSido.get(s.cd) || []).filter(r => !r.head);
      if (!rs.length) return '';
      return `<optgroup label="${esc(s.nm)}">`
        + rs.map(r => `<option value="${r.cd}">${esc(r.nm)}</option>`).join('') + '</optgroup>';
    }).join('');
  }

  function syncControls() {
    fillRegionSelect();
    $('#selSido').value = state.sido;
    $('#selRegion').value = state.region;
    $('#selAccount').value = state.accounts[0] || '';
    $('#selPart').value = state.part;
    $('#selYear').value = state.year;
    $('#mapYear').value = state.mapYear || state.year;
    $('#mapField').value = state.mapField;
    $('#mapPart').value = state.mapPart;
    $('#qTerms').value = state.qTerms;
    $('#qExclude').value = state.qExclude;
    $('#qMode').value = state.qMode;
    $('#qPart').value = state.qPart;
    $('#chkBand').checked = state.band;
    $$('#unitGroup button').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.unit === state.unit)));
    $$('#mapScope button').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.scope === state.mapScope)));
    $$('#fieldChecks input').forEach(i => { i.checked = state.fields.includes(i.value); });
    renderCompareChips(); updateBandHint();
  }

  function renderCompareChips() {
    $('#compareChips').innerHTML = state.compare.map(cd => {
      const r = M._regionByCd.get(cd);
      return `<span class="chip">${esc(r ? r.nm : cd)}<button type="button" data-drop="${cd}"`
        + ` aria-label="${esc(r ? r.nm : cd)} 제거">×</button></span>`;
    }).join('');
    $('#selCompare').disabled = state.compare.length >= 3;
  }

  function updateBandHint() {
    const s = M._sidoByCd.get(state.sido), n = s ? s.n_region : 0;
    const h = $('#bandHint');
    if (n < LF.MIN_BAND_POPULATION) {
      h.textContent = `${s ? s.nm : ''}는 시군구가 ${n}곳이라 분위 밴드를 그릴 수 없습니다`;
      $('#chkBand').disabled = true;
    } else {
      h.textContent = `${s ? s.nm : ''} ${n}곳의 1~3분위`;
      $('#chkBand').disabled = false;
    }
  }

  // ── 데이터 ──────────────────────────────────────────────
  async function ensureAgg(cd) {
    if (aggBySido.has(cd)) return aggBySido.get(cd);
    const a = await LF.loadAgg(cd); aggBySido.set(cd, a); return a;
  }
  function aggFor(regionCd) {
    const r = M._regionByCd.get(regionCd);
    return r ? (aggBySido.get(r.sido) || null) : null;
  }
  function compareSeries(cd, sel, ys, unit) {
    const src = aggFor(cd);
    return src ? LF.regionSeries(src, sel, cd, ys, unit) : null;
  }

  async function loadRegionData() {
    setStatus('', '불러오는 중…');
    try { agg = await ensureAgg(state.sido); }
    catch (e) { setStatus('err', `시도 데이터 오류 (${e.message})`); agg = null; return; }
    try { biz = await LF.loadBiz(state.region); } catch (e) { biz = null; }
    await Promise.all(state.compare.map(async cd => {
      const r = M._regionByCd.get(cd);
      if (r && r.sido !== state.sido) { try { await ensureAgg(r.sido); } catch (e) { /* 표시 단계에서 걸러진다 */ } }
    }));
    setStatus('ready', `${M.years.length}개 연도 · ${M.regions.length}개 자치단체`);
  }

  async function loadGeo() {
    if (!M.geo || !M.geo.available) { geo = null; return; }
    try {
      const cross = await LFMap.loadCrosswalk();
      const topo = await LFMap.loadTopo('sgg');
      geo = { cross, topo };
    } catch (e) { geo = null; }
  }

  // ── 선택 → core ─────────────────────────────────────────
  function partParentMap() {
    const m = {}; M.parts.forEach(p => { m[p.cd] = p.fld; }); return m;
  }
  function selection(over) {
    return Object.assign({
      accounts: state.accounts, fields: state.fields,
      parts: state.part ? [state.part] : null,
      partParent: partParentMap(), measure: 'bdg',
    }, over || {});
  }
  function years() { return M.years.map(y => y.y); }
  function unitLabel() { return LF.UNITS[state.unit].label; }
  function fmt(v) { return LF.formatNumber(v, state.unit); }
  function fieldNm(cd) { const f = M._fieldByCd.get(cd); return f ? f.nm : cd; }

  function scopeLabel() {
    if (state.part) { const p = M._partByCd.get(state.part); return p ? `${p.nm} (${p.cd})` : state.part; }
    return state.fields.map(cd => `${fieldNm(cd)}(${cd})`).join(' · ') || '없음';
  }
  function accountLabel() {
    if (!state.accounts.length) return '전체 (일반+특별+기금)';
    return state.accounts.map(cd => { const a = M._accountByCd.get(cd); return a ? a.nm : cd; }).join(', ');
  }

  // ── ① 추이 ──────────────────────────────────────────────
  function renderTrend() {
    if (!agg) return;
    const ys = years(), sel = selection(), unit = state.unit, tr = [];

    let band = null;
    if (state.band) {
      band = LF.band(agg, M, sel, state.sido, ys, unit);
      if (band.available) {
        tr.push({ x: ys, y: band.q1, type: 'scatter', mode: 'lines',
                  line: { width: 0 }, hoverinfo: 'skip', showlegend: false });
        tr.push({ x: ys, y: band.q3, type: 'scatter', mode: 'lines',
                  line: { width: 0 }, fill: 'tonexty', fillcolor: C.band,
                  name: `${M._sidoByCd.get(state.sido).nm} 1~3분위`,
                  hovertemplate: '1~3분위 상단 %{y:,.1f}<extra></extra>' });
        tr.push({ x: ys, y: band.med, type: 'scatter', mode: 'lines',
                  line: { color: C.median, width: 1.6, dash: 'dash' }, name: '시도 중위값',
                  hovertemplate: '중위 %{y:,.1f}<extra></extra>' });
      }
    }
    state.compare.forEach((cd, i) => {
      const r = M._regionByCd.get(cd); if (!r) return;
      const y = compareSeries(cd, sel, ys, unit); if (!y) return;
      tr.push({ x: ys, y, type: 'scatter', mode: 'lines+markers',
                line: { color: C.compare[i % 3], width: 1.7, dash: C.compareDash[i % 3] },
                marker: { size: 4 }, name: r.nm, connectgaps: false,
                hovertemplate: `${esc(r.nm)} %{y:,.1f}<extra></extra>` });
    });
    const self = M._regionByCd.get(state.region);
    const selfY = LF.regionSeries(agg, sel, state.region, ys, unit);
    tr.push({ x: ys, y: selfY, type: 'scatter', mode: 'lines+markers',
              line: { color: C.self, width: 3.2 }, marker: { size: 7 },
              name: self ? self.nm : state.region, connectgaps: false,
              hovertemplate: `${esc(self ? self.nm : '')} %{y:,.1f}<extra></extra>` });

    Plotly.react($('#chartTrend'), tr, baseLayout({
      yaxis: Object.assign(baseLayout().yaxis, {
        title: { text: LF.axisLabel(unit, M, sel), font: { size: 11.5 } }, rangemode: 'tozero' }),
      xaxis: Object.assign(baseLayout().xaxis, { dtick: 1 }),
    }), CFG);

    const missing = ys.filter((y, i) => selfY[i] == null);
    const notes = [];
    if (missing.length) notes.push(`${missing.join(', ')}년은 데이터가 없어 선을 끊었습니다 (0으로 채우지 않습니다).`);
    if (state.band && band && !band.available) notes.push(band.reason);
    if (unit === 'percent') notes.push(`비중의 분모는 ${LF.denominatorLabel(M, sel)}입니다.`);
    $('#trendNote').textContent = notes.join(' ');

    lastRender.trend = { years: ys, selfY, band, unit, sel };
    renderTrendTable(ys, selfY, band);
    renderCount(ys);
  }

  function partsOfSelectedFields() {
    const out = [];
    state.fields.forEach(f => (M._partsOfField.get(f) || []).forEach(p => out.push(p.cd)));
    return out;
  }

  function renderCount(ys) {
    if (!biz) { Plotly.purge($('#chartCount')); return; }
    const res = LF.search(biz, { terms: [], accounts: state.accounts,
      parts: state.part ? [state.part] : partsOfSelectedFields() });
    const counts = ys.map(y => res.countByYear.get(y) ?? null);
    const budgets = ys.map(y => res.byYear.get(y) ?? null);
    const div = state.unit === 'percent' ? 1e3 : LF.UNITS[state.unit].divisor;
    const avgLabel = state.unit === 'percent' ? '천원' : unitLabel();
    const avg = ys.map((y, i) => counts[i] && budgets[i] ? (budgets[i] / counts[i]) / div : null);

    Plotly.react($('#chartCount'), [
      { x: ys, y: counts, type: 'bar', name: '사업 수',
        marker: { color: C.self, opacity: .85 }, hovertemplate: '사업 %{y:,}개<extra></extra>' },
      { x: ys, y: avg, type: 'scatter', mode: 'lines+markers', yaxis: 'y2',
        name: `사업당 평균예산 (${avgLabel})`, line: { color: C.compare[0], width: 2 },
        marker: { size: 5 }, connectgaps: false, hovertemplate: '평균 %{y:,.1f}<extra></extra>' },
    ], baseLayout({
      yaxis: Object.assign(baseLayout().yaxis, { title: { text: '사업 수', font: { size: 11.5 } } }),
      yaxis2: { overlaying: 'y', side: 'right', showgrid: false, automargin: true,
                exponentformat: 'none', separatethousands: true,
                title: { text: `평균예산 (${avgLabel})`, font: { size: 11.5 } },
                tickfont: { color: css('--ink-3') } },
      xaxis: Object.assign(baseLayout().xaxis, { dtick: 1 }),
      margin: { l: 60, r: 68, t: 16, b: 48 },
    }), CFG);
    lastRender.count = { years: ys, counts, budgets, avg, avgLabel };
  }

  function renderTrendTable(ys, selfY, band) {
    const self = M._regionByCd.get(state.region), sel = selection();
    const cmp = state.compare.map(cd => ({ cd, r: M._regionByCd.get(cd),
      y: compareSeries(cd, sel, ys, state.unit) || ys.map(() => null) }));
    const head = ['연도', self ? self.nm : '선택 지역'].concat(cmp.map(c => c.r ? c.r.nm : c.cd))
      .concat(band && band.available ? ['시도 1분위', '시도 중위', '시도 3분위'] : []);
    const rows = ys.map((y, i) => {
      const row = [String(y), fmt(selfY[i])];
      cmp.forEach(c => row.push(fmt(c.y[i])));
      if (band && band.available) row.push(fmt(band.q1[i]), fmt(band.med[i]), fmt(band.q3[i]));
      return row;
    });
    drawTable($('#tblTrend'), head, rows, [0]);
    lastRender.trendTable = { head, rows };
  }

  // ── ② 구성 ──────────────────────────────────────────────
  function renderComp() {
    if (!agg) return;
    const comp = LF.composition(agg, M, state.region, state.year, state.accounts);
    if (!comp || !comp.total) {
      Plotly.purge($('#chartDonut')); Plotly.purge($('#chartParts'));
      $('#compHint').textContent = `${state.year}년 데이터가 없습니다.`;
      $('#compKpis').innerHTML = ''; drawTable($('#tblComp'), [], []); return;
    }
    const focus = M.focus_fields;
    const totals = focus.map(cd => comp.byField.get(cd) || 0);
    const focusSum = totals.reduce((a, b) => a + b, 0);
    const others = Math.max(comp.total - focusSum, 0);
    const pct = v => comp.total ? v / comp.total * 100 : 0;

    // 080·090 을 나누어 보여주고 합계도 함께 — 요구사항 그대로
    const u = state.unit === 'percent' ? 'billion' : state.unit;
    const money = v => LF.formatNumber(v / LF.UNITS[u].divisor, u);
    $('#compKpis').innerHTML = focus.map((cd, i) => `
      <div class="kpi f${cd}"><span class="k">${esc(fieldNm(cd))} (${cd})</span>
        <span class="v">${money(totals[i])}</span>
        <span class="u">${LF.UNITS[u].label} · 전체 세출의 ${pct(totals[i]).toFixed(1)}%</span></div>`
    ).join('') + `
      <div class="kpi"><span class="k">두 분야 합계</span>
        <span class="v">${money(focusSum)}</span>
        <span class="u">${LF.UNITS[u].label} · 전체 세출의 ${pct(focusSum).toFixed(1)}%</span></div>
      <div class="kpi"><span class="k">전체 세출</span>
        <span class="v">${money(comp.total)}</span>
        <span class="u">${LF.UNITS[u].label} · ${state.year}년</span></div>`;

    // 도넛 — 안쪽은 분야, 바깥은 부문. 같은 순서라 방사 방향이 맞는다.
    const innerLabels = focus.map(cd => `${fieldNm(cd)}(${cd})`).concat(['그 외 분야']);
    const innerValues = totals.concat([others]);
    const innerColors = [C.f080[1], C.f090[1]].slice(0, focus.length).concat([C.other]);
    const oL = [], oV = [], oC = [];
    focus.forEach((fcd, fi) => {
      const pal = fi === 0 ? C.f080 : C.f090;
      (M._partsOfField.get(fcd) || [])
        .map(p => ({ p, v: (comp.byPart.get(p.cd) || { bdg: 0 }).bdg }))
        .filter(x => x.v > 0).sort((a, b) => b.v - a.v)
        .forEach((x, i) => { oL.push(`${x.p.nm}(${x.p.cd})`); oV.push(x.v); oC.push(pal[i % pal.length]); });
    });
    oL.push('그 외 분야'); oV.push(others); oC.push(C.other);
    const hv = state.unit === 'percent' ? 'billion' : state.unit;
    const cd2 = arr => arr.map(v => LF.formatNumber(v / LF.UNITS[hv].divisor, hv));

    Plotly.react($('#chartDonut'), [
      { type: 'pie', labels: oL, values: oV, hole: .62, domain: { x: [0, 1], y: [0, 1] },
        marker: { colors: oC, line: { color: css('--surface'), width: 1.5 } },
        textinfo: 'none', sort: false, direction: 'clockwise', customdata: cd2(oV),
        hovertemplate: `%{label}<br>%{percent} · %{customdata} ${LF.UNITS[hv].label}<extra></extra>`, name: '부문' },
      { type: 'pie', labels: innerLabels, values: innerValues, hole: .34,
        domain: { x: [.185, .815], y: [.185, .815] },
        marker: { colors: innerColors, line: { color: css('--surface'), width: 1.5 } },
        textinfo: 'percent', textposition: 'inside', insidetextorientation: 'horizontal',
        insidetextfont: { size: 12, color: C.inside }, automargin: true,
        sort: false, direction: 'clockwise', customdata: cd2(innerValues),
        hovertemplate: `%{label}<br>%{percent} · %{customdata} ${LF.UNITS[hv].label}<extra></extra>`, name: '분야' },
    ], baseLayout({ showlegend: true, legend: { orientation: 'h', y: -.05, font: { size: 10.5 } },
                    margin: { l: 8, r: 8, t: 8, b: 8 } }), CFG);

    // 막대 — 크기 순위
    const rows = [];
    focus.forEach(fcd => (M._partsOfField.get(fcd) || []).forEach(p => {
      const v = comp.byPart.get(p.cd); if (!v || !v.bdg) return;
      const nbiz = biz ? LF.bizCount(biz, { years: [state.year], parts: [p.cd], accounts: state.accounts }) : null;
      rows.push({ cd: p.cd, nm: p.nm, fld: fcd, bdg: v.bdg, nbiz,
                  share: pct(v.bdg),
                  parentShare: (comp.byField.get(fcd) || 0) ? v.bdg / comp.byField.get(fcd) * 100 : null });
    }));
    rows.sort((a, b) => b.bdg - a.bdg);
    const isPct = state.unit === 'percent';
    const xs = rows.map(r => isPct ? r.share : r.bdg / LF.UNITS[state.unit].divisor);
    const labels = rows.map(r => `${r.nm}(${r.cd})`);

    Plotly.react($('#chartParts'), [{
      type: 'bar', orientation: 'h', x: xs.slice().reverse(), y: labels.slice().reverse(),
      marker: { color: rows.slice().reverse().map(r => r.fld === focus[0] ? C.f080[1] : C.f090[1]) },
      text: rows.slice().reverse().map(r => r.nbiz != null ? `사업 ${r.nbiz.toLocaleString('ko-KR')}개` : ''),
      textposition: 'outside', textfont: { size: 10.5, color: css('--ink-3') }, cliponaxis: false,
      customdata: rows.slice().reverse().map(r => r.cd),
      hovertemplate: `%{y}<br>%{x:,.1f} ${isPct ? '%' : unitLabel()}<extra></extra>`,
    }], baseLayout({
      hovermode: 'closest', showlegend: false, margin: { l: 150, r: 80, t: 8, b: 40 },
      xaxis: Object.assign(baseLayout().xaxis, {
        title: { text: isPct ? '전체 세출 대비 %' : unitLabel(), font: { size: 11.5 } },
        separatethousands: true, exponentformat: 'none', automargin: true }),
      yaxis: { automargin: true, tickfont: { size: 11 } },
    }), CFG);

    const gd = $('#chartParts');
    if (gd.removeAllListeners) gd.removeAllListeners('plotly_click');
    gd.on('plotly_click', ev => {
      if (!ev.points || !ev.points.length) return;
      const cd = ev.points[0].customdata; if (!cd) return;
      state.qPart = cd; state.qTerms = ''; syncControls(); selectTab('search');
    });

    $('#compHint').textContent =
      `${state.year}년 전체 세출 ${LF.formatNumber(comp.total / 1e8, 'billion')} 억원 중 `
      + `사회복지·보건이 ${pct(focusSum).toFixed(1)}%`;

    // 표 — 분야별로 나누고 소계·합계를 함께
    const head = ['분야', '부문', '코드', `예산(${isPct ? '%' : unitLabel()})`,
                  '전체 세출 대비 %', '상위 분야 대비 %', '사업 수'];
    const trows = [];
    focus.forEach(fcd => {
      rows.filter(r => r.fld === fcd).forEach(r => trows.push({
        cells: [fieldNm(fcd), r.nm, r.cd,
                LF.formatNumber(isPct ? r.share : r.bdg / LF.UNITS[state.unit].divisor, state.unit),
                r.share.toFixed(2), r.parentShare != null ? r.parentShare.toFixed(2) : '—',
                r.nbiz != null ? r.nbiz.toLocaleString('ko-KR') : '—'] }));
      const t = comp.byField.get(fcd) || 0;
      trows.push({ sub: true, cells: [`${fieldNm(fcd)} 소계`, '', fcd,
        LF.formatNumber(isPct ? pct(t) : t / LF.UNITS[state.unit].divisor, state.unit),
        pct(t).toFixed(2), '100.00', ''] });
    });
    trows.push({ sub: true, cells: ['두 분야 합계', '', '',
      LF.formatNumber(isPct ? pct(focusSum) : focusSum / LF.UNITS[state.unit].divisor, state.unit),
      pct(focusSum).toFixed(2), '', ''] });
    drawTable($('#tblComp'), head, trows, [0, 1, 2]);
    lastRender.comp = { head, rows: trows.map(r => r.cells), comp, partRows: rows, focusSum };
  }

  // ── ③ 지도 ──────────────────────────────────────────────
  function mapValues() {
    // 지도에 쓸 (자치단체 → 값). 시도 하나 또는 전국.
    const year = state.mapYear || state.year;
    const fields = state.mapField === 'both' ? M.focus_fields : [state.mapField];
    const sel = selection({ fields, parts: state.mapPart ? [state.mapPart] : null });
    const scope = state.mapScope;
    const sidos = scope === 'nation' ? M.sido.map(s => s.cd) : [state.sido];
    const values = new Map(), labels = new Map(), rows = [];

    sidos.forEach(sc => {
      const a = aggBySido.get(sc);
      if (!a) return;
      const { num, den } = LF.series(a, sel);
      (M._regionsOfSido.get(sc) || []).filter(r => !r.head).forEach(r => {
        const ri = a._rIdx.get(r.cd); if (ri === undefined) return;
        const nm = num.get(ri), v = nm ? nm.get(year) : undefined;
        if (v === undefined) return;
        let out;
        if (state.unit === 'percent') {
          const dm = den.get(ri), d = dm ? dm.get(year) : undefined;
          if (!d) return;
          out = v / d * 100;
        } else out = v / LF.UNITS[state.unit].divisor;
        values.set(r.cd, out); labels.set(r.cd, r.nm);
        rows.push({ cd: r.cd, nm: r.nm, sido: M._sidoByCd.get(sc)?.nm || '', v: out });
      });
    });
    return { values, labels, rows, year, sel };
  }

  async function renderMap() {
    const box = $('#mapBox'), note = $('#mapNote');
    if (!M.geo || !M.geo.available || !geo) {
      box.innerHTML = '';
      $('#mapLegend').innerHTML = '';
      note.textContent = M.geo && M.geo.match_rate != null
        ? `경계 매칭률이 ${(M.geo.match_rate * 100).toFixed(1)}% 로 낮아 지도를 제공하지 않습니다.`
        : '지도 데이터를 불러오지 못했습니다.';
      drawTable($('#tblMap'), [], []); return;
    }
    // 전국을 보려면 모든 시도 집계가 있어야 한다
    if (state.mapScope === 'nation') {
      setStatus('', '전국 데이터 불러오는 중…');
      await Promise.all(M.sido.map(s => ensureAgg(s.cd).catch(() => null)));
      setStatus('ready', `${M.years.length}개 연도 · ${M.regions.length}개 자치단체`);
    }

    const { values, labels, rows, year } = mapValues();
    const isPct = state.unit === 'percent';
    const uLabel = isPct ? '%' : unitLabel();
    const sidoGeo = geo.cross.sido ? geo.cross.sido[state.sido] : null;

    const info = LFMap.render(box, {
      topo: geo.topo, crosswalk: geo.cross,
      scope: state.mapScope, sidoGeo,
      values, labels, selected: state.region, unitLabel: uLabel,
      theme: document.documentElement.getAttribute('data-theme')
        || (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'),
      onPick: cd => {
        const r = M._regionByCd.get(cd); if (!r) return;
        state.region = r.cd; state.sido = r.sido;
        syncControls(); writeHash();
        loadRegionData().then(() => render());
      },
    });
    LFMap.legend($('#mapLegend'), info, uLabel);

    const sidoNm = M._sidoByCd.get(state.sido)?.nm || '';
    const fieldNmTxt = state.mapField === 'both' ? '사회복지+보건'
      : `${fieldNm(state.mapField)}(${state.mapField})`;
    $('#mapTitle').textContent =
      `${state.mapScope === 'nation' ? '전국' : sidoNm} · ${year}년 · ${fieldNmTxt}`;

    const parts = [];
    parts.push(`${info.matched}곳에 값이 있습니다.`);
    if (info.drawn > info.matched) parts.push(`${info.drawn - info.matched}곳은 자료가 없어 회색입니다.`);
    if (isPct) parts.push(`비중의 분모는 ${state.mapPart ? '상위 분야' : '전체 세출'}입니다.`);
    parts.push('색 구간은 표시된 지역들의 분위로 나눕니다.');
    note.textContent = parts.join(' ');

    rows.sort((a, b) => b.v - a.v);
    drawTable($('#tblMap'),
      ['순위', '시도', '지역', `값(${uLabel})`],
      rows.map((r, i) => [String(i + 1), r.sido, r.nm, LF.formatNumber(r.v, isPct ? 'percent' : state.unit)]),
      [1, 2]);
    lastRender.map = { rows, year, uLabel };
  }

  // ── ④ 검색 ──────────────────────────────────────────────
  function renderSearch() {
    const sum = $('#searchSummary');
    if (!biz) {
      sum.innerHTML = '<p class="small">이 지자체의 세부사업 데이터를 불러오지 못했습니다.</p>';
      Plotly.purge($('#chartSearch')); drawTable($('#tblSearch'), [], []); return;
    }
    const terms = state.qTerms.split(/\s+/).filter(Boolean);
    const exclude = state.qExclude.split(/\s+/).filter(Boolean);
    const opts = { parts: state.qPart ? [state.qPart] : null, accounts: state.accounts };
    const res = LF.search(biz, Object.assign({ terms, exclude, matchAll: state.qMode === 'all' }, opts));
    const base = LF.search(biz, Object.assign({ terms: [] }, opts));
    const share = base.bdgSum ? res.bdgSum / base.bdgSum * 100 : null;
    const region = M._regionByCd.get(state.region);
    const u = state.unit === 'percent' ? 'thousand' : state.unit;

    sum.innerHTML = `
      <div class="kpi"><span class="k">사업 수</span>
        <span class="v">${res.bizCount.toLocaleString('ko-KR')}</span>
        <span class="u">개 · 행 ${res.rowCount.toLocaleString('ko-KR')}건</span></div>
      <div class="kpi"><span class="k">예산 합계</span>
        <span class="v">${LF.formatNumber(res.bdgSum / LF.UNITS[u].divisor, u)}</span>
        <span class="u">${LF.UNITS[u].label} · 전 연도 합</span></div>
      <div class="kpi"><span class="k">검색 범위 대비</span>
        <span class="v">${share != null ? share.toFixed(1) : '—'}</span>
        <span class="u">% · ${esc(state.qPart ? M._partByCd.get(state.qPart).nm : '사회복지·보건 전체')}</span></div>
      <div class="kpi"><span class="k">검색 범위</span>
        <span class="v" style="font-size:15px">${esc(region ? region.nm : '')}</span>
        <span class="u">선택한 시군구 안에서만</span></div>`;

    const ys = years(), isPct = state.unit === 'percent';
    const yv = ys.map(y => {
      const v = res.byYear.get(y); if (v === undefined) return null;
      if (!isPct) return v / LF.UNITS[state.unit].divisor;
      const b = base.byYear.get(y); return b ? v / b * 100 : null;
    });

    Plotly.react($('#chartSearch'), [
      { x: ys, y: yv, type: 'scatter', mode: 'lines+markers', line: { color: C.self, width: 2.6 },
        marker: { size: 6 }, connectgaps: false, name: '검색 결과',
        hovertemplate: '%{y:,.1f}<extra></extra>' },
      { x: ys, y: ys.map(y => res.countByYear.get(y) ?? null), type: 'bar', yaxis: 'y2',
        name: '사업 수', marker: { color: C.median, opacity: .35 },
        hovertemplate: '사업 %{y:,}개<extra></extra>' },
    ], baseLayout({
      yaxis: Object.assign(baseLayout().yaxis, {
        title: { text: isPct ? '검색 범위 대비 %' : unitLabel(), font: { size: 11.5 } }, rangemode: 'tozero' }),
      yaxis2: { overlaying: 'y', side: 'right', showgrid: false, rangemode: 'tozero',
                automargin: true, exponentformat: 'none',
                title: { text: '사업 수', font: { size: 11.5 } }, tickfont: { color: css('--ink-3') } },
      xaxis: Object.assign(baseLayout().xaxis, { dtick: 1 }),
      margin: { l: 64, r: 60, t: 16, b: 48 },
    }), CFG);

    const byBiz = new Map();
    res.rows.forEach(i => {
      const key = biz.bc[i];
      let e = byBiz.get(key);
      if (!e) { e = { name: biz.names[biz.nm[i]], code: biz.codes[key],
                      part: biz.parts[biz.p[i]], bdg: 0, exec: 0, years: new Set() };
                byBiz.set(key, e); }
      e.bdg += biz.bdg[i]; if (biz.exec) e.exec += biz.exec[i]; e.years.add(biz.y[i]);
    });
    const list = [...byBiz.values()].sort((a, b) => b.bdg - a.bdg);
    const head = ['세부사업명', '부문', `예산 합계(${LF.UNITS[u].label})`, '집행률', '연도', '사업코드'];
    const rows = list.slice(0, 500).map(e => {
      const p = M._partByCd.get(e.part), yl = [...e.years].sort();
      return [e.name, p ? p.nm : e.part, LF.formatNumber(e.bdg / LF.UNITS[u].divisor, u),
              e.bdg && e.exec ? (e.exec / e.bdg * 100).toFixed(1) + '%' : '—',
              yl.length > 2 ? `${yl[0]}–${yl[yl.length - 1]} (${yl.length})` : yl.join(', '), e.code];
    });
    drawTable($('#tblSearch'), head, rows, [0, 1, 4, 5]);
    $('#searchNote').textContent = list.length > 500
      ? `상위 500개만 표시합니다 (전체 ${list.length.toLocaleString('ko-KR')}개). 엑셀에는 전부 담깁니다.` : '';
    lastRender.search = { head, rows, list, res, base, unitForList: u };
  }

  // ── 표 ──────────────────────────────────────────────────
  function drawTable(table, head, rows, textCols) {
    const tc = new Set(textCols || []);
    if (!head.length) { table.innerHTML = ''; return; }
    const body = rows.map(r => {
      const cells = Array.isArray(r) ? r : r.cells;
      const cls = (!Array.isArray(r) && r.sub) ? ' class="sub"' : '';
      return `<tr${cls}>` + cells.map((c, i) =>
        `<td class="${tc.has(i) ? (i === 0 ? 'name' : '') : 'n'}">${esc(c)}</td>`).join('') + '</tr>';
    }).join('');
    table.innerHTML = '<thead><tr>' + head.map((h, i) =>
      `<th class="${tc.has(i) ? '' : 'n'}">${esc(h)}</th>`).join('') + '</tr></thead><tbody>'
      + body + '</tbody>';
  }
  function esc(s) {
    return String(s).replace(/[&<>"']/g, m =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]));
  }

  // ── 출처 · 설명서 ───────────────────────────────────────
  function renderFooter() {
    const low = M.years.filter(y => y.completeness != null && y.completeness < 1);
    let geoTxt = '';
    if (M.geo && M.geo.source) {
      geoTxt = ` · 경계 ${esc(M.geo.source.name)} (${esc(M.geo.source.license || '')})`;
    }
    $('#footSource').innerHTML =
      `출처 ${esc(M.source.api)} · ${esc(M.source.basis)}${geoTxt}<br>`
      + `데이터 생성 ${esc(M.built_at)} · 연도 ${M.years[0].y}–${M.years[M.years.length - 1].y}`
      + ` · 자치단체 ${M.regions.length.toLocaleString('ko-KR')}곳`
      + `<br><span class="small">${esc(M.source.note || '')}</span>`;
    const w = (M.warnings || []).slice();
    if (low.length) w.push('수집률 100% 미만: '
      + low.map(y => `${y.y}년 ${(y.completeness * 100).toFixed(2)}%`).join(', '));
    $('#footWarn').textContent = w.join(' / ');
  }

  function fillGuide() {
    $('#guideSource').innerHTML =
      `${esc(M.source.api)} · ${esc(M.source.basis)}<br>`
      + `데이터 생성 ${esc(M.built_at)}. ${esc(M.source.note || '')}`;
    if (M.geo && M.geo.source) {
      const s = M.geo.source;
      $('#guideGeoSource').innerHTML =
        `지도 경계: <a href="${esc(s.url)}" target="_blank" rel="noopener">${esc(s.name)}</a>`
        + ` ${esc(s.version || '')} · ${esc(s.license || '')}. `
        + `경계 데이터와 지방재정365는 코드 체계가 달라 이름으로 결합했으며, `
        + `${M.geo.matched}/${M.geo.total}곳이 연결되었습니다.`;
    }
  }

  function openGuide() { $('#guide').hidden = false; $('#guide .x').focus(); }
  function closeGuide() { $('#guide').hidden = true; $('#btnGuide').focus(); }

  // ── 내보내기 ────────────────────────────────────────────
  function exportContext() {
    const r = M._regionByCd.get(state.region), s = M._sidoByCd.get(state.sido);
    return {
      regionLabel: `${s ? s.nm : ''} ${r ? r.nm : state.region}`.trim(),
      compareLabels: state.compare.map(cd => { const x = M._regionByCd.get(cd); return x ? x.nm : cd; }),
      yearLabel: `${M.years[0].y}–${M.years[M.years.length - 1].y}`,
      scopeLabel: scopeLabel(), accountLabel: accountLabel(), unitLabel: unitLabel(),
      denominatorLabel: state.unit === 'percent' ? LF.denominatorLabel(M, selection()) : null,
      source: M.source.api, basis: M.source.basis, builtAt: M.built_at,
      completeness: M.years.map(y => ({ y: y.y, rows: y.rows,
        total: y.rows != null && y.missing != null ? y.rows + y.missing : null, rate: y.completeness })),
      warnings: M.warnings || [],
    };
  }
  function sheetFrom(head, rows) {
    return [head].concat(rows.map(r => r.map(c => {
      if (typeof c === 'string' && /^-?[\d,]+(\.\d+)?$/.test(c)) {
        const n = Number(c.replace(/,/g, '')); if (isFinite(n)) return n;
      }
      return c;
    })));
  }
  function doExportXlsx(which) {
    const ctx = exportContext(), sheets = [XLSXOut.conditionSheet(ctx)];
    const base = ctx.regionLabel.replace(/\s+/g, '_');
    if (which === 'trend' || which === 'trendTable') {
      const t = lastRender.trendTable;
      if (t) sheets.push({ name: '연도별 추이', rows: sheetFrom(t.head, t.rows) });
      const b = lastRender.trend && lastRender.trend.band;
      if (b && b.available) sheets.push({ name: '시도 분포',
        rows: [['연도', '1분위', '중위', '3분위', '모집단 수']].concat(
          lastRender.trend.years.map((y, i) => [y, b.q1[i], b.med[i], b.q3[i], b.counts[i]])) });
    } else if (which === 'count') {
      const c = lastRender.count;
      if (c) sheets.push({ name: '사업 수',
        rows: [['연도', '사업 수', '예산(원)', `사업당 평균(${c.avgLabel})`]].concat(
          c.years.map((y, i) => [y, c.counts[i], c.budgets[i], c.avg[i]])) });
    } else if (which === 'comp') {
      const c = lastRender.comp;
      if (c) {
        sheets.push({ name: `${state.year}년 부문별`, rows: sheetFrom(c.head, c.rows) });
        sheets.push({ name: `${state.year}년 분야별`,
          rows: [['분야코드', '분야명', '예산(원)', '전체 대비 %']].concat(
            [...c.comp.byField.entries()].sort((a, b) => b[1] - a[1]).map(([cd, v]) =>
              [cd, fieldNm(cd), v, v / c.comp.total * 100])) });
      }
    } else if (which === 'map') {
      const m = lastRender.map;
      if (m) sheets.push({ name: `${m.year}년 지역별`,
        rows: [['순위', '시도', '지역', `값(${m.uLabel})`]].concat(
          m.rows.map((r, i) => [i + 1, r.sido, r.nm, r.v])) });
    } else if (which === 'search') {
      const s = lastRender.search;
      if (s) {
        const all = s.list.map(e => {
          const p = M._partByCd.get(e.part), yl = [...e.years].sort();
          return [e.name, p ? p.nm : e.part, e.bdg / LF.UNITS[s.unitForList].divisor,
                  e.bdg && e.exec ? e.exec / e.bdg * 100 : null, yl.join(' '), e.code];
        });
        sheets.push({ name: '사업 목록', rows: [s.head].concat(all) });
        sheets.push({ name: '검색 조건', rows: [['항목', '값'],
          ['검색어', state.qTerms || '(없음)'], ['제외어', state.qExclude || '(없음)'],
          ['여러 단어', state.qMode === 'all' ? '모두 포함' : '하나라도 포함'],
          ['부문', state.qPart ? M._partByCd.get(state.qPart).nm : '전체'],
          ['검색 범위', ctx.regionLabel], ['사업 수', s.res.bizCount],
          ['예산 합계(원)', s.res.bdgSum]] });
      }
    }
    XLSXOut.download(sheets, `지방재정_${base}_${which}`);
  }
  const CHART_OF = { trend: '#chartTrend', count: '#chartCount', donut: '#chartDonut',
                     parts: '#chartParts', search: '#chartSearch' };
  function doExportImage(which) {
    const r = M._regionByCd.get(state.region), nm = r ? r.nm : '';
    if (which === 'map') { LFMap.downloadImage($('#mapBox'), `지방재정_${nm}_지도`); return; }
    const el = $(CHART_OF[which]);
    if (el && el.data) XLSXOut.downloadImage(el, `지방재정_${nm}_${which}`, 'png');
  }

  // ── 탭 ──────────────────────────────────────────────────
  function selectTab(tab) {
    state.tab = tab;
    $$('#navTabs button').forEach(b => b.setAttribute('aria-selected', String(b.dataset.tab === tab)));
    $$('.panel').forEach(p => { p.hidden = p.id !== `panel-${tab}`; });
    writeHash(); render();
  }
  function render() {
    if (!M || !agg) return;
    C = palette();
    if (state.tab === 'trend') renderTrend();
    else if (state.tab === 'comp') renderComp();
    else if (state.tab === 'map') renderMap();
    else renderSearch();
  }

  // ── 이벤트 ──────────────────────────────────────────────
  let timer = null;
  function bindEvents() {
    $('#selSido').addEventListener('change', async e => {
      state.sido = e.target.value;
      const pool = (M._regionsOfSido.get(state.sido) || []).filter(r => !r.head);
      state.region = (pool[0] || M.regions[0]).cd;
      syncControls(); writeHash(); await loadRegionData(); render();
    });
    $('#selRegion').addEventListener('change', async e => {
      state.region = e.target.value; writeHash(); await loadRegionData(); render();
    });
    $('#selAccount').addEventListener('change', e => {
      state.accounts = e.target.value ? [e.target.value] : []; writeHash(); render();
    });
    $('#unitGroup').addEventListener('click', e => {
      const b = e.target.closest('button[data-unit]'); if (!b) return;
      state.unit = b.dataset.unit; syncControls(); writeHash(); render();
    });
    $('#themeGroup').addEventListener('click', e => {
      const b = e.target.closest('button[data-theme]'); if (!b) return;
      applyTheme(b.dataset.theme);
    });
    $('#fieldChecks').addEventListener('change', () => {
      const picked = $$('#fieldChecks input:checked').map(i => i.value);
      if (!picked.length) { syncControls(); return; }
      state.fields = picked;
      if (state.part) {
        const p = M._partByCd.get(state.part);
        if (p && !picked.includes(p.fld)) state.part = '';
      }
      syncControls(); writeHash(); render();
    });
    $('#selPart').addEventListener('change', e => {
      state.part = e.target.value;
      if (state.part) { const p = M._partByCd.get(state.part); if (p) state.fields = [p.fld]; }
      syncControls(); writeHash(); render();
    });
    $('#selCompare').addEventListener('change', async e => {
      const cd = e.target.value; e.target.value = '';
      if (!cd || state.compare.includes(cd) || cd === state.region || state.compare.length >= 3) return;
      state.compare.push(cd);
      const r = M._regionByCd.get(cd);
      if (r && r.sido !== state.sido) { try { await ensureAgg(r.sido); } catch (err) { /* 표시에서 걸러진다 */ } }
      renderCompareChips(); writeHash(); render();
    });
    $('#compareChips').addEventListener('click', e => {
      const b = e.target.closest('button[data-drop]'); if (!b) return;
      state.compare = state.compare.filter(c => c !== b.dataset.drop);
      renderCompareChips(); writeHash(); render();
    });
    $('#chkBand').addEventListener('change', e => { state.band = e.target.checked; writeHash(); render(); });
    $('#selYear').addEventListener('change', e => { state.year = +e.target.value; writeHash(); render(); });

    $('#mapYear').addEventListener('change', e => { state.mapYear = +e.target.value; renderMap(); });
    $('#mapField').addEventListener('change', e => { state.mapField = e.target.value; writeHash(); renderMap(); });
    $('#mapPart').addEventListener('change', e => { state.mapPart = e.target.value; renderMap(); });
    $('#mapScope').addEventListener('click', e => {
      const b = e.target.closest('button[data-scope]'); if (!b) return;
      state.mapScope = b.dataset.scope; syncControls(); writeHash(); renderMap();
    });

    ['#qTerms', '#qExclude'].forEach(sel => {
      $(sel).addEventListener('input', e => {
        state[sel === '#qTerms' ? 'qTerms' : 'qExclude'] = e.target.value;
        clearTimeout(timer); timer = setTimeout(() => { writeHash(); renderSearch(); }, 180);
      });
    });
    $('#qMode').addEventListener('change', e => { state.qMode = e.target.value; renderSearch(); });
    $('#qPart').addEventListener('change', e => { state.qPart = e.target.value; renderSearch(); });

    $('#navTabs').addEventListener('click', e => {
      const b = e.target.closest('button[data-tab]'); if (b) selectTab(b.dataset.tab);
    });

    $('#btnGuide').addEventListener('click', openGuide);
    $('#guide').addEventListener('click', e => { if (e.target.closest('[data-close]')) closeGuide(); });
    document.addEventListener('keydown', e => {
      if (e.key === 'Escape' && !$('#guide').hidden) closeGuide();
    });

    document.addEventListener('click', e => {
      const x = e.target.closest('[data-export-x]');
      if (x) { doExportXlsx(x.dataset.exportX); return; }
      const i = e.target.closest('[data-export-i]');
      if (i) doExportImage(i.dataset.exportI);
    });

    // 시스템 테마가 바뀌면 '시스템' 을 고른 사용자에게만 반영
    if (window.matchMedia) {
      window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
        if (state.theme === 'auto') { C = palette(); render(); }
      });
    }
    let rt = null;
    window.addEventListener('resize', () => {
      if (state.tab !== 'map') return;
      clearTimeout(rt); rt = setTimeout(() => renderMap(), 200);
    });
  }

  document.addEventListener('DOMContentLoaded', init);
})();
