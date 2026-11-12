/* 侧栏。结构、文案、入口都照真实侧栏画（web/src/workspace 的 WorkspaceSidebar / ProjectSwitcher / TaskTree / TaskTreeRows / HandoffMachines）：
   顶行（项目菜单、分支、常用命令）、工具行（聊天、圆点筛选、搜索、随手记、分组管理、新建任务）、任务树（置顶 / 任务 / 其他机器 / 其他项目）、底部一行。
   和现状不一样的只有清单里的四条：side-1 行首记号、side-2 行首与顶上圆点查同一张表、side-3「其他机器」排到「任务」后面并默认折起、side-4 底部一行的字号字色。
   对外：ASH.parts.side = { setStatus(id, status, why), setFilter(key), setPinned(id, on), setFar(open), refresh(), search() }；
   听 task:status、route；发 task:open { id }（点的不是当前这条任务时）、task:pin { id, pinned }。
   样机没画下去的去处（常用命令、随手记、任务模式、F 铺开的宽列表……）界面上照产品原样写，点了只在样机自己那条栏里说一句（ASH.todo）。 */
(() => {
  const { h, $, $$, icon } = ASH;
  const EASE_OUT = 'cubic-bezier(0.22, 1, 0.36, 1)';
  const EASE_IN = 'cubic-bezier(0.4, 0, 1, 1)';

  ASH.icons.branch = '<circle cx="5" cy="3.5" r="1.5"/><circle cx="5" cy="12.5" r="1.5"/><circle cx="11.5" cy="5.5" r="1.5"/><path d="M5 5v6M11.5 7c0 2.4-3 2.6-6.5 3"/>';
  ASH.icons.layers = '<path d="m8 2.5 5.5 3L8 8.5l-5.5-3z"/><path d="m2.5 8.5 5.5 3 5.5-3M2.5 11l5.5 3 5.5-3"/>';
  ASH.icons.gear ??= '<path d="M6.9 3.4 7.2 1.8H8.8L9.1 3.4 10.5 4 11.8 3.1 12.9 4.2 12 5.5 12.6 6.9 14.2 7.2V8.8L12.6 9.1 12 10.5 12.9 11.8 11.8 12.9 10.5 12 9.1 12.6 8.8 14.2H7.2L6.9 12.6 5.5 12 4.2 12.9 3.1 11.8 4 10.5 3.4 9.1 1.8 8.8V7.2L3.4 6.9 4 5.5 3.1 4.2 4.2 3.1 5.5 4z"/><circle cx="8" cy="8" r="2"/>';
  ASH.icons.tower ??= '<rect x="1.5" y="4" width="8" height="6" rx="1"/><path d="M5.5 10v2.5M3.5 12.5h4"/><rect x="11" y="3" width="3.5" height="10" rx="1"/><path d="M12.5 5.5h.5"/>';
  ASH.icons.assistant ??= '<path d="M8 2.5a5.5 5.5 0 0 1 0 11H2.5l1.7-1.7A5.5 5.5 0 0 1 8 2.5z"/><path d="M5.8 8.6a2.4 2.4 0 0 0 4.4 0"/>';
  ASH.icons.checks ??= '<path d="M8 4.5h5.5M8 8h5.5M8 11.5h5.5M2.5 4.5l1 1 1.8-2M2.5 8l1 1 1.8-2M2.5 11.5l1 1 1.8-2"/>';
  ASH.icons.folderPlus ??= '<path d="M2.5 4.5a1 1 0 0 1 1-1h2.6l1.4 1.5h5a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1h-9a1 1 0 0 1-1-1z"/><path d="M8 7.3v3.4M6.3 9h3.4"/>';

  /* 一张表管两处（side-2）：dot 是行首那颗（base.css 的 .dot 变体，空着 = 不画，位置留着），bucket 是算进顶上哪一颗，
     say 是指着那颗点时的那句话（照现在的 TaskStatusDot.tsx；没有点就没有话）。
     归到哪一颗照现在的口径（web/src/lib/taskAttention.ts 的 spreadBucket）：看轮到谁动、验收了没有，和读没读过无关。 */
  const LOOK = {
    waiting: { dot: 'wait', bucket: 'todo', say: '需要人工输入' },
    failed: { dot: 'bad', bucket: 'todo', say: '失败' },                  /* 一直红，不看读没读过 */
    open: { dot: 'open', bucket: 'todo', say: '已完成，等你验收' },        /* 做完没验收：靛蓝环，读没读过都在 */
    running: { dot: 'run', bucket: 'run', say: '运行中' },
    queued: { dot: 'queue', bucket: 'wait', say: '排队中' },              /* 排在队里、还没轮到 */
    stopped: { dot: '', bucket: 'done', say: '' },                        /* 停掉的归「已收尾」，行首空着 */
    backlog: { dot: '', bucket: 'wait', say: '' },                        /* 待排期：还没排进队，归「排着 / 暂停」 */
    fresh: { dot: 'new', bucket: 'accepted', say: '已完成，有未读动态' },  /* 验收过、还没看：点开就熄 */
    done: { dot: '', bucket: 'accepted', say: '' },                       /* 验收过、看过：行首空着 */
  };
  /* ⌘K 里任务下面那行小字用的状态词（照 shared 的 TASK_STATUS_LABELS；挂着提问的叫「等答复」） */
  const WORD = { running: '运行中', queued: '排队中', waiting: '等答复', failed: '失败', stopped: '已取消', backlog: '待排期', done: '完成' };
  /* 表里没有的状态不猜成「完成」：行首空着，提示里把原词报出来，归「排着 / 暂停」（现在也是哪一档都不算就落这里），控制台记一笔 */
  const odd = {};
  const lookOf = (task) => {
    if (task.status === 'done') return task.accepted === false ? LOOK.open : task.read === false ? LOOK.fresh : LOOK.done;
    if (task.status === 'stopped' && task.accepted) return LOOK.done;   /* 停掉的也能验收：验收了就归「验收完成」。失败的验收了还是红的，照旧等你处理 */
    if (['waiting', 'failed', 'running', 'queued', 'stopped', 'backlog'].includes(task.status)) return LOOK[task.status];
    if (!odd[task.status]) { console.warn(`[side] 状态表里没有「${task.status}」`); odd[task.status] = { dot: '', bucket: 'wait', say: `状态：${task.status}` }; }
    return odd[task.status];
  };
  const sigOf = (task) => `${task.status}|${task.accepted}|${task.read}|${task.why ?? ''}|${task.detail ?? ''}`;
  const mark = (look) => h(`span.dot${look.dot ? `.${look.dot}` : ''}`, look.say ? { role: 'img', 'aria-label': look.say } : {});

  /* 顶上那一排（保留项）：一颗星加五颗点，名字、颜色、次序跟现在一样 */
  const BUCKETS = [
    { key: 'star', label: '星标' },
    { key: 'todo', label: '需要你处理' },
    { key: 'run', label: '在跑' },
    { key: 'wait', label: '排着 / 暂停' },
    { key: 'done', label: '已收尾' },
    { key: 'accepted', label: '验收完成' },
  ];
  const OLD_KEY = { need: 'todo', queue: 'wait', fresh: 'done', rest: 'accepted' }; /* setFilter 以前收的是这几个名字，照样认 */
  const inBucket = (task, key) => (key === 'star' ? !!task.starred : lookOf(task).bucket === key);

  /* 别的机器、别的项目：名字和任务都是编的。项目和新建面板里能选的那三个是同一批 */
  const MACHINES = [
    { name: 'mac-studio', tasks: ['接力回来的会话少了最后一轮', '终端坞的高度记到本机'] },
    { name: 'win-desk', tasks: ['启动脚本的路径分隔符', '终端输出的中文乱码'] },
    { name: 'nuc-lab', tasks: [] },
  ];
  const OTHERS = [
    { name: 'ash-mobile', tone: 'green', tasks: ['会话页下拉刷新', '任务列表改成定时拉取'] },
    { name: 'docs-site', tone: 'cyan', tasks: [] },
  ];
  const TASK_MODE = ['任务模式', '所有项目里在跑、失败、等你答复和待验收的任务'];
  const SOURCE = { 't-cur': 't-rev', 't-fail': 't-run' }; /* 智能体派生的那两条各自来自哪条任务（编的） */
  const pathOf = (name) => `~/code/${name}`;
  /* ⌘K 命令面板里固定的几组：组名、条目、键位照现在的（web/src/overlays/CommandPalette.tsx）。[组, 名字, 图标, 键位, 去哪, 副题]；去哪空着 = 样机没画这一步 */
  const COMMANDS = [
    ['新建', '新建任务', 'plus', 'C', '#/new'],
    ['新建', '新建讨论 · 给你答案', 'chat'],
    ['新建', '新建随手记', 'edit', 'NI'],
    ['新建', '新建分组', 'layers'],
    ['新建', '新建项目', 'folderPlus'],
    ['管理', '随手记列表', 'edit', 'NL'],
    ['管理', '管理智能体执行器', 'gear', 'G S', '#/settings/agents'],
    ['管理', '项目设置', 'gear', '', '#/settings/project'],
    ['管理', '分组管理', 'layers', '', '#/settings/groups'],
    ['切换项目', TASK_MODE[0], 'checks', 'G T', '', TASK_MODE[1]],
  ];
  const typing = (node) => !!node && (node.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(node.tagName ?? ''));
  /* 字被省略号截掉时，指上去才补全文；没截就不出提示 */
  const cutTip = (node) => node.addEventListener('pointerover', () => {
    if (node.scrollWidth > node.clientWidth + 1) node.dataset.tip = node.textContent;
    else delete node.dataset.tip;
  });
  const todo = (what) => () => ASH.todo(what);

  ASH.part('side', {
    mount(el) {
      const tasks = ASH.data.tasks;
      const name = ASH.data.project;
      const byId = (id) => tasks.find((task) => task.id === id);
      const rows = new Map(); /* 任务 id → 这一行的各个节点，外加它现在画成什么（look / status / sig） */
      const order = { pin: [], task: [] }; /* 两节各自的先后；筛选只决定露不露，不改先后 */
      const held = {}; /* 对照清单的两条认领现在挂在谁身上 */
      let filter = null;
      let farOpen = false;
      let onTask = false;
      let seq = 0;
      let goAt = null; /* 上一次按 G 的时刻（没按过是 null）：G S / G C / G T 是两键连打，中间最多隔一秒 */

      /* 样机数据里没有星标，给一条让那颗星有东西可筛 */
      if (!tasks.some((task) => task.starred)) { const seed = byId('t-d3'); if (seed) seed.starred = true; }

      /* ---------- 顶行：项目（点开是项目菜单）、分支、常用命令 ---------- */
      const avatar = (who = name, cls = '') => h(`i.side-ava${cls}`, { 'aria-hidden': 'true', 'data-tone': OTHERS.find((p) => p.name === who)?.tone }, who[0].toUpperCase());
      const proj = h('button.side-proj', { type: 'button', 'aria-haspopup': 'menu', onclick: () => openProject() }, avatar(), h('span.cut', name), icon('caret', 'sm'));
      const cmdBtn = h('button.ico', { type: 'button', 'aria-label': '常用命令（G C）', 'aria-haspopup': 'dialog', 'data-tip': '常用命令', 'data-key': 'G C', onclick: todo('常用命令面板') }, icon('play', 'fill'));
      const top = h('div.side-top', {}, proj,
        h('button.side-branch', { type: 'button', 'aria-label': 'Git：分支 main，点击切换分支或同步', 'aria-haspopup': 'dialog', 'data-tip': '切换分支或同步', onclick: todo('切换分支的浮层') }, icon('branch'), h('span.cut', 'main'), icon('caret', 'sm')),
        cmdBtn);

      /* ---------- 工具行：聊天、圆点筛选、搜索、随手记、分组管理、新建任务（图标和次序照现在的） ---------- */
      const fbtn = {};
      const filterEl = h('div.side-filter', { role: 'group', 'aria-label': '按状态筛选任务', 'data-m': 'side-keep' }, BUCKETS.map((bucket) => {
        const btn = h('button.side-f', { type: 'button', 'data-k': bucket.key, 'aria-pressed': 'false', onclick: () => setFilter(filter === bucket.key ? null : bucket.key) },
          h('i', { 'aria-hidden': 'true' }, bucket.key === 'star' && icon('star', 'fill')));
        fbtn[bucket.key] = { btn, label: bucket.label };
        return btn;
      }));
      const chatBtn = h('a.ico', { href: '#/chat', 'aria-label': '聊天' }, icon('chat'));
      const searchBtn = h('button.ico', { type: 'button', 'aria-label': '搜索 Cmd K', 'aria-haspopup': 'dialog', 'data-tip': '搜索', 'data-key': '⌘K', onclick: () => openJump() }, icon('search'));
      const tools = h('div.side-tools', { role: 'toolbar', 'aria-label': '任务工具' }, chatBtn, filterEl, searchBtn,
        h('button.ico', { type: 'button', 'aria-label': '随手记', 'data-tip': '随手记', 'data-key': 'NI', onclick: todo('随手记') }, icon('edit')),
        h('a.ico', { href: '#/settings/groups', 'aria-label': '分组管理', 'data-tip': '分组管理' }, icon('layers')),
        h('a.ico', { href: '#/new', 'aria-label': '新建任务', 'data-tip': '新建任务' }, icon('plus')));

      /* ---------- 任务树的固定件 ---------- */
      const tree = h('nav.side-tree', { 'aria-label': '任务树' });
      const pinHead = h('div.sec.side-sec', {}, h('h3', '置顶'));
      const taskHead = h('div.sec.side-sec', {}, h('h3', '任务'));
      const empty = h('div.none');
      /* 其他机器（side-3）：排在「任务」后面、默认折成一行、右边写有几条。点开照现在的：一台机器一行，接力过去的任务缩进在它下面 */
      const farCount = MACHINES.reduce((n, machine) => n + machine.tasks.length, 0);
      const farHead = h('button.sec.side-sec.side-fold', { type: 'button', 'aria-expanded': 'false', 'aria-label': `展开其他机器，${farCount} 条`, 'data-m': 'side-3', onclick: () => setFar(!farOpen) },
        h('span', '其他机器'), icon('chev', 'sm'), h('span.grow'), h('b', String(farCount)));
      const farBody = h('div.side-far', {}, MACHINES.map((machine) => h('div.side-mach', {},
        h('div.side-mach-head', {}, icon('tower'), h('b.cut', machine.name),
          h('button.ico.sm', { type: 'button', 'aria-label': `把本项目正在跑的任务接力到 ${machine.name}`, 'data-tip': `把本项目正在跑的任务接力到 ${machine.name}`, onclick: todo('接力对话框') }, icon('send'))),
        machine.tasks.map((title) => h('button.side-mach-task', { type: 'button', onclick: () => ASH.emit('task:open', {}) }, h('i', { 'aria-hidden': 'true' }), h('span.cut', title))))));
      /* 其他项目：一个项目一行，默认折着；点开是它的任务，没有就一句「没有任务」 */
      const otherHead = h('div.sec.side-sec', {}, h('h3', '其他项目'));
      const others = OTHERS.map((other) => {
        const head = h('button.side-other', { type: 'button', 'aria-expanded': 'false', onclick: () => { other.open = !other.open; head.setAttribute('aria-expanded', String(other.open)); layout(); } },
          icon('chev', 'sm'), avatar(other.name), h('span.cut', other.name));
        const body = h('div.side-other-tasks', {}, other.tasks.length
          ? other.tasks.map((title) => h('div.side-row', {}, h('button.side-row-main', { type: 'button', onclick: () => ASH.emit('task:open', {}) }, h('span.side-row-lead', {}, h('span.dot')), h('span.side-row-title.cut', title))))
          : h('p', '没有任务'));
        return { other, head, body };
      });

      /* 底部一行（side-4）：四样和次序照现在的——连接灯、F、助手、收起；只是字从 10px 上下的三级灰提到 12px 次级色。
         「F 打开任务列表」照现在是一句不可点的提示；F 在真实产品里把侧栏铺开成宽列表，那一态样机没画 */
      const spreadHint = h('span.side-hint', {}, h('kbd', 'F'), '打开任务列表');
      const helper = h('a', { href: '#/assistant', 'aria-label': 'ash 助手', 'data-tip': 'ash 助手' }, icon('assistant'), '助手');
      const foot = h('div.side-foot', { 'data-m': 'side-4' },
        h('span.side-conn', { role: 'status', tabindex: '0', 'aria-label': '实时已连接', 'data-tip': '实时已连接' }, h('span.dot.new')),
        spreadHint, helper,
        h('button', { type: 'button', 'aria-label': '收起侧边栏', 'data-tip': '收起侧边栏', 'data-key': '⌘B', onclick: todo('收起侧栏') }, icon('sidebar'), '收起'));

      /* ---------- 行：行首记号、标题、「谁建的」徽记、行尾那句短话；行尾浮着星标、来源任务、团队记号（都照现在的 TaskTreeRows.tsx） ---------- */
      function buildRow(task) {
        const dot = h('span.dot');
        const lead = h('span.side-row-lead', {}, dot);
        const title = h('span.side-row-title', task.title);
        const end = h('span.side-row-end');
        const link = h('a.side-row-main', { href: '#/task', onclick: (e) => { if (!open(task)) e.preventDefault(); } }, lead, title,
          task.origin && h('span.side-row-from', {}, icon('bot'), task.origin), end);
        const star = h('button.side-row-star', { type: 'button', onclick: () => setStarred(task, !task.starred) }, icon('star'));
        const from = `来自任务：${byId(SOURCE[task.id])?.title ?? ''}`;
        const row = h(`div.side-row${task.origin ? '.has-from' : ''}${task.kind === 'team' ? '.is-team' : ''}`, { 'data-id': task.id }, link,
          task.kind === 'team' && h('span.side-row-kind', { role: 'img', 'aria-label': '团队任务' }, icon('team')),
          task.origin && h('button.side-row-src', { type: 'button', 'aria-label': from, 'data-tip': from, onclick: () => ASH.emit('task:open', { id: SOURCE[task.id] }) }, icon('file')),
          star);
        cutTip(title);
        rows.set(task.id, { task, el: row, link, lead, dot, title, end, star, why: null });
        paint(task, false);
      }

      /* 把一行画成它现在该有的样子：行首点、行尾那句短话、星标。只改有变化的那几样 */
      function paint(task, soft) {
        const row = rows.get(task.id);
        const look = lookOf(task);
        soft = soft && !ASH.reduced();
        if (row.look !== look) {
          row.look = look;
          const set = () => {
            if (row.look !== look) return;
            row.dot.className = `dot ${look.dot}`.trim();
            if (look.say) { row.dot.setAttribute('role', 'img'); row.dot.setAttribute('aria-label', look.say); row.lead.dataset.tip = look.say; }
            else { row.dot.removeAttribute('role'); row.dot.removeAttribute('aria-label'); delete row.lead.dataset.tip; }
          };
          if (soft && !look.dot) row.dot.animate([{ opacity: 1, transform: 'none' }, { opacity: 0, transform: 'scale(0.4)' }], { duration: 120, easing: EASE_IN }).onfinish = set;
          else { set(); if (soft) row.dot.animate([{ opacity: 0, transform: 'scale(0.4)' }, { opacity: 1, transform: 'none' }], { duration: 200, easing: EASE_OUT }); }
        }
        /* 行尾是一个定长的短词（等你答复、等你裁定），不截；多的那半句在提示里 */
        const say = task.why ?? '';
        if (say && row.why) ASH.swap(row.why, say);
        else if (say) { row.why = h(`span.side-row-why${soft ? '.enter' : ''}`, say); row.end.prepend(row.why); }
        else if (row.why) { row.why.remove(); row.why = null; }
        if (row.why) { if (task.detail) row.why.dataset.tip = task.detail; else delete row.why.dataset.tip; }
        row.el.classList.toggle('has-why', Boolean(say));
        const starred = !!task.starred;
        row.el.classList.toggle('is-starred', starred);
        row.star.setAttribute('aria-pressed', String(starred));
        row.star.setAttribute('aria-label', starred ? '取消星标' : '加星标');
        row.star.firstChild.classList.toggle('fill', starred);
        row.status = task.status;
        row.sig = sigOf(task);
      }

      function select() {
        for (const [id, row] of rows) {
          const on = onTask && id === ASH.data.current;
          row.el.classList.toggle('is-on', on);
          if (on) row.link.setAttribute('aria-current', 'page'); else row.link.removeAttribute('aria-current');
        }
      }

      /* 点开一行 = 读过：验收过、还没看的那颗绿点熄掉。样机只有当前这一条任务的详情：点的是它才返回 true，别的行主区不换 */
      function open(task) {
        if (task.status === 'done' && task.read === false) { task.read = true; paint(task, true); count(); layout(); }
        const mine = task.id === ASH.data.current;
        if (!mine) ASH.emit('task:open', { id: task.id });
        return mine;
      }

      /* ---------- 每颗圆点有几条：和现在一样只写在悬停提示里 ---------- */
      function count() {
        for (const bucket of BUCKETS) {
          const { btn } = fbtn[bucket.key];
          const n = tasks.filter((task) => inBucket(task, bucket.key)).length;
          const on = filter === bucket.key;
          btn.classList.toggle('is-empty', !n);
          btn.setAttribute('aria-pressed', String(on));
          btn.dataset.tip = `${bucket.label} · ${n}${on ? '（再点看全部）' : ''}`;
          btn.setAttribute('aria-label', btn.dataset.tip);
        }
      }

      /* ---------- 排版：树里此刻该有哪些孩子、按什么顺序（筛选只管「置顶」「任务」两节） ---------- */
      function wanted() {
        const pass = (id) => !filter || inBucket(byId(id), filter);
        const pins = order.pin.filter(pass).map((id) => rows.get(id).el);
        const rest = order.task.filter(pass).map((id) => rows.get(id).el);
        const list = [];
        if (pins.length) list.push(pinHead, ...pins);
        if (rest.length || !filter) list.push(taskHead, ...rest);
        if (filter && !pins.length && !rest.length) list.push(empty);
        list.push(farHead);
        if (farOpen) list.push(farBody);
        list.push(otherHead);
        for (const { other, head, body } of others) { list.push(head); if (other.open) list.push(body); }
        return list;
      }

      /* 对照清单的两条认领跟着内容走：第 1 条挂在一条「验收过、看过」的行上（行首空着），第 2 条挂在失败的那一行上 */
      function claim() {
        const shown = [...order.task, ...order.pin].map((id) => rows.get(id)).filter((row) => row.el.parentNode === tree);
        const picks = {
          'side-1': shown.find((row) => row.look === LOOK.done)?.el ?? taskHead,
          'side-2': (shown.find((row) => row.look === LOOK.failed) ?? shown.find((row) => row.look.dot))?.el ?? fbtn.todo.btn,
        };
        for (const id of Object.keys(picks)) if (held[id] !== picks[id]) held[id]?.removeAttribute('data-m');
        for (const id of Object.keys(picks)) { picks[id].setAttribute('data-m', id); held[id] = picks[id]; }
      }

      function commit() {
        seq += 1;
        const list = wanted();
        const focused = document.activeElement;
        for (const kid of list) { kid._out?.cancel(); kid._out = null; }
        ASH.flip(tree, () => {
          for (const kid of [...tree.children]) if (!list.includes(kid)) kid.remove();
          list.forEach((kid, i) => { if (tree.children[i] !== kid) tree.insertBefore(kid, tree.children[i] ?? null); });
        });
        if (focused && focused !== document.activeElement && tree.contains(focused)) focused.focus({ preventScroll: true });
        claim();
      }

      /* 要走的先用 120ms 淡掉，再让剩下的滑到新位置（ASH.flip）；连着触发时只认最后一次 */
      function layout() {
        const list = wanted();
        const gone = [...tree.children].filter((kid) => !list.includes(kid));
        if (!gone.length || ASH.reduced()) { commit(); return; }
        seq += 1;
        const mine = seq;
        for (const kid of gone) kid._out ??= kid.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 120, easing: EASE_IN, fill: 'forwards' });
        setTimeout(() => { if (mine === seq) commit(); }, 120);
      }

      function lift(row) {
        row.el.classList.add('is-moving');
        clearTimeout(row.lift);
        row.lift = setTimeout(() => row.el.classList.remove('is-moving'), 360);
      }

      /* ---------- 改状态：点换颜色，这一行滑到本节第一位（置顶节只看置顶时间，不动）。
         事件里的词比表多一个：'accepted' = 验收了（也算看过）。'done' 默认是做完了还没验收，除非明说 accepted: true ---------- */
      function apply(id, status, why, accepted) {
        const task = byId(id);
        const row = rows.get(id);
        if (!task || !row || !status) return;
        if (status === 'accepted') Object.assign(task, { status: 'done', accepted: true, read: true });
        else if (status === 'done') {
          if (row.status !== 'done') task.read = id === ASH.data.current; /* 正开着的那条算读过 */
          Object.assign(task, { status: 'done', accepted: accepted === true });
        } else {
          task.status = status;
          /* 失败、停掉的也能验收（「失败 · 已验收」）；重新跑起来、重新排队就把章摘掉 */
          if (typeof accepted === 'boolean') task.accepted = accepted; else if (status === 'running' || status === 'queued') task.accepted = false;
        }
        const say = why ?? (task.status === 'waiting' ? task.why || '等你处理' : '');
        if (say !== task.why) delete task.detail;
        if (say) task.why = say; else delete task.why;
        if (row.sig === sigOf(task)) return; /* 画着的就是这个样子：同样的状态再来一次不折腾 */
        task.when = '刚刚';
        paint(task, true);
        count();
        if (!task.pinned) { order.task = [id, ...order.task.filter((x) => x !== id)]; lift(row); }
        layout();
      }

      /* 筛选下一条都不剩时的那句话和按钮名照现在的（TaskTree.tsx） */
      function setFilter(key) {
        key = OLD_KEY[key] ?? key;
        filter = fbtn[key] ? key : null;
        if (filter) {
          empty.replaceChildren(h('p', `当前「${fbtn[filter].label}」筛选下没有任务`),
            h('button.btn.sm', { type: 'button', onclick: () => { const was = filter; setFilter(null); fbtn[was]?.btn.focus({ preventScroll: true }); } }, '显示全部'));
        }
        count();
        layout();
      }

      /* 置顶的开关在任务头上（侧栏行上没有）；任务头的图钉调这里，把这一行移进 / 移出「置顶」 */
      function setPinned(id, on) {
        const task = byId(id);
        const row = rows.get(id);
        if (!task || !row || !!task.pinned === !!on) return;
        task.pinned = !!on;
        order.pin = order.pin.filter((x) => x !== id);
        order.task = order.task.filter((x) => x !== id);
        order[on ? 'pin' : 'task'].unshift(id);
        lift(row);
        layout();
        ASH.emit('task:pin', { id, pinned: task.pinned });
      }

      /* 加星标 / 取消星标：只换这颗星，行不挪位置 */
      function setStarred(task, on) {
        task.starred = on;
        paint(task, true);
        count();
        layout();
      }

      function setFar(on) {
        farOpen = !!on;
        farHead.setAttribute('aria-expanded', String(farOpen));
        farHead.setAttribute('aria-label', `${farOpen ? '折叠' : '展开'}其他机器，${farCount} 条`);
        layout();
        if (farOpen) requestAnimationFrame(() => farBody.scrollIntoView({ block: 'nearest', behavior: ASH.reduced() ? 'auto' : 'smooth' }));
      }

      /* 别处改了 ASH.data.tasks（加了任务、换了当前任务）之后叫一声，整栏重新对一遍 */
      function refresh() {
        order.pin = order.pin.filter(byId);
        order.task = order.task.filter(byId);
        for (const task of tasks) {
          if (!rows.has(task.id)) { buildRow(task); order[task.pinned ? 'pin' : 'task'].unshift(task.id); }
          const [here, there] = task.pinned ? ['pin', 'task'] : ['task', 'pin'];
          if (order[there].includes(task.id)) { order[there] = order[there].filter((x) => x !== task.id); order[here].unshift(task.id); }
          paint(task, false);
        }
        select();
        count();
        layout();
      }

      /* ---------- 项目菜单：内容和次序照现在的——当前项目、设置、深浅色、搜索、「切换到」（任务模式排第一）、新建项目 ---------- */
      function openProject() {
        /* 深浅色和样机栏那颗「深色」、设置页那颗分段是同一份偏好（ASH.theme）；选完不收起菜单（现在也不收） */
        const themes = [['system', '跟随系统', 'monitor'], ['light', '浅色', 'sun'], ['dark', '深色', 'moon']].map(([value, label, glyph]) =>
          h('button', { type: 'button', 'data-v': value, onclick: () => ASH.theme.set(value) }, icon(glyph), label));
        const paintTheme = () => { for (const btn of themes) btn.setAttribute('aria-pressed', String(btn.dataset.v === ASH.theme.pref)); };
        const offTheme = ASH.on('theme:change', paintTheme);
        const input = h('input', { type: 'text', placeholder: '搜索项目…', 'aria-label': '搜索项目', autocomplete: 'off', spellcheck: 'false' });
        const list = h('div.menu.side-pm-list');
        const option = (lead, title, sub, tail, attrs) => h('button', { type: 'button', role: 'menuitemradio', ...attrs }, lead, h('span.side-pm-2', {}, h('b.cut', title), h('small.cut', sub)), tail);
        const draw = () => {
          const q = input.value.trim().toLowerCase();
          const hit = (who) => !q || who.toLowerCase().includes(q) || pathOf(who).includes(q);
          const found = [
            (!q || TASK_MODE[0].includes(q) || 'tasks'.startsWith(q)) && option(h('i.side-ava.is-mode', { 'aria-hidden': 'true' }, icon('checks')), ...TASK_MODE, h('kbd', 'G T'), { 'aria-checked': 'false', onclick: todo('任务模式') }),
            hit(name) && option(avatar(), name, pathOf(name), icon('check'), { 'aria-checked': 'true', onclick: () => { ASH.closePop(); proj.focus({ preventScroll: true }); } }),
            ...OTHERS.filter((other) => hit(other.name)).map((other) => option(avatar(other.name), other.name, pathOf(other.name), null, { 'aria-checked': 'false', onclick: todo('切换项目') })),
          ].filter(Boolean);
          list.replaceChildren(h('small', '切换到'), ...(found.length ? found : [h('p.none', '没有匹配的项目')]));
        };
        paintTheme();
        draw();
        const close = ASH.pop(proj, [
          h('div.side-pm-cur', {}, avatar(name, '.is-lg'), h('span.side-pm-2', {}, h('b.cut', name), h('small.cut', pathOf(name)))),
          h('div.menu', {}, h('button', { type: 'button', role: 'menuitem', onclick: () => { ASH.closePop(); ASH.go('#/settings/agents'); } },
            icon('gear'), h('span', '设置'), h('small', '智能体 · 项目 · 分组 · 归档'), h('kbd', 'G S'))),
          h('div.seg.side-pm-theme', { role: 'group', 'aria-label': '配色' }, themes),
          h('label.side-pm-find', {}, icon('search'), input),
          list,
          h('div.menu.side-pm-new', {}, h('button', { type: 'button', role: 'menuitem', onclick: todo('新建项目') }, icon('folderPlus'), h('span', '新建项目'))),
        ], { cls: 'side-pm', onclose: offTheme });
        if (!close) { offTheme(); return; }
        close.el.setAttribute('role', 'menu');
        close.el.setAttribute('aria-label', '项目切换');
        input.addEventListener('input', draw);
        close.el.addEventListener('keydown', (e) => {
          if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
          const stops = $$('button, input', close.el);
          e.preventDefault();
          stops[(stops.indexOf(document.activeElement) + (e.key === 'ArrowDown' ? 1 : stops.length - 1)) % stops.length]?.focus();
        });
        input.focus();
      }

      /* ---------- 键盘：F / \ 是铺开（样机没画这一态）、C 新建、G 加字母、⌘K；焦点在行上时 J / K / 上下键挪一格 ---------- */
      tree.addEventListener('keydown', (e) => {
        const step = { ArrowDown: 1, j: 1, J: 1, ArrowUp: -1, k: -1, K: -1 }[e.key];
        if (!step || e.metaKey || e.ctrlKey || e.altKey) return;
        const all = $$('.side-row-main, .side-mach-task', tree);
        const at = all.indexOf(document.activeElement?.closest?.('.side-row')?.firstElementChild ?? document.activeElement);
        if (at < 0) return;
        e.preventDefault();
        all[Math.max(0, Math.min(at + step, all.length - 1))].focus();
      });
      const GO = { s: () => ASH.go('#/settings/agents'), c: todo('常用命令面板'), t: todo('任务模式'), z: todo('终端抽屉') };
      addEventListener('keydown', (e) => {
        if (e.defaultPrevented || e.repeat || e.isComposing) return;
        const mod = e.metaKey || e.ctrlKey;
        const key = (e.key ?? '').toLowerCase();
        if (mod && !e.altKey && !e.shiftKey && key === 'k') { e.preventDefault(); openJump(); return; }
        const chord = goAt !== null && performance.now() - goAt < 1000;
        goAt = null;
        if (mod || e.altKey || typing(e.target) || $('.pop, .veil') || !el.offsetParent) return;
        if (chord && GO[key]) { e.preventDefault(); GO[key](); }
        else if (key === 'g') goAt = performance.now();
        else if (key === 'f' || key === '\\') { e.preventDefault(); ASH.todo('F 铺开的宽列表'); }
        else if (key === 'c') { e.preventDefault(); ASH.go('#/new'); }
      });

      /* ---------- ⌘K：居中的命令面板，底下一层遮罩。组名、条目、占位、脚注照现在的（CommandPalette.tsx）。
         焦点一直留在输入框里，上下键挪的是高亮；Esc、点遮罩、再按一次 ⌘K 都会关，关掉后焦点回到原来在的地方 ---------- */
      let shutJump = null;
      function openJump() {
        if (shutJump) { shutJump(); return; }
        const input = h('input', { type: 'text', placeholder: '搜索任务、随手记，或输入 / 命令', 'aria-label': '命令面板', autocomplete: 'off', spellcheck: 'false' });
        const list = h('div.menu', { role: 'listbox', 'aria-label': '命令和任务' });
        const panel = h('div.side-jump', { role: 'dialog', 'aria-modal': 'true', 'aria-label': '命令面板' },
          h('label.side-jump-in', {}, icon('search'), input, h('kbd', '⌘K')), list,
          h('div.side-jump-foot', {}, h('span', '↑↓ 选择'), h('span', '↵ 执行'), h('span', 'esc 关闭')));
        let active = 0;
        const options = () => $$('button', list);
        const light = () => options().forEach((btn, i) => {
          btn.dataset.active = String(i === active);
          btn.setAttribute('aria-selected', String(i === active));
          if (i === active) btn.scrollIntoView({ block: 'nearest' });
        });
        /* 层是全应用那一个（ASH.sheet）：Esc、点遮罩、焦点回原处归它管；keep = 点条目不抢输入框的焦点、Tab 不走 */
        const close = ASH.sheet(panel, { cls: 'side-jump-veil', keep: true, onclose: () => { shutJump = null; } });
        const shut = (to) => { close(); if (to) ASH.go(to); };
        /* 一条两行：名字在上、去处或状态在下；右边是键位，高亮那一行多一个回车记号 */
        const option = (lead, label, detail, keys, to) => h('button', { type: 'button', role: 'option', tabindex: '-1', onclick: () => { shut(to); if (to === '') ASH.todo(label); } },
          lead, h('span.side-pm-2', {}, h('b.cut', label), detail && h('small.cut', detail)), keys && h('kbd', keys), h('em', { 'aria-hidden': 'true' }, '↵'));
        const taskRow = (task) => {
          const row = option(h('span.side-row-lead', {}, mark(lookOf(task))), task.title, `${name} · ${WORD[task.status] ?? task.status}`, '', task.id === ASH.data.current ? '#/task' : null);
          row.addEventListener('click', () => open(task));
          return row;
        };
        /* 开着任务页时多一组「当前任务 · 标题」，里面有哪几条跟着状态走 */
        const current = () => {
          const task = onTask && byId(ASH.data.current);
          if (!task) return [];
          const group = `当前任务 · ${task.title}`;
          const live = task.status === 'running' || task.status === 'queued';
          return [
            (task.status === 'failed' || task.status === 'stopped') && [group, task.status === 'failed' ? '重试任务' : '运行任务', 'play', '', '', 'R'],
            live && [group, task.status === 'queued' ? '停止排队' : '停止运行', 'stop'],
            !live && task.status !== 'waiting' && [group, '归档任务', 'box'],
            [group, '删除任务', 'trash'],
          ].filter(Boolean);
        };
        const draw = () => {
          const q = input.value.trim().toLowerCase();
          const kids = [];
          const add = (label, items) => { if (items.length) kids.push(h('small', label), ...items); };
          if (q) add('任务', tasks.filter((task) => task.title.toLowerCase().includes(q)).map(taskRow));
          else add('进行中', tasks.filter((task) => ['running', 'queued', 'waiting'].includes(task.status)).slice(0, 6).map(taskRow));
          const all = [...current(), ...COMMANDS, ...[name, ...OTHERS.map((other) => other.name)].map((who) => ['切换项目', who, 'folder', '', '', pathOf(who)])]
            .filter(([group, label, , keys, , detail]) => !q || `${label} ${detail ?? ''} ${group} ${keys ?? ''}`.toLowerCase().includes(q));
          for (const group of new Set(all.map((item) => item[0]))) add(group, all.filter((item) => item[0] === group).map(([, label, glyph, keys, to, detail]) => option(icon(glyph), label, detail, keys, to || '')));
          list.replaceChildren(...(kids.length ? kids : [h('p.none', '没有匹配的命令、任务或随手记')]));
          active = 0;
          light();
        };
        input.addEventListener('input', draw);
        input.addEventListener('keydown', (e) => {
          const n = options().length;
          if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && n) { e.preventDefault(); active = (active + (e.key === 'ArrowDown' ? 1 : n - 1)) % n; light(); }
          else if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); options()[active]?.click(); }
        });
        draw();
        input.focus();
        shutJump = shut;
      }

      /* ---------- 装起来 ---------- */
      for (const task of tasks) { buildRow(task); order[task.pinned ? 'pin' : 'task'].push(task.id); }
      count();
      tree.replaceChildren(...wanted());
      el.replaceChildren(top, tools, tree, foot);
      claim();

      ASH.on('task:status', ({ id, status, why, accepted } = {}) => apply(id, status, why, accepted));
      ASH.on('task:title', ({ id, title } = {}) => { const row = rows.get(id); if (row && title) row.title.textContent = title; }); /* 任务头上改了名 */
      ASH.on('route', (route) => {
        onTask = route.name === 'task';
        select();
        for (const [link, where] of [[chatBtn, 'chat'], [helper, 'assistant']]) { if (route.name === where) link.setAttribute('aria-current', 'page'); else link.removeAttribute('aria-current'); }
      });

      /* 对照清单点到第 1、2 条时，先把筛选放开，那两行才在 */
      ASH.prep['side-1'] = ASH.prep['side-2'] = () => { if (filter) setFilter(null); };

      return { setStatus: apply, setFilter, setPinned, setFar, refresh, search: openJump };
    },
  });
})();
