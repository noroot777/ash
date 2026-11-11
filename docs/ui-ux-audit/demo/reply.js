/* 回复框（部件 reply）和全应用共用的那颗发送键 ASH.sendKey。
   发送键：const key = ASH.sendKey({ hint, key, size, launch, onsend(mode, detail), onstop(), onlayout() })
     key 不传 = 快捷键跟「发送键」设置走；launch：新建任务用的那一颗，尖角点开是「启动设置」五档，其余一样；onlayout：键刚变宽变窄、还没滑过去的那一刻
     key.el / key.main / key.opt；key.update({ empty, running, uploading })；key.submit()（回车走它，和点键同一个闸）；
     key.open() 打开发送设置；key.reset() 回到「立即发送」；key.set({ mode, at, task })；key.mode / key.time
     mode 是 'now' | 'timed' | 'after'（launch 时是 'now' | 'queue' | 'only' | 'timed' | 'cron'）；detail 是 { at, time, cron, task }；点停止时调 onstop()，没传就调 onsend('stop')。
     ASH.sendKey.mode() → 'enter' | 'mod'；ASH.sendKey.caps() → { send, newline }；ASH.sendKey.hit(keydown 事件) → 这一下算不算发送。
   回复框发出的事件：reply:send { text, files }（空闲时发）、reply:queue { text }（运行中发，进托盘）、reply:later { text, mode }（定时 / 等任务，进托盘）、
     reply:steer { text, taken }（引导会话：接的人把 taken 置 true）、reply:stop、reply:review { state }、reply:preview { open }、reply:handoff { to }。
     听的事件：run:state { running }、task:status { id, status }。
   回复框的方法：el、key（它的发送键）、value()、set(text)、clear()、focus()、takeQueued()、destroy()。 */
(() => {
  const { h, icon } = ASH;
  const EASE = 'cubic-bezier(0.22, 1, 0.36, 1)';
  ASH.icons.stopc = '<circle cx="8" cy="8" r="5.5"/><rect x="6" y="6" width="4" height="4" rx=".8"/>';

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
    const st = { empty: false, running: false, uploading: false };
    const cfg = { mode: 'now', at: '', cron: '', task: null };
    const view = { stop: false, dim: false };
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
    const el = h('span.skey', { 'data-size': opts.size === 36 ? '36' : '29' }, main, opt);

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
    /* 换字：旧字先淡出 80ms，键再变宽，新字淡入。连着变时只认最后一次 */
    function step() {
      if (want === shown) { busy = false; return; }
      if (ASH.reduced() || !el.isConnected || alike(shown, want)) { put(want); busy = false; return; }
      busy = true;
      txt.classList.add('is-out');
      setTimeout(() => {
        morph(() => put(want, true));
        txt.classList.remove('is-out');
        setTimeout(step, 200);
      }, shown ? 80 : 0);
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
      const tip = stop ? '停止这一轮' : up ? '附件传完才能发' : st.empty ? '先写点内容' : block ? block
        : launch ? (label ? launch[4] : hint)
        : cfg.mode === 'timed' ? `${clock(cfg.at)} 自动发出`
        : cfg.mode === 'after' ? `等「${cfg.task.title}」完成后发出`
        : st.running ? '排队，这一轮结束后发出' : hint;
      view.stop = stop;
      view.dim = dim;
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
    return {
      el, main, opt, submit,
      update(next) { Object.assign(st, next); render(); },
      open() { if (opt.getAttribute('aria-expanded') !== 'true') openSettings(); },
      reset() { if (cfg.mode !== 'now') { cfg.mode = 'now'; render(); } },
      set(next) { Object.assign(cfg, next); render(); },
      get mode() { return cfg.mode; },
      get time() { return cfg.at && clock(cfg.at); },
    };
  };
  Object.assign(ASH.sendKey, { mode: sendMode, caps: sendCaps, hit: sendHit });

  /* ---------- 回复框 ---------- */
  const FILES = [['回归截图.png', 248e3], ['review-gate.log', 12e3], ['裁定前后对比.png', 391e3]];
  const MACHINES = ['mac-studio', 'win-desk', 'nuc-lab'];   /* 和侧栏「其他机器」是同一批 */
  const ROW_ICON = { queue: 'queue', timed: 'clock', after: 'sand' };
  const LOG = ['$ npm -w web run dev -- --port 5174', '', '  VITE v6.0.3  ready in 412 ms', '', '  ➜  Local:   http://localhost:5174/', '  ➜  Network: use --host to expose',
    '', '14:02:11 [vite] hmr update /src/task-detail/ReplyBox.tsx', '14:02:36 [vite] hmr update /src/styles/task-reply.css', '14:05:02 [vite] page reload src/free-workflow/freeReviewCopy.ts'];
  const LINE = 20;   /* 输入区行高，和 reply.css 里的 textarea 对齐 */
  const MIN = 74;    /* 三行：20 × 3 + 上下内边距 14 */
  const size = (bytes) => (bytes >= 1e6 ? `${(bytes / 1e6).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1e3))} KB`);
  let fileNo = 0;
  let probe = null;
  /* 每 1px 字号对应多高的字形：用画布量真实字形，不拿行盒算（大写字母没有下伸部）。照 components/AgentPlate.tsx */
  function inkPer(style, text) {
    probe ??= document.createElement('canvas').getContext('2d');
    if (!probe) return 0.73;
    probe.font = `${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
    const m = probe.measureText(text);
    const ink = m.actualBoundingBoxAscent + m.actualBoundingBoxDescent;
    return ink > 0 ? ink / (parseFloat(style.fontSize) || 1) : 0.73;
  }

  /* 截图批注、预览日志开的那种对话框：外壳是公共的 .veil + .dlg。Esc 或点遮罩关，Tab 不出框，关掉后焦点回到触发处 */
  function sheet(title, body, acts, back) {
    const close = () => {
      removeEventListener('keydown', onKey, true);
      veil.classList.remove('is-in');
      setTimeout(() => veil.remove(), 130);
      back?.focus({ preventScroll: true });
    };
    const dlg = h('div.dlg.reply-dlg', { role: 'dialog', 'aria-modal': 'true', 'aria-label': title }, h('h2', title), body, h('div.dlg-acts', acts(close)));
    const veil = h('div.veil', { onpointerdown: (e) => { if (e.target === veil) close(); } }, dlg);
    const onKey = (e) => {
      if (e.key === 'Escape') { e.stopPropagation(); close(); }
      if (e.key !== 'Tab') return;
      const all = [...dlg.querySelectorAll('button:not([disabled]), [tabindex="0"]')];
      e.preventDefault();
      all[(all.indexOf(document.activeElement) + (e.shiftKey ? -1 : 1) + all.length) % all.length]?.focus();
    };
    addEventListener('keydown', onKey, true);
    document.body.append(veil);
    requestAnimationFrame(() => veil.classList.add('is-in'));
    dlg.querySelector('button:not([disabled])')?.focus();
    return veil;
  }

  ASH.part('reply', {
    mount(el, ctx) {
      const task = ASH.data.tasks.find((t) => t.id === ASH.data.current);
      const first = ASH.AGENTS[ctx?.agent ?? task?.agent] ? (ctx?.agent ?? task.agent) : 'claude';
      let who = { agent: first, model: ASH.AGENTS[first].models[0], level: 'high' };
      let running = Boolean(ctx?.running ?? ASH.parts.live?.running);
      let uploading = 0;
      let pinned = null;      /* 拖出来的高度；null = 跟着行数长 */
      let reviewing = 0;
      let armed = false;      /* 预约了复审：这一轮正常结束后自动开审 */
      let preview = 'off';    /* off / starting / on */
      let previewTimer = 0;
      let rehearsal = 0;
      const queue = [];
      const files = [];

      /* 水印：最底层，写着这一回合由谁来跑；换智能体时换词并重播进场。字号按框实测求解：字宽、字形高各占框的八成，取紧的那个。
         对照清单的圆圈要落在字上，所以另放一个不可见的框（mark）套住字形本身，水印自己的值一个不动。 */
      let word = h('span', who.agent);
      const mark = h('i', { 'data-m': 'reply-keep' });
      const plate = h('div.reply-plate', { 'aria-hidden': 'true' }, word, mark);
      function fit() {
        const style = getComputedStyle(word);
        const widthPer = word.offsetWidth / (parseFloat(style.fontSize) || 1);
        if (!widthPer) return;
        const next = Math.max(12, Math.min((box.clientWidth * 0.8) / widthPer, (box.clientHeight * 0.8) / inkPer(style, word.textContent)));
        plate.style.setProperty('--plate-size', `${next}px`);
        mark.style.width = `${widthPer * next}px`;
        mark.style.height = `${inkPer(style, word.textContent.toUpperCase()) * next}px`;
      }
      function setWord(name) { const next = h('span', name); word.replaceWith(next); word = next; fit(); }

      const ta = h('textarea', { rows: '3', placeholder: '回复…', 'aria-label': '回复任务', 'data-m': 'reply-1' });
      const tray = h('div.reply-list', { role: 'list', 'aria-label': '待发送消息' });
      const shelf = h('div.reply-list', { role: 'list', 'aria-label': '附件' });
      const key = ASH.sendKey({ onsend: send, onstop: stop, onlayout: () => fitActs() });
      key.opt.dataset.m = 'reply-2';
      key.main.dataset.m = 'reply-4';
      /* 三段胶囊：改的是这个任务以后都由谁跑；换智能体时水印跟着换词 */
      const caps = ASH.target({ value: who, label: '这个任务以后由谁来跑', place: 'top-start', onchange: (next) => {
        const swapped = next.agent !== who.agent;
        who = next;
        if (swapped) setWord(next.agent);
      } });

      /* ---------- 底排的动作：附件、派审、预览、接力在明面，截图批注和预览日志进「更多」 ---------- */
      const act = (name, onclick, attrs) => h('button.btn.quiet.sm', { type: 'button', onclick, ...attrs }, icon(name), h('span'));
      function startReview() {
        if (reviewing) return;
        ASH.emit('reply:review', { state: 'start' });
        reviewing = setTimeout(() => { reviewing = 0; paintActs(); }, 2600);
        paintActs();
      }
      /* 任务在跑时派不了审，只能预约「这一轮结束后开审」；再点一次取消 */
      const reviewBtn = act('search', () => {
        if (reviewing) return;
        if (!running) { startReview(); return; }
        armed = !armed;
        ASH.emit('reply:review', { state: armed ? 'armed' : 'idle' });
        paintActs();
      });
      /* 预览要起一会儿，这段时间里这颗键是「取消」 */
      const previewBtn = act('monitor', () => {
        clearTimeout(previewTimer);
        if (preview === 'off') {
          preview = 'starting';
          previewTimer = setTimeout(() => { preview = 'on'; paintActs(); ASH.emit('reply:preview', { open: true }); }, 1600);
        } else {
          if (preview === 'on') ASH.emit('reply:preview', { open: false });
          preview = 'off';
        }
        paintActs();
      });
      const handBtn = act('send', () => ASH.menu(handBtn, MACHINES.map((name) => ({ label: name, icon: 'monitor', onpick: async () => {
        const yes = await ASH.confirm({ title: `接力到 ${name}`, body: '等这一轮安全停稳后，代码、历史和附件一起移过去，本机保留历史存档。', ok: '开始接力' });
        if (yes) ASH.emit('reply:handoff', { to: name });
      } })), { place: 'top-start' }), { 'aria-haspopup': 'menu', 'aria-label': '接力到…', 'data-tip': '把这个任务移到另一台机器接着跑' });
      handBtn.lastChild.textContent = '接力到…';
      function paintActs(quick) {
        const set = (btn, label, tip) => {
          if (quick) btn.lastChild.textContent = label; else ASH.swap(btn.lastChild, label);
          btn.setAttribute('aria-label', label);
          btn.dataset.tip = tip;
        };
        if (reviewing) set(reviewBtn, '审查中 1/2', '第 1 轮，最多 2 轮');
        else if (running) set(reviewBtn, armed ? '已预约复审' : '预约复审', armed ? '这一轮结束后自动开审，再点取消预约' : '这一轮结束后自动开审');
        else set(reviewBtn, '再审', '再派一轮审查');
        reviewBtn.lastChild.classList.toggle('shim', Boolean(reviewing));
        reviewBtn.setAttribute('aria-pressed', String(armed && running && !reviewing));
        if (preview === 'on') set(previewBtn, '关闭预览', '停掉预览服务');
        else if (preview === 'starting') set(previewBtn, '启动中·点此取消', '不等了，取消启动');
        else set(previewBtn, '打开预览', '把这次改动跑起来看');
        previewBtn.lastChild.classList.toggle('shim', preview === 'starting');
        previewBtn.setAttribute('aria-pressed', String(preview === 'on'));
        previewBtn.firstChild.replaceWith(icon(preview === 'on' ? 'stopc' : 'monitor'));
        previewBtn.disabled = running;   /* 有回合在改代码时不让起预览 */
      }

      const copy = (text) => { try { navigator.clipboard?.writeText(text)?.catch(() => {}); } catch { /* file:// 下可能没有剪贴板 */ } };
      const showLog = () => sheet('预览日志', h('pre.reply-log', { tabindex: '0', 'aria-label': '预览日志' }, LOG.join('\n')), (close) => [
        h('button.btn', { type: 'button', onclick: () => copy(LOG.join('\n')) }, icon('copy'), '复制'),
        h('button.btn', { type: 'button', onclick: close }, '关闭')], moreBtn);
      /* 截图批注：选一张图（粘贴或上传），在图上点出几处意见，连同标注图单独发成一条回复 */
      function annotate() {
        let count = 0;
        const input = h('input', { type: 'file', accept: 'image/*', hidden: true, onchange: () => { if (input.files[0]) show(input.files[0]); } });
        const stage = h('div.reply-shot', h('b', '选一张截图，开始圈画'), h('p', '直接粘贴图片（⌘V），或从电脑上传。'),
          h('button.btn', { type: 'button', onclick: () => input.click() }, icon('image'), '选择图片'), input);
        const say = h('p');
        const sendBtn = h('button.btn.pri', { type: 'button', disabled: true }, running ? '排队发送批注' : '发送批注');
        function show(file) {
          const board = h('button.reply-shot-img', { type: 'button', 'aria-label': '在图上点一下，加一处意见' }, h('img', { src: URL.createObjectURL(file), alt: file.name }));
          board.addEventListener('click', (e) => {
            const r = board.getBoundingClientRect();
            const at = e.detail ? [(e.clientX - r.left) / r.width, (e.clientY - r.top) / r.height] : [0.5, 0.5];   /* 键盘点的落在正中 */
            board.append(h('i.enter', { style: { left: `${at[0] * 100}%`, top: `${at[1] * 100}%` } }, String(++count)));
            say.textContent = `${count} 条意见 + 1 张标注图，将单独回复给 ${who.agent}`;
            sendBtn.disabled = false;
          });
          stage.replaceChildren(board, say);
          board.focus();
        }
        const veil = sheet('截图批注', stage, (close) => {
          sendBtn.onclick = () => { close(); post(`截图批注：${count} 条意见，附 1 张标注图`); };
          return [h('button.btn', { type: 'button', onclick: close }, '关闭'), sendBtn];
        }, moreBtn);
        veil.addEventListener('paste', (e) => {
          const file = [...(e.clipboardData?.files ?? [])].find((f) => f.type.startsWith('image/'));
          if (file) { e.preventDefault(); show(file); }
        });
      }
      const clipBtn = h('button.ico', { type: 'button', 'aria-label': '上传附件', 'data-tip': '上传附件，也可直接粘贴', onclick: () => attach() }, icon('clip'));
      const moreBtn = h('button.ico', { type: 'button', 'aria-label': '更多', 'aria-haspopup': 'menu', 'data-tip': '更多',
        onclick: () => ASH.menu(moreBtn, [{ label: '截图批注', icon: 'edit', onpick: annotate }, { label: '预览日志', icon: 'term', onpick: showLog }], { place: 'top-start' }) }, icon('more'));

      /* 顶边的拖动条：往上拖把输入区拉高，双击回到跟着行数长；方向键也能调。照 task-detail/ReplyResizeHandle.tsx */
      const ceiling = () => Math.max(MIN, Math.min(560, innerHeight - 260));
      const pinTo = (px) => { pinned = px == null ? null : Math.max(MIN, Math.min(ceiling(), Math.round(px))); grow(); };
      const grip = h('div.reply-grip', { role: 'separator', tabindex: '0', 'aria-orientation': 'horizontal', 'aria-label': '拖动调整回复框高度，双击恢复按输入行数自动撑高',
        ondblclick: () => pinTo(null),
        onpointerdown: (e) => {
          if (e.button !== 0) return;
          e.preventDefault();
          const from = ta.offsetHeight + e.clientY;
          const move = (next) => pinTo(from - next.clientY);
          grip.classList.add('is-on');
          addEventListener('pointermove', move);
          addEventListener('pointerup', () => { grip.classList.remove('is-on'); removeEventListener('pointermove', move); }, { once: true });
        },
        onkeydown: (e) => {
          const to = { ArrowUp: ta.offsetHeight + 10, ArrowDown: ta.offsetHeight - 10, Home: MIN, End: ceiling() }[e.key];
          if (to == null) return;
          e.preventDefault();
          pinTo(to);
        } });

      const spacer = h('span.grow');
      const acts = h('div.reply-acts', { 'data-m': 'reply-3' }, clipBtn, reviewBtn, previewBtn, handBtn, moreBtn, spacer, caps.el, key.el);
      /* 底排放不下时按次序让：先把没有状态的动作收成图标（审查中、启动中、已预约这些有话要说的照样带字），
         再把胶囊收成只剩智能体，最后才换行。每次从最宽的样子量起，左右两组中间还有空就停 */
      function fitActs() {
        for (let level = 0; level < 4; level++) {
          acts.dataset.tight = level;
          if (spacer.offsetWidth > 0) break;
        }
      }
      const box = h('div.reply-box', grip, plate, ta, acts);
      const root = h('div.reply', h('div.reply-col', tray, shelf, box));

      /* ---------- 输入区：三行起步，随内容长到最多 12 行（且不过窗口的四成）；拖过就以拖的为准 ---------- */
      function grow() {
        ta.style.height = 'auto';
        const full = ta.scrollHeight;
        const next = pinned ?? Math.min(full, LINE * 12 + 14, Math.max(MIN, Math.round(innerHeight * 0.4)));
        ta.style.height = `${next}px`;
        ta.style.overflowY = full > next ? 'auto' : 'hidden';
      }
      const sync = () => key.update({ empty: !ta.value.trim() && !files.some((file) => !file.timer), running, uploading: uploading || false });
      ta.addEventListener('input', () => { grow(); sync(); });
      ta.addEventListener('keydown', (e) => { if (sendHit(e)) { e.preventDefault(); key.submit(); } });
      ta.addEventListener('paste', (e) => {
        const file = e.clipboardData?.files?.[0];
        if (file) { e.preventDefault(); attach(file.name, file.size); }
      });

      /* ---------- 框上方的状态：待发送的消息、附件。没有就不占高度 ---------- */
      function addRow(list, host, item, parts) {
        item.row = h('div.reply-row', { role: 'listitem' }, parts);
        list.push(item);
        ASH.flip(host, () => host.append(item.row));
        return item;
      }
      function dropRow(list, item) {
        const i = list.indexOf(item);
        if (i < 0) return;
        list.splice(i, 1);
        clearTimeout(item.due);
        const host = item.row.parentElement;
        item.row.classList.add('is-out');
        setTimeout(() => { if (host?.isConnected) ASH.flip(host, () => item.row.remove()); }, ASH.reduced() ? 0 : 120);
        paintRows();
      }
      /* 现在就发：任务在跑就排队，空闲就直接发 */
      function post(text, names = []) {
        if (running) { hold('queue', text, { names }); ASH.emit('reply:queue', { text }); } else ASH.emit('reply:send', { text, files: names.map((file) => file.name) });
      }
      /* 引导会话：不等这一轮结束，把最早排着的那条现在就接进对话。没人接这个事件时自己把气泡放进会话，不让它凭空消失 */
      function steer(item) {
        dropRow(queue, item);
        if (!running) { ASH.emit('reply:send', { text: item.text, files: [] }); return; }
        const msg = { text: item.text, taken: false };
        ASH.emit('reply:steer', msg);
        const bubble = !msg.taken && ASH.feedKit?.user?.(item.text, '刚刚');
        if (!bubble) return;
        bubble.classList.add('enter');
        ASH.parts.feed?.pin?.();
        ASH.parts.feed?.append?.(bubble);
      }
      function hold(kind, text, more = {}) {
        const item = { kind, text, names: [], ...more, status: more.task?.status };
        const withdraw = () => {
          dropRow(queue, item);
          api.set([item.text, ta.value].filter(Boolean).join('\n'));
          for (const file of item.names) attach(file.name, file.size, true);
          if (kind === 'after' || (kind === 'timed' && new Date(item.at).getTime() > Date.now())) key.set({ mode: kind, at: item.at ?? '', task: item.task ?? null });
          ta.focus();
        };
        item.when = h('small.cut.num');
        item.steer = h('button.btn.quiet.sm', { type: 'button', hidden: true, 'data-tip': '不等这一轮结束，现在就接进对话', onclick: () => steer(item) }, icon('chat'), '引导会话');
        item.now = h('button.btn.quiet.sm', { type: 'button', hidden: true, 'data-tip': '不再等它，现在发出', onclick: () => { dropRow(queue, item); post(item.text, item.names); } }, icon('send'), '直接发送');
        addRow(queue, tray, item, [icon(ROW_ICON[kind], 'sm'), h('span.cut.grow', text), item.when, item.steer, item.now,
          h('button.ico.sm', { type: 'button', 'aria-label': `撤回「${text}」，内容放回输入框`, 'data-tip': '撤回，放回输入框', onclick: withdraw }, icon('undo'))]);
        if (kind === 'timed') item.due = setTimeout(() => { dropRow(queue, item); post(text, item.names); }, Math.min(new Date(item.at).getTime() - Date.now(), 2 ** 31 - 1));
        paintRows();
      }
      /* 每一行右边那句话，和两颗只在特定时候出现的按钮：「引导会话」只在最早排队的那条上；「直接发送」只在等的任务不会再完成时 */
      function paintRows() {
        const head = queue.find((item) => item.kind === 'queue');
        for (const item of queue) {
          const stuck = item.kind === 'after' && STUCK[item.status];
          item.when.textContent = item.kind === 'queue' ? '排队中' : item.kind === 'timed' ? clock(item.at) : stuck ? `「${item.task.title}」${stuck}` : `等「${item.task.title}」完成`;
          item.when.classList.toggle('is-stuck', Boolean(stuck));
          item.steer.hidden = item !== head;
          item.now.hidden = !stuck;
        }
      }
      function attach(name, bytes, done) {
        if (uploading && !done) return;
        const [fileName, fileBytes] = name ? [name, bytes] : FILES[fileNo++ % FILES.length];
        const state = h('small.num', done ? size(fileBytes) : `上传中 1% · ${size(fileBytes)}`);
        const item = { name: fileName, size: fileBytes, timer: 0 };
        const remove = () => { if (item.timer) { clearInterval(item.timer); item.timer = 0; uploading = 0; } dropRow(files, item); sync(); };
        addRow(files, shelf, item, [icon(/\.(png|jpe?g|gif|webp)$/i.test(fileName) ? 'image' : 'file', 'sm'), h('span.cut.grow', fileName), state,
          h('button.ico.sm', { type: 'button', 'aria-label': `移除 ${fileName}`, 'data-tip': '移除', onclick: remove }, icon('x'))]);
        if (done) { sync(); return; }
        uploading = 1;
        item.timer = setInterval(() => {
          uploading = Math.min(100, uploading + 18);
          if (uploading < 100) { state.textContent = `上传中 ${uploading}% · ${size(fileBytes)}`; sync(); return; }
          clearInterval(item.timer);
          item.timer = 0;
          uploading = 0;
          ASH.swap(state, size(fileBytes));
          sync();
        }, 260);
        sync();
      }

      /* ---------- 发送与停止 ---------- */
      function send(mode, detail) {
        const body = ta.value.trim();
        const names = files.map((file) => ({ name: file.name, size: file.size }));
        const text = body || `[${names.length} 个附件]`;
        if (mode !== 'now') {
          hold(mode, text, { at: detail.at, task: detail.task, names });
          ASH.emit('reply:later', { text, mode });
          key.reset();
        } else post(text, names);
        for (const file of [...files]) dropRow(files, file);
        api.clear();
      }
      const setRunning = (next) => { running = next; paintActs(); sync(); };
      function stop() {
        ASH.emit('reply:stop');
        if (rehearsal) { clearTimeout(rehearsal); rehearsal = 0; setRunning(false); }
      }

      const api = {
        el: root,
        key,
        value: () => ta.value,
        set(next) { ta.value = next ?? ''; grow(); sync(); },
        clear() { api.set(''); },
        focus() { ta.focus(); },
        takeQueued() {
          const item = queue.find((it) => it.kind === 'queue');
          if (item) dropRow(queue, item);
          return item?.text ?? null;
        },
        destroy() {
          for (const off of offs) off();
          for (const ob of [watch, tidy]) ob.disconnect();
          for (const id of [reviewing, previewTimer, rehearsal, ...queue.map((item) => item.due)]) clearTimeout(id);
          for (const file of files) clearInterval(file.timer);
          delete ASH.prep['reply-2'];
          delete ASH.prep['reply-4'];
        },
      };

      el.replaceChildren(root);
      const watch = new ResizeObserver(() => { fit(); fitActs(); });
      watch.observe(box);
      const tidy = new MutationObserver(fitActs);   /* 按钮上的字、键上的字、胶囊里的字一变就重量；它自己只改 data-tight，不会绕回来 */
      tidy.observe(acts, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ['class', 'aria-pressed'] });
      document.fonts?.ready.then(fit);
      const offs = [
        ASH.on('run:state', (state) => setRunning(Boolean(state?.running))),
        ASH.on('task:status', ({ id, status } = {}) => {
          if (id === ASH.data.current) {
            /* 预约的那一轮审查：这一轮正常结束、托盘里也没有排着的消息了才开 */
            if (status === 'done' && armed && !queue.some((item) => item.kind === 'queue')) { armed = false; startReview(); }
            return;
          }
          for (const item of queue.filter((it) => it.kind === 'after' && it.task.id === id)) {
            item.status = status;
            if (status === 'done') { dropRow(queue, item); post(item.text, item.names); }
          }
          paintRows();
        }),
      ];
      /* 对照清单：发送设置要先打开；停止键要任务在跑才有——真跑一轮（没有执行模拟时自己演 4 秒） */
      ASH.prep['reply-2'] = () => key.open();
      ASH.prep['reply-4'] = () => {
        if (running) return;
        if (ASH.parts.live?.play) { ASH.parts.live.play('run'); return; }
        setRunning(true);
        rehearsal = setTimeout(() => { rehearsal = 0; setRunning(false); }, 4000);
      };
      paintActs(true);
      grow();
      sync();
      return api;
    },
  });
})();
