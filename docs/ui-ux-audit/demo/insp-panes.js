/* 右侧面板前两簇的四格：信息、文件、生成物、改动。外壳在 insp.js（排在它后面加载）。
   每一格是一个造法 I.build.<格>(c) → 节点；c 是外壳给的控制器（c.st 任务状态、c.on / c.emit 栏内事件、c.acts 面板头动作、c.open 切格）。
   内容只用 base.css 的六个公共件，加 insp.css 里那几样收不进去的（文件行、缩略图、细条）。
   任务的事实取自 ASH.data.cur，改动的账是 ASH.changes（改动工作区看的也是它）。
   通到别处的入口只发事件：changes:open（改动工作区）、diff:open / file:open / folder:open { path }、files:reveal、queue:open。 */
(ASH.insp ??= { build: {}, packs: [] }).packs.push((I) => {
  const { h, icon } = ASH;
  const { sec, pair, showRows, kv, go, reenter, fold, tool, copyBtn, big } = I.kit;
  const D = I.data;
  const cur = ASH.data.cur;
  const m = ASH.changes;
  const STATUS = { running: '运行中', waiting: '等答复', paused: '已暂停', queued: '排队中', failed: '失败', stopped: '已取消', backlog: '待排期', done: '完成' };   // 叫法和任务头一致
  const SETTABLE = ['backlog', 'done', 'failed', 'stopped'];   // 能手动设的四种，照 shared 的 USER_SETTABLE_STATUSES
  const pathLine = (copy) => h('p.insp-path', {}, icon('branch', 'sm'), h('b.cut', D.branch), h('span.cut', D.dir), copy && copyBtn(`${D.branch}  ${D.dir}`, '复制分支和目录'));

  /* ---------- 信息：全部是「标签 值」一种行。上面一组能改，下面一组是事实 ---------- */
  I.build.info = (c) => {
    const { st, task } = c;
    const req = h('button.insp-req', { type: 'button', 'aria-expanded': 'false', onclick: () => req.setAttribute('aria-expanded', String(req.getAttribute('aria-expanded') !== 'true')) }, h('span', cur.req));

    /* 后续追问：折成一行，点开再看。回复框里再发一句，这里跟着多一条 */
    const asks = cur.asks.map((ask) => [...ask]);
    const askList = h('ol.insp-asks');
    const askWide = h('dd.insp-wide', { hidden: true }, askList);
    const askBtn = h('button.insp-val', { type: 'button', 'aria-expanded': 'false', onclick: () => fold(askBtn, askWide) }, h('span'), icon('chev', 'sm insp-rot'));
    const paintAsks = () => {
      askBtn.firstChild.textContent = `${asks.length} 条`;
      askList.replaceChildren(...asks.map(([at, text]) => h('li', {}, h('time', at), h('p', text))));
    };
    c.on('send', (text) => { if (text) { asks.push(['刚刚', text]); paintAsks(); } });
    paintAsks();

    /* 状态：能手动设的是待排期、完成、失败、已取消，再加当前这一个 */
    const status = pair('状态');
    const paintStatus = (prev) => {
      const values = SETTABLE.includes(st.status) ? SETTABLE : [st.status, ...SETTABLE];
      const had = status.dd.contains(document.activeElement);
      const sel = ASH.select({ compact: true, value: st.status, label: '状态', options: values.map((value) => ({ value, label: STATUS[value] })),
        onchange: (value) => { if (value !== st.status) ASH.emit('task:status', { id: ASH.data.current, status: value }); } });
      status.dd.replaceChildren(sel, ...(st.accepted ? [h('span.faint', '已验收')] : []));
      if (had) sel.focus({ preventScroll: true });
      if (prev && prev.status !== st.status) { sel.firstChild.textContent = STATUS[prev.status]; ASH.swap(sel.firstChild, STATUS[st.status]); }
    };

    const labels = ['定时发送'];
    const tagIn = h('input.insp-tag-in', { placeholder: '添加', 'aria-label': '添加标签', size: 4, spellcheck: 'false' });
    const tags = h('span.insp-tags');
    const paintTags = () => tags.replaceChildren(...labels.map((name) => h('button.insp-tag', { type: 'button', 'aria-label': `移除标签「${name}」`, 'data-tip': '移除', onclick: () => { labels.splice(labels.indexOf(name), 1); paintTags(); tagIn.focus(); } }, h('span', name), icon('x'))), tagIn);
    tagIn.addEventListener('keydown', (e) => {
      if (e.isComposing) return;
      const name = tagIn.value.trim();
      if (e.key === 'Enter' && name) { if (!labels.includes(name)) labels.push(name); tagIn.value = ''; paintTags(); tagIn.focus(); }
      if (e.key === 'Backspace' && !tagIn.value && labels.length) { labels.pop(); paintTags(); tagIn.focus(); }
    });
    paintTags();

    /* 调度：选了「一次性」或「循环 Cron」才多出一行填时间 */
    const when = h('input.field.grow', { 'aria-label': '运行时间' });
    const saved = h('button.btn.sm', { type: 'button', onclick: () => { saved.textContent = '已保存'; setTimeout(() => { saved.textContent = '保存'; }, 1400); } }, '保存');
    const whenWide = h('dd.insp-wide.insp-when', { hidden: true }, when, saved);
    const schedule = ASH.select({ compact: true, value: 'none', label: '调度', options: [{ value: 'none', label: '不定时' }, { value: 'once', label: '一次性' }, { value: 'cron', label: '循环 Cron' }], onchange: (value) => {
      whenWide.hidden = value === 'none';
      when.value = '';
      when.placeholder = value === 'cron' ? '分 时 日 月 周，如 0 9 * * 1-5' : '月/日 时:分，如 11/12 09:00';
      if (value !== 'none') { reenter(whenWide); when.focus(); }
    } });

    /* 队列：排着的时候说第几位、下一个是谁；还能入队的时候给「排在谁后面」；已经结束的任务不进队列，这一行不出。
       这两行跟着状态出没：有来有去，底下的行滑到新位置，不是一帧跳 28px */
    const queue = pair('队列');
    const next = pair('下一个', h('span.cut', '导出周报'));
    const others = ASH.data.tasks.filter((t) => t.id !== task.id && (t.status === 'running' || t.status === 'queued'));
    const paintQueue = (first) => {
      const queued = st.status === 'queued';
      const open = st.status === 'running' || st.status === 'waiting';
      if (queued) queue.dd.replaceChildren(h('span.num', '第 2 / 3 位'), h('button.insp-val.end', { type: 'button', 'aria-haspopup': 'dialog', onclick: () => ASH.emit('queue:open') }, '查看队列 · 3 个任务'));
      else if (open) queue.dd.replaceChildren(ASH.select({ compact: true, value: '', label: '排在某任务之后', options: [{ value: '', label: '排在某任务之后…' }, ...others.map((t) => ({ value: t.id, label: `「${t.title}」之后` }))] }));
      const rows = [[queue, queued || open], [next, queued]];
      if (first) for (const [row, on] of rows) row.show(on); else showRows(top, rows);
    };

    /* 用量：一个执行器一行、互不相加（负责人 8 月 7 日定的，照旧）。本轮是最近跑完的那一轮 */
    const use = { claude: { ...cur.use.claude }, codex: { ...cur.use.codex } };
    const cells = {};
    const useRow = (name, label) => {
      const tokens = h('span.num');
      const wakes = h('span.num', String(use[name].wakes));
      cells[name] = { tokens, wakes };
      ASH.roll(tokens, use[name].tokens, { fmt: big });
      return [label, h('span', name), tokens, h('span.faint', {}, '· ', wakes, ' 轮')];
    };
    const turn = h('span.num');
    const time = h('span.num');
    let elapsed = cur.elapsed;
    turn.textContent = ASH.num(cur.turn);
    ASH.roll(time, elapsed, { fmt: ASH.dur });

    /* 上下文：还剩多少。细条画的也是剩下的那一截，剩到 15% 以下变红。正在压缩的那一会儿数字让位给「压缩中」，压完滚到新的数 */
    const WINDOW = 200000;
    let remain = cur.remain;
    let squeezing = false;
    const bar = h('span.insp-bar', {}, h('i'));
    const left = h('span.num');
    const paintCtx = () => {
      if (squeezing) { cancelAnimationFrame(left._roll); left.textContent = '压缩中'; return; }
      ASH.roll(left, remain, { fmt: (n) => `剩 ${Math.round(n)}%` });
      bar.style.setProperty('--p', String(remain / 100));
      bar.classList.toggle('is-low', remain <= 15);
    };
    const compactBtn = h('button.insp-val.end', { type: 'button', 'aria-haspopup': 'dialog', onclick: () => ASH.pop(compactBtn, h('div.insp-set', {},
      kv(['已装入', h('span.num', ASH.num(WINDOW * (100 - remain) / 100))], ['窗口', h('span.num', ASH.num(WINDOW))], ['还可装', h('span.num', ASH.num(WINDOW * remain / 100))]),
      h('label', {}, h('span.grow', '上下文窗口'), h('input.field.num', { value: String(WINDOW), inputmode: 'numeric', 'aria-label': '上下文窗口' }), h('span.faint', 'token')),
      h('label', {}, h('span.grow', '压缩触发点'), h('input.field.num', { value: '80', inputmode: 'numeric', 'aria-label': '压缩触发点' }), h('span.faint', '%')),
      h('div.insp-set-foot', {}, h('span.grow', '写给执行器 claude，下一轮生效'), h('button.btn.pri.sm', { type: 'button', onclick: () => { ASH.closePop(); compactBtn.focus(); } }, '保存'))), { place: 'bottom-end' }) }, '压缩设置');

    /* 改动：压成一行入口，点了去「改动」那一格 */
    const files = h('span.num');
    const add = h('span.num');
    const del = h('span.num');
    const commits = h('span.num');
    const int = (n) => String(Math.round(n));
    const paintChanges = () => {
      ASH.roll(files, m.rows.length, { fmt: int });
      ASH.roll(add, m.sum('add'), { fmt: int });
      ASH.roll(del, m.sum('del'), { fmt: int });
      commits.textContent = String(m.commits.length);
    };
    m.subs.push(paintChanges);

    c.on('usage', (u) => {
      if (u.turn != null) {                             // 一轮跑完了
        const name = use[u.agent] ? u.agent : 'claude';
        use[name].tokens += u.turn;
        use[name].wakes += 1;
        ASH.swap(turn, ASH.num(u.turn));               // 「本轮」换了一轮：是另一个数，换字；不是同一个数在涨，不滚
        ASH.roll(cells[name].tokens, use[name].tokens, { fmt: big });
        cells[name].wakes.textContent = String(use[name].wakes);
        if (u.elapsedMs != null) elapsed += u.elapsedMs;
      } else {
        if (u.tokens != null) { use.claude.tokens = u.tokens; ASH.roll(cells.claude.tokens, u.tokens, { fmt: big }); }
        if (u.elapsedMs != null) elapsed = u.elapsedMs;
      }
      ASH.roll(time, elapsed, { fmt: ASH.dur });
      if (u.squeezing != null) squeezing = u.squeezing;
      if (u.ctx != null) remain = Math.max(0, Math.min(100, u.ctx > 0 && u.ctx <= 1 ? u.ctx * 100 : u.ctx));
      if (u.ctx != null || u.squeezing != null) paintCtx();
    });
    c.on('status', (now, prev) => { paintStatus(prev); paintQueue(); });
    paintStatus();
    paintCtx();
    paintChanges();

    /* 续跑指令：它自己停下来等哨兵时留的那句交代（醒来以后接着做什么）；别的时候没设 */
    const RESUME_TIP = '任务暂停时才能改；没设就用标准的「继续」';
    const resume = h('span.cut.faint', { 'data-tip': RESUME_TIP }, '未设置');
    ASH.on('task:resume', ({ text } = {}) => {
      resume.textContent = text || '未设置';
      resume.classList.toggle('faint', !text);
      resume.dataset.tip = text || RESUME_TIP;
    });

    const top = kv(['追问', askBtn], askWide, status,
      ['分组', ASH.select({ compact: true, value: '', label: '分组', options: [{ value: '', label: '无分组' }, { value: 'g1', label: '定时与队列' }, { value: 'g2', label: '回复框' }] })],
      ['标签', tags], ['调度', schedule], whenWide, queue, next,
      ['续跑指令', resume]);
    paintQueue(true);
    return h('div', { 'data-m': 'insp-2' }, req, top, kv(
      ['来源', task.origin ?? '用户创建'],
      ['创建', h('span.num', cur.created)],
      ['用时', time],
      useRow('claude', '用量'), useRow('codex', ''),
      ['本轮', turn],
      ['上下文', bar, left, compactBtn],
      ['改动', h('button.insp-val', { type: 'button', onclick: () => c.open('scm') }, h('span', {}, files, ' 个文件'), h('span.plus', {}, '+', add), h('span.minus', {}, '−', del)), h('span.faint', {}, commits, ' 个提交')],
      ['分支', h('span.cut', D.branch)],
      ['目录', h('span.cut', D.dir)],
      ['会话', h('span.num', D.session)],
      ['resume', h('span.cut', D.resume), copyBtn(D.resume, '复制 resume 命令')]));
  };

  /* ---------- 文件：头上一行说清看的是哪条分支、哪个目录，下面是树。文件右边是大小；文件夹指到才出一颗「文件夹详情」 ---------- */
  const TREE = [
    ['node_modules', [], true],
    ['output', [['复现-过点不发.png', '184 KB'], ['补发后带标记.png', '201 KB'], ['重启后补发.mp4', '2.1 MB'], ['later-send.log', '48 KB']], true],
    ['docs', [['reviews', [['审查报告-第3轮.md', '6.2 KB'], ['回归记录.md', '3.1 KB']]], ['later-send.md', '4.4 KB']]],
    ['server', [['scripts', [['test-later-send-recover.ts', '7.4 KB']]], ['src', [['index.ts', '3.9 KB'], ['later-send-recover.ts', '4.3 KB'], ['later-send-store.ts', '6.1 KB'], ['later-send.ts', '9.6 KB']]], ['package.json', '2.2 KB']]],
    ['shared', [['src', [['index.ts', '1.4 KB'], ['later-send.ts', '2.7 KB']]]]],
    ['web', [['src', [['reply', [['LaterRow.tsx', '5.2 KB']]]]], ['index.html', '925 B']]],
    ['AGENTS.md', '7.2 KB'], ['package.json', '2.9 KB'],
  ];
  I.build.files = (c) => {
    const opened = new Set(['server']);
    const box = h('div');
    let ignored = false, picked = '';
    const level = (nodes, base, depth) => h('ul', {}, nodes.filter(([, , hide]) => ignored || !hide).map(([name, kids, hide]) => {
      const path = `${base}${name}`;
      const style = { paddingLeft: `${8 + depth * 14}px` };
      if (!Array.isArray(kids)) {
        return h('li', {}, h('button.insp-row', { type: 'button', style, 'aria-current': path === picked ? 'true' : null, onclick: (e) => {
          picked = path;
          for (const row of box.querySelectorAll('[aria-current]')) row.removeAttribute('aria-current');
          e.currentTarget.setAttribute('aria-current', 'true');
          ASH.emit('file:open', { path });
        } }, icon('file', 'sm'), h('span.cut', name), h('span.meta', kids)));
      }
      const sub = level(kids, `${path}/`, depth + 1);
      sub.hidden = !opened.has(path);
      /* 「文件夹详情」只跟着这一行出没：行和键包在一起，底下那一层不算在内 */
      return h(`li${hide ? '.is-ignored' : ''}`, {},
        h('div.insp-file', {},
          h('button.insp-row', { type: 'button', 'aria-expanded': String(!sub.hidden), style, onclick: (e) => { if (fold(e.currentTarget, sub)) opened.add(path); else opened.delete(path); } }, icon('chev', 'sm insp-rot'), h('span.cut', name)),
          tool('info', `打开 ${name} 文件夹详情`, () => ASH.emit('folder:open', { path }))),
        sub);
    }));
    const paint = () => box.replaceChildren(level(TREE, '', 0));
    const eye = tool('eyeOff', '显示被 .gitignore 忽略的文件', () => {
      ignored = !ignored;
      const say = ignored ? '隐藏被 .gitignore 忽略的文件' : '显示被 .gitignore 忽略的文件';
      eye.setAttribute('aria-pressed', String(ignored));
      eye.setAttribute('aria-label', say);
      eye.dataset.tip = say;
      eye.replaceChildren(icon(ignored ? 'eye' : 'eyeOff'));
      paint();
    }, { 'aria-pressed': 'false' });
    c.acts.files = [
      tool('folderOpen', '在文件管理器中打开工作目录', () => ASH.emit('files:reveal')),
      tool('code', '用编程 IDE 打开这个文件夹', (e) => ASH.menu(e.currentTarget, [{ label: 'VS Code', onpick: () => ASH.emit('files:reveal') }, { label: 'Cursor', onpick: () => ASH.emit('files:reveal') }, '-',
        { label: '重新探测本机 IDE', icon: 'redo', onpick: () => ASH.todo('重新探测本机 IDE') }], { place: 'bottom-end' }), { 'aria-haspopup': 'menu' }),
      eye,
      tool('redo', '重新读取文件列表', () => { paint(); reenter(box); }),
    ];
    paint();
    return [pathLine(false), box];
  };

  /* ---------- 生成物：按类型分节。图片和视频才有缩略图，其余一行一条。
     来源只在「还没提交」时写出来（未提交 / 未跟踪），已提交的不写；在哪个目录、什么时候改的，悬停或聚焦再给 ---------- */
  const MADE = {
    image: [['复现-过点不发.png', '184 KB', '未跟踪', 'output', '11/09 14:18'], ['补发后带标记.png', '201 KB', '未跟踪', 'output', '11/09 15:14']],
    video: [['重启后补发.mp4', '2.1 MB', '未跟踪', 'output', '11/09 15:15']],
    doc: [['审查报告-第3轮.md', '6.2 KB', '', 'docs/reviews', '11/09 15:40'], ['回归记录.md', '3.1 KB', '', 'docs/reviews', '11/09 15:28'], ['later-send.log', '48 KB', '未跟踪', 'output', '11/09 15:28']],
  };
  I.build.made = (c) => {
    const open = (name) => tool('ext', `用本机应用打开 ${name}`, () => ASH.emit('files:reveal', { name }));
    const where = (from, dir, at) => `${from === '未跟踪' ? '未纳入版本管理' : from || '已提交'} · ${dir} · ${at}`;
    const see = (dir, name) => () => ASH.emit('file:open', { path: `${dir}/${name}` });
    const thumb = (kind, glyph) => ([name, size, from, dir, at]) => h('div.insp-shot', {},
      h(`button.insp-thumb${kind}`, { type: 'button', 'data-tip': where(from, dir, at), onclick: see(dir, name) }, h('i', {}, icon(glyph)), h('span.cut', name), h('small', from ? `${from} · ${size}` : size)), open(name));
    const line = ([name, size, from, dir, at]) => h('li.insp-file', {},
      h('button.insp-row', { type: 'button', 'data-tip': where(from, dir, at), 'data-tip-side': 'left', onclick: see(dir, name) }, icon('file', 'sm'), h('span.cut', name), from && h('span.insp-from', from), h('span.meta', size)), open(name));
    const root = h('div', { 'data-m': 'insp-10' },
      sec('图片', MADE.image.length), h('div.insp-thumbs', {}, MADE.image.map(thumb('', 'image'))),
      sec('视频', MADE.video.length), h('div.insp-thumbs', {}, MADE.video.map(thumb('.video', 'play'))),
      sec('文档', MADE.doc.length), h('ul', {}, MADE.doc.map(line)));
    c.acts.made = [tool('redo', '重新扫描生成物', () => reenter(root))];
    return root;
  };

  /* ---------- 改动：分支和目录一行，「只读」一行灰字；文件一行一条，同名的带上目录 ---------- */
  I.build.scm = (c) => {
    const { st } = c;
    let tree = false, picked = null;
    const why = h('div.note', { hidden: true }, icon('lock'), h('span', '任务已经结束，这个工作区只看不改。要接着改，回一句话让它继续，或者派生一个新任务。'));
    const whyBtn = h('button.insp-row.insp-why', { type: 'button', 'aria-expanded': 'false', onclick: () => fold(whyBtn, why) }, icon('lock', 'sm'), h('span', '工作区只读'), icon('chev', 'sm insp-rot'));
    const busy = h('div.note', { hidden: true }, icon('warn'), h('span', '有任务正在这个工作目录里运行，智能体可能正在写这里。改动会随它变化，写操作需要额外确认。'));
    const busyBtn = h('button.insp-row.insp-why', { type: 'button', 'aria-expanded': 'false', onclick: () => fold(busyBtn, busy) }, icon('warn', 'sm'), h('span', '有任务正在这里运行'), icon('chev', 'sm insp-rot'));
    const readonly = h('div', {}, whyBtn, why);
    const running = h('div', { hidden: true }, busyBtn, busy);
    const paintState = () => {
      const live = st.status === 'running' || st.status === 'waiting';
      readonly.hidden = live || st.status === 'queued';
      running.hidden = !live;
    };

    const files = h('span.num');
    const add = h('span.num');
    const del = h('span.num');
    const list = h('ul', { 'data-m': 'insp-7' });
    const log = h('ul');
    const int = (n) => String(Math.round(n));
    const pick = (r) => {
      picked = r;
      for (const row of m.rows) { if (row === r) row.btn?.setAttribute('aria-current', 'true'); else row.btn?.removeAttribute('aria-current'); }
      ASH.emit('diff:open', { path: `${r.dir}/${r.name}` });
    };
    const paint = () => {
      const twice = (name) => m.rows.filter((r) => r.name === name).length > 1;
      const row = (r) => {
        r.btn = h(`button.insp-row${tree ? '.is-in' : ''}`, { type: 'button', 'aria-current': r === picked ? 'true' : null, 'data-tip': tree ? null : r.dir, 'data-tip-side': 'left', onclick: () => pick(r) },
          h('span.cut', {}, !tree && twice(r.name) && h('span.faint', `${r.dir}/`), r.name), h('span.meta', {}, h('span.plus', `+${r.add}`), ' ', h('span.minus', `−${r.del}`)));
        const li = h(`li${r.fresh ? '.enter' : ''}`, {}, r.btn);
        r.fresh = false;
        return li;
      };
      const dirs = [...new Set(m.rows.map((r) => r.dir))];
      list.replaceChildren(...(tree ? dirs.flatMap((dir) => [h('li.insp-dir', {}, icon('folder', 'sm'), h('span.cut', dir)), ...m.rows.filter((r) => r.dir === dir).map(row)]) : m.rows.map(row)));
      log.replaceChildren(...m.commits.map((k) => h('li', {}, h('button.insp-row', { type: 'button', 'data-tip': '在 Git 工作台里看这个提交', 'data-tip-side': 'left', onclick: () => ASH.go('#/git') }, h('span.mono.faint', k.hash.slice(0, 7)), h('span.cut', k.text), h('span.meta', k.at)))));
      ASH.roll(files, m.rows.length, { fmt: int });
      ASH.roll(add, m.sum('add'), { fmt: int });
      ASH.roll(del, m.sum('del'), { fmt: int });
    };
    const layout = tool('tree', '按目录树排', () => {
      tree = !tree;
      const say = tree ? '改回平铺' : '按目录树排';
      layout.setAttribute('aria-pressed', String(tree));
      layout.setAttribute('aria-label', say);
      layout.dataset.tip = say;
      paint();
    }, { 'aria-pressed': 'false' });
    c.acts.scm = [layout];
    m.subs.push(paint);
    c.on('status', paintState);
    paintState();
    paint();
    return [
      h('div', { 'data-m': 'insp-6' }, pathLine(true), readonly, running),
      h('p.insp-clean', {}, icon('check', 'sm'), h('span.grow', '无未提交改动'), h('button.insp-val.end', { type: 'button', onclick: () => ASH.go('#/git') }, 'Git 工作台', icon('ext', 'sm'))),
      sec('本任务已提交改动', [files, ' 个文件 ', h('span.plus', {}, '+', add), ' ', h('span.minus', {}, '−', del)]),
      list,
      go('打开改动工作区', () => ASH.emit('changes:open')),
      sec('最近提交'),
      log,
    ];
  };
});
