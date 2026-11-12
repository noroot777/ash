/* 助手页（#/assistant），外加聊天页（chat.js）一起用的几样零件 ASH.conv。
   两页都照现在的产品画，对的是 web/src/assistant 与 web/src/chat：二级栏五段（品牌与返回、项目名与副题、列表标题与动作、列表、栏底说明）、
   头部、欢迎块、日期胶囊、头像与「智能体」标记、常显的时间、「正在回复 · 停止回复」、输入框和它下面那行按键提示——入口和文案按原文。
   和现状不一样的只有三处：
   ① 清单 as-1（只讲助手页）：右栏只在有关联任务时出现，里面只有「关联任务 N」和各条任务的入口（智能体、回复风格屏上别处已经有了）；说了两遍的两句各留一处；
      「更换智能体」只留二级栏顶上一个入口，点开还是现在那一页（标题、一句话、三段胶囊、三颗按钮）。
   ② 顶上那条五项的模式条拿掉了（清单 home-3 里要负责人点头的那一处）。
   ③ 全应用的尺子：字号不低于 12px；跳动的小圆点换成字上的流光（全应用只有这一种「它在跑」）；输入框随内容长高。
   对话是编的开发话题。ASH.conv：clock / today / statusWord / initial / arrive / ava / typing / sys / msg / taskCard / room / rail / feed / composer / CLEARED。 */
(() => {
  const { h, icon } = ASH;
  for (const [name, path] of Object.entries({
    hash: '<path d="M6.3 2.5 5 13.5M11 2.5 9.7 13.5M2.8 6h10.7M2.5 10h10.7"/>',
    at: '<circle cx="8" cy="8" r="2.4"/><path d="M10.4 5.6v3.2a1.6 1.6 0 0 0 3.1.5A5.6 5.6 0 1 0 11 12.7"/>',
    back: '<path d="M13 8H3M7 4 3 8l4 4"/>',
    book: '<path d="M8 4.3C6.5 3.2 4.6 3 2.5 3.2v8.6c2.1-.2 4-.1 5.5 1 1.5-1.1 3.4-1.2 5.5-1V3.2c-2.1-.2-4 0-5.5 1.1zM8 4.3v8.5"/>',
    okc: '<circle cx="8" cy="8" r="5.5"/><path d="m5.5 8.2 1.7 1.7 3.3-3.6"/>',
    out: '<path d="M5 11 11 5M6 5h5v5"/>',
    asst: '<path d="M8 2.2a5.8 5.8 0 0 1 0 11.6H2.2l1.7-1.7A5.8 5.8 0 0 1 8 2.2z"/><path d="M5.7 9.2a2.6 2.6 0 0 0 4.6 0"/>',
    /* 实心的两颗（品牌位、欢迎块、助手头像，产品里这几处就是实心的）：里面的笑纹 / 三个点用 --knock 镂出来，谁装它谁给底色 */
    asstf: '<path style="fill:currentColor" d="M8 2.2a5.8 5.8 0 0 1 0 11.6H2.2l1.7-1.7A5.8 5.8 0 0 1 8 2.2z"/><path style="stroke:var(--knock,var(--panel))" d="M5.7 9.2a2.6 2.6 0 0 0 4.6 0"/>',
    chatf: '<path style="fill:currentColor" d="M2.5 4A1.5 1.5 0 0 1 4 2.5h8A1.5 1.5 0 0 1 13.5 4v5.5A1.5 1.5 0 0 1 12 11H7l-3 2.5V11a1.5 1.5 0 0 1-1.5-1.5z"/><path style="stroke:var(--knock,var(--panel));stroke-width:1.5" d="M5.4 6.8h.01M8 6.8h.01M10.6 6.8h.01"/>',
  })) ASH.icons[name] ??= path;

  /* ---------- 两页共用的零件 ---------- */
  const two = (n) => String(n).padStart(2, '0');
  const conv = (ASH.conv = {
    CLEARED: '上下文已清空。之后的对话从这里重新开始；之前的消息仍可查看，但不会再提供给智能体。',
    CLEARED_NOTE: '上下文已清空，后续对话从这里重新开始；旧消息仅供查看。',   /* 清空之后输入卡上方常驻的那一句 */
    clock: () => { const d = new Date(); return `${two(d.getHours())}:${two(d.getMinutes())}`; },
    today: () => { const d = new Date(); return `${d.getMonth() + 1}月${d.getDate()}日`; },
    /* 任务状态用产品里的叫法 */
    statusWord: (task) => ({ running: '运行中', waiting: '等答复', failed: '失败', queued: '排队中', stopped: '已取消' })[task.status] ?? (task.accepted === false ? '待验收' : '验收完成'),
    initial: (name) => (name.trim()[0] ?? '?').toUpperCase(),
    arrive: (el) => { el.classList.remove('enter'); void el.offsetWidth; el.classList.add('enter'); },
    ava: (kind, face) => h(`span.as-ava.${kind}`, { 'aria-hidden': 'true' }, face),
    typing: (text) => h('p.as-typing', { role: 'status' }, h('span.shim', text)),
    sys: (text) => h('p.as-sys', text),
    /* 一条消息：头像、名字、「智能体」标记、时间都常显 */
    msg: ({ ava, who, bot, at, body, state }) => h(`article.as-msg${state ? `.is-${state}` : ''}`, {}, ava,
      h('div.grow', {}, h('header', {}, h('strong', who), bot && h('span.as-bot', '智能体'), h('time.num', at)), body)),
    /* 消息里的任务卡：点了去任务页 */
    taskCard: ({ mark, eyebrow, title, line, code, done }) => h(`a.card.as-task${done ? '.is-done' : ''}`, { href: '#/task' },
      mark && icon(mark), h('span.grow', {}, h('small', eyebrow), h('strong', title), h('span', line), code && h('code', code)), icon('out')),
    room: (mark, name, count) => h('button.as-room', { type: 'button' }, icon(mark), h('span.cut.grow', name), count != null && h('small.num', String(count))),
  });

  conv.rail = ({ tag, label, mark, brandIcon, brand, backLabel, sub, extra, listTitle, actions, list, note }) => h(`${tag}.as-rail`, { 'aria-label': label, 'data-m': mark },
    h('header', {}, h('span.as-brand', {}, icon(brandIcon), brand),
      h('button.as-rbtn', { type: 'button', 'aria-label': backLabel, 'data-tip': backLabel, onclick: () => ASH.go('#/task') }, icon('back'))),
    h('div.as-proj', {}, ASH.data.project, h('small', sub)),
    extra,
    h('div.as-label', {}, h('span', listTitle), h('div', {}, actions)),
    list, note);

  /* 消息区：欢迎块一直在最上面；日期换了先插一颗日期胶囊；离开底部时浮出「最新消息」 */
  conv.feed = (label) => {
    const hello = h('div.as-hello');
    const log = h('div', { role: 'log', 'aria-label': label, 'aria-live': 'polite' });
    const box = h('div.as-feed', {}, hello, log);
    const jump = h('button.as-jump.is-hidden', { type: 'button', 'aria-label': '跳到最新消息', 'aria-hidden': 'true', tabindex: '-1' }, icon('down', 'sm'), '最新消息');
    /* 贴着底的时候，卡片变窄、输入框长高都跟着留在底部；只有自己往上翻了才松开（排版把内容撑高不算「翻走了」） */
    let stuck = true;
    let lastTop = 0;
    let lastDay = null;
    const far = () => box.scrollHeight - box.scrollTop - box.clientHeight > 40;
    const pin = () => { box.scrollTop = box.scrollHeight; lastTop = box.scrollTop; };
    const toEnd = (smooth) => { stuck = true; if (smooth && !ASH.reduced()) box.scrollTo({ top: box.scrollHeight, behavior: 'smooth' }); else pin(); };
    const sync = () => {
      const away = !stuck && far();
      jump.classList.toggle('is-hidden', !away);
      jump.setAttribute('aria-hidden', String(!away));
      jump.tabIndex = away ? 0 : -1;
    };
    new ResizeObserver(() => { if (stuck) pin(); sync(); }).observe(box);
    box.addEventListener('scroll', () => {
      if (box.scrollTop < lastTop - 1) stuck = false;
      if (!far()) stuck = true;
      lastTop = box.scrollTop;
      sync();
    }, { passive: true });
    jump.addEventListener('click', () => toEnd(true));
    return { el: h('div.as-feedwrap', {}, box, jump), hello, toEnd,
      reset() { log.replaceChildren(); lastDay = null; conv.arrive(box); },
      add(el, day) {
        if (day && day !== lastDay) { log.append(h('div.as-date', {}, h('span', day))); lastDay = day; }
        log.append(el);
        return el;
      } };
  };

  /* 输入区三层：上面一行状态（待命，或谁正在回复 + 停止回复），中间输入卡，下面一行按键提示。
     清空过上下文的对话，状态行和输入卡之间多一句说明（note） */
  conv.composer = ({ label, placeholder, idle, sendLabel, left, hint, tail, onsend, onstop, onkey, oninput }) => {
    const live = h('span', idle);
    const stop = h('button.as-stop', { type: 'button', hidden: true, onclick: onstop }, icon('stop', 'sm'), '停止回复');
    const input = h('textarea', { rows: '2', maxlength: '8000', placeholder, 'aria-label': label });
    const send = h('button.as-send', { type: 'button', 'aria-label': sendLabel, disabled: true }, icon('up'));
    let locked = false;
    /* 随内容长高（全应用的尺子，没有拖拽角）；上下限在样式里 */
    const fit = () => { input.style.height = 'auto'; input.style.height = `${input.scrollHeight}px`; };
    const sync = () => { fit(); send.disabled = locked || !input.value.trim(); oninput?.(input.value); };
    const submit = () => {
      const text = input.value.trim();
      if (!text || send.disabled) return;
      input.value = '';
      sync();
      onsend(text);
      input.focus();
    };
    send.addEventListener('click', submit);
    input.addEventListener('input', sync);
    input.addEventListener('keydown', (e) => {
      if (e.isComposing || onkey?.(e)) return;
      if (ASH.sendKey.hit(e)) { e.preventDefault(); submit(); }   /* 哪一下算发送跟「发送键」设置走，和回复框、新建是同一份判定 */
    });
    const keys = h('span');
    const paintKeys = () => { const caps = ASH.sendKey.caps(); keys.textContent = `${caps.send} 发送 · ${caps.newline} 换行 · /clear 清空上下文`; };
    const offKeys = ASH.on('sendkey:change', () => { if (keys.isConnected) paintKeys(); else offKeys(); });
    paintKeys();
    const ctx = h('p.as-ctx', { role: 'status', hidden: true });
    const card = h('div.as-box.inbox', {}, input, h('footer', {}, left, hint, send));
    const el = h('div.as-reply', {}, h('div.as-live', { role: 'status' }, live, stop), ctx, card,
      h('div.as-keys', {}, keys, tail && h('i', tail)));
    return { el, card, input,
      set(text) { input.value = text; sync(); input.focus(); },
      busy(text) { live.textContent = text ?? idle; live.classList.toggle('shim', !!text); stop.hidden = !text; },
      note(text) { ctx.textContent = text ?? ''; ctx.hidden = !text; },
      lock(on) { locked = on; sync(); } };
  };

  /* ---------- 助手页 ---------- */
  const STARTERS = [
    ['问用法', '任务显示失败，但智能体说已经做完了，该怎么排查？'],
    ['找任务', '帮我找之前做登录或认证的任务，记不清在哪个项目了。'],
    ['搭起手式', '帮我搭一个起手式：写完代码后跑构建和测试，等我确认再合并。'],
  ];
  const KNOW = [
    ['ash 使用说明', '内置功能指南：任务、团队、执行器、起手式与验收。'],
    ['任务与会话', '按需检索你可见项目的本机任务及会话，包括归档任务。'],
    ['当前资源', '可见项目、执行器、起手式示例和本对话草案的保存状态。'],
    ['回复风格 · 已启用', '默认 1–3 句或最多 3 个要点，通常不超过 200 字；需要时再展开。'],
  ];
  const knowledge = () => h('div.as-know', {}, h('dl', {}, KNOW.map(([dt, dd]) => [h('dt', dt), h('dd', dd)])), h('p', '暂未接入 Obsidian 等外部知识库，也不做联网检索。'));
  const STOPPED = '你已停止这次回复。发送新消息可继续；已创建的任务可在任务卡中管理。';
  const who = () => ({ agent: 'claude', model: null, level: null });
  /* 按建立的先后排；二级栏里新的在上，进来先开最新的那一段。
     第一段里有一张任务卡，所以它的右栏多一行「关联任务」；另外两段为零，那一行不出现（as-1）。 */
  const DATA = { rooms: [
    { name: '找定时消息的任务', who: who(), msgs: [
      { me: true, day: '11月9日', at: '16:02', text: '今天有个修定时消息不补发的任务，帮我找出来。' },
      { day: '11月9日', at: '16:02', text: '找到了：已经做完，还没验收。', queries: ['定时消息 补发', '过了点 待发送'], tasks: [{ id: 't-cur', why: '标题和会话里都提到「过了点没有补发」' }] },
    ] },
    { name: '起手式在哪配', who: who(), msgs: [
      { me: true, day: '11月10日', at: '17:05', text: '起手式在哪里配？' },
      { day: '11月10日', at: '17:05', text: '在「设置 → 起手式」。每一条都能改、能停用，新建任务时挑一条起手。' },
    ] },
    { name: '斜杠补全的进展', who: who(), msgs: [
      { me: true, day: '11月11日', at: '14:20', text: '斜杠补全那个任务到哪一步了？' },
      { day: '11月11日', at: '14:20', text: '在跑第 2 轮。正文后面敲 `/` 已经能弹出补全，还剩一条在改：菜单里按回车和点发送键，拦下来的情形要一样。' },
      { me: true, day: '11月11日', at: '14:23', text: '审查打回过吗？' },
      { day: '11月11日', at: '14:23', text: '打回过 1 轮，共 2 条：一条已经改完，另一条就是现在在改的这条。' },
    ] },
  ] };
  /* 助手的回复走 Markdown；样机里只认 `代码` 一样。一律文本节点，不拼 HTML */
  const md = (text) => text.split(/(`[^`]+`)/).map((part) => (part[0] === '`' && part.length > 2 ? h('code', part.slice(1, -1)) : part));

  function mount(main) {
    const state = structuredClone(DATA);
    const timers = new Set();
    const later = (fn, ms) => { const id = setTimeout(() => { timers.delete(id); fn(); }, ms); timers.add(id); return id; };
    const rowOf = new Map();
    let alive = true;
    let cur = state.rooms.at(-1);
    let setup = null;        /* 开着「更换助手的智能体」那一页时，是收起它的函数 */
    let endRename = null;
    let query = '';
    const waiting = (room) => room?.msgs.find((m) => m.wait);

    /* ---------- 二级栏 ---------- */
    const list = h('nav.as-rooms', { 'aria-label': '助手对话记录' });
    const row = (room) => {
      if (!rowOf.has(room)) { const el = conv.room('chat', room.name); el.addEventListener('click', () => open(room)); rowOf.set(room, el); }
      return rowOf.get(room);
    };
    function drawList() {
      const key = query.trim().toLowerCase();
      const hit = [...state.rooms].reverse().filter((room) => room.name.toLowerCase().includes(key));
      list.replaceChildren(...(hit.length ? hit.map(row) : [h('p', { role: 'status' }, key ? '没有匹配的对话，换个名称试试。' : '接入智能体后，在这里保留每次对话。')]));
      for (const [room, el] of rowOf) { if (room === cur) el.setAttribute('aria-current', 'page'); else el.removeAttribute('aria-current'); }
    }
    const find = h('input', { type: 'search', 'aria-label': '搜索助手对话', placeholder: '搜索对话名称' });
    const wipe = h('button', { type: 'button', hidden: true, 'aria-label': '清除对话搜索' }, icon('x', 'sm'));
    const findRow = h('label.as-search', { hidden: true }, icon('search', 'sm'), find, wipe);
    const findBtn = h('button.as-rbtn', { type: 'button', 'aria-label': '搜索对话', 'aria-expanded': 'false', 'data-tip': '搜索对话', onclick: () => toggleFind(findRow.hidden) }, icon('search'));
    const setQuery = (text) => { query = text; wipe.hidden = !text; drawList(); };
    function toggleFind(on) {
      findRow.hidden = !on;
      findBtn.setAttribute('aria-expanded', String(on));
      find.value = '';
      setQuery('');
      if (on) find.focus();
    }
    find.addEventListener('input', () => setQuery(find.value));
    wipe.addEventListener('click', () => { find.value = ''; setQuery(''); find.focus(); });
    const addBtn = h('button.as-rbtn', { type: 'button', 'aria-label': '新对话', 'data-tip': '新对话', onclick: () => addRoom(cur.who) }, icon('plus'));
    /* as-1：「更换智能体」只剩这一个入口，放在二级栏顶上。它就是原来头部那颗（机器人图标 + 智能体名），换了个位置 */
    const whoText = h('span.cut.grow');
    const whoBtn = h('button.as-who', { type: 'button', 'aria-label': '更换助手智能体', 'data-tip': '更换智能体', onclick: openSetup }, icon('bot'), whoText, icon('edit', 'sm'));
    /* 栏底说明照现状整段留着；「简洁回复已启用」「先说结论，只讲重点。」这两句全页只在这里各说一次（as-1） */
    const fold = knowledge();
    fold.hidden = true;
    const foldBtn = h('button.as-fold', { type: 'button', 'aria-expanded': 'false', onclick: () => {
      fold.hidden = !fold.hidden;
      foldBtn.setAttribute('aria-expanded', String(!fold.hidden));
      if (!fold.hidden) conv.arrive(fold);
    } }, icon('chev', 'sm'), icon('book', 'sm'), '知识与回复设置');
    const rail = conv.rail({ tag: 'aside', label: '助手侧栏', mark: 'as-keep', brandIcon: 'asstf', brand: '助手', backLabel: '关闭助手', sub: '直接对话 · 简洁回复', extra: [whoBtn],
      listTitle: '你的对话', actions: [findBtn, addBtn], list: [findRow, list],
      note: h('div.as-note', {}, icon('okc'), h('strong', '简洁回复已启用'), h('p', {}, '先说结论，只讲重点。', h('br'), '问用法、找任务、搭起手式。'), foldBtn, fold) });

    /* ---------- 头部：对话名（点它重命名）、连接灯、删除对话 ---------- */
    const nameEl = h('span.cut');
    const nameBtn = h('button.as-name', { type: 'button', onclick: rename }, icon('asst'), nameEl, icon('edit', 'sm'));
    const title = h('h1', {}, nameBtn, h('span.dot.as-conn', { tabindex: '0', role: 'status', 'aria-label': '实时连接', 'data-tip': '实时连接' }));
    const del = h('button.ico.as-del', { type: 'button', 'data-tip': '删除对话', onclick: remove }, icon('trash'));
    const head = h('header.as-bar', { 'data-m': 'home-3' }, title, del);
    function rename() {
      const room = cur;
      const box = h('input.field', { value: room.name, maxlength: '80', 'aria-label': '对话名称' });
      const form = h('form.as-rename', {}, box,
        h('button.ico.sm', { type: 'submit', 'aria-label': '保存对话名称', 'data-tip': '保存' }, icon('check')),
        h('button.ico.sm', { type: 'button', 'aria-label': '取消重命名', 'data-tip': '取消', onclick: () => end(true) }, icon('x')));
      const end = (refocus) => { endRename = null; form.replaceWith(title); if (refocus) nameBtn.focus(); };
      form.addEventListener('submit', (e) => {
        e.preventDefault();
        const name = box.value.trim();
        if (!name) return;
        room.name = name;
        row(room).querySelector('span').textContent = name;
        end(true);
        paint();
      });
      box.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.preventDefault(); end(true); } });
      endRename = () => end(false);
      title.replaceWith(form);
      box.focus();
      box.select();
    }
    /* 删除走全应用那一个确认框，标题和正文是产品里的原文 */
    async function remove() {
      const room = cur;
      const yes = await ASH.confirm({ title: `删除对话「${room.name}」`, ok: '删除对话', danger: true,
        body: '这段对话的全部消息和历史摘要会一起删除，无法恢复。正在进行的回复会先停止；对话中创建过的任务不受影响，仍留在任务列表里。' });
      if (!yes || !alive || !state.rooms.includes(room)) return;
      clearTimeout(waiting(room)?.timer);
      ASH.flip(list, () => { state.rooms.splice(state.rooms.indexOf(room), 1); rowOf.delete(room); drawList(); });
      if (cur !== room) return;
      if (state.rooms.length) open(state.rooms.at(-1)); else { cur = null; openSetup(); }
    }

    /* ---------- 消息 ---------- */
    const feed = conv.feed('助手对话');
    /* 欢迎块第二行原文是「直接发送，先说结论，只讲重点。」——后半句栏底已经说了，这里不再说（as-1）；「直接发送」输入框里那句还在 */
    feed.hello.append(h('span.as-tile', {}, icon('asstf')), h('h2', 'ash 助手，从一句话开始。'), h('p', '问 ash 怎么用，找回一个任务，或搭好起手式。'),
      h('div', {}, STARTERS.map(([label, text]) => h('button.btn.sm', { type: 'button', onclick: () => box.set(text) }, label))));
    function taskCard({ id, why }) {
      const task = ASH.data.tasks.find((t) => t.id === id);
      return task ? conv.taskCard({ eyebrow: `${ASH.data.project} · ${conv.statusWord(task)}`, title: task.title, line: why, code: task.id }) : h('p', '关联任务已删除或不可访问。');
    }
    const msgEl = (m) => (m.sys ? conv.sys(m.sys) : conv.msg({
      ava: m.me ? conv.ava('you', '你') : conv.ava('bot', icon('asstf')), who: m.me ? '你' : 'ash 助手', bot: !m.me, at: m.at, state: m.state,
      body: [m.wait ? conv.typing(m.wait) : h('div.as-text', {}, md(m.text)),
        m.queries && h('p.as-found', {}, icon('search', 'sm'), `已检索：${m.queries.join(' · ')}`),
        m.tasks && h('div.as-results', { 'aria-label': '相关任务' }, m.tasks.map(taskCard))] }));
    function drawFeed() {
      feed.reset();
      for (const m of cur.msgs) m.el = feed.add(msgEl(m), m.day);
      feed.toEnd();
    }
    function say(room, m) {
      room.msgs.push(m);
      if (room !== cur) return;
      m.el = feed.add(msgEl(m), m.day);
      m.el.classList.add('enter');
      feed.toEnd();
    }
    function settle(room, m, text, how) {
      clearTimeout(m.timer);
      delete m.wait;
      m.text = text;
      m.state = how;
      if (room !== cur) return;
      const el = msgEl(m);
      el.classList.add('enter');
      m.el.replaceWith(el);
      m.el = el;
      feed.toEnd();
      paintBusy();
      paintInfo();
    }
    function send(text) {
      const room = cur;
      const stamp = { day: conv.today(), at: conv.clock() };
      say(room, { me: true, ...stamp, text });
      if (/^\/clear$/i.test(text)) { room.cleared = true; say(room, { sys: conv.CLEARED }); paintBusy(); return; }
      const m = { ...stamp, wait: '正在理解问题、查询资料…' };
      say(room, m);
      m.timer = later(() => settle(room, m, '记下了。要我把它建成任务的话，说一声。'), 1700);
      paintBusy();
    }

    /* ---------- 输入区：知识与回复设置、「直接发送，无需 @」、发送 ---------- */
    const knowBtn = h('button.ico.sm', { type: 'button', 'aria-label': '知识与回复设置', 'aria-haspopup': 'dialog', 'data-tip': '知识与回复设置', onclick: () => {
      const shut = h('button.ico.sm', { type: 'button', 'aria-label': '关闭知识与回复设置', onclick: () => { ASH.closePop(); knowBtn.focus(); } }, icon('x'));
      const sheet = h('section', { role: 'dialog', 'aria-label': '知识与回复设置' }, h('header', {}, h('strong', '知识与回复设置'), shut), knowledge());
      if (ASH.pop(knowBtn, sheet, { place: 'top-start', cls: 'sv-as as-kpop' })) shut.focus({ preventScroll: true });   /* 打开后焦点进浮层 */
    } }, icon('book'));
    /* 按键提示右边原来还有一句「简洁回复已启用」，和栏底那句重复，只留栏底（as-1） */
    const box = conv.composer({ label: '给 ash 助手发消息', placeholder: '描述你遇到的问题，或记得的任务内容…', idle: '随时可以开始对话', sendLabel: '发送给助手',
      left: knowBtn, hint: h('span.grow', '直接发送，无需 @'), onsend: send,
      onstop: () => { const m = waiting(cur); if (m) settle(cur, m, STOPPED, 'stopped'); } });
    /* 回复没回来之前不能再发，也不能换智能体（照现状） */
    function paintBusy() {
      const on = !!waiting(cur);
      box.busy(on ? '正在回复' : null);
      box.note(cur.cleared ? conv.CLEARED_NOTE : null);
      box.lock(on);
      whoBtn.disabled = on;
    }

    /* ---------- 右栏（as-1）：有关联任务才有这一列，里面只有「关联任务 N」和各条任务的入口。
       用哪个智能体在二级栏顶上、回复风格在栏底，都已经说过；没有关联任务时整列不画，会话区吃满宽度 ---------- */
    const info = h('aside.as-info', { 'aria-label': '关联任务', 'data-m': 'as-1' });
    function paintInfo() {
      const ids = [...new Set(cur.msgs.flatMap((m) => (m.tasks ?? []).map((t) => t.id)))];
      const tasks = ids.map((id) => ASH.data.tasks.find((t) => t.id === id)).filter(Boolean);
      info.hidden = Boolean(setup) || !tasks.length;
      info.replaceChildren(h('h4.sec', {}, '关联任务', h('b', String(tasks.length))),
        ...tasks.map((t) => h('button.go', { type: 'button', onclick: () => { if (t.id === ASH.data.current) ASH.go('#/task'); else ASH.emit('task:open', { id: t.id }); } }, h('span.cut', t.title), icon('chev'))));
    }

    /* ---------- 「更换智能体」点开的那一页：换掉头部、消息和输入区，右栏也让开（照现状）。选谁干活是那颗三段胶囊 ---------- */
    const setupEl = h('section.as-setup', { 'aria-label': '助手智能体配置', hidden: true });
    function openSetup() {
      endRename?.();
      const first = !cur;
      const pick = ASH.target({ value: cur?.who ?? who(), label: '助手执行器' });
      const shut = () => { setup = null; setupEl.replaceChildren(); };
      const close = (save) => {
        shut();
        if (save && first) { addRoom(pick.value); return; }
        if (save) cur.who = pick.value;
        paint();
        feed.toEnd();
        whoBtn.focus();
      };
      setupEl.replaceChildren(h('h2', first ? '接入你的智能体' : '更换助手的智能体'), h('p', '选择 ash 中已配置的执行器，随后就可以直接对话。'),
        h('div.as-pick', {}, h('span', '助手执行器'), pick.el),
        h('footer', {}, h('a.btn', { href: '#/settings/agents' }, '打开执行器设置'), h('span.grow'),
          !first && h('button.btn', { type: 'button', onclick: () => close(false) }, '取消'),
          h('button.btn.pri', { type: 'button', onclick: () => close(true) }, first ? '开始对话' : '保存选择')));
      setup = shut;
      paint();
      conv.arrive(setupEl);
      pick.el.querySelector('button').focus();
    }

    function addRoom(target) {
      const room = { name: `对话 ${state.rooms.length + 1}`, who: { ...target }, msgs: [] };
      if (!findRow.hidden) toggleFind(false);
      ASH.flip(list, () => { state.rooms.push(room); drawList(); });
      open(room);
      box.input.focus();
    }
    function open(room) {
      endRename?.();
      setup?.();
      cur = room;
      paint();
      drawFeed();
    }
    function paint() {
      const on = !!cur && !setup;
      head.hidden = box.el.hidden = info.hidden = !on;
      feed.el.hidden = !!setup;
      setupEl.hidden = !setup;
      whoBtn.hidden = !cur;
      addBtn.disabled = !cur;
      drawList();
      if (!cur) return;
      nameEl.textContent = cur.name;
      nameBtn.setAttribute('aria-label', `重命名对话：${cur.name}`);
      del.setAttribute('aria-label', `删除对话：${cur.name}`);
      whoText.textContent = cur.who.agent;
      paintBusy();
      paintInfo();
    }

    main.append(h('section.sv-as.as-root', { 'aria-label': 'ash 助手' }, rail, h('div.as-mid', {}, head, feed.el, setupEl, box.el), info));
    paint();
    drawFeed();
    /* 对照清单点到 as-1：右栏只在有关联任务的对话里才有，先切到那一段；「更换智能体」那一页开着就先收起 */
    ASH.prep['as-1'] = () => {
      if (setup && cur) { setup(); paint(); }
      const withTask = state.rooms.find((room) => room.msgs.some((m) => m.tasks?.length));
      if (withTask && withTask !== cur) open(withTask);
      feed.toEnd();
    };
    return () => { alive = false; for (const id of timers) clearTimeout(id); delete ASH.prep['as-1']; };
  }

  ASH.surface('assistant', { chrome: 'app', mount });
})();
