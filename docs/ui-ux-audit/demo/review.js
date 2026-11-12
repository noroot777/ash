/* 审查的账和它的两张浮层。会话流里的审查行、回复框那颗键、右侧「审查」「工作流」两格读的都是 ASH.review 这一份，
   所以三处说的永远是同一轮、同一个结论。
   rounds：验收前的各轮 { n, by, took, at, ok, notes, note? }（note 是派这一轮时写的附言）；posts：验收后对合并结果的审查 { commit, by, took, at, ok, notes }。
   busy = 正在审的（第几轮 / 'post'）；armed = 约好「这一轮跑完就审」的那套设置；stale = 上一轮审完之后代码又动过；
   from / max = 这一趟从第几轮起、最多审到第几轮（未通过又没到头：意见交给执行者修，修完自动接着审）。
   key() 是回复框那颗键此刻的 { text, tip, busy, armed, off }；press(anchor) 是点它。
   start(plan?) / startPost() / arm(plan | null) / tune(anchor) / dialog()。
   每次变化发 review:change；起了一轮发 review:start { round, by }；出结论发 review:done { round, ok, post?, repair? }。 */
(() => {
  const { h, icon } = ASH;
  ASH.icons.minus ??= '<path d="M3.5 8h9"/>';
  const JUDGES = ASH.data.judges;
  const MAX_RETRIES = 20;
  const CHECKS = [{ value: 'logic', label: '逻辑检查' }, { value: 'syntax', label: '只做语法检查' }];
  const task = () => ASH.data.tasks.find((t) => t.id === ASH.data.current);

  const rounds = [
    { n: 1, by: '逻辑从严', check: 'logic', took: '13m 2s', at: '11/09 14:22 → 14:35', time: '11/09 14:35', ok: false,
      notes: ['服务在到点前一两秒起来时，补发和原来的定时器会各发一遍。', '补发没有写进记录，事后看不出这条为什么晚了。', '缺一条「同时过点好几条」的回归，现在发出去的先后是乱的。'] },
    { n: 2, by: '逻辑从严', check: 'logic', took: '8m 40s', at: '11/09 14:58 → 15:07', time: '11/09 15:07', ok: false,
      notes: ['撤回了的定时消息，重启后还是会被补发。', '系统时间往回拨过以后，同一条会被补发两次。'] },
    { n: 3, by: '逻辑从严', check: 'logic', took: '12m 5s', at: '11/09 15:28 → 15:40', time: '11/09 15:40', ok: true, notes: ['没有新的问题。前两轮的 5 条意见都已收口。'] },
  ];
  const posts = [];
  const st = { busy: null, armed: null, stale: false, from: 0, max: 0 };
  let plan = { judge: JUDGES[0].name, check: 'logic', retries: 1, note: '' };   /* 上一次派审用的那一套，下次打开对话框照它填 */
  let was = task()?.status ?? 'done';
  let accepted = Boolean(task()?.accepted);
  let noted = false;     /* 改过代码之后的头一次审查已经给过意见了 */
  let t0 = 0;
  let pop = null;        /* 开着的「调整审查轮数」 */
  const changed = () => ASH.emit('review:change');
  const live = () => was === 'running' || was === 'waiting' || was === 'queued';

  /* ---------- 一轮：2.6 秒出结论 ---------- */
  function begin(what, from, max) {
    Object.assign(st, { busy: what, from, max, armed: null });
    t0 = performance.now();
    const since = ASH.clock();
    if (what !== 'post') ASH.emit('review:start', { round: what, by: plan.judge });
    changed();
    setTimeout(() => {
      const took = ASH.dur(performance.now() - t0);
      const at = `${since} → ${ASH.clock()}`;
      if (pop?.el.contains(document.activeElement)) pop.anchor.focus();
      pop?.();                                            /* 审完了，调轮数那一扇跟着关 */
      pop = null;
      st.busy = null;
      if (what === 'post') {
        /* 头一次审合并结果给一条意见，好看得到「创建修复任务」；再审就过了 */
        const ok = posts.length > 0;
        posts.push({ commit: ASH.data.cur.commits[0][0], by: plan.judge, check: plan.check, took, at, ok, fresh: true, notes: [ok ? '没有新的问题。' : '合并后 main 上那条「撤回后不补发」的回归没有进验收前置命令。'] });
        ASH.emit('review:done', { post: true, ok });
        changed();
        return;
      }
      /* 代码没动过就再审：没有新问题。动过以后头一次审给一条意见，改完再审就过了 */
      const ok = !st.stale || noted;
      if (st.stale) noted = true;
      st.stale = false;
      rounds.push({ n: what, by: plan.judge, check: plan.check, note: plan.note.trim(), took, at, time: '刚刚', ok, fresh: true, notes: [ok ? '没有新的问题。' : '新加的回归没有覆盖「连着重启两次」这一种。'] });
      /* 没通过、这一趟还没到头、任务也闲着：意见交给执行者修，修完自动审下一轮 */
      const repair = !ok && what < st.max && !accepted && !live() && Boolean(ASH.parts.live?.play);
      if (repair) st.armed = { ...plan, chain: true };
      ASH.emit('review:done', { round: what, ok, repair });
      changed();
    }, 2600);
  }
  function start(next = plan) {
    if (st.busy) return;
    plan = { ...next, chain: false };
    const n = rounds.length + 1;
    begin(n, n, n + plan.retries);
  }
  function startPost() { if (!st.busy) begin('post', 0, 0); }
  function arm(next) {
    st.armed = next ? { ...next, chain: false } : null;
    if (next) plan = { ...next, chain: false };
    changed();
  }

  /* 任务状态：一轮正常跑完 = 代码动过了；约好的那一轮这时候开（回复框托盘里还排着消息就先让它们发完）。停止、失败、等答复时预约留着 */
  ASH.on('task:status', ({ id, status, accepted: flag } = {}) => {
    if (id !== ASH.data.current || !status) return;
    const prev = was;
    if (status === 'accepted') { was = 'done'; accepted = true; }
    else {
      was = status;
      if (typeof flag === 'boolean') accepted = flag; else if (['done', 'running', 'queued'].includes(status)) accepted = false;
    }
    if (accepted) st.armed = null;
    if (prev === 'running' && was === 'done') {
      st.stale = true;
      if (st.armed && !st.busy && !ASH.parts.reply?.hasQueued?.()) {
        const next = st.armed;
        const n = rounds.length + 1;
        plan = { ...next, chain: false };
        if (next.chain) begin(n, st.from, Math.max(st.max, n)); else begin(n, n, n + next.retries);
        return;
      }
    }
    changed();
  });

  /* ---------- 回复框那颗键此刻该写什么 ---------- */
  function key() {
    if (st.busy === 'post') return { text: '审查中', tip: '正在审查合并结果', busy: true, off: true };
    if (st.busy) return { text: `审查中 ${st.busy - st.from + 1}/${st.max - st.from + 1}`, tip: '改这一趟最多审几轮', busy: true };
    if (accepted) return { text: '再审', off: true };
    if (st.armed) return { text: '已预约复审', tip: st.armed.chain ? `修完自动审第 ${rounds.length + 1} 轮` : '这一轮结束后自动开审', armed: true };
    if (live()) return { text: '预约复审', tip: '这一轮结束后自动开审' };
    if (st.stale) return { text: '审查新改动', tip: '上一轮审完之后代码又动过' };
    return { text: rounds.length ? '再审' : '派审查', tip: '再派一轮审查' };
  }
  function press(anchor) {
    if (st.busy === 'post' || accepted) return;
    if (st.busy) tune(anchor); else dialog();
  }

  /* ---------- 步进器：[−] 数 [+] ---------- */
  function stepper({ value, min, max, label, onchange }) {
    const out = h('output.num', { 'aria-live': 'polite' }, String(value));
    const less = h('button.ico.sm', { type: 'button', 'aria-label': `${label}少一轮`, onclick: () => step(-1) }, icon('minus'));
    const more = h('button.ico.sm', { type: 'button', 'aria-label': `${label}多一轮`, onclick: () => step(1) }, icon('plus'));
    function step(d) {
      value = Math.min(max, Math.max(min, value + d));
      out.textContent = String(value);
      less.disabled = value <= min;
      more.disabled = value >= max;
      onchange?.(value);
    }
    const el = h('span.stepper', { role: 'group', 'aria-label': label }, less, out, more);
    step(0);
    return el;
  }

  /* ---------- 派审 / 预约审查：四行字段、一个主动作。任务在跑时它是「预约」，约过了再打开是「调整预约」 ---------- */
  function dialog() {
    const reserve = live() || Boolean(st.armed);
    const draft = { ...(st.armed ?? plan), chain: false };
    const title = reserve ? (st.armed ? '调整预约审查' : '预约审查') : '派审查';
    const note = h('textarea.field', { rows: '2', placeholder: '补充希望审查者重点关注的内容', 'aria-label': '附言', 'data-m': 'feed-12' }, draft.note);
    note.addEventListener('input', () => { draft.note = note.value; note.style.height = 'auto'; note.style.height = `${Math.min(note.scrollHeight, 168)}px`; });
    note.addEventListener('keydown', (e) => { if (ASH.sendKey.hit(e)) { e.preventDefault(); submit(); } });
    const zero = h('span.rv-zero', '未通过就停下，等你处理');
    const row = (label, ...control) => h('div.rv-row', h('span', label), h('div', control));
    const submit = () => { close(); if (reserve) arm(draft); else start(draft); };
    const go = h('button.btn.pri', { type: 'button', onclick: submit }, reserve ? (st.armed ? '保存预约' : '预约审查') : '开始审查');
    const close = ASH.sheet(h('div.dlg.rv-dlg', { role: 'dialog', 'aria-modal': 'true', 'aria-label': title, 'data-m': 'reply-5' },
      h('h2', title),
      row('审查者', ASH.select({ value: draft.judge, label: '审查者', width: 200, options: [
        ...JUDGES.map((j) => ({ value: j.name, label: j.name, hint: `${j.who.agent} · ${j.who.model} · ${j.who.level}` })), '-',
        { label: '管理审查者…', onpick: () => { close(); ASH.go('#/settings/reviewers'); } }], onchange: (v) => { draft.judge = v; } })),
      row('检查类型', ASH.select({ value: draft.check, label: '检查类型', width: 200, options: CHECKS, onchange: (v) => { draft.check = v; } })),
      row('失败后自动复审', stepper({ value: draft.retries, min: 0, max: MAX_RETRIES, label: '自动复审', onchange: (v) => { draft.retries = v; zero.hidden = v > 0; } }), h('span', '轮'), zero),
      row('附言', note),
      h('div.dlg-acts',
        st.armed && h('button.btn.quiet', { type: 'button', onclick: () => { close(); arm(null); } }, '取消预约'),
        st.armed && h('span.grow'),
        h('button.btn', { type: 'button', onclick: () => close() }, '取消'), go)));
    go.focus();
  }

  /* ---------- 审查在跑的时候改这一趟最多审几轮：正在审的那一轮自己占一轮，所以不能比它小 ---------- */
  function tune(anchor) {
    const round = st.busy;
    if (typeof round !== 'number') return;
    let total = Math.max(st.max, round);
    const say = h('p');
    const tell = () => { say.textContent = total > round ? `第 ${round} 轮未通过时，意见交给执行者修复，修完自动审第 ${round + 1} 轮。` : `第 ${round} 轮是最后一轮，未通过就停下来等你处理。`; };
    tell();
    pop = ASH.pop(anchor, h('div.insp-set', { role: 'dialog', 'aria-label': '调整审查轮数' },
      h('div.insp-step', h('span.grow', `第 ${round} 轮正在审查`), h('span', '最多'),
        stepper({ value: total, min: round, max: st.from + MAX_RETRIES, label: '最多轮数', onchange: (v) => { total = v; tell(); } }), h('span', '轮')),
      say,
      h('div.insp-set-foot', h('span.grow'), h('button.btn.pri.sm', { type: 'button', onclick: () => { st.max = total; ASH.closePop(); anchor.focus(); ASH.toast(`审查轮数已改为最多 ${total - st.from + 1} 轮`); changed(); } }, '保存'))),
    { place: anchor.closest('.reply') ? 'top-start' : 'bottom-start' });
  }

  ASH.review = {
    rounds, posts, key, press, start, startPost, arm, tune, dialog,
    get busy() { return st.busy; },
    get armed() { return Boolean(st.armed); },
    get stale() { return st.stale; },
    get max() { return st.max; },
    get plan() { return plan; },
  };
})();
