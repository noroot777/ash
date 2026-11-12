/* 全应用共用的那颗发送键：回复框、首页和新建任务的卡片、聊天、助手用的都是它。
   const key = ASH.sendKey({ hint, key, size, launch, onsend(mode, detail), onstop(), onlayout() })
     key 不传 = 快捷键跟「发送键」设置走；launch：新建任务用的那一颗，尖角点开是「启动设置」五档，其余一样；onlayout：键刚变宽变窄、还没滑过去的那一刻
     key.el / key.main / key.opt；key.update({ empty, running, uploading, stopSay })；key.submit()（回车走它，和点键同一个闸）；
     在跑、输入框空着时主段就是停止键；打了字主段要用来发，停止挪到它左边一颗小键上（key.halt）——任何时候都停得下来。stopSay 是停止键的提示（缺省「停止这一轮」）；
     key.open() 打开发送设置；key.reset() 回到「立即发送」；key.set({ mode, at, task })；key.mode / key.time
     mode 是 'now' | 'timed' | 'after'（launch 时是 'now' | 'queue' | 'only' | 'timed' | 'cron'）；detail 是 { at, time, cron, task }；点停止时调 onstop()，没传就调 onsend('stop')。
   哪一下算发送跟设置走（ASH.data.sendKey，改它用 ASH.setSendKey）：
     ASH.sendKey.mode() → 'enter' | 'mod'；ASH.sendKey.caps() → { send, newline }；ASH.sendKey.hit(keydown 事件) → 这一下算不算发送。
     设置一改（sendkey:change），还在页面上的每一颗键自己把提示里的键名换掉。 */
(() => {
  const { h, icon } = ASH;
  const EASE = 'cubic-bezier(0.22, 1, 0.36, 1)';
  const keys = new Set();   /* 还在页面上的键：设置改了挨个重画，已经卸掉的顺手摘出去 */
  ASH.on('sendkey:change', () => { for (const key of [...keys]) { if (key.el.isConnected) key.repaint(); else keys.delete(key); } });

  /* 三种发法：档位、浮层里的名字、键上的字（空 = 只画箭头）。照 components/LaterSend.tsx */
  const MODES = [['now', '立即发送', ''], ['timed', '指定时间', '定时发送'], ['after', '等任务完成', '完成后发送']];
  /* 新建任务的「启动设置」：档位、名字、键上的字、尖角上的图标（0 尖角 / 1 时钟 / 2 沙漏）、一句说明。照 composer/ComposerLaunchControl.tsx */
  const LAUNCH = [
    ['now', '创建并运行', '', 0, '创建后立即开始执行'],
    ['queue', '创建并排队', '创建并排队', 2, '入队不起跑，轮到它时自动开始'],
    ['only', '仅创建', '创建任务', 0, '先放入待办，需要时再运行'],
    ['timed', '一次性定时', '创建并定时', 1, '在指定的时间运行一次'],
    ['cron', '循环 Cron', '创建并定时', 1, '按 Cron 表达式循环运行'],
  ];
  const DOT = { running: 'run', waiting: 'wait', queued: 'queue', failed: 'bad' };
  const STUCK = { failed: '失败', stopped: '已取消' };
  /* 「等任务完成」能选谁：还会完成的排前面，失败的放后面（重跑完成后才发）。照 lib/sendAfter.ts */
  const waitable = () => (ASH.data?.tasks ?? []).filter((t) => DOT[t.status] && t.id !== ASH.data.current)
    .sort((a, b) => Boolean(STUCK[a.status]) - Boolean(STUCK[b.status]));
  /* 两个只差数字的字（上传进度）原地换，不走淡出淡入 */
  const alike = (a, b) => Boolean(a && b) && a.replace(/[\d:%]/g, '') === b.replace(/[\d:%]/g, '');
  const two = (n) => String(n).padStart(2, '0');
  const stamp = (d) => `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}T${two(d.getHours())}:${two(d.getMinutes())}`;
  /* 一列选项里上下键走 */
  const arrows = (list) => list.addEventListener('keydown', (e) => {
    const to = { ArrowDown: document.activeElement.nextElementSibling, ArrowUp: document.activeElement.previousElementSibling }[e.key];
    if (to) { e.preventDefault(); to.focus(); }
  });
  const clock = (at) => { const d = new Date(at); return `${two(d.getMonth() + 1)}/${two(d.getDate())} ${two(d.getHours())}:${two(d.getMinutes())}`; };

  /* 哪一下算发送，跟「发送键」设置走（ASH.data.sendKey：默认回车；mod-enter 是 ⌘ 回车）。照 lib/sendKey.ts：
     ⌘/Ctrl+回车两档下都发；Shift/Alt+回车、输入法选词中的回车永远不算。提示里的键名也从这里取。 */
  const sendMode = () => (/^mod/.test(ASH.data?.sendKey ?? '') ? 'mod' : 'enter');
  const sendCaps = () => (sendMode() === 'mod' ? { send: '⌘↵', newline: '↵' } : { send: '↵', newline: '⇧↵' });
  const sendHit = (e) => e.key === 'Enter' && !e.isComposing && e.keyCode !== 229 && !e.shiftKey && !e.altKey
    && (e.metaKey || e.ctrlKey || sendMode() === 'enter');

  /* ---------- 发送键 ---------- */
  ASH.sendKey = (opts = {}) => {
    const hint = opts.hint ?? '发送';
    const st = { empty: false, running: false, uploading: false, stopSay: '' };
    const cfg = { mode: 'now', at: '', cron: '', task: null };
    const view = { stop: false, dim: false, halt: false };
    let shown = '';
    let want = '';
    let busy = false;

    const txt = h('span.skey-txt.num');
    const glyph = h('span.skey-glyph', icon('up', 'is-on'), icon('stop', 'fill'));
    const clip = h('i.skey-clip', h('i.skey-bg'));
    const main = h('button.skey-main', { type: 'button', onclick: () => (view.stop ? (opts.onstop ?? opts.onsend)?.('stop') : submit()) }, clip, txt, glyph);
    const optGlyph = h('span.skey-glyph', icon('caret', 'is-on'), icon('clock'), icon('sand'));
    const optName = opts.launch ? '启动设置' : '发送设置';
    const opt = h('button.skey-opt', { type: 'button', 'aria-label': optName, 'aria-haspopup': 'dialog', 'aria-expanded': 'false', 'data-tip': optName, onclick: openSettings }, optGlyph);
    const stopNow = () => (opts.onstop ?? opts.onsend)?.('stop');
    const halt = h('button.skey-halt', { type: 'button', hidden: true, 'aria-label': '停止', onclick: stopNow }, icon('stop', 'fill'));
    const el = h('span.skey', { 'data-size': opts.size === 36 ? '36' : '29' }, halt, main, opt);

    /* 键变宽变窄：布局一步到位，再让底色、箭头、尖角和旁边的东西从旧位置滑到新位置（只动 transform）。
       底色分两层：外层跟着右缘走，里层补上左缘的差，圆角不会被拉扁。 */
    function morph(mutate) {
      if (ASH.reduced() || !el.isConnected) { mutate(); return; }
      const moving = [glyph, opt, ...[...el.parentElement.children].filter((node) => node !== el)];
      const was = [main, ...moving].map((node) => node.getBoundingClientRect());
      mutate();
      opts.onlayout?.();
      const now = [main, ...moving].map((node) => node.getBoundingClientRect());
      const slide = (node, dx) => { if (Math.abs(dx) > 0.5) node.animate([{ transform: `translateX(${dx}px)` }, { transform: 'none' }], { duration: 200, easing: EASE }); };
      const right = was[0].right - now[0].right;
      slide(clip, right);
      slide(clip.firstChild, was[0].left - now[0].left - right);
      moving.forEach((node, i) => slide(node, was[i + 1].left - now[i + 1].left));
    }
    function put(to, hold) {
      txt.textContent = to;
      main.classList.toggle('has-txt', Boolean(to));
      txt.classList.toggle('is-out', Boolean(hold));
      shown = to;
    }
    /* 换字：旧字先淡出 120ms，键再变宽，新字淡入。连着变时只认最后一次。小停止键和换字是同一拍进出 */
    function step() {
      const sync = () => { halt.hidden = !view.halt; };
      if (want === shown) { if (halt.hidden === view.halt) morph(sync); busy = false; return; }
      if (ASH.reduced() || !el.isConnected || alike(shown, want)) { put(want); sync(); busy = false; return; }
      busy = true;
      txt.classList.add('is-out');
      setTimeout(() => {
        morph(() => { put(want, true); sync(); });
        txt.classList.remove('is-out');
        setTimeout(step, 200);
      }, shown ? 120 : 0);
    }
    const pickGlyph = (box, n) => [...box.children].forEach((svg, i) => svg.classList.toggle('is-on', i === n));
    /* 选了「稍后」却没配好：拦下并说清，不悄悄退回立即发送 */
    const blocker = () => (opts.launch
      ? (cfg.mode === 'timed' && !cfg.at ? '请选择一次性运行时间'
        : cfg.mode === 'cron' && cfg.cron.trim().split(/\s+/).filter(Boolean).length !== 5 ? (cfg.cron.trim() ? 'Cron 需要 5 个字段：分 时 日 月 周' : '请输入 Cron 表达式')
        : cfg.mode === 'queue' && !cfg.task ? '选择要接在哪个任务之后' : '')
      : cfg.mode === 'timed' && !(new Date(cfg.at).getTime() > Date.now()) ? '发送时间得晚于现在'
      : cfg.mode === 'after' && !cfg.task ? '还没选要等哪个任务' : '');

    function render() {
      const up = Boolean(st.uploading);
      const stop = st.running && st.empty && !up;
      const block = stop || up || st.empty ? '' : blocker();
      const dim = up || (st.empty && !stop) || Boolean(block);
      const launch = opts.launch && LAUNCH.find(([mode]) => mode === cfg.mode);
      const label = (launch || MODES.find(([mode]) => mode === cfg.mode))[2];
      const stopSay = st.stopSay || '停止这一轮';
      const tip = stop ? stopSay : up ? '附件传完才能发' : st.empty ? '先写点内容' : block ? block
        : launch ? (label ? launch[4] : hint)
        : cfg.mode === 'timed' ? `${clock(cfg.at)} 自动发出`
        : cfg.mode === 'after' ? `等「${cfg.task.title}」完成后发出`
        : st.running ? '排队，这一轮结束后发出' : hint;
      view.stop = stop;
      view.dim = dim;
      view.halt = Boolean(st.running) && !stop;
      halt.dataset.tip = stopSay;
      el.classList.toggle('is-dim', dim);
      main.setAttribute('aria-label', stop ? '停止' : label || (st.running ? '排队发送' : hint));
      main.setAttribute('aria-disabled', String(dim));
      main.dataset.tip = tip;
      if (stop || dim) delete main.dataset.key; else main.dataset.key = opts.key ?? sendCaps().send;
      pickGlyph(glyph, stop ? 1 : 0);
      pickGlyph(optGlyph, launch ? launch[3] : cfg.mode === 'timed' ? 1 : cfg.mode === 'after' ? 2 : 0);
      want = up ? `上传中 ${typeof st.uploading === 'number' ? Math.round(st.uploading) : 0}%` : stop ? '' : label || (st.running ? '排队发送' : '');
      if (!busy) step();
    }

    /* 真的发出去。键是淡的、是停止键时都不发；提交那一刻按此刻的时钟再判一次 */
    function submit() {
      if (view.stop || view.dim) return false;
      if (blocker()) { render(); return false; }
      opts.onsend?.(cfg.mode, { at: cfg.at, time: cfg.at && clock(cfg.at), cron: cfg.cron, task: cfg.task });
      return true;
    }

    /* 发送设置（三档分段）和启动设置（五档一列）是同一张浮层：选了不收起，下面跟着这一档要填的那一样；
       再点尖角、按 Esc、点外面才收 */
    function openSettings() {
      const body = h('div.skey-body');
      const name = opts.launch ? '启动方式' : '发送方式';
      const head = opts.launch
        ? h('div.menu', { role: 'listbox', 'aria-label': name }, LAUNCH.map(([mode, label, , , say]) => h('button', { type: 'button', role: 'option', 'data-mode': mode, onclick: () => pick(mode) }, h('span', label), h('em', say))))
        : h('div.seg', { role: 'group', 'aria-label': name }, MODES.map(([mode, label]) => h('button', { type: 'button', 'data-mode': mode, onclick: () => pick(mode) }, label)));
      if (opts.launch) arrows(head);
      function pick(mode) {
        if (cfg.mode === mode) return;
        cfg.mode = mode;
        if (mode === 'timed' && !cfg.at) cfg.at = stamp(new Date(Date.now() + 3600e3));   /* 默认一小时后 */
        draw(true);
        render();
      }
      function draw(fresh) {
        for (const btn of head.children) btn.setAttribute(opts.launch ? 'aria-selected' : 'aria-pressed', String(btn.dataset.mode === cfg.mode));
        const note = h('p');
        if (cfg.mode === 'timed' || cfg.mode === 'cron') {
          const cron = cfg.mode === 'cron';
          const tell = () => { note.textContent = blocker() || (opts.launch ? '' : '到点自动发出，发出前可在待发送里撤回。'); };
          const input = cron ? h('input.field.num', { value: cfg.cron, placeholder: '分 时 日 月 周', 'aria-label': 'Cron 表达式', spellcheck: 'false' })
            : h('input.field.num', { type: 'datetime-local', value: cfg.at, min: stamp(new Date(Date.now() + 60e3)), 'aria-label': opts.launch ? '一次性运行时间' : '发送时间' });
          input.addEventListener('input', () => { cfg[cron ? 'cron' : 'at'] = input.value; tell(); render(); });
          tell();
          body.replaceChildren(input, note);
        } else if (cfg.mode === 'after' || cfg.mode === 'queue') {
          const queue = cfg.mode === 'queue';   /* 排队只能接在还没结束的任务后面 */
          const choose = (task) => { cfg.task = task; draw(false); render(); body.querySelector('[aria-selected="true"]')?.focus(); };
          const list = h('div.menu.sel-menu', { role: 'listbox', 'aria-label': queue ? '接在谁后面' : '等哪个任务完成' }, waitable().filter((task) => !queue || !STUCK[task.status])
            .map((task) => h('button', { type: 'button', role: 'option', 'aria-selected': String(task === cfg.task), onclick: () => choose(task) },
              h(`span.dot.${DOT[task.status]}`), h('span.cut.grow', task.title), STUCK[task.status] && h('small', '重跑完成后才发'))));
          arrows(list);
          note.textContent = queue ? (cfg.task ? `排在「${cfg.task.title}」之后，轮到它时自动开始。` : blocker())
            : cfg.task ? `等「${cfg.task.title}」完成后自动发出。` : '先选一个要等的任务，它完成后自动发出。';
          body.replaceChildren(list, note);
        } else {
          body.replaceChildren();
        }
        if (fresh) { body.classList.remove('enter'); void body.offsetWidth; body.classList.add('enter'); }
      }
      draw(false);
      const close = ASH.pop(opt, h(`div.skey-pop${opts.launch ? '.skey-launch' : ''}`, { role: 'dialog', 'aria-label': optName }, head, body), { place: 'top-end' });
      if (!close) return;
      /* 浮层开在键的上方：改成贴住下缘，换档时内容变高只往上长，不压到键 */
      if (parseFloat(close.el.style.top) > 8) {
        close.el.style.top = 'auto';
        close.el.style.bottom = `${innerHeight - opt.getBoundingClientRect().top + 6}px`;
      }
      head.querySelector('[aria-pressed="true"], [aria-selected="true"]')?.focus({ preventScroll: true });
    }

    render();
    const api = {
      el, main, opt, halt, submit,
      repaint: render,
      update(next) { Object.assign(st, next); render(); },
      open() { if (opt.getAttribute('aria-expanded') !== 'true') openSettings(); },
      reset() { if (cfg.mode !== 'now') { cfg.mode = 'now'; render(); } },
      set(next) { Object.assign(cfg, next); render(); },
      get mode() { return cfg.mode; },
      get time() { return cfg.at && clock(cfg.at); },
    };
    keys.add(api);
    return api;
  };
  Object.assign(ASH.sendKey, { mode: sendMode, caps: sendCaps, hit: sendHit });
})();
