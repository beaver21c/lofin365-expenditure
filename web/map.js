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
 *
 * 그리는 단위는 '경계 도형' 이 아니라 '예산이 잡히는 자치단체' 다.
 * 용인시는 경계상 3개 구지만 예산은 하나뿐이라, 셋을 묶어 한 덩어리로
 * 그린다. 안 묶으면 같은 값이 세 번 칠해지고 이름도 세 번 붙는다.
 */
(function (global) {
  'use strict';

  const MAP = {};
  const cache = { topo: new Map(), cross: null };

  // 확대 한계. 1 은 '전체가 화면에 들어온 상태' 이므로 그보다 작게는 줄이지
  // 않는다. 위쪽은 시군구 하나가 화면을 채울 정도면 충분하다.
  const MIN_Z = 1, MAX_Z = 14;

  // 전국 지도에서 이 배율 아래로는 지역명을 아예 띄우지 않는다.
  // 자리 여부만 따지면 넓은 군 몇 곳(강원·경북)만 이름이 붙어, 지도가
  // 아니라 그 지역만 강조한 그림처럼 보인다.
  const NATION_LABEL_Z = 1.6;

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
  //
  // 호(arc) 색인도 함께 남긴다. 맞닿은 두 도형은 같은 호를 공유하므로,
  // 한 덩어리 안에서 두 번 나오는 호가 곧 '안쪽 경계' 다. 이것을 빼면
  // 도형을 실제로 합치는 계산 없이도 내부 선을 지울 수 있다.
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
      arcIdx: geomArcs(g),
    }));
    return { features, arcs };
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

  /** 이 도형이 쓰는 호 번호. 방향은 지우고 중복도 없앤다. */
  function geomArcs(g) {
    const rings = g.type === 'Polygon' ? g.arcs
      : g.type === 'MultiPolygon' ? g.arcs.flat() : [];
    const s = new Set();
    rings.forEach(r => r.forEach(a => s.add(a < 0 ? ~a : a)));
    return Array.from(s);
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

  /**
   * 라벨을 놓을 자리. 가장 큰 고리의 면적 가중 중심을 쓴다.
   * 오목한 모양에서는 중심이 도형 밖으로 나갈 수 있지만, 시군구는
   * 대체로 뭉툭해서 이 정도로 충분하다. 함께 돌려주는 폭·높이로
   * 글자가 들어갈 자리가 있는지 판단한다.
   *
   * 여러 도형을 묶은 자치단체라면 그중 가장 큰 고리 하나가 기준이 된다.
   * 본토와 부속 섬을 함께 가진 곳에서 이름이 섬에 붙는 일을 막아 준다.
   */
  function labelAnchor(rings, proj) {
    let best = null, bestArea = -1;
    rings.forEach(r => {
      if (r.length < 3) return;
      let a = 0;
      for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
        a += r[j][0] * r[i][1] - r[i][0] * r[j][1];
      }
      a = Math.abs(a) / 2;
      if (a > bestArea) { bestArea = a; best = r; }
    });
    if (!best) return null;

    let cx = 0, cy = 0, area = 0;
    for (let i = 0, j = best.length - 1; i < best.length; j = i++) {
      const f = best[j][0] * best[i][1] - best[i][0] * best[j][1];
      area += f;
      cx += (best[j][0] + best[i][0]) * f;
      cy += (best[j][1] + best[i][1]) * f;
    }
    let pt;
    if (Math.abs(area) < 1e-12) {
      pt = best[Math.floor(best.length / 2)];
    } else {
      area *= 3;
      pt = [cx / area, cy / area];
    }

    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    best.forEach(p => {
      const [x, y] = proj(p);
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (y < minY) minY = y; if (y > maxY) maxY = y;
    });
    const [px, py] = proj(pt);
    return { x: px, y: py, w: maxX - minX, h: maxY - minY };
  }

  function ringPath(ring, proj) {
    let d = '';
    for (let i = 0; i < ring.length; i++) {
      const [x, y] = proj(ring[i]);
      d += (i ? 'L' : 'M') + x.toFixed(1) + ' ' + y.toFixed(1);
    }
    return d + 'Z';
  }

  /** 덩어리의 바깥 테두리. 안쪽에서 두 번 쓰인 호는 뺀다. */
  function outlinePath(arcCount, arcs, proj) {
    let d = '';
    arcCount.forEach((n, i) => {
      if (n > 1) return;                 // 같은 자치단체 안쪽 경계
      const seg = arcs[i];
      for (let k = 0; k < seg.length; k++) {
        const [x, y] = proj(seg[k]);
        d += (k ? 'L' : 'M') + x.toFixed(1) + ' ' + y.toFixed(1);
      }
    });
    return d;
  }

  // ── 색 ──────────────────────────────────────────────────
  // 순차 팔레트. 값이 클수록 진해진다. 밝은 테마와 어두운 테마에서
  // 각각 대비가 살아 있는 두 벌을 둔다.
  const RAMP_LIGHT = ['#EDF3F8', '#CFE0EC', '#A8C6DD', '#7FA9CA', '#5589B3', '#31688F', '#1B4A6B'];
  const RAMP_DARK  = ['#1B2733', '#22384A', '#2C4E67', '#3A6A8B', '#4E8CB0', '#6BAAC9', '#8FC6DF'];

  /**
   * 값들을 분위로 나눈다. 팔레트 칸수만큼 나누되, **경계가 겹치면 버린다.**
   *
   * 제주처럼 면이 하나뿐인 지도에서 그냥 7등분하면 경계값이 전부 같아져
   * 범례에 같은 숫자가 일곱 번 늘어선다. 구간이 있는 척하는 그림이 된다.
   * 서로 다른 경계만 남기고 색도 그만큼만 쓴다.
   *
   * 돌려주는 idx 는 원래 팔레트에서의 자리다. 글자색을 뒤집을지 판단할 때
   * 칸수가 아니라 색의 진하기를 봐야 하므로 이 값이 필요하다.
   */
  function classify(values, ramp) {
    const v = values.filter(x => x != null && isFinite(x)).sort((a, b) => a - b);
    if (!v.length) return { breaks: [], colors: [], idx: [], min: null, max: null };
    const breaks = [];
    for (let i = 1; i < ramp.length; i++) {
      const b = v[Math.floor(v.length * i / ramp.length)];
      if (b > v[0] && (!breaks.length || b > breaks[breaks.length - 1])) breaks.push(b);
    }
    const k = breaks.length + 1;
    // 한 칸뿐이면 팔레트 가운데보다 살짝 연한 색. 밝은 테마에서도 어두운
    // 테마에서도 글자가 얹히는 색이다.
    const idx = k === 1 ? [2]
      : Array.from({ length: k }, (_, i) => Math.round(i * (ramp.length - 1) / (k - 1)));
    return { breaks, colors: idx.map(i => ramp[i]), idx,
             min: v[0], max: v[v.length - 1] };
  }

  function rampIndex(value, breaks, colors) {
    if (value == null || !isFinite(value)) return -1;
    let i = 0;
    while (i < breaks.length && value >= breaks[i]) i++;
    return Math.min(i, colors.length - 1);
  }

  // ── 확대·이동 ───────────────────────────────────────────
  // 도형은 <g> 하나에 담아 transform 으로 옮기고 키운다. 다시 그리지
  // 않으므로 휠을 굴려도 끊기지 않는다.
  //
  // 반면 글자는 확대에 딸려 커지면 안 된다. 라벨은 변환 밖 층에 두고
  // 배율이 바뀔 때마다 자리만 다시 계산한다. 넓어진 면에 새 이름이
  // 들어가는 것도 이 재계산에서 일어난다.
  function clampView(V) {
    V.z = Math.min(Math.max(V.z, MIN_Z), MAX_Z);
    V.tx = Math.min(0, Math.max(V.W - V.W * V.z, V.tx));
    V.ty = Math.min(0, Math.max(V.H - V.H * V.z, V.ty));
    return V;
  }

  function applyView(st) {
    const V = st.view;
    clampView(V);
    st.shapes.setAttribute(
      'transform',
      `translate(${V.tx.toFixed(2)} ${V.ty.toFixed(2)}) scale(${V.z.toFixed(4)})`);
    // 선 굵기는 화면 기준으로 일정하게 — 확대했다고 국경이 굵어지면
    // 좁은 자치구가 선에 먹힌다.
    const sw = (0.6 / V.z).toFixed(3);
    st.strokeNodes.forEach(n => n.setAttribute('stroke-width', sw));
    if (st.selNode) st.selNode.setAttribute('stroke-width', (2.4 / V.z).toFixed(3));
    st.el.classList.toggle('zoomed', V.z > MIN_Z + 1e-6);
    const lab = layoutLabels(st);
    st.stat.zoom = V.z;
    st.stat.labelled = lab.labelled;
    st.stat.tooSmall = lab.tooSmall;
    st.stat.gated = lab.gated;
    st.stat.canZoomIn = V.z < MAX_Z - 1e-6;
    st.stat.canZoomOut = V.z > MIN_Z + 1e-6;
    if (st.onView) st.onView(st.stat);
  }

  function layoutLabels(st) {
    const V = st.view, layer = st.labelLayer;
    if (st.mode === 'none') { layer.innerHTML = ''; return { labelled: 0, tooSmall: 0, gated: false }; }
    if (V.z < st.labelZ) {
      layer.innerHTML = '';
      return { labelled: 0, tooSmall: 0, gated: true };
    }

    const fs = 10.5;
    let labelled = 0, tooSmall = 0;
    const out = [];
    st.items.forEach(it => {
      const a = it.a;
      if (!a) return;
      const x = a.x * V.z + V.tx, y = a.y * V.z + V.ty;
      // 화면 밖은 세지도 그리지도 않는다. 확대해서 밀려난 것을
      // '자리가 좁아 생략' 이라고 알리면 거짓말이 된다.
      if (x < -60 || x > V.W + 60 || y < -30 || y > V.H + 30) return;
      const need = it.short.length * fs * 0.98;
      if (a.w * V.z < need || a.h * V.z < (it.line2 ? fs * 2.4 : fs * 1.5)) { tooSmall++; return; }
      labelled++;
      const dy = it.line2 ? -1 : 3.5;
      out.push(
        `<text class="lbl" x="${x.toFixed(1)}" y="${(y + dy).toFixed(1)}"`
        + ` text-anchor="middle" font-size="${fs}" fill="${it.ink}"`
        + ` stroke="${it.halo}" stroke-width="2.6" paint-order="stroke"`
        + ` pointer-events="none">${esc(it.short)}`
        + (it.line2 ? `<tspan x="${x.toFixed(1)}" dy="${fs + 1.5}"`
            + ` font-size="${fs - 0.8}">${esc(it.line2)}</tspan>` : '')
        + '</text>');
    });
    layer.innerHTML = out.join('');
    return { labelled, tooSmall, gated: false };
  }

  /** 컨테이너 좌표 → SVG 내부 좌표. 폭이 달라도 어긋나지 않게 실측으로 낸다. */
  function toSvg(st, ev) {
    const r = st.el.getBoundingClientRect();
    if (!r.width || !r.height) return [st.view.W / 2, st.view.H / 2];
    return [(ev.clientX - r.left) * (st.view.W / r.width),
            (ev.clientY - r.top) * (st.view.H / r.height)];
  }

  function zoomAt(st, factor, px, py) {
    const V = st.view;
    const z0 = V.z;
    const z1 = Math.min(Math.max(z0 * factor, MIN_Z), MAX_Z);
    if (Math.abs(z1 - z0) < 1e-6) return false;
    // 커서 아래에 있던 지점이 그대로 커서 아래에 남도록 옮긴다
    V.tx = px - (px - V.tx) * (z1 / z0);
    V.ty = py - (py - V.ty) * (z1 / z0);
    V.z = z1;
    applyView(st);
    return true;
  }

  // 휠·끌기는 컨테이너에 한 번만 붙인다. 다시 그릴 때마다 붙이면
  // 핸들러가 쌓여 한 번 굴렸는데 여러 번 확대된다.
  function bindGestures(el) {
    if (el._lfmapBound) return;
    el._lfmapBound = true;

    el.addEventListener('wheel', ev => {
      const st = el._lfmap;
      if (!st) return;
      const unit = ev.deltaMode === 1 ? 16 : ev.deltaMode === 2 ? st.view.H : 1;
      const [px, py] = toSvg(st, ev);
      // 배율이 실제로 바뀔 때만 화면 스크롤을 막는다. 이미 최소 배율인데
      // 아래로 굴렸다면 그건 지도가 아니라 문서를 내리려는 것이다.
      if (zoomAt(st, Math.exp(-ev.deltaY * unit * 0.0016), px, py)) ev.preventDefault();
    }, { passive: false });

    el.addEventListener('pointerdown', ev => {
      const st = el._lfmap;
      if (!st || ev.button !== 0) return;
      // 손가락으로는 확대한 뒤에만 끌 수 있게 한다. 축소 상태에서까지
      // 잡아 두면 지도 위에서 화면을 내릴 수 없다.
      if (ev.pointerType === 'touch' && st.view.z <= MIN_Z + 1e-6) return;
      st.drag = { x: ev.clientX, y: ev.clientY, tx: st.view.tx, ty: st.view.ty, moved: false };
      try { el.setPointerCapture(ev.pointerId); } catch (e) { /* 캡처 못 해도 동작한다 */ }
    });

    el.addEventListener('pointermove', ev => {
      const st = el._lfmap;
      if (!st || !st.drag) return;
      const r = el.getBoundingClientRect();
      const s = r.width ? st.view.W / r.width : 1;
      const dx = (ev.clientX - st.drag.x) * s, dy = (ev.clientY - st.drag.y) * s;
      if (!st.drag.moved && Math.abs(dx) + Math.abs(dy) < 4) return;
      st.drag.moved = true;
      el.classList.add('panning');
      st.view.tx = st.drag.tx + dx;
      st.view.ty = st.drag.ty + dy;
      applyView(st);
    });

    const end = () => {
      const st = el._lfmap;
      if (!st) return;
      // 끌고 놓은 직후의 click 은 지역 선택으로 치지 않는다
      st.dragged = !!(st.drag && st.drag.moved);
      st.drag = null;
      el.classList.remove('panning');
      if (st.dragged) setTimeout(() => { if (el._lfmap === st) st.dragged = false; }, 0);
    };
    el.addEventListener('pointerup', end);
    el.addEventListener('pointercancel', end);
    el.addEventListener('pointerleave', end);
  }

  MAP.zoomBy = function (el, factor) {
    const st = el && el._lfmap;
    if (!st) return;
    zoomAt(st, factor, st.view.W / 2, st.view.H / 2);
  };

  MAP.resetView = function (el) {
    const st = el && el._lfmap;
    if (!st) return;
    st.view.z = MIN_Z; st.view.tx = 0; st.view.ty = 0;
    applyView(st);
  };

  // ── 렌더 ────────────────────────────────────────────────
  /**
   * @param el       그릴 컨테이너
   * @param opts     {
   *   topo, crosswalk, scope: 'nation'|'sido', sidoGeo,
   *   values: Map<lafCd, number>, labels: Map<lafCd, string>,
   *   selected: lafCd, unitLabel, theme, labelMode, onPick(lafCd), onView(stat)
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
    if (!feats.length) { el.innerHTML = ''; el._lfmap = null; return { drawn: 0 }; }

    // 경계 sgg 코드 → 재정 자치단체 코드
    const sggToLaf = new Map();
    Object.entries(crosswalk.region || {}).forEach(([laf, v]) => {
      (v.sgg || []).forEach(s => sggToLaf.set(String(s), laf));
    });

    // ── 같은 자치단체끼리 묶는다.
    // 일반구(용인시 3개 구)도, 예산이 도로 잡히는 제주시·서귀포시도
    // 여기서 하나가 된다. 재정 코드를 못 찾은 경계는 저 혼자 남아
    // 회색으로 그려진다.
    const groups = [];
    const byKey = new Map();
    feats.forEach(f => {
      const sgg = String(f.properties.sgg_cd);
      const laf = sggToLaf.get(sgg);
      const key = laf || ('#' + sgg);
      let g = byKey.get(key);
      if (!g) {
        g = { laf: laf || null, rings: [], arcCount: new Map(),
              nm: (laf && labels.get(laf)) || f.properties.sggnm || '' };
        byKey.set(key, g); groups.push(g);
      }
      g.rings = g.rings.concat(f.rings);
      f.arcIdx.forEach(i => g.arcCount.set(i, (g.arcCount.get(i) || 0) + 1));
    });

    // 높이는 지역의 실제 가로세로 비에서 낸다. 고정 비율로 두면 서울처럼
    // 옆으로 넓은 곳에서 위아래 여백만 잔뜩 생긴다.
    const W = Math.max(el.clientWidth || 640, 320);
    const bb = bounds(feats);
    const pad = 12;
    const H = Math.min(Math.max(Math.round((W - pad * 2) * (bb.h / bb.w) + pad * 2), 260), 720);
    const proj = makeProjection(bb, W, H, pad);
    if (!proj) { el.innerHTML = ''; el._lfmap = null; return { drawn: 0 }; }

    // 분위는 자치단체 단위로 낸다. 도형마다 세면 구가 많은 시가
    // 여러 표로 셈해져 구간 경계가 그쪽으로 끌려간다.
    const bands = classify(
      groups.map(g => (g.laf != null ? values.get(g.laf) : undefined)), ramp);
    const { breaks, colors } = bands;

    const stroke = dark ? '#0E141B' : '#FFFFFF';
    const noData = dark ? '#2B3644' : '#E7EAEE';
    const selStroke = dark ? '#F0C46B' : '#14324F';

    const fills = [], lines = [], items = [];
    let drawn = 0, matched = 0, selLine = '';
    const mode = opts.labelMode || 'none';

    groups.forEach(g => {
      const v = g.laf != null ? values.get(g.laf) : undefined;
      const ri = rampIndex(v, breaks, colors);
      const fill = ri < 0 ? noData : colors[ri];
      const d = g.rings.map(r => ringPath(r, proj)).join('');
      if (!d) return;
      drawn++;
      if (v != null) matched++;
      const txt = v == null ? '자료 없음'
        : `${v.toLocaleString('ko-KR', { maximumFractionDigits: 1 })} ${unitLabel}`;
      const isSel = g.laf && g.laf === selected;
      const cls = 'rg' + (isSel ? ' sel' : '') + (g.laf ? ' has' : '');
      fills.push(`<path class="${cls}" d="${d}" fill="${fill}" stroke="none"`
        + ` data-laf="${g.laf || ''}"><title>${esc(g.nm)}\n${esc(txt)}</title></path>`);

      // 테두리는 면을 다 칠한 뒤 따로 얹는다. 같이 그리면 옆 지역의
      // 면이 먼저 그린 선을 덮어 굵기가 들쭉날쭉해진다.
      const outline = outlinePath(g.arcCount, topo.arcs, proj);
      if (outline) {
        lines.push(`<path class="ln" d="${outline}" fill="none" stroke="${stroke}"`
          + ` stroke-width="0.6" stroke-linejoin="round" stroke-linecap="round"`
          + ` pointer-events="none"></path>`);
        if (isSel) selLine = `<path class="selring" d="${outline}" fill="none"`
          + ` stroke="${selStroke}" stroke-width="2.4" stroke-linejoin="round"`
          + ` stroke-linecap="round" pointer-events="none"></path>`;
      }

      if (mode !== 'none' && g.nm) {
        const a = labelAnchor(g.rings, proj);
        if (a) {
          // 진한 면 위에 어두운 글자를 얹으면 읽히지 않는다. 칠해진
          // 색의 진하기에 따라 글자색을 뒤집는다. 밝은 테마의 팔레트는 값이
          // 클수록 진해지고, 어두운 테마는 반대로 밝아진다.
          const ci = ri < 0 ? -1 : bands.idx[ri];
          const onDarkFill = ri < 0 ? dark : (dark ? ci <= 2 : ci >= 4);
          items.push({
            a,
            short: g.nm.length > 6 ? g.nm.slice(0, 5) + '…' : g.nm,
            line2: (mode === 'both' && v != null)
              ? v.toLocaleString('ko-KR', { maximumFractionDigits: 1 }) : null,
            ink: onDarkFill ? '#F4F8FB' : '#16202E',
            halo: onDarkFill ? 'rgba(12,20,28,.72)' : 'rgba(255,255,255,.86)',
          });
        }
      }
    });

    // 확대 상태는 같은 지도를 다시 그리는 동안에만 이어 간다. 연도나
    // 단위를 바꿨다고 보던 자리가 튀면 곤란하고, 범위를 바꿨는데
    // 이전 지도의 배율이 남아도 곤란하다.
    const viewKey = `${opts.scope}|${opts.sidoGeo || ''}`;
    const prev = el._lfmap;
    const V = { z: MIN_Z, tx: 0, ty: 0, W, H };
    if (prev && prev.viewKey === viewKey && prev.view) {
      const r = prev.view.W ? W / prev.view.W : 1;
      V.z = prev.view.z; V.tx = prev.view.tx * r; V.ty = prev.view.ty * r;
    }

    el.innerHTML =
      `<svg viewBox="0 0 ${W} ${H}" width="100%" height="${H}" role="img"`
      + ` aria-label="시군구별 코로플레스 지도" class="choropleth" style="overflow:hidden">`
      + `<g class="shapes">${fills.join('')}${lines.join('')}${selLine}</g>`
      + `<g class="lbls"></g></svg>`;

    const st = {
      el, viewKey, view: V, items, mode,
      labelZ: opts.scope === 'nation' ? NATION_LABEL_Z : MIN_Z,
      shapes: el.querySelector('g.shapes'),
      labelLayer: el.querySelector('g.lbls'),
      strokeNodes: Array.from(el.querySelectorAll('path.ln')),
      selNode: el.querySelector('path.selring'),
      onView: opts.onView || null,
      // 범례에 넘기는 ramp 는 실제로 쓴 색만 — 겹치는 구간을 버렸으면
      // 팔레트 전체가 아니라 남은 칸만 보여야 맞다.
      stat: { drawn, matched, breaks, ramp: colors, noData, min: bands.min, max: bands.max,
              minZ: MIN_Z, maxZ: MAX_Z,
              labelGate: opts.scope === 'nation' ? NATION_LABEL_Z : MIN_Z },
      drag: null, dragged: false,
    };
    el._lfmap = st;
    bindGestures(el);
    // 첫 배치에서 onView 를 부르면 호출한 쪽이 아직 결과를 못 받은 채
    // 알림이 먼저 간다. 여기서만 잠시 끄고, 값은 반환값으로 넘긴다.
    const cb = st.onView; st.onView = null;
    applyView(st);
    st.onView = cb;

    if (onPick) {
      el.querySelectorAll('path.rg.has').forEach(p => {
        p.addEventListener('click', () => {
          if (st.dragged) return;            // 지도를 끌어 옮긴 것이지 고른 게 아니다
          const laf = p.getAttribute('data-laf');
          if (laf) onPick(laf);
        });
      });
    }
    return st.stat;
  };

  /** 범례. 구간 색과 경계값을 함께 보여준다. */
  MAP.legend = function (el, info, unitLabel) {
    if (!info || !info.ramp) { el.innerHTML = ''; return; }
    const { breaks, ramp, noData } = info;
    const fmt = v => v == null ? ''
      : v.toLocaleString('ko-KR', { maximumFractionDigits: 1 });
    // 나눌 구간이 없으면(면이 하나뿐이거나 값이 모두 같으면) 범위를 그대로
    // 적는다. 경계가 없는데 '~' 만 찍혀 있으면 읽는 쪽이 더 헷갈린다.
    const cells = ramp.length === 1
      ? `<span class="lg"><i style="background:${ramp[0]}"></i>`
        + (info.min != null && info.max != null && info.max > info.min
            ? `${fmt(info.min)}~${fmt(info.max)}` : fmt(info.min))
        + '</span><span class="lg">구간을 나누지 않았습니다</span>'
      : ramp.map((c, i) => {
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
