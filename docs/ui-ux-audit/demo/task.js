/* 任务页（面 task）：头部 + 会话列（会话流、提问坞、回复框；看改动、验收时换成改动工作区）+ 右侧面板。骨架照现状：面板通顶，头部只压在会话那一列上面。
   头部是部件 head。左边说「这是哪个任务」：类型（一个图标）、标题（可改名）、来源（智能体开的才有，一个图标）、图钉。
   右边没有字，只有图标：此刻轮到你的那一步（重试 / 运行）、验收的那枚章、更多、面板开关。状态不在头上写——侧栏那一行的行首和会话里都有。
   章空心是「改动等你验收」，实心是「验过了」；点它开的是改动工作区（changes.js），真正的「验收通过」在那里面，和现在一样。在跑、排队、等答复时没有章。
   停止是发送键（reply.js）；时间住进右侧面板、「重新排队」进更多（head-1）。
   对外：ASH.parts.head = { set(status), state, accepted, destroy() }。
   发 task:status { id, status }、task:title { id, title }、task:act { label }（重试 / 运行，由 live.js 接）、changes:open（章，和更多里的「查看改动与审查」）；
   听 task:status { id, status, accepted? }、task:pin { id, pinned }、insp:state { shut }、changes:state { open }。 */
(() => {
  const { h, icon } = ASH;
  ASH.icons.download ??= '<path d="M8 2.5v8M4.5 7.5 8 11l3.5-3.5M3 13.5h10"/>';
  /* 验收的章：八瓣的印，里面一个勾（Phosphor 里叫 SealCheck）。两笔分开画：验过了以后印填实、勾反白 */
  ASH.icons.seal ??= '<path d="M5.95 3.06A2.3 2.3 0 0 1 10.05 3.06A2.3 2.3 0 0 1 12.94 5.95A2.3 2.3 0 0 1 12.94 10.05A2.3 2.3 0 0 1 10.05 12.94A2.3 2.3 0 0 1 5.95 12.94A2.3 2.3 0 0 1 3.06 10.05A2.3 2.3 0 0 1 3.06 5.95A2.3 2.3 0 0 1 5.95 3.06z"/><path d="m5.9 8.2 1.5 1.5 2.8-3.1"/>';

  /* 类型：图标和侧栏行尾那颗是同一套（TaskModeIcon），指上去是它的名字 */
  const KIND = { single: ['file', '任务'], team: ['team', '团队任务'], duet: ['chat', '讨论任务'] };
  const KNOWN = ['running', 'waiting', 'failed', 'queued', 'stopped', 'backlog', 'done'];
  const ACT = { 重试: 'redo', 运行: 'play' };

  /* 这个状态下头上有哪几颗（自由工作流顶层任务的 primaryAction / terminalRerunAction）。
     样机的 stopped 就是产品里的 canceled，waiting 是挂着提问。seal：'' 不画 / open 等你验收 / done 验过了 */
  const look = (status, accepted) => {
    if (status === 'running' || status === 'queued' || status === 'waiting') return { acts: [], seal: '' };
    const seal = accepted ? 'done' : 'open';
    if (status === 'failed') return { acts: ['重试'], seal };
    if (status === 'stopped') return { acts: ['运行'], seal };
    if (status === 'backlog') return { acts: ['运行'], seal: '' };
    return { acts: [], seal };
  };

  const copy = (text) => { try { navigator.clipboard?.writeText(text)?.catch(() => {}); } catch { /* file:// 下可能没有剪贴板 */ } };
  let ruler = null;

  ASH.part('head', {
    mount(el) {
      const task = ASH.data.tasks.find((t) => t.id === ASH.data.current);
      let status = KNOWN.includes(task.status) ? task.status : 'done';
      let accepted = Boolean(task.accepted);
      if (status === 'queued') task.inQueue = true;   /* 进过队列就一直算在队列里（产品里是 queueId）：「重新排队」只给这样的任务 */
      const tell = (next) => ASH.emit('task:status', { id: task.id, status: next });

      const [glyph, kindName] = KIND[task.kind] ?? KIND.single;
      const kind = h('span.task-kind', { role: 'img', 'aria-label': kindName, 'data-tip': kindName }, icon(glyph));
      /* 来源只有智能体开的任务才有（TaskCreationBadge） */
      const origin = task.origin && h('span.task-from', { role: 'img', 'aria-label': task.origin, 'data-tip': task.origin }, icon('bot'));

      /* 图钉：置顶了一直在；没置顶的，指到头部或者 Tab 到它才出来 */
      const pin = h('button.ico.sm.task-pin', { type: 'button', onclick: () => {
        const on = pin.getAttribute('aria-pressed') !== 'true';
        setPin(on);
        if (ASH.parts.side?.setPinned) ASH.parts.side.setPinned(task.id, on);   /* 侧栏那一行跟着进出置顶 */
        else { task.pinned = on; ASH.emit('task:pin', { id: task.id, pinned: on }); }
      } }, icon('pin'));
      function setPin(on) {
        const say = on ? '取消置顶' : '置顶';
        pin.setAttribute('aria-pressed', String(on));
        pin.setAttribute('aria-label', say);
        pin.dataset.tip = say;
      }
      setPin(Boolean(task.pinned));

      /* 标题一直是输入框，只是平时不画框（task.css）：回车或移开改名，Esc 放弃。
         宽度跟着字走——来源和图钉紧跟在标题后面，不是甩在这一行的另一头 */
      const title = h('input.task-title', { value: task.title, 'aria-label': '任务标题', spellcheck: 'false', autocomplete: 'off' });
      const size = () => {
        ruler ??= document.createElement('canvas').getContext('2d');
        const cs = getComputedStyle(title);
        ruler.font = `${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
        title.style.width = `${Math.ceil(ruler.measureText(title.value || ' ').width) + 14}px`;
      };
      title.addEventListener('input', size);
      title.addEventListener('keydown', (e) => {
        if (e.isComposing) return;
        if (e.key === 'Enter') title.blur();
        if (e.key === 'Escape') { title.value = task.title; size(); title.blur(); }
      });
      title.addEventListener('blur', () => {
        const next = title.value.trim();
        if (!next || next === task.title) { title.value = task.title; size(); return; }
        task.title = title.value = next;
        size();
        ASH.emit('task:title', { id: task.id, title: next });
      });

      /* 右边那一组：一步一颗图标，章排在最后、位置不随状态变。章开着改动工作区时是按下的样子，再点一次回对话 */
      const acts = h('span.task-acts', { 'data-m': 'head-1' });
      const seal = h('button.ico.task-seal', { type: 'button', 'aria-expanded': 'false', onclick: () => ASH.emit('changes:open') }, icon('seal'));
      const actBtn = (label) => h('button.ico', { type: 'button', 'aria-label': label, 'data-tip': label, 'data-act': label, onclick: () => ASH.emit('task:act', { label }) }, icon(ACT[label]));

      const markDone = async () => {
        const yes = await ASH.confirm({ title: '标记为已完成', ok: '标记完成', body: [
          h('span.task-say', '把这个任务直接落成「已完成」。用在 agent 其实干完了、只是没调 complete_task 交卷的时候 —— 请先核对产物（提交、改动、产出文件）确实在。'),
          h('span.task-say', '它跟「重试」是两条路：重试会从中断处接着跑，标记完成则就此收尾，队列里排在后面的任务会开始跑。')] });
        if (yes) tell('done');
      };
      const remove = async () => {
        const yes = await ASH.confirm({ title: '删除任务', body: `确定删除“${task.title || '未命名任务'}”？此操作不可撤销。`, ok: '删除', danger: true });
        if (yes) ASH.todo('删掉这个任务之后的样子');
      };
      const talk = () => ASH.parts.feed?.el?.innerText ?? '';
      const download = () => {
        const url = URL.createObjectURL(new Blob([talk()], { type: 'text/markdown;charset=utf-8' }));
        const a = h('a', { href: url, download: `${task.title}.md` });
        document.body.append(a);
        a.click();
        a.remove();
        URL.revokeObjectURL(url);
      };
      /* 更多：项和次序照 TaskHeader.tsx 的菜单。「重新排队」是从头部挪进来的，列在最前，条件和原来一样：失败或已取消、而且在队列里；
         「标记为已完成」只在失败 / 已取消时有；在跑、排队时不能归档；删除是红的 */
      const more = h('button.ico', { type: 'button', 'aria-label': '更多任务操作', 'aria-haspopup': 'menu', onclick: () => {
        const ended = status === 'failed' || status === 'stopped';
        ASH.menu(more, [
          ended && task.inQueue && { label: '重新排队', icon: 'queue', onpick: () => tell('queued') },
          ended && task.inQueue && '-',
          { label: '刷新', icon: 'redo', onpick: () => ASH.todo('重新读取这个任务') },
          { label: '查看改动与审查', icon: 'diff', onpick: () => ASH.emit('changes:open') },
          { label: '复制全部对话', icon: 'copy', onpick: () => copy(talk()) },
          { label: '下载 Markdown', icon: 'download', onpick: download },
          { label: '复制任务链接', icon: 'copy', onpick: () => copy(location.href) },
          ended && '-',
          ended && { label: '标记为已完成', icon: 'check', onpick: markDone },
          '-',
          { label: '归档任务', icon: 'box', disabled: status === 'running' || status === 'queued', onpick: () => ASH.todo('归档之后的样子') },
          { label: '删除任务', icon: 'trash', danger: true, onpick: remove },
        ].filter(Boolean), { place: 'bottom-end' });
      } }, icon('more'));

      /* 面板开关：提示照现状（InspectorHost.tsx），没有快捷键。全应用那一条焦点环（a11y-1）认领在它身上 */
      const panel = h('button.ico.task-panel', { type: 'button', 'aria-controls': 'insp', 'data-m': 'a11y-1', onclick: () => ASH.emit('insp:toggle') }, icon('panel'));
      function setPanel(shut) {
        const say = shut ? '显示 Inspector' : '隐藏 Inspector';
        panel.setAttribute('aria-label', say);
        panel.setAttribute('aria-expanded', String(!shut));
        panel.dataset.tip = say;
      }
      setPanel(false);
      /* 清单点到 a11y-1：把键盘焦点放上去，环一直留到焦点离开 */
      ASH.prep['a11y-1'] = () => {
        panel.focus({ preventScroll: true });
        panel.classList.add('is-focus');
        panel.addEventListener('blur', () => panel.classList.remove('is-focus'), { once: true });
      };

      el.append(h('div.task-name', { 'data-m': 'head-2' }, kind, title, origin, pin), h('span.grow'), acts, more, panel);
      size();
      document.fonts?.ready.then(size);

      /* 换状态：留着的那颗不重画、滑到新位置，新来的淡入（ASH.flip） */
      const paint = (first) => {
        const s = look(status, accepted);
        const redraw = () => {
          const old = new Map([...acts.children].map((btn) => [btn.dataset.act, btn]));
          const say = s.seal === 'done' ? '已验收' : '验收';
          seal.dataset.on = String(s.seal === 'done');
          seal.setAttribute('aria-label', say);
          seal.dataset.tip = say;
          acts.replaceChildren(...s.acts.map((label) => old.get(label) ?? actBtn(label)), ...(s.seal ? [seal] : []));
        };
        if (first) redraw(); else ASH.flip(acts, redraw);
      };
      /* accepted 没明说时：收到「验收完成」就是验过了；重新跑起来、重新排队、改回「完成」都把章摘掉；其余状态不动它 */
      function apply(next, flag) {
        if (next === 'accepted') { status = 'done'; accepted = true; }
        else if (KNOWN.includes(next)) {
          status = next;
          if (next === 'queued') task.inQueue = true;
          if (typeof flag === 'boolean') accepted = flag;
          else if (next === 'done' || next === 'running' || next === 'queued') accepted = false;
        } else return;
        paint();
      }
      paint(true);

      const offs = [
        ASH.on('task:status', ({ id, status: next, accepted: flag } = {}) => { if (id === task.id) apply(next, flag); }),
        ASH.on('task:pin', ({ id, pinned } = {}) => { if (id === task.id) setPin(Boolean(pinned)); }),
        ASH.on('insp:state', ({ shut } = {}) => setPanel(Boolean(shut))),
        ASH.on('changes:state', ({ open } = {}) => seal.setAttribute('aria-expanded', String(Boolean(open)))),
      ];
      return {
        set(next) { apply(next); },
        get state() { return status; },
        get accepted() { return accepted; },
        destroy() { for (const off of offs) off(); delete ASH.prep['a11y-1']; },
      };
    },
  });

  ASH.surface('task', {
    chrome: 'app',
    mount(main) {
      const head = h('header.task-head');
      const wrap = h('div.feed-wrap');
      const dock = h('div.dock');
      const reply = h('div', { id: 'reply' });
      const work = h('section.changes', { hidden: true, 'aria-label': '改动与提交' });
      const insp = h('aside.task-insp', { id: 'insp', 'aria-label': '右侧面板' });
      main.append(h('div.task', h('div.task-main', head, h('section.task-col', wrap, dock, reply, work)), insp));
      const parts = [ASH.mount('head', head), ASH.mount('feed', wrap, { dock }), ASH.mount('reply', reply, { kind: 'task' }), ASH.mount('insp', insp), ASH.mount('live', main),
        ASH.mount('changes', work, { talk: [wrap, dock, reply] })];
      return () => { for (const p of parts) p.destroy?.(); for (const name of ['head', 'feed', 'reply', 'insp', 'live', 'changes']) delete ASH.parts[name]; };
    },
  });
})();
