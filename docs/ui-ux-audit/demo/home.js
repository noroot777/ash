/* 首页（面 home）与新建面板（面 new）：同一个输入块的两种形态。
   清单只动四处（home-1…home-4）：首页就是输入框；卡片限宽 720、两面落在同一处；选项入口从卡片上方挪到输入区下面、
   上方只剩三种模式、写作参考进「更多选项」；面板底下那行小字收进发送键的提示和 ⌘/ 帮助。
   其余照现状（web/src/composer）：模式叫单任务 / 团队 / 讨论，入口的名字、次序、默认值不变，标题栏是项目名、清空草稿、取消 Esc。
   选项点开之后的内容在 home-opts.js（ASH.homeOpts）。草稿跨两面留着。 */
(() => {
  const { h, icon, $ } = ASH;
  ASH.icons.expand = '<path d="M9.5 2.5h4v4M13.5 2.5 9 7M6.5 13.5h-4v-4M2.5 13.5 7 9"/>';

  /* 模式：值、名字、图标、输入区的占位（三样都照现状） */
  const MODES = [
    ['single', '单任务', 'bot', '想完成什么？\n\n一个问题、一个想法，或一个完整的目标。'],
    ['team', '团队', 'team', '想让团队完成什么？\n\n写下目标，剩下的交给团队。'],
    ['duet', '讨论', 'chat', '有什么想一起讨论？\n\n写下背景、方案，或一个还没想清楚的问题。'],
  ];
  const FILES = ['回复框-回车被吞.png', 'slash-menu.log', '复现步骤.md'];

  /* 哪一下算「创建」跟全局的「发送键」设置走（默认回车；另一档是 ⌘ 回车）。⌘/Ctrl+回车两档下都算，Shift/Alt+回车永远是换行。
     判定和键名用发送键自己那一份（ASH.sendKey.mode / caps / hit），和回复框是同一处；它不在时按同样的规矩兜底 */
  const sendMode = () => ASH.sendKey?.mode?.() ?? (/^mod/.test(ASH.data?.sendKey ?? '') ? 'mod' : 'enter');
  const keycap = () => ASH.sendKey?.caps?.() ?? (sendMode() === 'mod' ? { send: '⌘↵', newline: '↵' } : { send: '↵', newline: '⇧↵' });
  const sendHit = (e) => ASH.sendKey?.hit?.(e) ?? (e.key === 'Enter' && !e.isComposing && e.keyCode !== 229 && !e.shiftKey && !e.altKey && (e.metaKey || e.ctrlKey || sendMode() === 'enter'));
  /* ⌘/ 帮助：原来面板底下那行小字（/、@、发送键）进「输入」一组，其余是现有键位 */
  const keys = () => [
    ['输入', [['调用技能', '/'], ['引用项目文件', '@'], ['换行', keycap().newline], ['创建并运行', keycap().send]]],
    ['任务', [['新建任务', 'C'], ['运行', 'R'], ['上一条 / 下一条', 'K', 'J'], ['任务列表', 'F']]],
    ['跳转', [['全局跳转', '⌘K'], ['任务模式', 'G', 'T'], ['设置', 'G', 'S'], ['终端', 'G', 'Z']]],
    ['面板', [['右侧面板', 'I', '字母'], ['会话输入导航', 'Q'], ['关闭', 'Esc'], ['快捷键', '⌘/']]],
  ];

  let draft = null;
  const theDraft = () => (draft ??= { text: '', mode: 'single', files: [], ...ASH.homeOpts.defaults() });

  /* ---------- 选项浮层：外观就是 .pop，开关自己管 ----------
     里面要放下拉和三段胶囊，而 ASH.pop 一次只开一个（开它们的菜单会把外层关掉），所以这一层单独管：
     点在自己、触发钮、任何 .pop（里面那层菜单）或确认框上都不关；Esc 先关里面那层，再关自己；
     别处开了不是下拉菜单的浮层（⌘K 跳转、帮助、启动设置），自己让开。
     内容变高变宽（换了工作方式）、页面滚动或改了窗口大小，位置跟着重算。
     openSheet(触发钮, { name, build() → 内容, wide() → 要不要宽的那一档, end: 右缘对齐触发钮（它在卡片右半边时） }) */
  let sheet = null;
  const closeSheet = (back) => sheet?.(back);
  function openSheet(anchor, { name, build, wide, end }) {
    if (sheet?.anchor === anchor) { sheet(); return; }
    sheet?.();
    ASH.closePop();
    const el = h('div.pop.sv-home-pop', { role: 'dialog', tabindex: '-1', 'aria-label': name }, build());
    document.body.append(el);
    const place = () => {
      el.classList.toggle('is-wide', Boolean(wide?.()));
      const a = anchor.getBoundingClientRect();
      const w = el.offsetWidth;
      const tall = el.offsetHeight;
      const up = a.bottom + 6 + tall > innerHeight - 8 && a.top - tall - 6 > 8;
      el.style.left = `${Math.max(8, Math.min(end ? a.right - w : a.left, innerWidth - w - 8))}px`;
      el.style.top = `${Math.max(8, up ? a.top - tall - 6 : a.bottom + 6)}px`;
      el.style.setProperty('--origin', `${up ? 'bottom' : 'top'} ${end ? 'right' : 'left'}`);
    };
    place();
    requestAnimationFrame(() => el.classList.add('is-in'));
    anchor.setAttribute('aria-expanded', 'true');
    const outside = (e) => { if (!anchor.contains(e.target) && !e.target.closest?.('.pop, .veil')) close(); };
    const key = (e) => {
      /* 里面那层菜单、确认框、正在起名的输入框（data-esc）先收这一下 Esc */
      if (e.key !== 'Escape' || $('.pop.is-in:not(.sv-home-pop)') || $('.veil') || e.target.matches?.('[data-esc]')) return;
      e.stopPropagation();
      close(true);
    };
    const rival = new MutationObserver((changes) => {
      if (changes.some((c) => [...c.addedNodes].some((n) => n !== el && n.classList?.contains('pop') && !n.classList.contains('sel-menu')))) close();
    });
    const size = new ResizeObserver(place);
    function close(back) {
      if (sheet !== close) return;
      sheet = null;
      anchor.setAttribute('aria-expanded', 'false');
      removeEventListener('pointerdown', outside, true);
      removeEventListener('keydown', key, true);
      removeEventListener('resize', place);
      removeEventListener('scroll', place, true);
      rival.disconnect();
      size.disconnect();
      el.classList.remove('is-in');
      setTimeout(() => el.remove(), 130);
      if (back) anchor.focus({ preventScroll: true });
    }
    close.anchor = anchor;
    close.place = place;
    addEventListener('pointerdown', outside, true);
    addEventListener('keydown', key, true);
    addEventListener('resize', place);
    addEventListener('scroll', place, true);
    rival.observe(document.body, { childList: true });
    size.observe(el);
    sheet = close;
    el.focus({ preventScroll: true });
  }

  /* ---------- ⌘/ 帮助 ---------- */
  const helpSheet = () => h('div.grid', { role: 'group', 'aria-label': '快捷键' }, keys().map(([name, rows]) => h('section', {},
    h('h3.sec', name),
    h('dl', rows.map(([what, ...caps]) => [h('dt', what), h('dd', caps.map((k) => h('kbd', k)))])))));
  function toggleHelp(anchor) {
    if (!anchor?.isConnected) return;
    closeSheet();
    ASH.pop(anchor, helpSheet(), { place: 'bottom-end', cls: 'sv-home-help' });
  }

  /* 发送键用回复框那一颗（launch：尖角点开是「启动设置」五档）；它不在时退回一颗只画箭头的主按钮 */
  function sendKey(onsend) {
    const opts = { hint: '创建并运行', key: keycap().send, onsend, size: 36, launch: true };
    let key = null;
    try { key = ASH.sendKey ? ASH.sendKey(opts) : null; } catch { key = null; }
    if (key?.el) return key;
    const el = h('button.btn.pri.own-send', { type: 'button', 'aria-label': opts.hint, 'data-tip': opts.hint, 'data-key': opts.key, onclick: () => onsend() }, icon('up'));
    return { el, update: ({ empty } = {}) => { el.classList.toggle('is-disabled', Boolean(empty)); el.setAttribute('aria-disabled', String(Boolean(empty))); } };
  }

  /* ---------- 输入块 ---------- */
  function composer({ compact, mark, onsubmit, onchange }) {
    const d = theDraft();
    /* 首页的精简形态只建单任务；模式留给新建面板，也不动草稿里选好的那种 */
    const mode = () => (compact ? 'single' : d.mode);
    const area = h('textarea.draft', { rows: 3, 'aria-label': '任务目标' });
    area.value = d.text;
    const grow = () => { area.style.height = 'auto'; area.style.height = `${area.scrollHeight}px`; };

    /* 附件：点一下加一个，粘贴图片也进这里；有附件时底排下面写着个数 */
    const files = h('div.files', { hidden: true });
    const status = h('div.status', { role: 'status', hidden: true });
    const countFiles = () => {
      files.hidden = !d.files.length;
      status.hidden = !d.files.length;
      status.textContent = `${d.files.length} 个附件`;
    };
    const addFile = (name, fresh) => {
      const chip = h(`span.file${fresh ? '.enter' : ''}`, {}, icon(/\.png$/.test(name) ? 'image' : 'file', 'sm'), h('span.cut', name),
        h('button', { type: 'button', 'aria-label': `移除 ${name}`, onclick: () => { d.files = d.files.filter((f) => f !== name); chip.remove(); sync(); } }, icon('x', 'sm')));
      files.append(chip);
    };
    const attach = (name) => { if (!name || d.files.includes(name)) return; d.files.push(name); addFile(name, true); sync(); };
    d.files.forEach((name) => addFile(name, false));
    const clip = h('button.ico', { type: 'button', 'aria-label': '上传附件', 'data-tip': '上传附件', onclick: () => attach(FILES.find((f) => !d.files.includes(f))) }, icon('clip'));
    area.addEventListener('paste', (e) => {
      if (![...(e.clipboardData?.items ?? [])].some((it) => it.kind === 'file')) return;
      e.preventDefault();
      attach(`粘贴的图片 ${d.files.filter((f) => f.startsWith('粘贴')).length + 1}.png`);
    });

    /* 底排的选项入口：图标 + 键上原来那几个字，不带尖角；开关和下拉在点开的浮层里（内容见 home-opts.js） */
    const api = {
      paint: () => paint(),
      close: (back) => closeSheet(back),
      fit: () => sheet?.place(),
      insert: (text) => { area.value = area.value.trim() ? `${area.value}\n\n${text}` : text; sync(); area.focus(); },
      setMode: (next) => {
        if (!compact) { setMode(next, true); return; }
        d.mode = next;
        if (next !== 'single') ASH.go('#/new');   /* 首页只建单任务：选了团队 / 讨论就展开成新建面板，草稿带过去 */
      },
    };
    const option = (kind) => {
      const glyph = h('span.glyph');
      const text = h('span.cut');
      const o = { glyph, text, shown: '', label: '' };
      o.btn = h('button.opt', { type: 'button', 'data-kind': kind, 'aria-haspopup': 'dialog', onclick: () => openSheet(o.btn, {
        name: o.label, build: () => ASH.homeOpts.sheet(kind, d, mode(), api), wide: () => ASH.homeOpts.wide(kind, d, mode()), end: kind === 'cast' }) }, glyph, text);
      return o;
    };
    const opts = compact ? { where: option('where') } : { work: option('work'), where: option('where'), org: option('org'), cast: option('cast') };
    const more = h('button.opt.only', { type: 'button', 'aria-label': '更多选项', 'aria-haspopup': 'dialog', 'data-tip': '更多选项', onclick: () => openSheet(more, { name: '更多选项', build: () => ASH.homeOpts.sheet('more', d, mode(), api) }) }, icon('more'));
    const expand = h('button.opt.only', { type: 'button', 'aria-label': '全部选项', 'data-tip': '全部选项', 'data-key': 'C', onclick: () => ASH.go('#/new') }, icon('expand'));

    /* 谁来做：单任务是底排这颗三段胶囊；按起手式走时由那条线的「让 AI 干活」一站决定，这里只读；团队 / 讨论是一颗入口（opts.cast） */
    const caps = ASH.target({ value: d.who.single, label: '任务执行器', onchange: (value) => { d.who.single = value; paint(); } });
    const run = h('span.preset-run', { hidden: true }, icon('flow', 'sm'), h('span.cut'));

    let painted = false;
    const show = (el, on) => {
      if (el.hidden === !on) return;
      el.hidden = !on;
      el.classList.toggle('enter', on && painted);
    };
    function paint() {
      const face = ASH.homeOpts.face(d, mode());
      for (const [kind, o] of Object.entries(opts)) {
        const f = face[kind];
        show(o.btn, Boolean(f));
        if (!f) continue;
        if (o.shown !== f.glyph) { o.glyph.replaceChildren(icon(f.glyph)); o.shown = f.glyph; }
        if (painted) ASH.swap(o.text, f.text); else o.text.textContent = f.text;
        const full = `${f.label}：${f.value ?? f.text}`;
        o.label = f.label;
        o.btn.setAttribute('aria-label', full);
        o.btn.dataset.tip = full;
        o.btn.classList.toggle('is-set', Boolean(f.set));
      }
      const preset = mode() === 'single' && d.flow === 'preset';
      /* 按起手式走时执行器是在「工作方式」里那一站改的：底排这颗跟上，切回自由工作流时不是旧值 */
      if (JSON.stringify(caps.value) !== JSON.stringify(d.who.single)) caps.set(d.who.single);
      show(caps.el, mode() === 'single' && !preset);
      show(run, preset);
      run.lastChild.textContent = face.run;
      run.dataset.tip = `起手式执行器：${d.who.single.agent} · ${face.run}`;
      painted = true;
    }

    /* 正文或附件有一样就能建；发送键只画箭头，「创建并运行」和快捷键在它的提示里 */
    const submit = () => {
      if (!area.value.trim() && !d.files.length) { area.focus(); return; }
      d.text = '';
      d.files = [];
      closeSheet();
      onsubmit();
    };
    const send = sendKey(submit);
    function sync() {
      d.text = area.value;
      countFiles();
      send.update?.({ empty: !area.value.trim() && !d.files.length, running: false });
      grow();
      onchange?.();
    }
    area.addEventListener('input', () => {
      /* 敲「/team 目标…」直接切模式，命令本身不留在正文里（/single、/duet 同理） */
      const cmd = /^\s*\/(single|team|duet)\s+([\s\S]*)$/i.exec(area.value);
      if (cmd) area.value = cmd[2];
      sync();
      if (cmd) api.setMode(cmd[1].toLowerCase());
    });
    /* 键盘和点键走同一个闸：发送键有 submit() 就交给它（空着、传着附件时它不放行） */
    area.addEventListener('keydown', (e) => {
      if (!sendHit(e)) return;
      e.preventDefault();
      if (send.submit) send.submit(); else submit();
    });

    const help = h('button.ico.sm.help', { type: 'button', 'aria-label': '快捷键', 'aria-haspopup': 'dialog', 'data-tip': '快捷键', 'data-key': '⌘/', 'data-m': 'home-4', onclick: () => toggleHelp(help) }, icon('help'));

    /* 模式：卡片上方只剩这三种。切了以后占位、底排的入口跟着变 */
    let modes = null;
    function setMode(next, animate) {
      if (!compact) d.mode = next;
      for (const b of modes?.children ?? []) b.setAttribute('aria-pressed', String(b.dataset.mode === mode()));
      area.placeholder = MODES.find(([m]) => m === mode())[3];
      if (animate) closeSheet();
      paint();
    }
    if (!compact) {
      modes = h('div.seg', { role: 'group', 'aria-label': '任务模式', 'data-m': 'home-3' }, MODES.map(([id, name, glyph]) => h('button', { type: 'button', 'data-mode': id, onclick: () => { setMode(id, true); area.focus(); } }, icon(glyph, 'sm'), h('span', name))));
    }

    const el = h('div.cmp', {},
      modes && h('div.modes.enter', {}, modes),
      h('div.inbox.box', { 'data-m': mark }, area, files,
        /* 发送键是这张卡的主动作，守在右下角（和回复框一个落点）；「?」是三级入口，排在左边那排选项的末尾 */
        h('div.foot', {}, clip, h('div.opts', {}, compact ? [opts.where.btn, expand, help] : [opts.work.btn, opts.where.btn, opts.org.btn, more, help]),
          h('span.grow'), caps.el, run, opts.cast?.btn, send.el),
        status));
    setMode(MODES.some(([m]) => m === d.mode) ? d.mode : 'single', false);
    return {
      el, help,
      dirty: () => Boolean(d.text || d.files.length),
      clear() { area.value = ''; d.files = []; files.replaceChildren(); sync(); area.focus(); },
      focus() { sync(); area.focus({ preventScroll: true }); area.setSelectionRange(area.value.length, area.value.length); },
    };
  }

  /* 应用栏：类型标 + 标题，照现状一条 */
  const bar = (kind, title, ...rest) => h('header.bar', {}, h('span.kind', kind), h('b.cut', title), rest);

  /* 两面共用的键盘：⌘/ 开帮助；Esc 在没有浮层和确认框开着时交给这一面（C 新建由侧栏管）。
     对照清单点到 home-4 时先把帮助打开（已经开着就不动）；离开这一面时一并收掉 */
  function listen(cmp, onesc) {
    const onkey = (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key === '/') { e.preventDefault(); toggleHelp(cmp.help); return; }
      if (e.key === 'Escape' && !e.isComposing && !$('.pop') && !$('.veil')) onesc?.();
    };
    document.addEventListener('keydown', onkey);
    ASH.prep['home-4'] = () => { if (cmp.help.getAttribute('aria-expanded') !== 'true') toggleHelp(cmp.help); };
    return () => { document.removeEventListener('keydown', onkey); closeSheet(); delete ASH.prep['home-4']; };
  }

  /* ---------- 首页：就是输入框，下面是等你处理的 ----------
     等你处理 = 等答复 / 等裁定、失败、做完了还没验收（和侧栏「需要你处理」那一颗同一个口径）。 */
  const NEED = {
    waiting: (t) => ['wait', t.why ?? '等你处理'],
    failed: (t) => ['bad', t.why ?? '失败'],
    done: (t) => (t.accepted === false ? ['open', '待验收'] : null),
  };
  ASH.surface('home', {
    chrome: 'app',
    mount(main) {
      const tasks = ASH.data?.tasks ?? [];
      const todo = tasks.map((t) => [t, NEED[t.status]?.(t)]).filter(([, look]) => look);
      const cmp = composer({ compact: true, mark: 'home-1', onsubmit: () => ASH.go('#/task') });
      const list = todo.length ? h('section.todo.enter', { 'aria-label': '等你处理' },
        h('h2.sec', {}, '等你处理', h('b', String(todo.length))),
        h('ul', {}, todo.slice(0, 6).map(([t, [dot, why]]) => h('li', {}, h('button.go', { type: 'button', onclick: () => { ASH.emit('task:open', { id: t.id }); ASH.go('#/task'); } },
          h(`i.dot.${dot}`), h('span.cut.grow', t.title), h('span.why', why), h('span.when.num', t.when)))))) : null;
      main.append(h('div.sv-home', {},
        bar('项目', ASH.data?.project ?? 'harness', h('span.grow'), h('span.count.num', `${tasks.length} 项任务`)),
        h('div.scroll', {}, h('div.col', {}, cmp.el, list))));
      cmp.focus();
      return listen(cmp);
    },
  });

  /* ---------- 新建面板：标题栏照现状（项目名、清空草稿、取消 Esc），卡片上方多一行模式 ---------- */
  ASH.surface('new', {
    chrome: 'app',
    mount(main) {
      const close = () => ASH.go('#/home');
      /* 草稿是「关掉也留着」的，所以有东西时给一个明写的丢弃口 */
      const wipe = h('button.btn.quiet', { type: 'button', hidden: true, onclick: () => cmp.clear() }, '清空草稿');
      const cmp = composer({ compact: false, mark: 'home-2', onsubmit: () => ASH.go('#/task'), onchange: () => { wipe.hidden = !cmp?.dirty(); } });
      main.append(h('div.sv-home.sv-new', {},
        bar('新建', '新建任务', h('span.proj.cut', ASH.data?.project ?? 'harness'), h('span.grow'), wipe,
          h('button.btn.quiet', { type: 'button', onclick: close }, '取消 Esc')),
        h('div.scroll', {}, h('div.col', {}, cmp.el))));
      cmp.focus();
      return listen(cmp, close);
    },
  });
})();
