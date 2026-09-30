/*
 * ai.js — 개인 Gemini 키로 받는 「대략적인 해석」.
 *
 * 화면이 보여 주는 표를 **그대로** 모델에 넘긴다. 별도로 다시 집계하지 않는다.
 * 그래야 해석이 근거로 삼은 숫자와 사용자가 보고 있는 숫자가 갈라지지 않는다.
 *
 * 키를 다루는 방식(보관·검증·모델 폴백·하루 몫 장부)은 beaver21c/rssp_help 의
 * 방식을 그대로 가져왔다. gemini.js · quota.js 참고.
 *
 * 선택이 바뀌면 앞서 받은 해석을 지운다. 바뀐 표 옆에 옛 해석이 남아 있으면
 * 그것이 지금 화면을 설명하는 글로 읽힌다 — 틀린 글을 붙여 두는 셈이다.
 */
(function (global) {
  'use strict';

  const AI = {};
  const gem = global.LFGemini;
  const quota = global.LFQuota;

  const $ = s => document.querySelector(s);
  const $$ = s => Array.from(document.querySelectorAll(s));

  const K = { verified: false, models: [], state: 'need', spent: false };
  let getContext = () => null;      // app.js 가 꽂아 준다
  const slots = new Map();          // tab → { box, out, note, btn, payload, pre, ctx }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, m =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]));
  }

  // ── 모델에게 주는 지시 ───────────────────────────────────
  /*
   * 지방재정 숫자는 맥락을 모르면 쉽게 잘못 읽힌다. 그래서 이 화면이 문서에
   * 적어 둔 주의사항을 지시문에 그대로 넣는다. 모델이 "복지 비중이 높으니
   * 복지에 힘쓴다" 같은 단정을 하지 않게 하는 것이 이 지시문의 목적이다.
   */
  const SYSTEM = [
    '당신은 한국 지방재정 자료를 읽는 분석가입니다. 사용자가 보고 있는 화면의 표를 그대로 받아',
    '그 표에서 읽히는 것만 간결하게 설명합니다.',
    '',
    '반드시 지킬 것',
    '- 준 표에 있는 숫자만 씁니다. 표에 없는 값을 계산해 덧붙이거나 지어내지 않습니다.',
    '- 원인을 단정하지 않습니다. 예산 자료만으로는 왜 그런지 알 수 없습니다.',
    '- 자료로 알 수 없는 것은 "이 자료로는 알 수 없습니다"라고 적습니다.',
    '- 정책 평가·권고를 하지 않습니다. 무엇이 보이는지까지만 적습니다.',
    '',
    '지방재정 자료를 읽을 때의 함정 (해당될 때만 짚습니다)',
    '- 광역과 기초를 단순히 더하면 안 됩니다. 시도비 보조금이 기초 세출에 다시 잡혀 중복됩니다.',
    '- 명목액입니다. 여러 해에 걸친 증가에는 물가 상승분이 들어 있습니다.',
    '- 회계 범위(일반·특별·기금)에 따라 총액이 크게 달라집니다.',
    '- 행정구역 개편이 있으면 시계열이 끊깁니다.',
    '- 사업 수가 늘었다고 서비스가 넓어진 것은 아닙니다. 분할·통합 효과가 섞입니다.',
    '- 비중은 분모가 무엇인지에 따라 전혀 다른 이야기가 됩니다. 표에 적힌 분모를 그대로 씁니다.',
    '',
    '형식 — 아래 세 머리말을 그대로 쓰고, 각 항목은 한 줄로 짧게 적습니다. 표를 다시 그리지 않습니다.',
    '## 한눈에',
    '(1~2문장)',
    '## 눈에 띄는 것',
    '(- 로 시작하는 항목 2~4개)',
    '## 조심할 것',
    '(- 로 시작하는 항목 1~2개)',
  ].join('\n');

  /** 화면 맥락을 모델이 읽을 평문으로 편다. */
  function promptFor(ctx) {
    const head = [
      `# ${ctx.heading}`,
      '',
      '## 조회 조건',
      ...ctx.conditions.map(c => `- ${c}`),
      '',
      '## 화면에 보이는 값',
    ];
    const tail = [
      '',
      '## 출처',
      `- ${ctx.source}`,
    ];
    if (ctx.notes && ctx.notes.length) {
      tail.push('', '## 이 화면의 단서', ...ctx.notes.map(n => `- ${n}`));
    }
    tail.push('', '위 표에서 읽히는 것만 지시된 형식으로 정리하십시오.');
    return [...head, ctx.body, ...tail].join('\n');
  }

  // ── 답 글을 화면에 앉히기 ────────────────────────────────
  /*
   * 모델이 돌려주는 것은 아주 좁은 마크다운(## 머리말, - 항목, **굵게**)뿐이다.
   * 라이브러리를 들이는 대신 그 세 가지만 다룬다. 그 밖의 글자는 전부 이스케이프하므로
   * 모델이 무엇을 뱉든 화면에 태그로 심어지지 않는다.
   */
  function renderAnswer(text) {
    const out = [];
    let list = null;
    String(text || '').split(/\r?\n/).forEach(raw => {
      const line = raw.trim();
      if (!line) { if (list) { out.push('</ul>'); list = null; } return; }
      const bold = s => esc(s).replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
      if (/^#{1,6}\s/.test(line)) {
        if (list) { out.push('</ul>'); list = null; }
        out.push(`<h4>${bold(line.replace(/^#{1,6}\s*/, ''))}</h4>`);
      } else if (/^[-*·]\s/.test(line)) {
        if (!list) { out.push('<ul>'); list = 1; }
        out.push(`<li>${bold(line.replace(/^[-*·]\s*/, ''))}</li>`);
      } else {
        if (list) { out.push('</ul>'); list = null; }
        out.push(`<p>${bold(line)}</p>`);
      }
    });
    if (list) out.push('</ul>');
    return out.join('');
  }

  // ── 탭마다 붙는 상자 ─────────────────────────────────────
  const SLOT_HTML = `
    <div class="ch"><h3>AI 해석 <span class="aitag">참고용</span></h3>
      <div class="acts">
        <button class="btn" type="button" data-ai-run>해석 생성</button>
        <button class="btn" type="button" data-ai-key>키 설정</button>
      </div>
    </div>
    <div class="aibd">
      <p class="note" data-ai-note></p>
      <details data-ai-payload hidden>
        <summary>보낼 내용 그대로 보기</summary>
        <pre data-ai-pre></pre>
      </details>
      <div class="aiout" data-ai-out hidden></div>
    </div>`;

  function mount() {
    $$('.aislot').forEach(el => {
      const tab = el.dataset.tab;
      el.className = 'card ai aislot';
      el.innerHTML = SLOT_HTML;
      const s = {
        box: el,
        btn: el.querySelector('[data-ai-run]'),
        note: el.querySelector('[data-ai-note]'),
        payload: el.querySelector('[data-ai-payload]'),
        pre: el.querySelector('[data-ai-pre]'),
        out: el.querySelector('[data-ai-out]'),
        busy: false,
      };
      s.btn.addEventListener('click', () => run(tab));
      el.querySelector('[data-ai-key]').addEventListener('click', openModal);
      slots.set(tab, s);
    });
    refresh();
  }

  /** 지금 상태에서 해석을 만들 수 있는가. 못 만들면 사유를 함께 준다. */
  function readiness() {
    if (!gem.getKey()) return { ok: false, why: 'Gemini API 키를 넣으면 이 화면의 표를 읽고 대략적인 해석을 붙여 드립니다.' };
    if (K.spent) return { ok: false, why: `오늘 쓸 수 있는 무료 몫을 다 썼습니다. ${quota.resetText()} 에 되돌아옵니다.` };
    if (!K.verified) return { ok: false, why: '키 확인이 끝나지 않았습니다. [키 설정]에서 확인하십시오.' };
    return { ok: true, why: '' };
  }

  /** 선택이 바뀔 때마다 불린다. 앞서 받은 해석을 지우고 상태를 다시 적는다. */
  function refresh() {
    const r = readiness();
    slots.forEach((s, tab) => {
      const ctx = safeContext(tab);
      s.btn.disabled = !r.ok || !ctx || s.busy;
      s.out.hidden = true;
      s.out.innerHTML = '';
      if (!ctx) {
        s.note.textContent = '아직 표시할 값이 없습니다.';
        s.payload.hidden = true;
        return;
      }
      s.ctx = ctx;
      const prompt = promptFor(ctx);
      s.pre.textContent = prompt;
      s.payload.hidden = false;
      s.payload.open = false;
      let bytes = 0;
      try { bytes = gem.requestSize({ system: SYSTEM, prompt }); } catch (e) { bytes = 0; }
      s.note.textContent = r.ok
        ? `[해석 생성]을 누르면 위 조건의 표가 구글 Gemini 로 전송됩니다 (약 ${(bytes / 1024).toFixed(1)}KB). 공개된 예산 집계값이며 개인정보는 들어 있지 않습니다.`
        : r.why;
    });
    syncSide();
  }
  AI.refresh = refresh;

  function safeContext(tab) {
    try {
      const c = getContext(tab);
      return c && c.body ? c : null;
    } catch (e) { return null; }
  }

  async function run(tab) {
    const s = slots.get(tab);
    if (!s || s.busy) return;
    const r = readiness();
    if (!r.ok) { s.note.textContent = r.why; return; }
    const ctx = safeContext(tab);
    if (!ctx) { s.note.textContent = '아직 표시할 값이 없습니다.'; return; }

    s.busy = true;
    s.btn.disabled = true;
    s.note.textContent = '해석을 만드는 중…';
    s.out.hidden = true;
    try {
      const res = await gem.generate({
        system: SYSTEM,
        prompt: promptFor(ctx),
        temperature: 0.2,
        maxOutputTokens: 1200,
      });
      s.out.innerHTML = renderAnswer(res.text)
        + `<p class="aifoot">Gemini <b>${esc(res.model)}</b> 가 위 표만 읽고 만든 <b>참고용</b> 글입니다. `
        + '사실 확인 없이 인용하지 마십시오. 숫자는 표와 엑셀 내보내기를 기준으로 하십시오.</p>';
      s.out.hidden = false;
      s.note.textContent = `${usageText()} · 선택을 바꾸면 이 해석은 지워집니다.`;
    } catch (e) {
      if (e && e.quota) { markSpent(e.message); s.note.textContent = e.message; }
      else s.note.textContent = `해석을 만들지 못했습니다 — ${e.message}`;
    } finally {
      s.busy = false;
      s.btn.disabled = !readiness().ok;
      syncSide();
    }
  }

  // ── 사이드바 표시 ────────────────────────────────────────
  function syncSide() {
    const dot = $('#aiDot');
    const txt = $('#aiState');
    if (!dot || !txt) return;
    let cls = '';
    let msg = '키 없음 — 해석 기능 꺼짐';
    if (K.spent) { cls = 'warn'; msg = `오늘 몫 소진 · ${quota.resetText()} 복귀`; }
    else if (K.verified && gem.getKey()) { cls = 'ready'; msg = `연결됨 · 오늘 ${quota.usage().total}회`; }
    else if (gem.getKey()) { cls = 'warn'; msg = '키 확인 필요'; }
    dot.className = 'dot ' + cls;
    txt.textContent = msg;
  }

  function usageText() {
    const u = quota.usage();
    const left = quota.untilReset();
    const bits = [`오늘 ${u.total}회 사용`];
    const lim = quota.limitOf(gem.getPreferred() || '');
    if (lim.rpd) bits.push(`한도 ${lim.rpd.toLocaleString('ko-KR')}회(${lim.source === 'observed' ? '관측값' : '참고값'})`);
    bits.push(`몫 복귀 ${quota.resetText()} (${left.hours}시간 ${left.minutes}분 뒤)`);
    return bits.join(' · ');
  }

  // ── 키 설정 모달 — rssp_help 의 상태 기계를 그대로 옮겼다 ──
  function setState(s) {
    K.state = s;
    $('#aiSetup').dataset.state = s;
    const busy = s === 'busy';
    ['#kIn', '#kGo', '#kSkip', '#kRecheck', '#kModel'].forEach(q => {
      const el = $(q); if (el) el.disabled = busy;
    });
    if (s !== 'fail') $('#kFix').hidden = true;
  }

  const storeMode = () => ($$('input[name=kStore]').find(r => r.checked) || {}).value === 'local';
  const say = (sel, msg, kind) => {
    const el = $(sel);
    el.textContent = msg || '';
    el.className = 'kstatus' + (kind ? ' ' + kind : '');
  };

  function markSpent(msg) {
    K.spent = true;
    setState('fail');
    say('#kTest', msg || '오늘 쓸 수 있는 무료 몫을 다 썼습니다.', 'err');
    const box = $('#kFix');
    box.innerHTML = '무료 등급의 하루 몫은 <b>태평양 자정</b>에 되돌아옵니다 — '
      + `<b>${esc(quota.resetText())}</b>(약 ${quota.untilReset().hours}시간 뒤)까지 해석 기능은 잠깁니다. `
      + '그동안 추이·구성·지도·사업 검색과 내보내기는 그대로 쓸 수 있습니다.';
    box.hidden = false;
    refresh();
  }

  /* 우선 모델 선택 상자를 살아 있는 목록으로 다시 채운다.
     기억해 둔 이름이 목록에서 사라졌으면 (목록에 없음)을 달아 그대로 보여 준다 —
     조용히 지우면 왜 다른 모델이 답했는지 알 수 없다. */
  function fillModels(list, cur) {
    const sel = $('#kModel');
    const want = cur == null ? gem.getPreferred() : cur;
    sel.innerHTML = '';
    sel.appendChild(new Option('자동 — 앞선 것부터 차례로 (권장)', ''));
    list.forEach(m => sel.appendChild(new Option(m, m)));
    if (want && !list.includes(want)) sel.appendChild(new Option(`${want} (목록에 없음)`, want));
    sel.value = want || '';
  }

  async function verify() {
    if (!gem.getKey()) { K.verified = false; setState('need'); refresh(); return; }
    K.verified = false;
    setState('busy');
    refresh();
    say('#kTest', '키를 확인하는 중… (모델 목록 조회 + 실제 생성 1회)', 'busy');
    const pick = $('#kModel').value || '';
    const res = await gem.verifyKey({ model: pick });
    K.models = res.models || [];
    K.verified = res.ok;
    // 고른 값은 사람이 고른 그대로 둔다. 답한 모델을 되박으면 '자동'이 슬그머니
    // 고정으로 바뀌어, 그 이름이 없어졌을 때 폴백이 막힌다.
    fillModels(K.models, pick);

    if (res.ok) {
      K.spent = false;
      setState('ok');
      if (res.switchedFrom) { gem.setPreferred(res.model); fillModels(K.models, res.model); }
      $('#kOkLbl').textContent = gem.keyScope() === 'local'
        ? 'API 키 확인됨 · 이 브라우저에 저장' : 'API 키 확인됨 · 이 탭에서만';
      const bits = [`응답 모델 ${res.model}`];
      if (res.switchedFrom) bits.push(`${res.switchedFrom} 은 내려가 자동으로 바꿨습니다`);
      bits.push(res.listed ? `쓸 수 있는 모델 ${K.models.length}개` : '모델 목록은 못 받아 내장 이름으로 연결했습니다');
      bits.push(usageText());
      if (gem.storageBlocked()) bits.push('저장소가 막혀 메모리에만 둡니다 — 새로 고치면 지워집니다');
      $('#kOkWhy').textContent = bits.join(' · ');
      say('#kTest', '', '');
    } else if (res.quota) {
      markSpent('확인 실패 — ' + res.error);
    } else {
      setState('fail');
      $('#kAuto').hidden = !pick;
      say('#kTest', '확인 실패 — ' + (res.error || '사유 불명'), 'err');
      showFix(res, pick);
    }
    refresh();
  }

  /* 사유별 조치 안내. 「잠시 뒤 다시」로 뭉뚱그리면 기다려도 안 풀리는 문제까지
     기다리게 만든다. 계정 단위 문제와 일시적 문제를 갈라 적는다. */
  function showFix(res, pick) {
    const box = $('#kFix');
    let html;
    if (res.billing) {
      html = '구글 계정의 선불 크레딧이 바닥났습니다. <b>모델을 바꾸거나 기다려도 풀리지 않습니다</b> — '
        + '<a href="https://ai.studio/projects" target="_blank" rel="noopener noreferrer">AI Studio</a> 에서 '
        + '결제·크레딧을 처리한 뒤 다시 확인하십시오.';
    } else if (res.retired) {
      html = `<b>${esc(res.retired)}</b> 는 내려간 모델입니다`
        + (res.replacement
          ? ` — 구글이 <b>${esc(res.replacement)}</b> 를 대신 쓰라고 알려 왔습니다. `
            + '[자동 모델로 되돌려 다시 확인]을 누르면 살아 있는 목록에서 다시 고릅니다.'
          : '. [자동 모델로 되돌려 다시 확인]을 눌러 살아 있는 목록에서 다시 고르십시오.');
      $('#kAuto').hidden = false;
    } else if (res.fatal) {
      html = '키 자체가 거부됐습니다. 붙여넣기가 온전한지 보고, 아니면 '
        + '<a href="https://aistudio.google.com/apikey" target="_blank" rel="noopener noreferrer">AI Studio</a> 에서 '
        + '키를 다시 발급하십시오.';
    } else if (pick) {
      html = `${esc(pick)} 모델을 고정해 둔 상태입니다. [자동 모델로 되돌려 다시 확인]을 눌러 보십시오.`;
    } else {
      html = '연결이나 한도 쪽 문제일 수 있습니다. 잠시 뒤 [키 확인하고 시작]을 다시 누르십시오.';
    }
    box.innerHTML = html;
    box.hidden = false;
  }

  function openKeyForm() {
    $('#kIn').value = gem.getKey();
    const local = gem.keyScope() === 'local';
    $$('input[name=kStore]').forEach(r => { r.checked = (r.value === 'local') === local; });
    K.verified = false;
    setState('need');
    say('#kTest', '', '');
    refresh();
    $('#kIn').focus();
  }

  function openModal() {
    $('#aiKey').hidden = false;
    if (K.state === 'need' || K.state === 'fail') $('#kIn').focus();
    else $('#aiKey .x').focus();
  }
  function closeModal() { $('#aiKey').hidden = true; }
  AI.open = openModal;

  function bindModal() {
    $('#aiKey').addEventListener('click', e => { if (e.target.closest('[data-close]')) closeModal(); });
    document.addEventListener('keydown', e => {
      if (e.key === 'Escape' && !$('#aiKey').hidden) closeModal();
    });
    $('#btnAiKey').addEventListener('click', openModal);

    $('#kGo').onclick = async () => {
      const typed = $('#kIn').value.trim();
      if (!typed) { say('#kTest', '키를 넣고 누르십시오', 'err'); return; }
      if (typed !== gem.getKey()) gem.setKey(typed, storeMode());
      else gem.clearModelCache();
      await verify();
    };
    $('#kIn').addEventListener('keydown', e => { if (e.key === 'Enter') $('#kGo').click(); });
    $('#kSkip').onclick = () => { K.verified = false; setState('off'); refresh(); closeModal(); };
    $('#kOpen').onclick = openKeyForm;
    $('#kEdit').onclick = openKeyForm;
    $('#kRecheck').onclick = () => { gem.clearModelCache(); verify(); };
    $('#kModel').onchange = () => { gem.setPreferred($('#kModel').value); verify(); };
    $('#kAuto').onclick = () => {
      gem.setPreferred('');
      gem.clearModelCache();
      fillModels(K.models, '');
      verify();
    };
    $('#kDel').onclick = () => {
      gem.setKey('', false);
      gem.setPreferred('');
      quota.clearVerified();
      $('#kIn').value = '';
      K.verified = false; K.models = []; K.spent = false;
      setState('need');
      say('#kTest', '키를 지웠습니다', '');
      refresh();
    };
    /* 확인이 안 통했는데도 쓰겠다는 경우 — 막다른 길을 만들지 않되 무엇을 건너뛰는지는 남긴다 */
    $('#kForce').onclick = () => {
      if (!gem.getKey()) return;
      K.verified = true;
      setState('ok');
      $('#kOkLbl').textContent = '확인을 건너뛰고 사용 중';
      $('#kOkWhy').textContent = '연결 확인이 통하지 않았습니다. 호출이 실패하면 각 탭의 상태줄에 사유가 뜹니다';
      refresh();
    };
  }

  /**
   * app.js 가 부팅 끝에 한 번 부른다.
   * ctxFn(tab) → { heading, conditions[], body, source, notes[] } 또는 null.
   */
  AI.init = function (ctxFn) {
    getContext = typeof ctxFn === 'function' ? ctxFn : (() => null);
    mount();
    bindModal();

    // 저장해 둔 키가 있으면 확인한다. 다만 **오늘 이미 확인한 키면 실호출을 건너뛴다** —
    // 무료 등급에서 페이지를 열 때마다 하루 몫을 한 칸씩 쓰는 것이 아깝다.
    const key = gem.getKey();
    if (!key) { setState('need'); refresh(); return; }
    $('#kIn').value = key;
    const local = gem.keyScope() === 'local';
    $$('input[name=kStore]').forEach(r => { r.checked = (r.value === 'local') === local; });
    if (quota.isVerified(key)) {
      K.verified = true;
      K.models = [];
      fillModels([], null);
      setState('ok');
      $('#kOkLbl').textContent = local ? 'API 키 확인됨 · 이 브라우저에 저장' : 'API 키 확인됨 · 이 탭에서만';
      $('#kOkWhy').textContent = [
        '오늘 이미 확인한 키라 실호출을 건너뛰었습니다(무료 몫 아낌)',
        gem.getPreferred() ? `우선 모델 ${gem.getPreferred()}` : '',
        usageText(),
      ].filter(Boolean).join(' · ');
      refresh();
    } else {
      verify();
    }
  };

  global.LFAI = AI;
})(window);
