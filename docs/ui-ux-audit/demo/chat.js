/* 聊天页（#/chat）。照现在的产品画，对的是 web/src/chat（ChatView / ChatMessages / ChatMembers / chat.css）：
   二级栏：品牌与返回、项目名与副题、「你的群聊」与新建、每个群的成员数、栏底说明；
   主区：群名（点它是群聊设置）、连接灯、「N 位成员」，欢迎块、日期胶囊、头像、「智能体」标记、常显的时间、任务卡、「最新消息」，
        「谁正在回复 · 停止回复」、点名菜单、输入框底下那句「将唤醒谁」、再下面一行按键提示；
   右栏：「在这个空间」、@all、每位成员的状态、管理成员、「从对话到行动」、关联任务数、那段上下文说明；
   群聊设置 / 新建群聊（先选成员）：群名、每位成员的点名名称和三段胶囊、添加成员、删除群聊（走全应用那一个确认框）。
   产品里这一页没有「更多」菜单：改群名和删除群聊都在「群聊设置」里。
   清单对这一页只有两处：as-keep（二级栏配色一个值不动，见 assist.css 开头）和 home-3 里要负责人点头的那一处（顶上五项的模式条拿掉了）。
   其余和现状不一样的只有全应用的尺子：字号下限 12px、跳动的小圆点换成字上的流光、输入框随内容长高。
   零件（头像、消息、消息区、输入区、二级栏）来自 assist.js 的 ASH.conv，挂载时才取，所以两个脚本谁先谁后都行。对话是编的开发话题。 */
(() => {
  const { h, icon } = ASH;
  const ALL = ['all', '所有人'];                 /* 召唤全体成员的两个保留名 */
  const TAIL = /(?:^|\s)@([^\s@]*)$/u;           /* 正文末尾正在打的那个 @ */
  const STOPPED = '你已停止这次回复。再次 @ 才会继续；已创建的任务可在任务卡中管理。';
  const member = (name, agent) => ({ name, agent, model: null, level: null });
  const DATA = { rooms: [
    { name: '发布安排', members: [member('Claude', 'claude'), member('Codex', 'codex')], msgs: [
      { day: '11月10日', at: '17:48', text: '更新日志周三晚上我来写，先不用管。' },
      { day: '11月11日', at: '10:02', text: '@Claude 周四发 0.9.4，还差哪几项没合？' },
      { day: '11月11日', at: '10:02', who: 'Claude', text: '还差两项：「斜杠补全」在跑，预计下午完；「合并移动端轮询」在等你答复。其余 7 项已经合进 release/0.9.4。' },
      { day: '11月11日', at: '10:05', text: '@Codex 把这周合进去的改动导一份周报，发布说明要用。' },
      { day: '11月11日', at: '10:05', who: 'Codex', text: '已建任务，排在队里，跑完把结果贴回来。', task: 't-q' },
    ] },
    { name: '移动端轮询', members: [member('Claude', 'claude')], msgs: [
      { day: '11月10日', at: '16:40', text: '@Claude 列表 5 秒、会话 3 秒的轮询间隔，合并之后还保持吗？' },
      { day: '11月10日', at: '16:41', who: 'Claude', text: '保持。合并只是把两个定时器并成一个调度器，间隔各自不变；下拉刷新照旧立刻拉一次。' },
    ] },
    { name: '审查口径', members: [member('Codex', 'codex'), member('Claude', 'claude'), member('Gemini', 'gemini')], msgs: [
      { day: '11月9日', at: '09:15', text: '@Codex 这一轮审查只核对执行者登记的回归结果，不要重跑。' },
      { day: '11月9日', at: '09:15', who: 'Codex', text: '明白。没覆盖到的缺口写进覆盖声明，不补跑。' },
    ] },
  ] };

  function mount(main) {
    const conv = ASH.conv;
    const state = structuredClone(DATA);
    const timers = new Set();
    const later = (fn, ms) => { const id = setTimeout(() => { timers.delete(id); fn(); }, ms); timers.add(id); return id; };
    const rowOf = new Map();
    let alive = true;
    let cur = state.rooms[0];
    let editing = null;      /* 'create' | 'members'：主区换成群聊设置那一页 */
    let options = [];        /* 点名菜单里现在列着谁 */
    let at = 0;
    const active = (room) => room.msgs.filter((m) => m.wait);
    const tasksOf = (room) => new Set(room.msgs.map((m) => m.task).filter(Boolean)).size;
    const tone = (room, name) => `t${Math.max(0, room.members.findIndex((m) => m.name === name)) % 4}`;
    /* 这句话点了谁：@all / @所有人 是全体，否则按名字 */
    const called = (text, room) => {
      const names = (text.match(/@[^\s@，。！？,:：;；]+/gu) ?? []).map((part) => part.slice(1));
      return names.some((name) => ALL.includes(name.toLowerCase())) ? room.members : room.members.filter((m) => names.includes(m.name));
    };

    /* ---------- 二级栏 ---------- */
    const list = h('div.as-rooms');
    const row = (room) => {
      if (!rowOf.has(room)) { const el = conv.room('hash', room.name, room.members.length); el.addEventListener('click', () => open(room)); rowOf.set(room, el); }
      return rowOf.get(room);
    };
    function drawList() {
      list.replaceChildren(...state.rooms.map(row));
      for (const [room, el] of rowOf) {
        el.querySelector('span').textContent = room.name;
        el.querySelector('small').textContent = String(room.members.length);
        if (room === cur && editing !== 'create') el.setAttribute('aria-current', 'true'); else el.removeAttribute('aria-current');
      }
    }
    const rail = conv.rail({ tag: 'nav', label: '聊天频道', mark: 'as-keep', brandIcon: 'chatf', brand: '聊天', backLabel: '返回工作区', sub: '点名协作 · 安静待命',
      listTitle: '你的群聊', actions: h('button.as-rbtn', { type: 'button', 'aria-label': '新建群聊', 'data-tip': '新建群聊', onclick: () => edit('create') }, icon('plus')), list,
      note: h('div.as-note', {}, icon('at'), h('strong', '有需要，再叫上它。'), h('p', '没有 @ 的普通消息只保存在群里。@all 唤醒全部成员；单独发送 /clear 重新开始上下文。')) });

    /* ---------- 头部：群名（点它是群聊设置）、连接灯、成员数（也进群聊设置） ---------- */
    const nameEl = h('span.cut');
    const nameBtn = h('button.as-name', { type: 'button', onclick: () => edit('members') }, icon('hash'), nameEl, icon('edit', 'sm'));
    const count = h('span');
    const countBtn = h('button.btn.as-count', { type: 'button', onclick: () => edit('members') }, icon('team'), count);
    const conn = h('span.dot.as-conn', { tabindex: '0', role: 'status', 'aria-label': '实时连接', 'data-tip': '实时连接' });
    const nobody = h('span.as-name', { hidden: true }, icon('hash'), '聊天空间');   /* 一个群都没有时头部写的字，不是键 */
    const head = h('header.as-bar', { 'data-m': 'home-3' },   /* 顶上那条五项的模式条拿掉了（清单 home-3 里要负责人点头的那一处） */
      h('h1', {}, nameBtn, nobody, conn), countBtn);

    /* ---------- 消息 ---------- */
    const feed = conv.feed('群聊消息');
    const chip = (name) => h('button.btn.sm', { type: 'button', onclick: () => mention(name) }, `@${name}`);
    /* 正文里点到真成员（或全体）的 @ 才高亮 */
    const marks = (text, room) => text.split(/(@[^\s@，。！？,:：;；]+)/u).map((part) =>
      (part[0] === '@' && (room.members.some((m) => `@${m.name}` === part) || ALL.includes(part.slice(1).toLowerCase())) ? h('mark', part) : part));
    function msgEl(m, room) {
      if (m.sys) return conv.sys(m.sys);
      const task = m.task && ASH.data.tasks.find((t) => t.id === m.task);
      const done = task?.status === 'done';
      return conv.msg({ ava: m.who ? conv.ava(tone(room, m.who), conv.initial(m.who)) : conv.ava('you', '你'), who: m.who ?? '你', bot: !!m.who, at: m.at, state: m.state,
        body: [m.wait ? conv.typing(m.wait) : h('p.as-text', {}, marks(m.text, room)),
          task && conv.taskCard({ mark: done ? 'okc' : 'bolt', eyebrow: `ASH 任务 · ${task.agent}`, title: task.title, done,
            line: `${conv.statusWord(task)} · ${done ? '结果已就绪，点击查看' : '点击查看详情与日志'}` })] });
    }
    function drawFeed() {
      const n = cur.members.length;
      feed.hello.replaceChildren(h('span.as-tile', {}, icon('hash')), h('h2', `${cur.name}，从一句话开始。`),
        h('p', {}, '想法留在这里，复杂的工作交给任务。', h('br'), '点名才加入对话，不点名就安静待命。'),
        h('div', {}, n > 1 && chip('all'), cur.members.map((m) => chip(m.name))));
      feed.reset();
      for (const m of cur.msgs) m.el = feed.add(msgEl(m, cur), m.day);
      feed.toEnd();
    }
    function say(room, m) {
      room.msgs.push(m);
      if (room !== cur) return;
      m.el = feed.add(msgEl(m, room), m.day);
      m.el.classList.add('enter');
      feed.toEnd();
    }
    function settle(room, m, text, how) {
      clearTimeout(m.timer);
      delete m.wait;
      m.text = text;
      m.state = how;
      if (room !== cur) return;
      const el = msgEl(m, room);
      el.classList.add('enter');
      m.el.replaceWith(el);
      m.el = el;
      feed.toEnd();
      paintLive();
    }
    /* 点了名的才回；不点名只记下。别人还在回的时候也能接着发（照现状） */
    function send(text) {
      const room = cur;
      const stamp = { day: conv.today(), at: conv.clock() };
      say(room, { ...stamp, text });
      if (/^\/clear$/i.test(text)) { halt(room); room.cleared = true; say(room, { sys: conv.CLEARED }); paintLive(); return; }
      called(text, room).forEach((who, i) => {
        const m = { ...stamp, who: who.name, wait: '正在组织简短回复' };
        say(room, m);
        m.timer = later(() => settle(room, m, '收到，我来看。'), 1500 + i * 900);
      });
      paintLive();
    }
    const halt = (room) => { for (const m of active(room)) settle(room, m, STOPPED, 'stopped'); };

    /* ---------- 输入区：点名菜单、@ 键、「将唤醒谁」那一句、发送 ---------- */
    const hint = h('span.grow', '不 @，只记录；不唤醒');
    const hintWord = (text) => {
      if (/^\/clear$/i.test(text.trim())) return '将清空后续上下文，并停止当前回复';
      const names = called(text, cur);
      if (!names.length) return '不 @，只记录；不唤醒';
      return cur.members.length > 1 && names.length === cur.members.length ? `将唤醒全部 ${names.length} 位成员` : `将唤醒 ${names.map((m) => `@${m.name}`).join('、')}`;
    };
    /* 点名菜单长在输入卡上方，焦点一直留在输入框里：上下键选人，回车或 Tab 点名，Esc 收起 */
    const menu = h('div.as-mention.menu', { role: 'listbox', 'aria-label': '点名成员', hidden: true });
    const atBtn = h('button.ico.sm', { type: 'button', 'aria-label': '选择点名成员', 'aria-expanded': 'false', 'data-tip': '点名', onclick: () => { showMenu(menu.hidden); box.input.focus(); } }, icon('at'));
    const away = (e) => { if (!menu.contains(e.target) && !atBtn.contains(e.target) && e.target !== box.input) showMenu(false); };
    const point = () => [...menu.children].forEach((el, i) => { el.setAttribute('aria-selected', String(i === at)); el.dataset.active = String(i === at); });
    function showMenu(on) {
      if (on) {
        const key = (box.input.value.match(TAIL)?.[1] ?? '').toLowerCase();
        const n = cur.members.length;
        options = [...(n > 1 && ALL.some((alias) => alias.includes(key)) ? [{ name: ALL[0], hint: `全体成员 · ${n} 位` }] : []),
          ...cur.members.filter((m) => m.name.toLowerCase().includes(key)).map((m) => ({ name: m.name, hint: m.agent }))];
        at = 0;
        menu.replaceChildren(...options.map((o, i) => h('button', { type: 'button', role: 'option', tabindex: '-1', onclick: () => mention(o.name) },
          conv.ava(`t${i % 4}.sm`, conv.initial(o.name)), h('strong', `@${o.name}`), h('small', o.hint))));
        point();
        on = options.length > 0;
      }
      if (on && menu.hidden) conv.arrive(menu);
      menu.hidden = !on;
      atBtn.setAttribute('aria-expanded', String(on));
      if (on) addEventListener('pointerdown', away, true); else removeEventListener('pointerdown', away, true);
    }
    /* 正在打一个 @ 就把它补全，否则接在后面 */
    function mention(name) {
      const text = box.input.value;
      box.set(TAIL.test(text) ? text.replace(/@[^\s@]*$/u, `@${name} `) : `${text}${text && !/\s$/u.test(text) ? ' ' : ''}@${name} `);
      showMenu(false);
    }
    const box = conv.composer({ label: '群聊消息输入', placeholder: '', idle: '所有成员安静待命', sendLabel: '发送消息', left: atBtn, hint, tail: '短回复，长任务。',
      onsend: send, onstop: () => halt(cur),
      oninput: (text) => { ASH.swap(hint, hintWord(text)); showMenu(TAIL.test(text)); },
      onkey: (e) => {
        if (menu.hidden) return false;
        if (e.key === 'Escape') { showMenu(false); return true; }
        if (!['ArrowDown', 'ArrowUp', 'Enter', 'Tab'].includes(e.key)) return false;
        e.preventDefault();
        if (e.key === 'Enter' || e.key === 'Tab') mention(options[at].name);
        else { at = (at + (e.key === 'ArrowDown' ? 1 : options.length - 1)) % options.length; point(); }
        return true;
      } });
    box.card.append(menu);

    /* ---------- 右栏：在这个空间（@all、每位成员的状态）、管理成员、从对话到行动、关联任务数 ---------- */
    const info = h('aside.as-info', { 'aria-label': '群聊信息' });
    function paintInfo() {
      const n = cur.members.length;
      const busy = new Set(active(cur).map((m) => m.who));
      info.replaceChildren(
        h('h2.sec', {}, icon('team', 'sm'), '在这个空间'), h('p', '只有你点名时，才会加入对话。'),
        h('div.as-presence', {},
          n > 1 && h('button.go', { type: 'button', onclick: () => mention(ALL[0]) }, conv.ava('t3', icon('team')), h('span.grow', {}, h('strong', `@${ALL[0]}`), h('small', `一次唤醒全部 ${n} 位`)), icon('at', 'sm')),
          cur.members.map((m, i) => h('button.go', { type: 'button', onclick: () => mention(m.name) },
            conv.ava(`t${i % 4}${busy.has(m.name) ? '.is-busy' : ''}`, [conv.initial(m.name), h('i')]),
            h('span.grow', {}, h('strong', m.name), h('small', {}, busy.has(m.name) ? h('span.shim', '正在回复') : '待命 · @ 唤醒')), icon('at', 'sm')))),
        h('button.btn.sm.as-manage', { type: 'button', onclick: () => edit('members') }, icon('plus'), '管理成员'),
        h('hr'), h('h3.sec', '从对话到行动'), h('p', '明确委派的工作会创建 ash 任务，进度留在对话里，详细过程放在任务页。'),
        h('div.as-stat', {}, h('strong.num', String(tasksOf(cur))), h('span', '项关联任务')),
        h('small', '被点名时读取本群共享摘要和近期完整消息。接近预算上限时整理较早历史，原文保留，不读取其他群。'));
    }
    function paintLive() {
      const names = [...new Set(active(cur).map((m) => m.who))];
      box.busy(names.length ? `${names.join('、')} 正在回复` : null);
      box.note(cur.cleared ? conv.CLEARED_NOTE : null);
      paintInfo();
    }

    /* ---------- 群聊设置 / 新建群聊：换掉头部、消息和输入区，右栏也让开（照现状）。每位成员「选谁干活」是那颗三段胶囊 ---------- */
    const editEl = h('section.as-edit', { hidden: true });
    const AGENTS = Object.keys(ASH.AGENTS);
    function edit(kind) {
      const creating = kind === 'create';
      const room = creating ? null : cur;
      const members = creating ? [] : room.members.map((m) => ({ ...m, was: m.name }));
      const name = h('input.field', { value: creating ? '协作空间' : room.name, maxlength: '80' });
      const fields = h('div.as-fields');
      const save = h('button.btn.pri', { type: 'button', onclick: commit }, creating ? '创建群聊' : '保存设置');
      const add = h('button.btn.sm', { type: 'button', onclick: () => {
        const agent = AGENTS[members.length % AGENTS.length];
        let label = agent;
        for (let n = 2; members.some((m) => m.name === label); n += 1) label = `${agent}-${n}`;
        members.push(member(label, agent));
        draw();
      } }, icon('plus'), '添加成员');
      const sync = () => { save.disabled = !members.length || !name.value.trim(); add.disabled = members.length >= 24; };
      function draw() {
        fields.replaceChildren(...members.map((m, i) => {
          const face = conv.ava(`t${i % 4}`, conv.initial(m.name));
          const nick = h('input.field', { value: m.name, maxlength: '32' });
          nick.addEventListener('input', () => { m.name = nick.value; face.textContent = conv.initial(m.name); });
          const pick = ASH.target({ value: { agent: m.agent, model: m.model, level: m.level }, label: '执行器', onchange: (next) => Object.assign(m, next) });
          return h('div.as-field', {}, face, h('label', {}, '点名名称', nick), h('div.as-pick', {}, h('span', '执行器'), pick.el),
            h('button.ico.sm', { type: 'button', 'aria-label': `移除 ${m.name}`, 'data-tip': '移除', onclick: () => { members.splice(i, 1); draw(); } }, icon('x')));
        }));
        sync();
      }
      function commit() {
        const next = members.map((m) => member(m.name.trim() || m.agent, m.agent));
        next.forEach((m, i) => { m.model = members[i].model; m.level = members[i].level; });
        if (creating) { const made = { name: name.value.trim(), members: next, msgs: [] }; state.rooms.push(made); open(made); box.input.focus(); return; }
        /* 改了点名名称的，旧消息跟着换名字 */
        members.forEach((m, i) => { if (m.was && m.was !== next[i].name) for (const msg of room.msgs) if (msg.who === m.was) msg.who = next[i].name; });
        room.name = name.value.trim();
        room.members = next;
        open(room);
        nameBtn.focus();
      }
      name.addEventListener('input', sync);
      editEl.setAttribute('aria-label', creating ? '创建群聊' : '群聊设置');
      editEl.replaceChildren(
        h('header', {}, h('div', {}, h('small', '让合适的人参与'), h('h2', creating ? '创建一个聊天空间' : '群聊设置')),
          h('button.ico', { type: 'button', 'aria-label': '关闭成员配置', 'data-tip': '关闭', onclick: () => { editing = null; editEl.replaceChildren(); paint(); if (cur) { feed.toEnd(); nameBtn.focus(); } } }, icon('x'))),
        h('p', {}, '选择智能体、模型与智能水平。只有你明确 @ 的成员才会收到会话并回复；', h('strong', '@all（或 @所有人）一次唤醒全部成员'), '，所以成员名不能叫 all 或所有人。'),
        h('p', '所有已注册智能体均可参与。被你 @ 后可查看当前项目、使用工具辅助回答；修改代码等执行工作需你明确委派，再创建任务。'),
        h('p', '写入或无法确认只读的工具调用会中止咨询并保留警告；咨询期间项目目录的并发变化不会中止回复，只随回复附注展示。已发生的改动都不会自动撤销。'),
        h('label.as-roomname', {}, '群聊名称', name), fields, add,
        h('footer', {}, creating ? h('span', '智能体之间的 @ 只展示，不会触发执行。') : h('button.btn.danger', { type: 'button', onclick: () => removeRoom(room) }, icon('trash'), '删除群聊'), save));
      editing = kind;
      showMenu(false);
      paint();
      draw();
      conv.arrive(editEl);
      name.focus();
    }
    /* 删除走全应用那一个确认框，标题和正文是产品里的原文 */
    async function removeRoom(room) {
      const yes = await ASH.confirm({ title: `删除群聊「${room.name}」`, ok: '删除群聊', danger: true,
        body: '这个群的全部消息和历史摘要会一起删除，无法恢复。正在进行的回复会先停止；由这个群创建过的任务不受影响，仍留在任务列表里。' });
      if (!yes || !alive || !state.rooms.includes(room)) return;
      for (const m of active(room)) clearTimeout(m.timer);
      state.rooms.splice(state.rooms.indexOf(room), 1);
      rowOf.delete(room);
      if (state.rooms.length) { open(state.rooms[0]); nameBtn.focus(); } else { cur = null; edit('create'); }
    }

    /* 一个群都没有、又关掉了新建那一页时的空态 */
    const blank = h('div.none.as-blank', { hidden: true }, icon('chat'), h('h2', '把想法变成对话'), h('p', '建立一个空间，和你的智能体一起聊。'),
      h('button.btn.pri', { type: 'button', onclick: () => edit('create') }, '新建群聊'));

    function open(room) {
      cur = room;
      editing = null;
      editEl.replaceChildren();
      box.set('');
      paint();
      drawFeed();
    }
    function paint() {
      const on = !!cur && !editing;
      feed.el.hidden = box.el.hidden = info.hidden = !on;
      editEl.hidden = !editing;
      blank.hidden = !!cur || !!editing;
      head.hidden = !!editing;
      nameBtn.hidden = conn.hidden = countBtn.hidden = !cur;
      nobody.hidden = !!cur;
      drawList();
      if (!on) return;
      nameEl.textContent = cur.name;
      nameBtn.setAttribute('aria-label', `群聊设置：${cur.name}`);
      count.textContent = `${cur.members.length} 位成员`;
      box.input.placeholder = `发消息到 #${cur.name}，@ 选择成员、@all 唤醒全部…`;
      paintLive();
    }

    main.append(h('section.sv-chat.as-root', { 'aria-label': '聊天模式' }, rail, h('div.as-mid', {}, head, feed.el, blank, editEl, box.el), info));
    paint();
    drawFeed();
    return () => { alive = false; for (const id of timers) clearTimeout(id); removeEventListener('pointerdown', away, true); };
  }

  ASH.surface('chat', { chrome: 'app', mount });
})();
