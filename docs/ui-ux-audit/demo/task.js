/* 任务页（面 task）：头部 + 会话列（会话流、提问坞、回复框）+ 右侧面板。骨架照现状：面板通顶，头部只压在会话那一列上面。
   头部是部件 head。件、次序、文案照 web/src/task-detail/TaskHeader.tsx：类型与来源、图钉、标题（可改名）、状态、主按钮、次级按钮、更多、面板开关。
   清单动了的只有三处：灰掉的按钮不画，它多说的半句接在状态词后面；时间住进右侧面板、「重新排队」进更多（head-1）；类型和来源拼成一颗两段胶囊，图钉是看得见的灰（head-2）。
   对外：ASH.parts.head = { set(status), state, accepted, destroy() }。
   发 head:act { label }（验收 / 重试 / 运行 / 停止，由 live.js 接）、task:status { id, status }、task:title { id, title }；
   听 task:status { id, status, accepted? }、task:pin { id, pinned }、insp:state { shut }。 */
(() => {
  const { h, icon } = ASH;
  ASH.icons.download ??= '<path d="M8 2.5v8M4.5 7.5 8 11l3.5-3.5M3 13.5h10"/>';

  const KIND = { team: '团队', duet: '讨论' };
  const KNOWN = ['running', 'waiting', 'failed', 'queued', 'stopped', 'done'];
  /* 状态点指上去的那句话，照 TaskStatusDot.tsx */
  const DOT_SAY = { run: '运行中或排队中', queue: '运行中或排队中', wait: '需要人工输入', open: '已完成，等你验收', bad: '失败' };

  /* 状态词和按钮：自由工作流顶层任务的 primaryAction / terminalRerunAction。
     现状里灰着的「已验收」「等答复」不画成按钮——和状态词同一句的就省掉，不同的接在状态词后面（「失败 · 已验收」）。
     样机的 stopped 就是产品里的 canceled（叫「已取消」），waiting 是挂着提问（叫「等答复」）。按钮是 [字, 图标, 样式]，第一颗是主按钮 */
  function look(status, accepted) {
    if (status === 'running') return { word: '运行中', dot: 'run', acts: [['停止', 'stop', 'danger']] };
    if (status === 'queued') return { word: '排队中', dot: 'queue', acts: [['停止排队', 'stop', 'danger']] };
    if (status === 'waiting') return { word: '等答复', dot: 'wait', acts: [] };
    if (status === 'failed') return { word: '失败', tail: accepted && '已验收', dot: 'bad', acts: [!accepted && ['验收', 'check', 'pri'], ['重试', 'redo', '']] };
    if (status === 'stopped') return { word: '已取消', tail: accepted && '已验收', dot: '', acts: [!accepted && ['验收', 'check', 'pri'], ['运行', 'play', '']] };
    return accepted ? { word: '验收完成', dot: '', acts: [] } : { word: '完成', dot: 'open', acts: [['验收', 'check', 'pri']] };
  }

  const copy = (text) => { try { navigator.clipboard?.writeText(text)?.catch(() => {}); } catch { /* file:// 下可能没有剪贴板 */ } };

  ASH.part('head', {
    mount(el) {
      const task = ASH.data.tasks.find((t) => t.id === ASH.data.current);
      let status = KNOWN.includes(task.status) ? task.status : 'done';
      let accepted = Boolean(task.accepted);
      if (status === 'queued') task.inQueue = true;   /* 进过队列就一直算在队列里（产品里是 queueId）：「重新排队」只给这样的任务 */
      const tell = (next) => ASH.emit('task:status', { id: task.id, status: next });

      /* 类型 + 来源：一颗两段胶囊。来源只有智能体开的任务才有（TaskCreationBadge） */
      const origin = task.origin && h('i', icon('bot'), h('span', task.origin));
      const kind = h('span.task-kind', { 'data-m': 'head-2' }, h('b', KIND[task.kind] ?? '任务'), origin);

      const pin = h('button.ico.sm.task-pin', { type: 'button', onclick: () => {
        const on = pin.getAttribute('aria-pressed') !== 'true';
        setPin(on);
        if (ASH.parts.side?.setPinned) ASH.parts.side.setPinned(task.id, on);   /* 侧栏那一行跟着进出「置顶」 */
        else { task.pinned = on; ASH.emit('task:pin', { id: task.id, pinned: on }); }
      } }, icon('pin'));
      function setPin(on) {
        const say = on ? '取消置顶' : '置顶';
        pin.setAttribute('aria-pressed', String(on));
        pin.setAttribute('aria-label', say);
        pin.dataset.tip = say;
      }
      setPin(Boolean(task.pinned));

      /* 标题一直是输入框，只是平时不画框（task.css）：回车或移开改名，Esc 放弃 */
      const title = h('input.task-title', { value: task.title, 'aria-label': '任务标题', spellcheck: 'false', autocomplete: 'off' });
      title.addEventListener('keydown', (e) => {
        if (e.isComposing) return;
        if (e.key === 'Enter') title.blur();
        if (e.key === 'Escape') { title.value = task.title; title.blur(); }
      });
      title.addEventListener('blur', () => {
        const next = title.value.trim();
        if (!next || next === task.title) { title.value = task.title; return; }
        task.title = title.value = next;
        ASH.emit('task:title', { id: task.id, title: next });
      });

      /* 两条清单认领在同一处会叠成一颗圆圈：head-1 认领整个状态，run-6（换字）认领那个词 */
      const dot = h('i.dot', { role: 'img', hidden: true });
      const word = h('span', { 'data-m': 'run-6' });
      const says = h('span.task-status', { 'data-m': 'head-1' }, dot, word);
      const acts = h('span.task-acts');

      const markDone = async () => {
        const yes = await ASH.confirm({ title: '标记为已完成', ok: '标记完成', body: [
          h('span.task-say', '把这个任务直接落成「已完成」。用在 agent 其实干完了、只是没调 complete_task 交卷的时候 —— 请先核对产物（提交、改动、产出文件）确实在。'),
          h('span.task-say', '它跟「重试」是两条路：重试会从中断处接着跑，标记完成则就此收尾，队列里排在后面的任务会开始跑。')] });
        if (yes) tell('done');
      };
      const remove = () => ASH.confirm({ title: '删除任务', body: `确定删除“${task.title || '未命名任务'}”？此操作不可撤销。`, ok: '删除', danger: true });   /* 确认之后的事样机里没做 */
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
        const close = ASH.menu(more, [
          ended && task.inQueue && { label: '重新排队', icon: 'queue', onpick: () => tell('queued') },
          ended && task.inQueue && '-',
          { label: '刷新', icon: 'redo' },
          { label: '查看改动与审查', icon: 'diff', onpick: () => ASH.emit('insp:open', { pane: 'scm' }) },
          { label: '复制全部对话', icon: 'copy', onpick: () => copy(talk()) },
          { label: '下载 Markdown', icon: 'download', onpick: download },
          { label: '复制任务链接', icon: 'copy', onpick: () => copy(location.href) },
          ended && '-',
          ended && { label: '标记为已完成', icon: 'check', onpick: markDone },
          '-',
          { label: '归档任务', icon: 'box', disabled: status === 'running' || status === 'queued' },
          { label: '删除任务', icon: 'trash', onpick: remove },
        ].filter(Boolean), { place: 'bottom-end' });
        close?.el.querySelector('.menu > button:last-child')?.classList.add('task-danger');
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

      el.append(h('div.task-name', kind, pin, title), says, acts, more, panel);

      const press = (label) => {
        /* 没有在跑的回合要停（排着队，或者状态是从别处改成运行中的）：直接落到已取消 */
        if (label === '停止排队' || (label === '停止' && !ASH.parts.live?.running)) { tell('stopped'); return; }
        ASH.emit('head:act', { label });
        /* live.js 现在只接「重试」，没接「运行」：已取消的任务先在这里替它跑一轮；它接上以后这一句走不到 */
        if (label === '运行' && !ASH.parts.live?.running) ASH.parts.live?.play?.('run', '运行');
      };

      /* 一行摆不下时（开着对照清单、右侧面板又展开）：量实际溢出，一档一档让，够了就停——
         1 次级按钮只剩图标　2 标题再短一截　3 主按钮只剩图标　4 来源只剩图标　5 标题有多少算多少。字收掉的那几颗才带提示 */
      function fit() {
        const squeeze = (n) => {
          [...acts.children].forEach((btn, i) => {
            const bare = n >= (i ? 1 : 3);
            btn.classList.toggle('is-bare', bare);
            if (bare) btn.dataset.tip = btn.dataset.act; else delete btn.dataset.tip;
          });
          title.classList.toggle('is-short', n >= 2);
          kind.classList.toggle('is-short', n >= 4);
          if (origin) { if (n >= 4) origin.dataset.tip = task.origin; else delete origin.dataset.tip; }
          title.classList.toggle('is-least', n >= 5);
        };
        squeeze(0);
        for (let n = 1; n <= 5 && el.scrollWidth > el.clientWidth; n += 1) squeeze(n);
      }
      /* 按钮自己换的时候 paint 直接调 fit；这里只看整行变宽变窄、状态词换完字变长变短 */
      const sizes = new ResizeObserver(fit);
      sizes.observe(el);
      sizes.observe(says);

      /* 换状态是一拍：要走的（旧的点、用不上的按钮）和旧的词一起淡出，150ms 后新的一起到位（和 ASH.swap 同一拍）。
         留着的按钮不重画，滑到新位置；新来的淡入（ASH.flip）。连着换几次只认最后一次 */
      const button = (label, glyph, cls) => h(`button.btn${cls ? `.${cls}` : ''}`, { type: 'button', 'data-act': label, 'aria-label': label, onclick: () => press(label) },
        icon(glyph, glyph === 'stop' || glyph === 'play' ? 'fill' : ''), h('span', label));
      let landing = 0;
      const paint = (first) => {
        const s = look(status, accepted);
        const want = s.acts.filter(Boolean);
        const text = s.tail ? `${s.word} · ${s.tail}` : s.word;
        const dotStays = (dot.dataset.kind ?? '') === s.dot;
        const redraw = () => {
          const old = new Map([...acts.children].map((btn) => [btn.dataset.act, btn]));
          acts.replaceChildren(...want.map(([label, glyph, cls]) => old.get(label) ?? button(label, glyph, cls)));
          fit();
        };
        const land = () => {
          dot.dataset.kind = s.dot;
          dot.className = `dot${s.dot ? ` ${s.dot}` : ''}`;
          dot.hidden = !s.dot;
          if (s.dot) { dot.setAttribute('aria-label', DOT_SAY[s.dot]); dot.dataset.tip = DOT_SAY[s.dot]; }
          if (first) { redraw(); return; }
          if (!dotStays) { dot.classList.add('is-out'); void dot.offsetWidth; dot.classList.remove('is-out'); }
          ASH.flip(acts, redraw);
        };
        clearTimeout(landing);
        if (first) word.textContent = text; else ASH.swap(word, text);
        if (first || ASH.reduced()) { land(); return; }
        dot.classList.toggle('is-out', !dotStays);
        for (const btn of acts.children) btn.classList.toggle('is-out', !want.some(([label]) => label === btn.dataset.act));
        landing = setTimeout(land, 150);
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
      ];
      return {
        set(next) { apply(next); },
        get state() { return status; },
        get accepted() { return accepted; },
        destroy() { for (const off of offs) off(); sizes.disconnect(); clearTimeout(landing); delete ASH.prep['a11y-1']; },
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
      const insp = h('aside.task-insp', { id: 'insp', 'aria-label': '右侧面板' });
      main.append(h('div.task', h('div.task-main', head, h('section.task-col', wrap, dock, reply)), insp));
      const parts = [ASH.mount('head', head), ASH.mount('feed', wrap, { dock }), ASH.mount('reply', reply, { kind: 'task' }), ASH.mount('insp', insp), ASH.mount('live', main)];
      return () => { for (const p of parts) p.destroy?.(); for (const name of ['head', 'feed', 'reply', 'insp', 'live']) delete ASH.parts[name]; };
    },
  });
})();
