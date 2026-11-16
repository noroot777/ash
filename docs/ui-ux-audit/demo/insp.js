/* 右侧面板（改后）：这个文件是外壳（竖轨、面板头、开合、快捷键）和各格共用的账。
   十一格的内容在另外三个文件里，各自把造法登记到 ASH.insp：
     insp-panes.js  信息、文件、生成物、改动（看任务本身、看它改了什么）
     insp-work.js   备忘、工作流、审查、预览指正、哨兵（跟它一起干活）
     insp-talk.js   子智能体、侧聊（它派出去的、你另开的那几路话）
   竖轨的形态、格数、次序、图标、快捷键都照现在的产品；改的是：选中只有一种长相、状态变成小点、
   分三簇、再点一次收起、摘掉的格不自己回来（信息、哨兵、子智能体照旧：下次进来还在）。
   对外：ASH.parts.insp = { open(pane, opts), shut(bool), setUsage(u), destroy() }
   发 insp:state { shut, pane }、task:status（信息格的状态下拉）、changes:open、diff:open { path }、file:open { path }、folder:open { path }、
     preview:open、files:reveal { name? }、queue:open（这几个去处别处接，没画的由 app.js 说一句）。
   听 insp:toggle { shut? }、insp:open { pane, round?, quote? }、task:status、run:state、reply:send、
   usage { turn, ctx, files, add, del, elapsedMs, agent?, commit? }——带 turn 的是「一轮跑完了」：这一轮的量记到 agent（缺省 claude）
   那一行、轮数加一、用时累加；files / add / del 是跑完之后的总数，ctx 是上下文还剩百分之几。同一轮报两遍只记一次。
   不带 turn 的按绝对值设（tokens 是 claude 那一行的累计）。审查的事各格直接读 ASH.review、听 review:change。 */
(() => {
  const { h, icon } = ASH;
  const I = (ASH.insp ??= { build: {}, packs: [] });

  /* 竖轨上的图标照现在的产品（文件夹是打开的、生成物是两张叠着的图、改动是合并请求、备忘带笔、侧聊是两个气泡） */
  const ICONS = {
    folderOpen: '<path d="M2.5 12.5v-8a1 1 0 0 1 1-1h2.6l1.4 1.5h4a1 1 0 0 1 1 1V7"/><path d="m2.5 12.5 1.7-4.8a1 1 0 0 1 1-.7h8a.7.7 0 0 1 .6 1l-1.6 4.5z"/>',
    images: '<rect x="4.5" y="2.5" width="9" height="8.5" rx="1.5"/><path d="M2.5 5.5V12A1.5 1.5 0 0 0 4 13.5h7.5M4.8 9.2l2.3-2.3 2.2 2.2 1.4-1.4 2.6 2.6"/>',
    pull: '<circle cx="4" cy="3.5" r="1.5"/><circle cx="4" cy="12.5" r="1.5"/><circle cx="12" cy="12.5" r="1.5"/><path d="M4 5v6M12 11V7a3 3 0 0 0-3-3H7.5M9.3 2.2 7.5 4l1.8 1.8"/>',
    notePencil: '<path d="M13 8.5V12a1.5 1.5 0 0 1-1.5 1.5h-7A1.5 1.5 0 0 1 3 12V5a1.5 1.5 0 0 1 1.5-1.5H8"/><path d="m7 9.5.4-2.2 4.9-4.9 1.8 1.8-4.9 4.9z"/>',
    chats: '<path d="M2.5 3.5a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1V8a1 1 0 0 1-1 1h-4l-3 2.2z"/><path d="M10.5 5.5h2a1 1 0 0 1 1 1v6.7l-3-2.2h-4a1 1 0 0 1-1-1V9"/>',
    shuffle: '<path d="M2 4.5h2c3.2 0 4.3 7 7.5 7H14M2 11.5h2c1.2 0 2.1-1 2.9-2.2M9.2 6.6c.7-1.2 1.4-2.1 2.3-2.1H14M12 2.5l2 2-2 2M12 9.5l2 2-2 2"/>',
    browser: '<rect x="2" y="3" width="12" height="10" rx="2"/><path d="M2 6.5h12"/>',
    branch: '<circle cx="4.5" cy="3.5" r="1.5"/><circle cx="4.5" cy="12.5" r="1.5"/><circle cx="11.5" cy="5" r="1.5"/><path d="M4.5 5v6M11.5 6.5c0 2.6-7 1.6-7 4.5"/>',
    tree: '<path d="M3 2.5v9h3.5M3 6h3.5"/><rect x="6.5" y="4.5" width="6.5" height="3" rx="1"/><rect x="6.5" y="10" width="6.5" height="3" rx="1"/>',
    code: '<path d="M5.5 4.5 2 8l3.5 3.5M10.5 4.5 14 8l-3.5 3.5M9 3 7 13"/>',
    minus: '<path d="M3.5 8h9"/>',
    eyeOff: '<path d="m2.5 2.5 11 11M6.5 6.6a2 2 0 0 0 2.9 2.8M4.6 4.7C2.7 5.9 1.5 8 1.5 8s2.4 4.5 6.5 4.5c1.1 0 2-.3 2.9-.8M7 3.6c.3-.1.7-.1 1-.1 4.1 0 6.5 4.5 6.5 4.5s-.6 1.1-1.7 2.2"/>',
  };
  for (const [name, path] of Object.entries(ICONS)) ASH.icons[name] ??= path;

  /* 次序就是竖轨的次序；g 是第几簇（看任务本身｜看它改了什么｜跟它一起干活）；on = 默认在条上。
     子智能体、哨兵「用过才浮现」：这个任务两样都用过，所以都在条上。 */
  const PANES = [
    { id: 'info', name: '信息', icon: 'info', key: 'i', g: 1, on: true },
    { id: 'files', name: '文件', icon: 'folderOpen', key: 'f', g: 2, on: true },
    { id: 'made', name: '生成物', icon: 'images', key: 'a', g: 2, on: true },
    { id: 'scm', name: '改动', icon: 'pull', key: 'g', g: 2, on: true },
    { id: 'agents', name: '子智能体', icon: 'bot', key: 's', g: 3, on: true },
    { id: 'memo', name: '备忘', icon: 'notePencil', key: 'b', g: 3, on: true },
    { id: 'chat', name: '侧聊', icon: 'chats', key: 'c', g: 3, on: true },
    { id: 'flow', name: '工作流', icon: 'shuffle', key: 'w', g: 3, on: true },
    { id: 'review', name: '审查', icon: 'search', key: 'r', g: 3, on: true },
    { id: 'preview', name: '预览指正', icon: 'browser', key: 'p', g: 3, on: true },
    { id: 'watch', name: '哨兵', icon: 'pulse', key: 'm', g: 3, on: true },
  ];
  const ALIAS = { changes: 'scm', diff: 'scm', artifacts: 'made', memos: 'memo', 'side-chat': 'chat', workflow: 'flow', monitors: 'watch', subagents: 'agents' };
  const CELL = 32, GAP = 2, BREAK = 8, PAD = 4, INK = 20;   // 和 insp.css 里竖轨的尺寸是一套
  const CHORD_MS = 1000;                                    // I 加字母：和现在一样等一秒
  const KNOWN = ['running', 'waiting', 'paused', 'failed', 'queued', 'stopped', 'backlog', 'done'];
  /* 这一次打开样机期间记住的三样：你摘掉 / 加回的格、停在哪一格、整栏收没收。切到别的面再回来不会被重置。
     三格不记「摘掉」，照现在的产品：信息是必开格，下次打开面板它自己补回来；哨兵、子智能体是「用过才浮现」，这个任务用过，重新进来还会冒出来 */
  const mem = { off: new Set(), on: new Set(), pane: 'info', shut: false };
  const COMES_BACK = ['info', 'watch', 'agents'];

  /* ---------- 各格共用的小件：六个公共件的造法，加几个小动作 ---------- */
  const sec = (text, count, ...tail) => h('h4.sec', {}, text, count != null && h('b', {}, count), tail);
  /* 一行「标签 值」。要跟着状态出没的那几行先用 pair 造好，再交给 kv */
  const pair = (label, ...value) => {
    const dt = h('dt', label);
    const dd = h('dd', {}, value);
    return { dt, dd, show(on) { dt.hidden = !on; dd.hidden = !on; } };
  };
  /* 几行「标签 值」跟着状态出没（rows 是 [[pair, 在不在], …]）：要走的先淡出 120ms，新来的淡入，其余的行滑到新位置 */
  const showRows = (list, rows) => {
    const apply = () => { for (const [row, on] of rows) row.show(on); };
    if (ASH.reduced() || !list.isConnected) { apply(); return; }
    const going = rows.filter(([row, on]) => !on && !row.dt.hidden).flatMap(([row]) => [row.dt, row.dd]);
    const fades = going.map((el) => el.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 120, easing: 'ease-in', fill: 'forwards' }));
    setTimeout(() => { for (const fade of fades) fade.cancel(); ASH.flip(list, apply); }, going.length ? 120 : 0);
  };
  const kv = (...rows) => h('dl.kv', {}, rows.filter(Boolean).flatMap((r) => (Array.isArray(r) ? [h('dt', r[0]), h('dd', {}, r.slice(1))] : r instanceof Node ? [r] : [r.dt, r.dd])));
  const go = (label, onclick, meta) => h('button.go', { type: 'button', onclick }, h('span.cut', label), meta, icon('chev'));
  const none = (text, action, onclick) => h('div.none', {}, h('p', text), action && h('button.btn', { type: 'button', onclick }, action));
  const reenter = (el) => { el.classList.remove('enter'); void el.offsetWidth; el.classList.add('enter'); };
  const fold = (btn, target, open = btn.getAttribute('aria-expanded') !== 'true') => {
    btn.setAttribute('aria-expanded', String(open));
    target.hidden = !open;
    if (open) reenter(target);
    return open;
  };
  /* 退场：120ms 淡出，再真的拿走 */
  const leave = (node, done) => {
    if (ASH.reduced() || !node.isConnected) { done(); return; }
    node.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 120, easing: 'ease-in' }).onfinish = done;
  };
  /* 面板头、行尾的小图标钮 */
  const tool = (glyph, label, onclick, attrs = {}) => h('button.ico.sm', { type: 'button', 'aria-label': label, 'data-tip': label, onclick, ...attrs }, icon(glyph));
  const copyBtn = (text, label) => {
    const btn = tool('copy', label, () => {
      try { navigator.clipboard?.writeText(text)?.catch(() => {}); } catch { /* file:// 下可能没有剪贴板 */ }
      btn.replaceChildren(icon('check'));
      btn.dataset.tip = '已复制';
      clearTimeout(btn._t);
      btn._t = setTimeout(() => { btn.replaceChildren(icon('copy')); btn.dataset.tip = label; }, 1400);
    });
    btn.classList.add('insp-copy');
    return btn;
  };
  /* 多行输入随内容长高；返回的函数把它清空、收回一行 */
  const grow = (area) => {
    area.addEventListener('input', () => { area.style.height = 'auto'; area.style.height = `${area.scrollHeight}px`; });
    return () => { area.value = ''; area.style.height = ''; };
  };
  const big = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(2)}M` : ASH.num(n));   // 用量：21.40M，和现在一样留两位
  const clock = ASH.clock;
  I.kit = { sec, pair, showRows, kv, go, none, reenter, fold, leave, tool, copyBtn, grow, big, clock };
  const { branch, dir, session } = ASH.data.cur;
  I.data = { branch, dir, session, resume: `claude --resume ${session}` };

  /* ---------- 面板里的账：跟着任务走，不跟着页面 ----------
     各格只造一次。切到别的面再回来，新审的轮次、写的备忘、侧聊、哨兵都还在；不在眼前的时候事件照收
     （一轮在后台跑完，回来时工作流、审查、用量都是对的）。每次进任务页重画的只有外壳：竖轨和面板头。
     c 是交给各格的控制器：c.acts[格] 是面板头上这一格自己的动作；c.on / c.emit 是这一栏内部的事件
     （usage、status、run、send、show:<格>）；c.mark 画竖轨上那颗点 */
  const cores = {};
  function coreOf(task) {
    if (cores[task.id]) return cores[task.id];
    const subs = {};
    const waiting = [];
    const told = new Set();   // 记过的那几轮：回到任务页时 live 会把跑完的每一轮再报一遍，同一轮只记一次
    const st = { status: KNOWN.includes(task.status) ? task.status : 'done', accepted: Boolean(task.accepted) };
    const core = { st, els: {}, marks: {}, shell: null, built: false, running: false };
    const c = core.c = {
      task, st, acts: {},
      open: (id, opts) => core.shell?.open(id, opts),
      on: (evt, fn) => { (subs[evt] ??= []).push(fn); },
      emit: (evt, ...args) => { for (const fn of subs[evt] ?? []) fn(...args); },
      setActs(id, nodes) { c.acts[id] = nodes; core.shell?.acts(id); },
      /* kind：'has' 里面有东西（灰点）、'run' 有东西在跑（主色点）、空 = 不画；n 是提示里跟着的个数 */
      mark(id, kind, n) { core.marks[id] = { kind, n }; core.shell?.mark(id); },
    };
    core.whenBuilt = (fn) => { if (core.built) fn(); else waiting.push(fn); };
    core.usage = (u) => {
      if (u.turn != null && typeof u.elapsedMs === 'number') {
        const key = [u.turn, u.elapsedMs, u.files, u.add, u.del].join('|');
        if (told.has(key)) return;
        told.add(key);
      }
      core.whenBuilt(() => c.emit('usage', u));
    };
    /* 任务状态：和任务头同一套规矩——「验收完成」是完成加一枚章；重新跑起来、重新排队、改回完成都把章摘掉 */
    core.setStatus = (next, flag) => {
      const prev = { ...st };
      if (next === 'accepted') { st.status = 'done'; st.accepted = true; }
      else if (KNOWN.includes(next)) {
        st.status = next;
        if (typeof flag === 'boolean') st.accepted = flag;
        else if (next === 'done' || next === 'running' || next === 'queued') st.accepted = false;
      } else return;
      if (prev.status !== st.status || prev.accepted !== st.accepted) c.emit('status', st, prev);
    };
    const mine = () => ASH.data.current === task.id;
    ASH.on('usage', (u) => { if (mine()) core.usage(u ?? {}); });
    ASH.on('task:status', (d = {}) => { if (d.id === task.id) core.whenBuilt(() => core.setStatus(d.status, d.accepted)); });
    ASH.on('run:state', (d = {}) => {
      const next = Boolean(d.running);
      if (!mine() || next === core.running) return;
      core.running = next;
      core.whenBuilt(() => c.emit('run', next));
    });
    ASH.on('reply:send', (d = {}) => { if (mine()) core.whenBuilt(() => c.emit('send', d.text)); });

    const build = () => {
      for (const pack of I.packs.splice(0)) pack(I);
      for (const p of PANES) core.els[p.id] = h('div.insp-pane', { 'data-pane': p.id, hidden: true }, I.build[p.id]?.(c));
      core.built = true;
      core.shell?.attach();
      for (const fn of waiting.splice(0)) fn();
    };
    build();
    return (cores[task.id] = core);
  }

  /* ---------- 外壳：竖轨、面板头、开合、快捷键 ---------- */
  ASH.part('insp', { mount(el, ctx = {}) {
    const task = ASH.data.tasks.find((t) => t.id === ASH.data.current) ?? {};
    const core = coreOf(task);
    const { c } = core;
    const panes = PANES.map((p) => ({ ...p, on: mem.on.has(p.id) || (p.on && !mem.off.has(p.id)) }));
    const by = (id) => panes.find((p) => p.id === (ALIAS[id] ?? id));
    const shown = () => panes.filter((p) => p.on);
    const offs = [];
    const preps = {};
    let cur = by(ctx.pane ?? mem.pane) ?? panes[0];      // 默认打开「信息」，不再有写着 Inspector 的空面板
    let seen = false, openedAt = 0, removedAt = 0, chordAt = -Infinity;
    cur.on = true;

    const title = h('b');
    const acts = h('div.insp-acts');
    const closeBtn = h('button.ico.sm', { type: 'button', 'data-tip': '移出竖轨，可从 + 加回', onclick: () => remove() }, icon('x'));
    const body = h('div.insp-body');
    const cells = h('div.insp-cells');
    const ink = h('i.insp-ink');
    const add = h('button.insp-cell.insp-add', { type: 'button', 'aria-label': '添加面板', 'aria-haspopup': 'menu', 'data-tip': '添加面板', 'data-tip-side': 'left', 'data-m': 'insp-keep', onclick: () => addMenu() }, icon('plus'));
    const rail = h('nav.insp-rail', { 'aria-label': '面板', 'data-m': 'insp-1' }, cells, add, ink);
    for (const p of panes) {
      p.btn = h('button.insp-cell', { type: 'button', 'aria-label': p.name, 'aria-pressed': 'false', 'data-tip': p.name, 'data-key': `I ${p.key.toUpperCase()}`, 'data-tip-side': 'left', onclick: (e) => clickCell(p, e) }, icon(p.icon));
    }
    by('files').btn.dataset.m = 'insp-4';
    cells.append(...shown().map((p) => p.btn));
    el.classList.add('insp');
    el.classList.toggle('is-shut', Boolean(ctx.shut ?? mem.shut));
    el.replaceChildren(h('div.insp-in', {}, h('section.insp-main', { 'aria-label': '任务面板', 'data-m': 'insp-3' }, h('header.insp-head', {}, title, h('span.grow'), acts, closeBtn), body), rail));

    const isShut = () => el.classList.contains('is-shut');
    const tell = () => ASH.emit('insp:state', { shut: isShut(), pane: cur.id });

    /* 簇间的空和竖条的位置按尺寸算，不去量。按条上实际摆着的格算：正在淡出的那一格还占着位置 */
    function layout() {
      let y = PAD, prev = null;
      for (const btn of cells.children) {
        const p = panes.find((q) => q.btn === btn);
        const gap = Boolean(prev) && prev.g !== p.g;    // 相邻两格不在同一簇才留空；整簇都摘掉时不会留出双倍
        btn.classList.toggle('gap', gap);
        if (gap) y += BREAK;
        if (p === cur) ink.style.setProperty('--y', `${y + (CELL - INK) / 2}px`);
        y += CELL + GAP;
        prev = p;
      }
    }
    function paint() {
      for (const p of panes) {
        p.btn.setAttribute('aria-pressed', String(p === cur));
        if (core.els[p.id]) core.els[p.id].hidden = p !== cur;
      }
      title.textContent = cur.name;
      acts.replaceChildren(...(c.acts[cur.id] ?? []));
      closeBtn.setAttribute('aria-label', `把「${cur.name}」移出竖轨`);
      layout();
    }
    /* 竖轨上那颗点：各格报过的记在 core.marks 里，外壳重画时照着补上 */
    function mark(id) {
      const p = by(id);
      const { kind, n } = core.marks[id] ?? {};
      if (kind) p.btn.dataset.dot = kind; else delete p.btn.dataset.dot;
      p.btn.dataset.tip = n ? `${p.name}（${n}）` : p.name;
      p.btn.setAttribute('aria-label', `${p.btn.dataset.tip}${kind === 'run' ? '，有东西在跑' : ''}`);
    }
    /* 各格造好了（或者早就造好了）：搬进这一次的外壳里 */
    function attach() {
      body.append(...panes.map((p) => core.els[p.id]));
      for (const id of Object.keys(core.marks)) mark(id);
      paint();
    }
    /* 上条 / 下条。账是立刻记的（shown() 马上就不含它），按钮淡出 120ms 后才真的拿走；
       别的格滑到新位置，竖条跟着同一个节奏走 */
    function setOn(p, on) {
      if (p.on === on) return;
      p.on = on;
      if (on || !COMES_BACK.includes(p.id)) mem[on ? 'on' : 'off'].add(p.id);
      mem[on ? 'off' : 'on'].delete(p.id);
      const settle = () => {
        if (p.on !== on) return;                        // 淡出的这一小会儿里又被加回来了
        const mutate = () => {
          if (on) cells.insertBefore(p.btn, panes.slice(panes.indexOf(p) + 1).find((q) => q.btn.parentNode === cells)?.btn ?? null); else p.btn.remove();
          layout();
        };
        ink.classList.add('is-slow');
        setTimeout(() => ink.classList.remove('is-slow'), 340);
        if (el.isConnected) ASH.flip(cells, mutate); else mutate();
      };
      if (on) settle(); else leave(p.btn, settle);
    }
    function shut(next = !isShut(), snap = false) {
      if (next === isShut()) return;
      mem.shut = next;
      /* 收起时焦点还在栏里的话，交给任务头上开合这一栏的那颗键 */
      if (next && el.contains(document.activeElement)) document.querySelector('[aria-controls="insp"]')?.focus({ preventScroll: true });
      if (!next) setOn(by('info'), true);              // 「信息」摘掉过：重新打开面板时它自己补回来
      el.classList.toggle('is-snap', snap);
      el.classList.toggle('is-shut', next);
      if (snap) { void el.offsetWidth; el.classList.remove('is-snap'); }
      tell();
    }
    function open(id, { snap, ...opts } = {}) {
      const p = by(id);
      if (!p) return;
      setOn(p, true);
      const changed = p !== cur;
      cur = p;
      mem.pane = p.id;
      openedAt = performance.now();
      paint();
      if (changed && core.els[p.id]) { reenter(core.els[p.id]); body.scrollTop = 0; }
      if (isShut()) shut(false, snap); else if (changed) tell();
      core.whenBuilt(() => c.emit(`show:${p.id}`, opts));
    }
    /* 再点已选中的格 = 收起整栏。只认鼠标：回车、空格触发的 click，detail 是 0；
       刚切过来 350ms 内的那一下不算，否则双击一格会「先选中再收起」 */
    function clickCell(p, e) {
      if (p !== cur) { open(p.id); return; }
      if (e.detail > 0 && performance.now() - openedAt > 350) shut(true);
    }
    /* 关闭键 = 把这一格移出竖轨，面板切到它后面那一格（它是最后一格就切到前面那格）；条上只剩它一格时，整栏收起。
       之后任务状态怎么变它都不会自己回来，只能从「+」或快捷键加回。
       摘完以后关闭键还在原地、指的已经是下一格：0.4 秒内紧跟着的那一下不算，连点两下不会连摘两格 */
    function remove() {
      if (performance.now() - removedAt < 400) return;
      removedAt = performance.now();
      const list = shown();
      const out = cur;
      const next = list[list.indexOf(out) + 1] ?? list[list.indexOf(out) - 1];
      setOn(out, false);
      if (!next) { shut(true); cur = by('info'); mem.pane = 'info'; paint(); return; }
      open(next.id);
      closeBtn.focus({ preventScroll: true });
    }
    /* 「+」：全部十一格，已在条上的置灰。菜单朝左上开，不盖住竖轨 */
    function addMenu() {
      const close = ASH.menu(add, panes.map((p) => ({ label: p.name, icon: p.icon, kbd: `I ${p.key.toUpperCase()}`, disabled: p.on,
        onpick: () => { open(p.id); p.btn.focus({ preventScroll: true }); } })), { place: 'top-end', cls: 'insp-add-menu' });
      const pop = close?.el;
      if (!pop) return;
      const a = add.getBoundingClientRect();
      pop.style.left = `${Math.max(8, a.left - pop.offsetWidth - 8)}px`;
      pop.style.top = `${Math.max(8, a.bottom - pop.offsetHeight)}px`;
      pop.style.setProperty('--origin', 'bottom right');
    }
    rail.addEventListener('keydown', (e) => {
      const step = { ArrowDown: 1, ArrowUp: -1 }[e.key];
      if (!step) return;
      const all = [...shown().map((p) => p.btn), add];
      e.preventDefault();
      all[(all.indexOf(document.activeElement) + step + all.length) % all.length].focus();
    });

    /* 按 I 再按字母：切到那一格，不在条上的顺手加回来。正在打字、开着菜单或确认框时不算 */
    function onKey(e) {
      if (gone() || e.repeat || e.isComposing) return;
      const busy = e.metaKey || e.ctrlKey || e.altKey || e.target.closest?.('input, textarea, [contenteditable], .pop') || document.querySelector('.veil');
      const key = (e.key ?? '').toLowerCase();
      const hit = !busy && performance.now() - chordAt < CHORD_MS ? panes.find((p) => p.key === key) : null;
      chordAt = !busy && !hit && key === 'i' ? performance.now() : -Infinity;
      if (!hit) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      open(hit.id);
    }
    const shell = { open, mark, attach, acts: (id) => { if (cur.id === id) acts.replaceChildren(...(c.acts[id] ?? [])); } };
    /* 卸掉的只是外壳；各格和它们的账留在 core 里，下次进任务页接着用 */
    function destroy() {
      removeEventListener('keydown', onKey, true);
      for (const off of offs.splice(0)) off();
      if (core.shell === shell) core.shell = null;
      for (const [id, fn] of Object.entries(preps)) if (ASH.prep[id] === fn) delete ASH.prep[id];
    }
    /* 任务页被换掉以后还收到事件：自己把监听摘干净（正常是任务页卸载时调 destroy） */
    function gone() {
      if (el.isConnected) { seen = true; return false; }
      if (seen) destroy();
      return seen;
    }
    const on = (evt, fn) => offs.push(ASH.on(evt, (data) => { if (!gone()) fn(data ?? {}); }));
    addEventListener('keydown', onKey, true);
    on('insp:toggle', (d) => shut(typeof d.shut === 'boolean' ? d.shut : undefined));
    on('insp:open', (d) => open(d.pane ?? 'info', { round: d.round, quote: d.quote }));

    /* 对照清单：目标不在眼前的，先把整栏展开、切到那一格。各格的造法还没到齐时，等到齐了再定位一次 */
    const prep = (id, fn) => { preps[id] = ASH.prep[id] = () => { if (core.built) fn(); else core.whenBuilt(() => ASH.focusMark?.(id)); }; };
    const reveal = () => shut(false, true);
    const show = (pane) => () => open(pane, { snap: true });
    for (const id of ['insp-1', 'insp-3', 'insp-keep']) prep(id, reveal);
    prep('insp-4', () => { setOn(by('files'), true); reveal(); });
    for (const [id, pane] of [['insp-2', 'info'], ['insp-5', 'review'], ['insp-6', 'scm'], ['insp-7', 'scm'], ['insp-8', 'flow'], ['insp-9', 'watch'], ['insp-10', 'made'], ['insp-11', 'preview'], ['insp-12', 'agents'], ['insp-13', 'chat']]) prep(id, show(pane));

    core.shell = shell;
    paint();
    if (core.built) attach();
    if (ctx.usage) core.usage(ctx.usage);
    return { open: (pane, opts) => open(pane, opts), shut: (next) => shut(next), setUsage: (u) => core.usage(u ?? {}), destroy };
  } });
})();
