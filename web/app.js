/*
 * app.js — 화면과 조작.
 *
 * 선택지를 코드에 적지 않는다. 연도·지역·분야·부문·회계는 전부 매니페스트에서
 * 만들어지므로, 수집된 원자료가 늘거나 줄면 화면이 저절로 따라간다.
 */
(function () {
  'use strict';

  const $ = sel => document.querySelector(sel);
  const $$ = sel => Array.from(document.querySelectorAll(sel));

  let M = null;              // 매니페스트
  let agg = null;            // 현재 시도의 집계
  let biz = null;            // 현재 지자체의 세부사업
  const lastRender = {};     // 내보내기용 — 화면에 그려진 값 그대로

  // 이미 받아 둔 시도 집계. 비교지역이 다른 시도일 수 있어,
  // 그리는 시점에는 동기적으로 꺼내 쓸 수 있어야 한다.
  const aggBySido = new Map();

  async function ensureAgg(sidoCd) {
    if (aggBySido.has(sidoCd)) return aggBySido.get(sidoCd);
    const a = await LF.loadAgg(sidoCd);
    aggBySido.set(sidoCd, a);
    return a;
  }

  /** 지자체 코드로 그 지역이 담긴 집계를 찾는다. 아직 안 받았으면 null. */
  function aggFor(regionCd) {
    const r = M._regionByCd.get(regionCd);
    if (!r) return null;
    return aggBySido.get(r.sido) || null;
  }

  /** 비교지역 계열. 아직 받지 못한 시도의 지역은 조용히 건너뛴다. */
  function compareSeries(cd, sel, ys, unit) {
    const src = aggFor(cd);
    if (!src) return null;
    return LF.regionSeries(src, sel, cd, ys, unit);
  }

  const state = {
    tab: 'trend',
    sido: null, region: null,
    accounts: [],            // 빈 배열 = 전체
    unit: LF.DEFAULT_UNIT,
    fields: ['080', '090'],
    part: '',
    compare: [],
    band: false,
    year: null,
    qTerms: '', qExclude: '', qMode: 'all', qPart: '',
  };

  // ── 색 ──────────────────────────────────────────────────
  // 본인 지자체만 진한 유채색으로 강조하고 분포는 무채색으로 둔다.
  // 비교지역은 서로 구분되어야 하므로 색을 주되, 선 굵기와 파선으로
  // 본인과 위계를 분명히 한다. 흑백 인쇄에서도 구분이 남는다.
  function css(name) {
    return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  }

  // 색은 스타일시트에서 읽어 온다. 테마가 바뀌면 같이 따라가야 하므로
  // 상수로 굳히지 않고 그릴 때마다 다시 읽는다.
  function palette() {
    return {
      self: css('--c-self') || '#1E4B76',
      median: css('--c-median') || '#8A94A2',
      band: css('--c-band') || 'rgba(138,148,162,0.18)',
      compare: [css('--c-cmp1') || '#B4622A', css('--c-cmp2') || '#3F7D5C',
                css('--c-cmp3') || '#6E4E86'],
      compareDash: ['dash', 'dot', 'dashdot'],
      // 사회복지(080) 계열과 보건(090) 계열은 색상 자체를 달리해야
      // 부문이 10개 가까이 되어도 구분된다. 명도만 다르면 못 읽는다.
      f080: ['#1F4E79', '#2E6DA4', '#4A90C4', '#7FB3D9', '#A8CCE4', '#C9E0EE'],
      f090: ['#7A4419', '#A9662B', '#C98A4B', '#DDAE7C', '#EBCBA8'],
      other: css('--c-other') || '#C3CAD3',
      inside: css('--c-inside') || '#FFFFFF',
    };
  }
  let C = { self: '#1E4B76', median: '#8A94A2', band: 'rgba(138,148,162,.18)',
            compare: ['#B4622A', '#3F7D5C', '#6E4E86'],
            compareDash: ['dash', 'dot', 'dashdot'],
            f080: [], f090: [], other: '#C3CAD3', inside: '#fff' };

  function baseLayout(extra) {
    const ink = css('--ink') || '#16202E';
    const ink3 = css('--ink-3') || '#7C8798';
    const rule = css('--rule-2') || '#EDF0F4';
    return Object.assign({
      paper_bgcolor: 'rgba(0,0,0,0)',
      plot_bgcolor: 'rgba(0,0,0,0)',
      font: { family: css('--sans') || 'sans-serif', size: 12, color: ink },
      margin: { l: 68, r: 24, t: 16, b: 48 },
      hovermode: 'x unified',
      hoverlabel: { namelength: -1 },
      legend: { orientation: 'h', y: -0.16, font: { size: 11.5 } },
      xaxis: { gridcolor: rule, zerolinecolor: rule, tickfont: { color: ink3 } },
      // Plotly 기본값은 큰 수를 30B 처럼 영문 약어로 줄인다. 한글 단위를
      // 쓰는 화면에서 B·M 이 섞이면 오히려 못 읽으므로 전부 펼쳐 쓴다.
      yaxis: { gridcolor: rule, zerolinecolor: rule, tickfont: { color: ink3 },
               separatethousands: true, exponentformat: 'none', automargin: true },
    }, extra || {});
  }

  const PLOT_CFG = {
    displaylogo: false, responsive: true,
    // 내보내기 버튼을 따로 두었으므로 기본 카메라는 감춘다
    modeBarButtonsToRemove: ['toImage', 'lasso2d', 'select2d'],
  };

  // ── 상태 표시 ────────────────────────────────────────────
  function setStatus(kind, text) {
    const el = $('#status');
    el.className = 'status' + (kind ? ' ' + kind : '');
    $('#statusText').textContent = text;
  }

  // ── URL 해시 ─────────────────────────────────────────────
  // 담당자끼리 링크로 화면을 주고받는 일이 흔하다.
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
    history.replaceState(null, '', '#' + p.toString());
  }

  function readHash() {
    const p = new URLSearchParams(location.hash.slice(1));
    const g = (k, d) => (p.has(k) ? p.get(k) : d);
    const region = g('r', null);
    if (region && M._regionByCd.has(region)) {
      state.region = region;
      state.sido = M._regionByCd.get(region).sido;
    }
    state.tab = g('t', 'trend');
    state.unit = LF.UNITS[g('u', '')] ? g('u') : LF.DEFAULT_UNIT;
    state.accounts = g('a', '') ? g('a').split(',') : [];
    state.fields = g('f', '') ? g('f').split(',') : ['080', '090'];
    state.part = g('p', '');
    state.compare = g('c', '') ? g('c').split(',').slice(0, 3) : [];
    state.band = g('b', '') === '1';
    const y = parseInt(g('y', ''), 10);
    if (!isNaN(y)) state.year = y;
    state.qTerms = g('q', '');
  }

  // ── 초기화 ───────────────────────────────────────────────
  async function init() {
    try {
      M = await LF.loadManifest();
    } catch (e) {
      $('#emptyState').hidden = false;
      $('#emptyDetail').textContent = e.status === 404
        ? '(data/manifest.json 이 없습니다 — 아직 빌드되지 않았습니다)'
        : `(${e.message})`;
      setStatus('err', '데이터 없음');
      return;
    }

    if (!M.regions.length || !M.years.length) {
      $('#emptyState').hidden = false;
      $('#emptyDetail').textContent = '(매니페스트는 있으나 내용이 비어 있습니다)';
      setStatus('err', '데이터 없음');
      return;
    }

    readHash();
    buildStaticControls();
    $('#app').hidden = false;

    // 기본 선택 — 해시가 없으면 첫 시도의 첫 기초자치단체
    if (!state.region) {
      const firstSido = M.sido[0];
      state.sido = firstSido.cd;
      const pool = (M._regionsOfSido.get(firstSido.cd) || []).filter(r => !r.head);
      state.region = (pool[0] || M.regions[0]).cd;
    }
    if (!state.year) state.year = M.years[M.years.length - 1].y;

    renderFooter();
    syncControls();
    await loadRegionData();
    selectTab(state.tab);
  }

  function buildStaticControls() {
    // 시도
    const selSido = $('#selSido');
    selSido.innerHTML = M.sido
      .map(s => `<option value="${s.cd}">${s.nm} (${s.n_region})</option>`).join('');

    // 회계 — 빈 값이 '전체'
    $('#selAccount').innerHTML =
      '<option value="">전체 (일반+특별+기금)</option>' +
      M.accounts.map(a => `<option value="${a.cd}">${a.nm}</option>`).join('');

    // 단위
    $('#unitGroup').innerHTML = Object.entries(LF.UNITS)
      .map(([k, u]) => `<button type="button" data-unit="${k}" aria-pressed="false">${u.label}</button>`)
      .join('');

    // 분야 — 매니페스트의 focus_fields 를 그대로 쓴다
    $('#fieldChecks').innerHTML = M.focus_fields.map(cd => {
      const f = M._fieldByCd.get(cd);
      return `<label><input type="checkbox" value="${cd}" checked> ${f ? f.nm : cd} (${cd})</label>`;
    }).join('');

    // 부문
    const partOpts = M.focus_fields.map(fcd => {
      const parts = M._partsOfField.get(fcd) || [];
      if (!parts.length) return '';
      const f = M._fieldByCd.get(fcd);
      return `<optgroup label="${f ? f.nm : fcd}">` +
        parts.map(p => `<option value="${p.cd}">${p.nm} (${p.cd})</option>`).join('') +
        '</optgroup>';
    }).join('');
    $('#selPart').innerHTML = '<option value="">전체</option>' + partOpts;
    $('#qPart').innerHTML = '<option value="">전체</option>' + partOpts;

    // 연도
    $('#selYear').innerHTML = M.years.map(y => `<option value="${y.y}">${y.y}년</option>`).join('');

    bindEvents();
  }

  function fillRegionSelect() {
    const pool = M._regionsOfSido.get(state.sido) || [];
    const basic = pool.filter(r => !r.head);
    const heads = pool.filter(r => r.head);
    let html = basic.map(r => `<option value="${r.cd}">${r.nm}</option>`).join('');
    if (heads.length) {
      html += `<optgroup label="본청">` +
        heads.map(r => `<option value="${r.cd}">${r.nm}</option>`).join('') + '</optgroup>';
    }
    $('#selRegion').innerHTML = html;

    // 비교지역 후보 — 시도를 넘어 고를 수 있게 한다.
    // 다른 시도의 비슷한 규모와 견주는 요구가 실제로 흔하다.
    const groups = M.sido.map(s => {
      const rs = (M._regionsOfSido.get(s.cd) || []).filter(r => !r.head);
      if (!rs.length) return '';
      return `<optgroup label="${s.nm}">` +
        rs.map(r => `<option value="${r.cd}">${r.nm}</option>`).join('') + '</optgroup>';
    }).join('');
    $('#selCompare').innerHTML = '<option value="">＋ 지역 추가</option>' + groups;
  }

  function syncControls() {
    fillRegionSelect();
    $('#selSido').value = state.sido;
    $('#selRegion').value = state.region;
    $('#selAccount').value = state.accounts[0] || '';
    $('#selPart').value = state.part;
    $('#selYear').value = state.year;
    $('#qTerms').value = state.qTerms;
    $('#qExclude').value = state.qExclude;
    $('#qMode').value = state.qMode;
    $('#qPart').value = state.qPart;
    $('#chkBand').checked = state.band;
    $$('#unitGroup button').forEach(b =>
      b.setAttribute('aria-pressed', String(b.dataset.unit === state.unit)));
    $$('#fieldChecks input').forEach(i => { i.checked = state.fields.includes(i.value); });
    renderCompareChips();
    updateBandHint();
  }

  function renderCompareChips() {
    $('#compareChips').innerHTML = state.compare.map(cd => {
      const r = M._regionByCd.get(cd);
      return `<span class="chip">${r ? r.nm : cd}<button type="button" data-drop="${cd}" aria-label="${r ? r.nm : cd} 제거">×</button></span>`;
    }).join('');
    $('#selCompare').disabled = state.compare.length >= 3;
  }

  function updateBandHint() {
    const s = M._sidoByCd.get(state.sido);
    const n = s ? s.n_region : 0;
    const hint = $('#bandHint');
    if (n < LF.MIN_BAND_POPULATION) {
      hint.textContent = `${s ? s.nm : ''}는 시군구가 ${n}곳이라 분위 밴드를 그릴 수 없습니다`;
      $('#chkBand').disabled = true;
    } else {
      hint.textContent = `${s ? s.nm : ''} ${n}곳의 1~3분위`;
      $('#chkBand').disabled = false;
    }
  }

  // ── 데이터 적재 ──────────────────────────────────────────
  async function loadRegionData() {
    setStatus('', '불러오는 중…');
    try {
      agg = await ensureAgg(state.sido);
    } catch (e) {
      setStatus('err', `시도 데이터를 불러오지 못했습니다 (${e.message})`);
      agg = null; return;
    }
    // 세부사업은 검색뿐 아니라 사업 수를 정확히 세는 데도 쓴다.
    // 집계 파일의 사업 수는 회계·부문을 합칠 때 중복이 생기지만
    // 이 파일에서는 어떤 필터 조합에서도 정확하다.
    try {
      biz = await LF.loadBiz(state.region);
    } catch (e) {
      biz = null;
    }

    // 비교지역 중 다른 시도에 속한 곳의 집계도 미리 받아 둔다.
    await Promise.all(state.compare.map(async cd => {
      const r = M._regionByCd.get(cd);
      if (r && r.sido !== state.sido) {
        try { await ensureAgg(r.sido); } catch (e) { /* 그 계열은 그리지 않는다 */ }
      }
    }));

    const yr = M.years.length;
    setStatus('ready', `${yr}개 연도 · ${M.regions.length}개 자치단체`);
  }

  // ── 선택 상태 → core 가 쓰는 형태 ────────────────────────
  function selection() {
    const partParent = {};
    M.parts.forEach(p => { partParent[p.cd] = p.fld; });
    return {
      accounts: state.accounts,
      fields: state.fields,
      parts: state.part ? [state.part] : null,
      partParent,
      measure: 'bdg',
    };
  }

  function years() { return M.years.map(y => y.y); }

  function scopeLabel() {
    if (state.part) {
      const p = M._partByCd.get(state.part);
      return p ? `${p.nm} (${p.cd})` : state.part;
    }
    return state.fields.map(cd => {
      const f = M._fieldByCd.get(cd);
      return f ? `${f.nm}(${cd})` : cd;
    }).join(' · ') || '없음';
  }

  function accountLabel() {
    if (!state.accounts.length) return '전체 (일반+특별+기금)';
    return state.accounts.map(cd => {
      const a = M._accountByCd.get(cd);
      return a ? a.nm : cd;
    }).join(', ');
  }

  function unitLabel() { return LF.UNITS[state.unit].label; }

  // ── ① 추이 ───────────────────────────────────────────────
  function renderTrend() {
    if (!agg) return;
    const ys = years();
    const sel = selection();
    const unit = state.unit;
    const traces = [];

    // 분포 밴드 — 요청했을 때만 계산한다
    let band = null;
    if (state.band) {
      band = LF.band(agg, M, sel, state.sido, ys, unit);
      if (band.available) {
        // 밴드는 두 선 사이를 채워 만든다. 아래 선은 감춘다.
        traces.push({
          x: ys, y: band.q1, type: 'scatter', mode: 'lines',
          line: { width: 0 }, hoverinfo: 'skip', showlegend: false,
        });
        traces.push({
          x: ys, y: band.q3, type: 'scatter', mode: 'lines',
          line: { width: 0 }, fill: 'tonexty', fillcolor: C.band,
          name: `${M._sidoByCd.get(state.sido).nm} 1~3분위`,
          hovertemplate: '1~3분위 상단 %{y:,.1f}<extra></extra>',
        });
        traces.push({
          x: ys, y: band.med, type: 'scatter', mode: 'lines',
          line: { color: C.median, width: 1.6, dash: 'dash' },
          name: '시도 중위값',
          hovertemplate: '중위 %{y:,.1f}<extra></extra>',
        });
      }
    }

    // 비교지역 — 본인보다 가는 선 + 파선
    state.compare.forEach((cd, i) => {
      const r = M._regionByCd.get(cd);
      if (!r) return;
      const y = compareSeries(cd, sel, ys, unit);
      if (!y) return;
      traces.push({
        x: ys, y,
        type: 'scatter', mode: 'lines+markers',
        line: { color: C.compare[i % 3], width: 1.7, dash: C.compareDash[i % 3] },
        marker: { size: 4 },
        name: r.nm,
        connectgaps: false,
        hovertemplate: `${r.nm} %{y:,.1f}<extra></extra>`,
      });
    });

    // 본인 지자체 — 유일하게 굵은 실선
    const self = M._regionByCd.get(state.region);
    const selfY = LF.regionSeries(agg, sel, state.region, ys, unit);
    traces.push({
      x: ys, y: selfY, type: 'scatter', mode: 'lines+markers',
      line: { color: C.self, width: 3.2 }, marker: { size: 7 },
      name: self ? self.nm : state.region,
      connectgaps: false,          // 결측 연도는 선을 끊는다
      hovertemplate: `${self ? self.nm : ''} %{y:,.1f}<extra></extra>`,
    });

    Plotly.react($('#chartTrend'), traces, baseLayout({
      yaxis: Object.assign(baseLayout().yaxis, {
        title: { text: LF.axisLabel(unit, M, sel), font: { size: 11.5 } },
        rangemode: 'tozero',
      }),
      xaxis: Object.assign(baseLayout().xaxis, { dtick: 1 }),
    }), PLOT_CFG);

    // 결측·단절 안내 — 0으로 채우지 않았다는 사실을 밝힌다
    const missing = ys.filter((y, i) => selfY[i] == null);
    const notes = [];
    if (missing.length) {
      notes.push(`${missing.join(', ')}년은 데이터가 없어 선을 끊었습니다 (0으로 채우지 않습니다).`);
    }
    if (state.band && band && !band.available) notes.push(band.reason);
    if (unit === 'percent') notes.push(`비중의 분모는 ${LF.denominatorLabel(M, sel)}입니다.`);
    $('#trendNote').textContent = notes.join(' ');

    lastRender.trend = { years: ys, selfY, band, unit, sel };
    renderTrendTable(ys, selfY, band);
    renderCount(ys);
  }

  function renderCount(ys) {
    if (!biz) {
      Plotly.purge($('#chartCount'));
      return;
    }
    const opts = {
      accounts: state.accounts,
      parts: state.part ? [state.part] : partsOfSelectedFields(),
    };
    const res = LF.search(biz, { ...opts, terms: [] });
    const counts = ys.map(y => res.countByYear.get(y) ?? null);
    const budgets = ys.map(y => res.byYear.get(y) ?? null);
    const divisor = state.unit === 'percent' ? 1e3 : LF.UNITS[state.unit].divisor;
    const avgLabel = state.unit === 'percent' ? '천원' : unitLabel();
    const avg = ys.map((y, i) =>
      counts[i] && budgets[i] ? (budgets[i] / counts[i]) / divisor : null);

    Plotly.react($('#chartCount'), [
      {
        x: ys, y: counts, type: 'bar', name: '사업 수',
        marker: { color: C.self, opacity: .85 },
        hovertemplate: '사업 %{y:,}개<extra></extra>',
      },
      {
        x: ys, y: avg, type: 'scatter', mode: 'lines+markers', yaxis: 'y2',
        name: `사업당 평균예산 (${avgLabel})`,
        line: { color: C.compare[0], width: 2 }, marker: { size: 5 },
        connectgaps: false,
        hovertemplate: '평균 %{y:,.1f}<extra></extra>',
      },
    ], baseLayout({
      yaxis: Object.assign(baseLayout().yaxis, { title: { text: '사업 수', font: { size: 11.5 } } }),
      yaxis2: {
        overlaying: 'y', side: 'right', showgrid: false, automargin: true,
        title: { text: `평균예산 (${avgLabel})`, font: { size: 11.5 } },
        tickfont: { color: css('--ink-3') },
        separatethousands: true, exponentformat: 'none',
      },
      xaxis: Object.assign(baseLayout().xaxis, { dtick: 1 }),
      margin: { l: 60, r: 68, t: 16, b: 48 },
    }), PLOT_CFG);

    lastRender.count = { years: ys, counts, budgets, avg, avgLabel };
  }

  function partsOfSelectedFields() {
    const out = [];
    state.fields.forEach(f => (M._partsOfField.get(f) || []).forEach(p => out.push(p.cd)));
    return out;
  }

  function renderTrendTable(ys, selfY, band) {
    const self = M._regionByCd.get(state.region);
    const sel = selection();
    const cmp = state.compare.map(cd => ({
      cd, r: M._regionByCd.get(cd),
      y: compareSeries(cd, sel, ys, state.unit) || ys.map(() => null),
    }));
    const head = ['연도', self ? self.nm : '선택 지역']
      .concat(cmp.map(c => (c.r ? c.r.nm : c.cd)))
      .concat(band && band.available ? ['시도 1분위', '시도 중위', '시도 3분위'] : []);

    const rows = ys.map((y, i) => {
      const row = [String(y), fmt(selfY[i])];
      cmp.forEach(c => row.push(fmt(c.y[i])));
      if (band && band.available) {
        row.push(fmt(band.q1[i]), fmt(band.med[i]), fmt(band.q3[i]));
      }
      return row;
    });
    drawTable($('#tblTrend'), head, rows, [0]);
    lastRender.trendTable = { head, rows };
  }

  function fmt(v) { return LF.formatNumber(v, state.unit); }

  // ── ② 구성 ───────────────────────────────────────────────
  function renderComp() {
    if (!agg) return;
    const comp = LF.composition(agg, M, state.region, state.year, state.accounts);
    if (!comp || !comp.total) {
      Plotly.purge($('#chartDonut')); Plotly.purge($('#chartParts'));
      $('#compHint').textContent = `${state.year}년 데이터가 없습니다.`;
      drawTable($('#tblComp'), [], []);
      return;
    }

    const focus = M.focus_fields;
    const focusTotals = focus.map(cd => comp.byField.get(cd) || 0);
    const others = comp.total - focusTotals.reduce((a, b) => a + b, 0);

    // 안쪽 고리 — 전체 세출 중 구성. '총예산 중' 이라는 요구가 여기 담긴다.
    const innerLabels = focus.map(cd => {
      const f = M._fieldByCd.get(cd);
      return f ? `${f.nm}(${cd})` : cd;
    }).concat(['그 외 분야']);
    const innerValues = focusTotals.concat([Math.max(others, 0)]);
    const innerColors = [C.f080[1], C.f090[1]].slice(0, focus.length).concat([C.other]);

    // 바깥 고리 — 부문별. 안쪽과 같은 순서로 두어야 방사 방향이 맞는다.
    const outerLabels = [], outerValues = [], outerColors = [];
    focus.forEach((fcd, fi) => {
      const palette = fi === 0 ? C.f080 : C.f090;
      const parts = (M._partsOfField.get(fcd) || [])
        .map(p => ({ p, v: (comp.byPart.get(p.cd) || { bdg: 0 }).bdg }))
        .filter(x => x.v > 0)
        .sort((a, b) => b.v - a.v);
      parts.forEach((x, i) => {
        outerLabels.push(`${x.p.nm}(${x.p.cd})`);
        outerValues.push(x.v);
        outerColors.push(palette[i % palette.length]);
      });
    });
    outerLabels.push('그 외 분야');
    outerValues.push(Math.max(others, 0));
    outerColors.push(C.other);

    const pct = v => (v / comp.total * 100);
    const hoverAbs = state.unit === 'percent' ? 'thousand' : state.unit;

    Plotly.react($('#chartDonut'), [
      {   // 바깥
        type: 'pie', labels: outerLabels, values: outerValues,
        hole: 0.62, domain: { x: [0, 1], y: [0, 1] },
        marker: { colors: outerColors, line: { color: css('--surface'), width: 1.5 } },
        textinfo: 'none', sort: false, direction: 'clockwise',
        hovertemplate: `%{label}<br>%{percent} · %{customdata} ${LF.UNITS[hoverAbs].label}<extra></extra>`,
        customdata: outerValues.map(v => LF.formatNumber(v / LF.UNITS[hoverAbs].divisor, hoverAbs)),
        name: '부문',
      },
      {   // 안쪽
        type: 'pie', labels: innerLabels, values: innerValues,
        hole: 0.34, domain: { x: [0.185, 0.815], y: [0.185, 0.815] },
        marker: { colors: innerColors, line: { color: css('--surface'), width: 1.5 } },
        // 조각을 따라 돌아가는 기본 글자 방향은 좁은 조각에서 읽기 어렵다.
        // 가로로 고정하고, 들어가지 않는 조각의 글자는 감춘다.
        textinfo: 'percent', textposition: 'inside',
        insidetextorientation: 'horizontal',
        insidetextfont: { size: 12, color: C.inside },
        automargin: true,
        sort: false, direction: 'clockwise',
        hovertemplate: `%{label}<br>%{percent} · %{customdata} ${LF.UNITS[hoverAbs].label}<extra></extra>`,
        customdata: innerValues.map(v => LF.formatNumber(v / LF.UNITS[hoverAbs].divisor, hoverAbs)),
        name: '분야',
      },
    ], baseLayout({
      showlegend: true,
      legend: { orientation: 'h', y: -0.05, font: { size: 10.5 } },
      margin: { l: 8, r: 8, t: 8, b: 8 },
    }), PLOT_CFG);

    // 막대 — 크기 순위. 도넛이 비중을 맡으므로 여기는 순위를 맡는다.
    const partRows = [];
    focus.forEach(fcd => {
      (M._partsOfField.get(fcd) || []).forEach(p => {
        const v = comp.byPart.get(p.cd);
        if (!v || !v.bdg) return;
        const nbiz = biz ? LF.bizCount(biz, {
          years: [state.year], parts: [p.cd], accounts: state.accounts,
        }) : null;
        partRows.push({
          cd: p.cd, nm: p.nm, fld: fcd, bdg: v.bdg, nbiz,
          share: pct(v.bdg),
          parentShare: (comp.byField.get(fcd) || 0)
            ? v.bdg / comp.byField.get(fcd) * 100 : null,
        });
      });
    });
    partRows.sort((a, b) => b.bdg - a.bdg);

    const isPct = state.unit === 'percent';
    const xs = partRows.map(r => isPct ? r.share : r.bdg / LF.UNITS[state.unit].divisor);
    const labels = partRows.map(r => `${r.nm}(${r.cd})`);

    Plotly.react($('#chartParts'), [{
      type: 'bar', orientation: 'h',
      x: xs.slice().reverse(), y: labels.slice().reverse(),
      marker: {
        color: partRows.slice().reverse().map(r =>
          r.fld === M.focus_fields[0] ? C.f080[1] : C.f090[1]),
      },
      text: partRows.slice().reverse().map(r =>
        r.nbiz != null ? `사업 ${r.nbiz.toLocaleString('ko-KR')}개` : ''),
      textposition: 'outside', textfont: { size: 10.5, color: css('--ink-3') },
      cliponaxis: false,
      customdata: partRows.slice().reverse().map(r => r.cd),
      hovertemplate: `%{y}<br>%{x:,.1f} ${isPct ? '%' : unitLabel()}<extra></extra>`,
    }], baseLayout({
      hovermode: 'closest',
      showlegend: false,
      margin: { l: 150, r: 80, t: 8, b: 40 },
      // 가로 막대라 값 축이 x다. 연도 축과 달리 여기에는 천단위 구분과
      // 약어 해제를 적용해야 한다 (연도 축에 걸면 2016 이 2,016 이 된다).
      xaxis: Object.assign(baseLayout().xaxis, {
        title: { text: isPct ? '전체 세출 대비 %' : unitLabel(), font: { size: 11.5 } },
        separatethousands: true, exponentformat: 'none', automargin: true,
      }),
      yaxis: { automargin: true, tickfont: { size: 11 } },
    }), PLOT_CFG);

    // 막대를 누르면 그 부문으로 좁힌 검색으로 넘어간다
    const gd = $('#chartParts');
    if (gd.removeAllListeners) gd.removeAllListeners('plotly_click');
    gd.on('plotly_click', ev => {
      if (!ev.points || !ev.points.length) return;
      const cd = ev.points[0].customdata;
      if (!cd) return;
      state.qPart = cd; state.qTerms = '';
      syncControls(); selectTab('search');
    });

    const focusSum = focusTotals.reduce((a, b) => a + b, 0);
    $('#compHint').textContent =
      `${state.year}년 전체 세출 ${LF.formatNumber(comp.total / 1e8, 'billion')} 억원 중 ` +
      `사회복지·보건이 ${(focusSum / comp.total * 100).toFixed(1)}% · ` +
      `${LF.formatNumber(focusSum / 1e8, 'billion')} 억원`;

    const head = ['부문', '코드', '예산(' + (isPct ? '%' : unitLabel()) + ')',
                  '전체 세출 대비 %', '상위 분야 대비 %', '사업 수'];
    const rows = partRows.map(r => [
      r.nm, r.cd,
      LF.formatNumber(isPct ? r.share : r.bdg / LF.UNITS[state.unit].divisor, state.unit),
      r.share.toFixed(2),
      r.parentShare != null ? r.parentShare.toFixed(2) : '—',
      r.nbiz != null ? r.nbiz.toLocaleString('ko-KR') : '—',
    ]);
    drawTable($('#tblComp'), head, rows, [0, 1]);
    lastRender.comp = { head, rows, comp, partRows };
  }

  // ── ③ 검색 ───────────────────────────────────────────────
  function renderSearch() {
    const sum = $('#searchSummary');
    if (!biz) {
      sum.innerHTML = '<p class="small">이 지자체의 세부사업 데이터를 불러오지 못했습니다.</p>';
      Plotly.purge($('#chartSearch'));
      drawTable($('#tblSearch'), [], []);
      return;
    }
    const terms = state.qTerms.split(/\s+/).filter(Boolean);
    const exclude = state.qExclude.split(/\s+/).filter(Boolean);
    const res = LF.search(biz, {
      terms, exclude, matchAll: state.qMode === 'all',
      parts: state.qPart ? [state.qPart] : null,
      accounts: state.accounts,
    });

    // 분모 — 현재 지자체의 080·090 전체
    const base = LF.search(biz, {
      terms: [], parts: state.qPart ? [state.qPart] : null, accounts: state.accounts,
    });
    const share = base.bdgSum ? res.bdgSum / base.bdgSum * 100 : null;

    const region = M._regionByCd.get(state.region);
    sum.innerHTML = `
      <div class="kpi"><span class="k">사업 수</span>
        <span class="v">${res.bizCount.toLocaleString('ko-KR')}</span>
        <span class="u">개 · 행 ${res.rowCount.toLocaleString('ko-KR')}건</span></div>
      <div class="kpi"><span class="k">예산 합계</span>
        <span class="v">${LF.formatNumber(res.bdgSum / LF.UNITS[state.unit === 'percent' ? 'thousand' : state.unit].divisor, state.unit === 'percent' ? 'thousand' : state.unit)}</span>
        <span class="u">${state.unit === 'percent' ? '천원' : unitLabel()} · 전 연도 합</span></div>
      <div class="kpi"><span class="k">검색 범위 대비</span>
        <span class="v">${share != null ? share.toFixed(1) : '—'}</span>
        <span class="u">% · ${state.qPart ? M._partByCd.get(state.qPart).nm : '사회복지·보건 전체'}</span></div>
      <div class="kpi"><span class="k">검색 범위</span>
        <span class="v" style="font-size:15px">${region ? region.nm : ''}</span>
        <span class="u">선택한 시군구 안에서만 검색합니다</span></div>`;

    const ys = years();
    const isPct = state.unit === 'percent';
    const yv = ys.map(y => {
      const v = res.byYear.get(y);
      if (v === undefined) return null;
      if (!isPct) return v / LF.UNITS[state.unit].divisor;
      const b = base.byYear.get(y);
      return b ? v / b * 100 : null;
    });

    Plotly.react($('#chartSearch'), [{
      x: ys, y: yv, type: 'scatter', mode: 'lines+markers',
      line: { color: C.self, width: 2.6 }, marker: { size: 6 },
      connectgaps: false, name: '검색 결과',
      hovertemplate: `%{y:,.1f}<extra></extra>`,
    }, {
      x: ys, y: ys.map(y => res.countByYear.get(y) ?? null),
      type: 'bar', yaxis: 'y2', name: '사업 수',
      marker: { color: C.median, opacity: .35 },
      hovertemplate: '사업 %{y:,}개<extra></extra>',
    }], baseLayout({
      yaxis: Object.assign(baseLayout().yaxis, {
        title: { text: isPct ? '검색 범위 대비 %' : unitLabel(), font: { size: 11.5 } },
        rangemode: 'tozero',
      }),
      yaxis2: {
        overlaying: 'y', side: 'right', showgrid: false, rangemode: 'tozero',
        automargin: true, exponentformat: 'none',
        title: { text: '사업 수', font: { size: 11.5 } }, tickfont: { color: css('--ink-3') },
      },
      xaxis: Object.assign(baseLayout().xaxis, { dtick: 1 }),
      margin: { l: 64, r: 60, t: 16, b: 48 },
    }), PLOT_CFG);

    // 목록 — 사업 단위로 접어서 보여준다. 행을 그대로 늘어놓으면
    // 같은 사업이 회계·연도별로 여러 번 나와 읽기 어렵다.
    const byBiz = new Map();
    res.rows.forEach(i => {
      const key = biz.bc[i];
      let e = byBiz.get(key);
      if (!e) {
        e = { name: biz.names[biz.nm[i]], code: biz.codes[key],
              part: biz.parts[biz.p[i]], bdg: 0, exec: 0, years: new Set() };
        byBiz.set(key, e);
      }
      e.bdg += biz.bdg[i];
      if (biz.exec) e.exec += biz.exec[i];
      e.years.add(biz.y[i]);
    });
    const list = [...byBiz.values()].sort((a, b) => b.bdg - a.bdg);
    const unitForList = isPct ? 'thousand' : state.unit;

    const head = ['세부사업명', '부문', `예산 합계(${LF.UNITS[unitForList].label})`,
                  '집행률', '연도', '사업코드'];
    const rows = list.slice(0, 500).map(e => {
      const p = M._partByCd.get(e.part);
      const yl = [...e.years].sort();
      return [
        e.name, p ? p.nm : e.part,
        LF.formatNumber(e.bdg / LF.UNITS[unitForList].divisor, unitForList),
        e.bdg && e.exec ? (e.exec / e.bdg * 100).toFixed(1) + '%' : '—',
        yl.length > 2 ? `${yl[0]}–${yl[yl.length - 1]} (${yl.length})` : yl.join(', '),
        e.code,
      ];
    });
    drawTable($('#tblSearch'), head, rows, [0, 1, 4, 5]);
    $('#searchNote').textContent = list.length > 500
      ? `상위 500개만 표시합니다 (전체 ${list.length.toLocaleString('ko-KR')}개). 엑셀에는 전부 담깁니다.`
      : '';
    lastRender.search = { head, rows, list, res, base, unitForList };
  }

  // ── 표 ───────────────────────────────────────────────────
  function drawTable(table, head, rows, textCols) {
    const tc = new Set(textCols || []);
    if (!head.length) { table.innerHTML = ''; return; }
    table.innerHTML =
      '<thead><tr>' + head.map((h, i) =>
        `<th class="${tc.has(i) ? '' : 'n'}">${h}</th>`).join('') + '</tr></thead>' +
      '<tbody>' + rows.map(r => '<tr>' + r.map((c, i) =>
        `<td class="${tc.has(i) ? (i === 0 ? 'name' : '') : 'n'}">${escapeHtml(c)}</td>`
      ).join('') + '</tr>').join('') + '</tbody>';
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, m =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]));
  }

  // ── 하단 출처 ────────────────────────────────────────────
  function renderFooter() {
    const done = M.years.filter(y => y.completeness != null && y.completeness < 1);
    $('#footSource').innerHTML =
      `출처 ${escapeHtml(M.source.api)} · ${escapeHtml(M.source.basis)} · ` +
      `데이터 생성 ${escapeHtml(M.built_at)} · ` +
      `연도 ${M.years[0].y}–${M.years[M.years.length - 1].y} · ` +
      `자치단체 ${M.regions.length.toLocaleString('ko-KR')}곳<br>` +
      `<span class="small">${escapeHtml(M.source.note || '')}</span>`;
    const warns = (M.warnings || []).slice();
    if (done.length) {
      warns.push(`수집률이 100% 미만인 연도: ` +
        done.map(y => `${y.y}년 ${(y.completeness * 100).toFixed(2)}%`).join(', '));
    }
    $('#footWarn').textContent = warns.join(' / ');
  }

  // ── 내보내기 ─────────────────────────────────────────────
  function exportContext() {
    return {
      regionLabel: (() => {
        const r = M._regionByCd.get(state.region);
        const s = M._sidoByCd.get(state.sido);
        return `${s ? s.nm : ''} ${r ? r.nm : state.region}`.trim();
      })(),
      compareLabels: state.compare.map(cd => {
        const r = M._regionByCd.get(cd); return r ? r.nm : cd;
      }),
      yearLabel: `${M.years[0].y}–${M.years[M.years.length - 1].y}`,
      scopeLabel: scopeLabel(),
      accountLabel: accountLabel(),
      unitLabel: unitLabel(),
      denominatorLabel: state.unit === 'percent'
        ? LF.denominatorLabel(M, selection()) : null,
      source: M.source.api,
      basis: M.source.basis,
      builtAt: M.built_at,
      completeness: M.years.map(y => ({
        y: y.y, rows: y.rows, total: y.rows != null && y.missing != null
          ? y.rows + y.missing : null, rate: y.completeness,
      })),
      warnings: M.warnings || [],
    };
  }

  function sheetFrom(head, rows) {
    return [head].concat(rows.map(r => r.map(c => {
      // 표에 넣을 때 서식을 입혔던 숫자를 되돌려 엑셀에서 계산 가능하게 한다
      if (typeof c === 'string' && /^-?[\d,]+(\.\d+)?$/.test(c)) {
        const n = Number(c.replace(/,/g, ''));
        if (isFinite(n)) return n;
      }
      return c;
    })));
  }

  function doExportXlsx(which) {
    const ctx = exportContext();
    const sheets = [XLSXOut.conditionSheet(ctx)];
    const base = ctx.regionLabel.replace(/\s+/g, '_');

    if (which === 'trend' || which === 'trendTable') {
      const t = lastRender.trendTable;
      if (t) sheets.push({ name: '연도별 추이', rows: sheetFrom(t.head, t.rows) });
      const b = lastRender.trend && lastRender.trend.band;
      if (b && b.available) {
        sheets.push({
          name: '시도 분포',
          rows: [['연도', '1분위', '중위', '3분위', '모집단 수']].concat(
            lastRender.trend.years.map((y, i) =>
              [y, b.q1[i], b.med[i], b.q3[i], b.counts[i]])),
        });
      }
    } else if (which === 'count') {
      const c = lastRender.count;
      if (c) sheets.push({
        name: '사업 수',
        rows: [['연도', '사업 수', '예산(원)', `사업당 평균(${c.avgLabel})`]].concat(
          c.years.map((y, i) => [y, c.counts[i], c.budgets[i], c.avg[i]])),
      });
    } else if (which === 'comp') {
      const c = lastRender.comp;
      if (c) {
        sheets.push({ name: `${state.year}년 부문별`, rows: sheetFrom(c.head, c.rows) });
        sheets.push({
          name: `${state.year}년 분야별`,
          rows: [['분야코드', '분야명', '예산(원)', '전체 대비 %']].concat(
            [...c.comp.byField.entries()].sort((a, b) => b[1] - a[1]).map(([cd, v]) => {
              const f = M._fieldByCd.get(cd);
              return [cd, f ? f.nm : cd, v, (v / c.comp.total * 100)];
            })),
        });
      }
    } else if (which === 'search') {
      const s = lastRender.search;
      if (s) {
        // 화면은 500개까지만 보여주지만 엑셀에는 전부 넣는다
        const all = s.list.map(e => {
          const p = M._partByCd.get(e.part);
          const yl = [...e.years].sort();
          return [e.name, p ? p.nm : e.part,
                  e.bdg / LF.UNITS[s.unitForList].divisor,
                  e.bdg && e.exec ? e.exec / e.bdg * 100 : null,
                  yl.join(' '), e.code];
        });
        sheets.push({ name: '사업 목록', rows: [s.head].concat(all) });
        sheets.push({
          name: '검색 조건',
          rows: [['항목', '값'],
                 ['검색어', state.qTerms || '(없음)'],
                 ['제외어', state.qExclude || '(없음)'],
                 ['여러 단어', state.qMode === 'all' ? '모두 포함' : '하나라도 포함'],
                 ['부문', state.qPart ? M._partByCd.get(state.qPart).nm : '전체'],
                 ['검색 범위', ctx.regionLabel],
                 ['사업 수', s.res.bizCount],
                 ['예산 합계(원)', s.res.bdgSum]],
        });
      }
    }
    XLSXOut.download(sheets, `지방재정_${base}_${which}`);
  }

  const CHART_OF = {
    trend: '#chartTrend', count: '#chartCount',
    donut: '#chartDonut', parts: '#chartParts', search: '#chartSearch',
  };

  function doExportImage(which) {
    const el = $(CHART_OF[which]);
    if (!el || !el.data) return;
    const r = M._regionByCd.get(state.region);
    XLSXOut.downloadImage(el, `지방재정_${(r ? r.nm : '')}_${which}`, 'png');
  }

  // ── 탭 ───────────────────────────────────────────────────
  function selectTab(tab) {
    state.tab = tab;
    $$('.tabs button').forEach(b =>
      b.setAttribute('aria-selected', String(b.dataset.tab === tab)));
    $$('.panel').forEach(p => { p.hidden = p.id !== `panel-${tab}`; });
    writeHash();
    render();
  }

  function render() {
    if (!agg) return;
    C = palette();          // 테마 전환을 반영한다
    if (state.tab === 'trend') renderTrend();
    else if (state.tab === 'comp') renderComp();
    else renderSearch();
  }

  // ── 이벤트 ───────────────────────────────────────────────
  let searchTimer = null;

  function bindEvents() {
    $('#selSido').addEventListener('change', async e => {
      state.sido = e.target.value;
      const pool = (M._regionsOfSido.get(state.sido) || []).filter(r => !r.head);
      state.region = (pool[0] || M.regions[0]).cd;
      syncControls(); writeHash();
      await loadRegionData(); render();
    });

    $('#selRegion').addEventListener('change', async e => {
      state.region = e.target.value;
      writeHash();
      await loadRegionData(); render();
    });

    $('#selAccount').addEventListener('change', e => {
      state.accounts = e.target.value ? [e.target.value] : [];
      writeHash(); render();
    });

    $('#unitGroup').addEventListener('click', e => {
      const b = e.target.closest('button[data-unit]');
      if (!b) return;
      state.unit = b.dataset.unit;
      syncControls(); writeHash(); render();
    });

    $('#fieldChecks').addEventListener('change', () => {
      const picked = $$('#fieldChecks input:checked').map(i => i.value);
      if (!picked.length) { syncControls(); return; }   // 전부 해제는 막는다
      state.fields = picked;
      // 고른 분야에 속하지 않는 부문이 선택돼 있으면 푼다
      if (state.part) {
        const p = M._partByCd.get(state.part);
        if (p && !picked.includes(p.fld)) state.part = '';
      }
      syncControls(); writeHash(); render();
    });

    $('#selPart').addEventListener('change', e => {
      state.part = e.target.value;
      // 부문을 고르면 상위 분야로 자동으로 좁힌다. 그래야 비중의 분모가 맞는다.
      if (state.part) {
        const p = M._partByCd.get(state.part);
        if (p) state.fields = [p.fld];
      }
      syncControls(); writeHash(); render();
    });

    $('#selCompare').addEventListener('change', async e => {
      const cd = e.target.value;
      e.target.value = '';
      if (!cd || state.compare.includes(cd) || cd === state.region) return;
      if (state.compare.length >= 3) return;
      state.compare.push(cd);
      const r = M._regionByCd.get(cd);
      if (r && r.sido !== state.sido) {
        try { await ensureAgg(r.sido); } catch (err) { /* 그 계열은 그리지 않는다 */ }
      }
      renderCompareChips(); writeHash(); render();
    });

    $('#compareChips').addEventListener('click', e => {
      const b = e.target.closest('button[data-drop]');
      if (!b) return;
      state.compare = state.compare.filter(c => c !== b.dataset.drop);
      renderCompareChips(); writeHash(); render();
    });

    $('#chkBand').addEventListener('change', e => {
      state.band = e.target.checked;
      writeHash(); render();
    });

    $('#selYear').addEventListener('change', e => {
      state.year = parseInt(e.target.value, 10);
      writeHash(); render();
    });

    // 검색은 입력마다 다시 계산하되 디바운스를 건다
    ['#qTerms', '#qExclude'].forEach(sel => {
      $(sel).addEventListener('input', e => {
        const key = sel === '#qTerms' ? 'qTerms' : 'qExclude';
        state[key] = e.target.value;
        clearTimeout(searchTimer);
        searchTimer = setTimeout(() => { writeHash(); renderSearch(); }, 180);
      });
    });
    $('#qMode').addEventListener('change', e => { state.qMode = e.target.value; renderSearch(); });
    $('#qPart').addEventListener('change', e => { state.qPart = e.target.value; renderSearch(); });

    $$('.tabs button').forEach(b =>
      b.addEventListener('click', () => selectTab(b.dataset.tab)));

    document.addEventListener('click', e => {
      const x = e.target.closest('[data-export-x]');
      if (x) { doExportXlsx(x.dataset.exportX); return; }
      const i = e.target.closest('[data-export-i]');
      if (i) { doExportImage(i.dataset.exportI); }
    });

    // 테마가 바뀌면 차트 색도 따라가야 한다
    if (window.matchMedia) {
      window.matchMedia('(prefers-color-scheme: dark)')
        .addEventListener('change', () => render());
    }
  }

  document.addEventListener('DOMContentLoaded', init);
})();
