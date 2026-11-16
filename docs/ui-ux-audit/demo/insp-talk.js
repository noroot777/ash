/* 右侧面板里的两格：子智能体、侧聊。其余五格在 insp-work.js，外壳在 insp.js；造法和控制器 c 的用法同那边。
   子智能体：一行一个，右边是用时。在跑的那几个排在最前，用时是主色，底下多一行它此刻在做什么；别的状态只换右边那几个字。
     点开先是它带回来的话，再是一行出处（类型 · 模型 · 几点派的），「收到的输入」折着，「执行过程」通到盖住会话的那只抽屉（样机没画）。
     现在的三格统计、一段说明、每行一颗「查看执行」都不要了。待办收成最底下一行：它在会话的执行过程里也有一份。
   侧聊：一场聊天拿它的第一句话当名字，换场走面板头那颗钟；你的话靠右，它的话靠左，都不报名字。
     它的每条回答指到才出两颗键：复制、发给主任务。发出去以后那条回答底下多一行回执——主任务还在跑就先排着（能撤回），空下来才送到。
     原来要靠你打一句「把结论告诉主任务」、再由它判断你是不是真要发。
     从主会话带一段过来问：那一段是输入框上面的一行引用，发出去以后跟在你那句话的上面。
   听 agents:spawn { title, kind, model, ms, acts, result, input }：执行中那一轮派出来的子智能体。 */
(ASH.insp ??= { build: {}, packs: [] }).packs.push((I) => {
  const { h, icon } = ASH;
  const { none, reenter, fold, leave, tool, copyBtn, grow, clock } = I.kit;
  const live = (text) => h('span.insp-live', text);
  ASH.icons.toMain ??= '<path d="M6.5 3.5 3 7l3.5 3.5"/><path d="M3 7h6a4 4 0 0 1 4 4v1.5"/>';

  /* ---------- 子智能体 ---------- */
  I.build.agents = (c) => {
    const WORD = { stop: '已停止', fail: '失败' };
    const EARLY = [
      { title: '查定时回复是在哪里排上定时器的', kind: 'Explore', model: 'haiku-4-5', at: '14:15', ms: 48000,
        input: '找出定时回复是在哪里排上定时器的：入口在哪个函数，ash 启动时怎么把还没发的重新排上，已经过了点的走哪条分支。只读代码，不要改。',
        result: '入口在 server/src/later-send.ts 的 arm()。启动时它只给还没到点的消息挂定时器；已经过了点的那几条在循环里被直接跳过，没有补发这一步。' },
      { title: '查待发送的定时消息怎么存', kind: 'Explore', model: 'haiku-4-5', at: '14:15', ms: 72000,
        input: '看待发送的定时消息存在哪、有哪些字段、撤回和发出各改了什么。只读代码，不要改。',
        result: '存在 later_messages 表里，三个时间：原定几点发、实际几点发的、几点撤回的。撤回只记时间、不删行；发出去才记实际时间。读写都在 server/src/later-send-store.ts。' },
      { title: '找现有的定时发送测试', kind: 'Explore', model: 'haiku-4-5', at: '14:16', ms: 36000,
        input: '找出现在有哪些测试覆盖了定时发送，各测了什么场景，有没有「过了点才启动」这一种。',
        result: '只有 server/scripts/test-later-send.ts，15 条，测的都是「没重启、到点发出」。没有一条覆盖「过了点才启动」。' },
    ];
    const TODOS = ['找到过了点不补发的原因', '启动时把过了点的补发出去', '补发的消息上标一句「补发」', '补一份回归测试', '写清楚这次改了什么'];
    const rows = [];
    const list = h('div.insp-agents');
    const empty = none('这个任务没有派过子智能体。');
    let ticker = 0, batch = 0;

    function make(a) {
      const side = h('span.meta');
      const doing = h('p.insp-agent-doing.cut', { hidden: true });
      const out = h('p');
      const facts = h('p.insp-agent-facts');
      const brief = h('p.insp-agent-in', { hidden: true }, a.input);
      const briefBtn = h('button.insp-fold', { type: 'button', 'aria-expanded': 'false', onclick: () => fold(briefBtn, brief) }, icon('chev', 'insp-rot'), '收到的输入');
      const more = h('div.insp-agent-more', { hidden: true }, out, facts,
        h('div.insp-folds', {}, briefBtn, h('button.insp-fold.end', { type: 'button', onclick: () => ASH.todo('子智能体的执行过程') }, '执行过程', icon('chev'))), brief);
      const btn = h('button.insp-row', { type: 'button', 'aria-expanded': 'false', onclick: () => fold(btn, more) }, h('span.cut', a.title), icon('chev', 'sm insp-rot'), side);
      a.el = h('div.insp-agent', {}, btn, doing, more);
      a.tick = () => { side.textContent = WORD[a.state] ?? ASH.dur(a.ms); };
      a.paint = () => {
        const going = a.state === 'run';
        side.className = `meta num${going ? ' insp-live' : a.state === 'fail' ? ' bad' : ''}`;
        doing.hidden = !going || !a.doing;
        if (a.doing) ASH.swap(doing, a.doing);
        out.hidden = !a.result;
        out.textContent = a.result ?? '';
        facts.textContent = [a.kind, a.model, `${a.at} 派出`, WORD[a.state] && `跑了 ${ASH.dur(a.ms)}`].filter(Boolean).join(' · ');
        a.tick();
      };
      a.paint();
      return a;
    }
    function paint() {
      const going = rows.filter((a) => a.state === 'run');
      empty.hidden = rows.length > 0;
      c.mark('agents', going.length ? 'run' : rows.length ? 'has' : null, rows.length);
      clearInterval(ticker);
      ticker = going.length ? setInterval(() => { for (const a of going) { a.ms = performance.now() - a.t0; a.tick(); } }, 1000) : 0;
    }
    function end(a, how) {
      if (a.state !== 'run') return;
      for (const id of a.timers) clearTimeout(id);
      Object.assign(a, { state: how, ms: performance.now() - a.t0, doing: '' }, how === 'done' ? {} : { result: null });
      a.paint();
      paint();
    }
    /* 新派出来的排在最前；和上一轮派的那几个之间多留一点空，不写「第几批」。它此刻在做什么按剧本一句一句换，到点带着结果落定 */
    function start(spec) {
      const { ms, acts = [], result, ...rest } = spec;
      const a = make({ ...rest, batch, at: clock(), ms: 0, t0: performance.now(), state: 'run', doing: acts[0] ?? '', result: null, timers: [] });
      a.el.classList.add('enter');
      if (rows[0] && rows[0].batch !== batch) rows[0].el.classList.add('is-older');
      a.timers = [
        ...acts.slice(1).map((text, i) => setTimeout(() => { a.doing = text; a.paint(); }, (ms * (i + 1)) / acts.length)),
        setTimeout(() => { a.result = result; end(a, 'done'); }, ms),
      ];
      rows.unshift(a);
      list.prepend(a.el);
      paint();
    }
    for (const spec of EARLY) { const a = make({ ...spec, state: 'done' }); rows.push(a); list.append(a.el); }
    rows[0].el.dataset.m = 'insp-12';
    ASH.on('agents:spawn', (spec) => { if (spec?.title) start(spec); });
    c.on('run', (on) => { if (on) batch++; else for (const a of rows) end(a, 'stop'); });   // 主任务这一轮停了，它派出去的也跟着停

    const todoList = h('ol.insp-todo', { hidden: true }, TODOS.map((text) => h('li', {}, icon('check', 'sm'), h('span', text))));
    const todoBtn = h('button.insp-row.insp-todo-row', { type: 'button', 'aria-expanded': 'false', onclick: () => fold(todoBtn, todoList) },
      h('span', '待办'), icon('chev', 'sm insp-rot'), h('span.meta.num', `${TODOS.length} / ${TODOS.length}`));
    paint();
    return [list, empty, todoBtn, todoList];
  };

  /* ---------- 侧聊 ---------- */
  I.build.chat = (c) => {
    const FIRST = '补发只在启动时跑一次：过了点还没发的，按原定时间排好，前一条发出去才发下一条，每条标一句「补发」。';
    const ANSWERS = [
      '不会。启动时只补一次；之后新定的消息还是各等各的点，和补发没有关系。',
      '有记录。每补发一条都记一笔：原定几点、实际几点发的。回复框上面「待发送」那一排里，这一条会多一句「补发 · 晚了 2 小时」。',
      '这一点主会话里没提到过。我只知道开这场侧聊那一刻主会话里的内容，要不要查一下，可以发给主任务让它去看。',
    ];
    const rooms = [];
    let room = null, timer = 0, quote = null, asked = 0, mainBusy = false;
    let stop = () => {};
    const whenIdle = new Set();   // 排着等主任务空下来的那几条
    const who = { agent: 'claude', model: null, level: null };

    const log = h('div.insp-log', { role: 'log', 'aria-label': '侧聊消息' });
    const area = h('textarea', { rows: 1, 'aria-label': '侧聊消息输入' });
    const reset = grow(area);
    const quoteText = h('p');
    const quoteBox = h('div.insp-quote', { hidden: true }, quoteText, tool('x', '不带这一段', () => setQuote(null)));
    const whoText = h('span');
    const whoBtn = h('button.insp-who', { type: 'button', 'aria-haspopup': 'listbox', 'data-tip': '谁来答', onclick: () => pickWho() }, whoText, icon('caret', 'sm'));
    const sendBtn = h('button.btn.pri.insp-send', { type: 'button', onclick: () => (timer ? stop() : send()) });

    /* 谁来答：平时只有执行器的名字；模型、智能水平指定过才跟在后面。三样在同一张菜单里改 */
    const paintWho = () => {
      whoText.textContent = [who.agent, who.model, who.level].filter(Boolean).join(' · ');
      whoBtn.setAttribute('aria-label', `谁来答：${whoText.textContent}`);
    };
    function pickWho() {
      const kit = ASH.AGENTS[who.agent];
      const row = (key, value, label) => ({ label, selected: who[key] === value, onpick: () => { Object.assign(who, key === 'agent' && value !== who.agent ? { agent: value, model: null, level: null } : { [key]: value }); paintWho(); } });
      ASH.menu(whoBtn, [
        '执行器', ...Object.keys(ASH.AGENTS).map((name) => row('agent', name, name)),
        '模型', row('model', null, '跟随执行器'), ...kit.models.map((name) => row('model', name, name)),
        '智能水平', row('level', null, '跟随'), ...kit.levels.map((name) => row('level', name, name)),
      ], { role: 'listbox', place: 'top-start' });
    }

    /* 面板头：聊过才有那颗钟（换一场），正在一场里才有「+」 */
    const paintActs = () => c.setActs('chat', [
      rooms.length > (room ? 1 : 0) && tool('clock', '换一场侧聊', (e) => ASH.menu(e.currentTarget,
        rooms.map((r) => ({ label: r.title, hint: r.at, selected: r === room, onpick: () => pick(r) })), { role: 'listbox', place: 'bottom-end', cls: 'insp-rooms' }), { 'aria-haspopup': 'listbox' }),
      room && tool('plus', '新开一场', () => pick(null)),
    ].filter(Boolean));
    const paintKey = () => {
      sendBtn.replaceChildren(icon(timer ? 'stop' : 'up'));
      sendBtn.setAttribute('aria-label', timer ? '停止回答' : '发送');
      sendBtn.disabled = !timer && !area.value.trim();
    };
    function setQuote(text) {
      quote = text;
      quoteBox.hidden = !text;
      quoteText.textContent = text ?? '';
      area.placeholder = text ? '想问这一段什么？' : '问个问题，不打断主任务…';
      if (text) reenter(quoteBox);
    }
    function pick(next) {
      if (timer) stop();
      if (room) room.nodes = [...log.children];
      room = next;
      log.replaceChildren(...(next?.nodes ?? []));
      paintActs();
      area.focus({ preventScroll: true });
    }

    const mine = (text, cited) => h('div.insp-me', {}, cited && h('p.bubble-quote', cited), h('p', text));
    /* 它的一条回答：正文、指到才出的两颗键、回执。发给主任务：主任务在跑就排着，空下来才送到；排着的时候能撤回 */
    function answer(text) {
      const body = h('p', {}, text ?? live('在想'));
      const receipt = h('p.insp-receipt', { hidden: true });
      const acts = h('span.insp-ans-acts');
      const el = h('article.insp-ans', {}, body, h('footer.insp-ans-foot', {}, receipt, acts));
      function arm(said) {
        const fwd = tool('toMain', '发给主任务', () => {
          let undo = null;
          const land = () => { undo = null; receipt.replaceChildren(icon('check', 'sm'), h('span', '已送达主任务')); };
          const back = h('button.sys-more', { type: 'button', onclick: () => { undo?.(); leave(receipt, () => { receipt.hidden = true; fwd.hidden = false; fwd.focus({ preventScroll: true }); }); } }, '撤回');
          fwd.hidden = true;
          receipt.hidden = false;
          receipt.replaceChildren(icon('clock', 'sm'), h('span', mainBusy ? '排着，主任务空下来就发' : '正在发给主任务'), back);
          reenter(receipt);
          if (mainBusy) { whenIdle.add(land); undo = () => whenIdle.delete(land); } else { const id = setTimeout(land, 900); undo = () => clearTimeout(id); }
        });
        acts.replaceChildren(copyBtn(said, '复制'), fwd);
      }
      if (text) arm(text);
      return { el, settle(said, stopped) {
        body.replaceChildren(stopped ? h('span.insp-stopped', '已停止') : said);
        if (!stopped) arm(said);
        reenter(body);
      } };
    }
    const push = (...nodes) => { log.append(...nodes); nodes.at(-1).scrollIntoView({ block: 'nearest' }); };

    function send() {
      const text = area.value.trim();
      if (!text || timer) return;
      reset();
      if (!room) {
        room = { title: text, at: clock(), nodes: [] };
        rooms.unshift(room);
        log.append(h('p.insp-snap', { 'data-tip': '它知道的是这一刻之前的主会话；之后的新内容要新开一场才带得上' }, `主会话快照 ${room.at}`));
        paintActs();
      }
      const me = mine(text, quote);
      const reply = answer();
      me.classList.add('enter');
      reply.el.classList.add('enter');
      setQuote(null);
      push(me, reply.el);
      const said = ANSWERS[asked++ % ANSWERS.length];
      const here = room;
      const done = (stopped) => {
        timer = 0;
        stop = () => {};
        reply.settle(said, stopped);
        if (here === room) reply.el.scrollIntoView({ block: 'nearest' });
        paintKey();
      };
      timer = setTimeout(() => done(false), 1600);
      stop = () => { clearTimeout(timer); done(true); };
      paintKey();
    }

    area.addEventListener('input', paintKey);
    area.addEventListener('keydown', (e) => { if (ASH.sendKey.hit(e)) { e.preventDefault(); send(); } });
    c.on('show:chat', ({ quote: text } = {}) => { if (text) { setQuote(text); area.focus({ preventScroll: true }); } });
    c.on('run', (on) => {
      mainBusy = on;
      if (!on) for (const land of [...whenIdle]) { whenIdle.delete(land); land(); }
    });

    /* 开着样机时已经聊过的一场 */
    room = { title: '补发的时候如果攒了十几条，会不会一下子全发出去？', at: '15:31', nodes: [] };
    rooms.push(room);
    log.append(h('p.insp-snap', { 'data-tip': '它知道的是这一刻之前的主会话；之后的新内容要新开一场才带得上' }, '主会话快照 15:31'),
      mine(room.title), answer(`不会一下子全发。${FIRST}`).el,
      mine('这种情况平时会遇到吗？', '系统时间往回拨以后，同一条被补发两次'), answer('很少。要么是手动改了系统时间，要么是虚拟机恢复快照以后时钟往回跳。合上笔记本再打开不会。').el);
    log.lastElementChild.dataset.m = 'insp-13';

    setQuote(null);
    paintWho();
    paintKey();
    paintActs();
    return [log, h('div.insp-ask.inbox', {}, quoteBox, area, h('div', {}, tool('clip', '添加文件或图片', () => ASH.todo('添加文件或图片')), whoBtn, h('span.grow'), sendBtn))];
  };
});
