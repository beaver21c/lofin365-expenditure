/*
 * map.js — 코로플레스 지도.
 *
 * Plotly 의 basic 번들에는 지도 trace 가 없다(scatter·bar·pie 뿐). 전체 번들을
 * 받아오는 대신 SVG 로 직접 그린다. 배경 타일이 필요 없는 단색 면 지도라
 * 라이브러리가 하는 일이 많지 않고, 외부 의존을 늘리지 않는 편이 낫다.
 * 테마 색을 그대로 쓰고 이미지로 내보내기도 쉬워진다.
 *
 * 경계 코드와 지방재정365 코드는 체계가 달라 직접 이을 수 없다.
 * scripts/build_geo.py 가 만든 crosswalk.json 을 거쳐 결합한다.
 */
(function (global) {
  'use strict';

  const MAP = {};
  const cache = { topo: new Map(), cross: null };

  async function getJSON(url) {
    const r = await fetch(url, { cache: 'no-cache' });
    if (!r.ok) { const e = new Error(`${url} (HTTP ${r.status})`); e.status = r.status; throw e; }
    return r.json();
  }

  MAP.loadCrosswalk = async function () {
    if (cache.cross) return cache.cross;
    cache.cross = await getJSON('data/geo/crosswalk.json');
    return cache.cross;
  };

  MAP.loadTopo = async function (which) {
    if (cache.topo.has(which)) return cache.topo.get(which);
    const t = decode(await getJSON(`data/geo/${which}.topojson`));
    cache.topo.set(which, t);
    return t;
  };

  // ── TopoJSON 디코딩 ──────────────────────────────────────
  // 양자화된 좌표(정수 델타)를 실제 위경도로 되돌린다.
  function decode(topo) {
    const { scale, translate } = topo.transform || { scale: [1, 1], translate: [0, 0] };
    const arcs = topo.arcs.map(arc => {
      let x = 0, y = 0;
      return arc.map(([dx, dy]) => {
        x += dx; y += dy;
        return topo.transform
          ? [x * scale[0] + translate[0], y * scale[1] + translate[1]]
          : [dx, dy];
      });
    });

    const objName = Object.keys(topo.objects)[0];
    const features = topo.objects[objName].geometries.map(g => ({
      properties: g.properties || {},
      rings: geomRings(g, arcs),
    }));
    return { features };
  }

  function arcPoints(arcs, i) {
    // 음수 색인은 그 호를 뒤집어 쓰라는 뜻이다 (~i 번째를 역순으로)
    return i < 0 ? arcs[~i].slice().reverse() : arcs[i];
  }

  function ringPoints(arcs, ringIdx) {
    const pts = [];
    ringIdx.forEach((ai, k) => {
      const seg = arcPoints(arcs, ai);
      // 이어 붙일 때 첫 점이 겹치므로 두 번째부터 넣는다
      for (let j = k === 0 ? 0 : 1; j < seg.length; j++) pts.push(seg[j]);
    });
    return pts;
  }

  function geomRings(g, arcs) {
    if (g.type === 'Polygon') return g.arcs.map(r => ringPoints(arcs, r));
    if (g.type === 'MultiPolygon') return g.arcs.flatMap(p => p.map(r => ringPoints(arcs, r)));
    return [];
  }

  // ── 투영 ────────────────────────────────────────────────
  // 남한은 위도 범위가 좁아 정교한 투영이 필요 없다. 경도에 cos(위도)를
  // 곱해 가로 비율만 바로잡으면 눈에 거슬리지 않는다.
  function bounds(featureList) {
    let minX = 180, maxX = -180, minY = 90, maxY = -90;
    featureList.forEach(f => f.rings.forEach(r => r.forEach(([x, y]) => {
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (y < minY) minY = y; if (y > maxY) maxY = y;
    })));
    const k = Math.cos(((minY + maxY) / 2) * Math.PI / 180);
    return { minX, maxX, minY, maxY, k, w: (maxX - minX) * k, h: maxY - minY };
  }

  function makeProjection(bb, width, height, pad) {
    if (!(bb.w > 0 && bb.h > 0)) return null;
    const s = Math.min((width - pad * 2) / bb.w, (height - pad * 2) / bb.h);
    const offX = (width - bb.w * s) / 2, offY = (height - bb.h * s) / 2;
    return ([x, y]) => [
      (x - bb.minX) * bb.k * s + offX,
      (bb.maxY - y) * s + offY,       // 화면 y는 아래로 증가
    ];
  }

  function ringPath(ring, proj) {
    let d = '';
    for (let i = 0; i < ring.length; i++) {
      const [x, y] = proj(ring[i]);
      d += (i ? 'L' : 'M') + x.toFixed(1) + ' ' + y.toFixed(1);
    }
    return d + 'Z';
  }

  // ── 색 ──────────────────────────────────────────────────
  // 순차 팔레트. 값이 클수록 진해진다. 밝은 테마와 어두운 테마에서
  // 각각 대비가 살아 있는 두 벌을 둔다.
  const RAMP_LIGHT = ['#EDF3F8', '#CFE0EC', '#A8C6DD', '#7FA9CA', '#5589B3', '#31688F', '#1B4A6B'];
  const RAMP_DARK  = ['#1B2733', '#22384A', '#2C4E67', '#3A6A8B', '#4E8CB0', '#6BAAC9', '#8FC6DF'];

  function quantileBreaks(values, n) {
    const v = values.filter(x => x != null && isFinite(x)).sort((a, b) => a - b);
    if (!v.length) return [];
    const out = [];
    for (let i = 1; i < n; i++) out.push(v[Math.floor(v.length * i / n)]);
    return out;
  }

  function colorOf(value, breaks, ramp) {
    if (value == null || !isFinite(value)) return null;
    let i = 0;
    while (i < breaks.length && value >= breaks[i]) i++;
    return ramp[Math.min(i, ramp.length - 1)];
  }

  // ── 렌더 ────────────────────────────────────────────────
  /**
   * @param el       그릴 컨테이너
   * @param opts     {
   *   topo, crosswalk, scope: 'nation'|'sido', sidoGeo,
   *   values: Map<lafCd, number>, labels: Map<lafCd, string>,
   *   selected: lafCd, unitLabel, theme, onPick(lafCd)
   * }
   */
  MAP.render = function (el, opts) {
    const { topo, crosswalk, values, labels, selected, unitLabel, onPick } = opts;
    const dark = opts.theme === 'dark';
    const ramp = dark ? RAMP_DARK : RAMP_LIGHT;

    // 이 화면에 그릴 경계만 고른다
    let feats = topo.features;
    if (opts.scope === 'sido' && opts.sidoGeo) {
      feats = feats.filter(f => String(f.properties.sido_cd) === String(opts.sidoGeo));
    }
    if (!feats.length) { el.innerHTML = ''; return { drawn: 0 }; }

    // 경계 sgg 코드 → 재정 자치단체 코드
    const sggToLaf = new Map();
    Object.entries(crosswalk.region || {}).forEach(([laf, v]) => {
      (v.sgg || []).forEach(s => sggToLaf.set(String(s), laf));
    });

    // 높이는 지역의 실제 가로세로 비에서 낸다. 고정 비율로 두면 서울처럼
    // 옆으로 넓은 곳에서 위아래 여백만 잔뜩 생긴다.
    const W = Math.max(el.clientWidth || 640, 320);
    const bb = bounds(feats);
    const pad = 12;
    const H = Math.min(Math.max(Math.round((W - pad * 2) * (bb.h / bb.w) + pad * 2), 260), 720);
    const proj = makeProjection(bb, W, H, pad);
    if (!proj) { el.innerHTML = ''; return { drawn: 0 }; }

    const vals = [];
    feats.forEach(f => {
      const laf = sggToLaf.get(String(f.properties.sgg_cd));
      const v = laf != null ? values.get(laf) : undefined;
      if (v != null && isFinite(v)) vals.push(v);
    });
    const breaks = quantileBreaks(vals, ramp.length);

    const stroke = dark ? '#0E141B' : '#FFFFFF';
    const noData = dark ? '#2B3644' : '#E7EAEE';
    const selStroke = dark ? '#F0C46B' : '#14324F';

    const parts = [
      `<svg viewBox="0 0 ${W} ${H}" width="100%" height="${H}" role="img" `
      + `aria-label="시군구별 코로플레스 지도" class="choropleth">`,
    ];
    let drawn = 0, matched = 0;
    let selPath = '';

    feats.forEach(f => {
      const sgg = String(f.properties.sgg_cd);
      const laf = sggToLaf.get(sgg);
      const v = laf != null ? values.get(laf) : undefined;
      const fill = colorOf(v, breaks, ramp) || noData;
      const d = f.rings.map(r => ringPath(r, proj)).join('');
      if (!d) return;
      drawn++;
      if (v != null) matched++;
      const nm = (laf && labels.get(laf)) || f.properties.sggnm || '';
      const txt = v == null ? '자료 없음'
        : `${v.toLocaleString('ko-KR', { maximumFractionDigits: 1 })} ${unitLabel}`;
      const isSel = laf && laf === selected;
      const cls = 'rg' + (isSel ? ' sel' : '') + (laf ? ' has' : '');
      const el1 = `<path class="${cls}" d="${d}" fill="${fill}" stroke="${stroke}" `
        + `stroke-width="0.6" data-laf="${laf || ''}" `
        + `><title>${esc(nm)}\n${esc(txt)}</title></path>`;
      if (isSel) selPath = `<path class="rg selring" d="${d}" fill="none" `
        + `stroke="${selStroke}" stroke-width="2.4" pointer-events="none"></path>`;
      parts.push(el1);
    });

    // 선택 지역 테두리는 맨 위에 다시 그려 다른 면에 가리지 않게 한다
    if (selPath) parts.push(selPath);
    parts.push('</svg>');
    el.innerHTML = parts.join('');

    if (onPick) {
      el.querySelectorAll('path.rg.has').forEach(p => {
        p.addEventListener('click', () => {
          const laf = p.getAttribute('data-laf');
          if (laf) onPick(laf);
        });
      });
    }
    return { drawn, matched, breaks, ramp, noData };
  };

  /** 범례. 구간 색과 경계값을 함께 보여준다. */
  MAP.legend = function (el, info, unitLabel) {
    if (!info || !info.ramp) { el.innerHTML = ''; return; }
    const { breaks, ramp, noData } = info;
    const fmt = v => v == null ? ''
      : v.toLocaleString('ko-KR', { maximumFractionDigits: 1 });
    const cells = ramp.map((c, i) => {
      const lo = i === 0 ? null : breaks[i - 1];
      const hi = i < breaks.length ? breaks[i] : null;
      const label = lo == null ? `~${fmt(hi)}`
        : hi == null ? `${fmt(lo)}~` : `${fmt(lo)}~`;
      return `<span class="lg"><i style="background:${c}"></i>${label}</span>`;
    }).join('');
    el.innerHTML = cells
      + `<span class="lg"><i style="background:${noData}"></i>자료 없음</span>`
      + `<span class="lgu">${esc(unitLabel)}</span>`;
  };

  function esc(s) {
    return String(s).replace(/[&<>"]/g, m =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[m]));
  }

  /** SVG 를 PNG 로 저장. Plotly 를 거치지 않으므로 직접 그린다. */
  MAP.downloadImage = function (el, filename) {
    const svg = el.querySelector('svg');
    if (!svg) return;
    const vb = svg.getAttribute('viewBox').split(/\s+/).map(Number);
    const w = vb[2], h = vb[3], scale = 3;
    const bg = getComputedStyle(document.body).backgroundColor || '#fff';
    const blob = new Blob(
      ['<?xml version="1.0" encoding="UTF-8"?>',
       svg.outerHTML.replace('<svg', '<svg xmlns="http://www.w3.org/2000/svg"')],
      { type: 'image/svg+xml;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => {
      const cv = document.createElement('canvas');
      cv.width = w * scale; cv.height = h * scale;
      const ctx = cv.getContext('2d');
      ctx.fillStyle = bg; ctx.fillRect(0, 0, cv.width, cv.height);
      ctx.drawImage(img, 0, 0, cv.width, cv.height);
      URL.revokeObjectURL(url);
      cv.toBlob(b => {
        const a = document.createElement('a');
        a.href = URL.createObjectURL(b);
        a.download = filename.endsWith('.png') ? filename : filename + '.png';
        document.body.appendChild(a); a.click(); a.remove();
        setTimeout(() => URL.revokeObjectURL(a.href), 1000);
      }, 'image/png');
    };
    img.onerror = () => URL.revokeObjectURL(url);
    img.src = url;
  };

  global.LFMap = MAP;
})(window);
