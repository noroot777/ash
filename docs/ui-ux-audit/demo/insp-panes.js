/* 右侧面板前两簇的四格：信息、文件、生成物、改动。外壳在 insp.js（排在它后面加载）。
   每一格是一个造法 I.build.<格>(c) → 节点；c 是外壳给的控制器（c.st 任务状态、c.on / c.emit 栏内事件、c.acts 面板头动作、c.open 切格）。
   内容只用 base.css 的六个公共件，加 insp.css 里那几样收不进去的（文件行、缩略图、细条）。
   样机里没有做下去的三个去处，只发事件：changes:open（改动工作区）、diff:open { path }（中间栏的差异）、files:reveal。 */
(ASH.insp ??= { build: {}, packs: [] }).packs.push((I) => {
  const { h, icon } = ASH;
  const { sec, pair, kv, go, reenter, fold, tool, copyBtn, big } = I.kit;
  const D = I.data;
  const STATUS = { running: '运行中', waiting: '等答复', queued: '排队中', failed: '失败', stopped: '已取消', done: '完成' };   // 叫法和任务头一致
  const pathLine = (copy) => h('p.insp-path', {}, icon('branch', 'sm'), h('b.cut', D.branch), h('span.cut', D.dir), copy && copyBtn(`${D.branch}  ${D.dir}`, '复制分支和目录'));

  /* ---------- 改动的账：信息格那一行和改动格的清单看的是同一份 ---------- */
  const CHANGED = [['test-free-review-dispute-gate.ts', 'server/scripts', 159, 6], ['free-review-ruling-release.ts', 'server/src', 96, 34], ['free-review-reservations.ts', 'server/src', 55, 2],
    ['free-review-dispute.ts', 'server/src', 30, 18], ['free-workflow.ts', 'server/src', 11, 4], ['schema-free-workflow.ts', 'server/src/db', 9, 1],
    ['index.ts', 'server/src', 4, 0], ['free-workflow.ts', 'shared/src', 4, 0], ['FreeReviewDisputeCard.tsx', 'web/src/free-workflow', 3, 0]];
  const LATER = [['incidents.md', 'docs'], ['free-review-copy.ts', 'web/src/free-workflow'], ['README.md', 'server']];   // 再跑几轮时新碰到的文件
  const COMMITS = [['b255e9ac', '开审前重新检查资格', '22:37'], ['7c1d04e', '裁定后保留预约，不再取消重挂', '22:34'],
    ['3f0e2b8', '放行写进记录；补「裁定后再派审」的回归', '22:08'], ['a91c3d7', '裁定「不用改了」后放行等着的那一轮', '21:42']];
  function changesOf(c) {
    if (c.changes) return c.changes;
    const m = c.changes = {
      rows: CHANGED.map(([name, dir, add, del]) => ({ name, dir, add, del })),
      commits: COMMITS.map(([hash, text, at]) => ({ hash, text, at })),
      subs: [],
      sum: (key) => m.rows.reduce((n, r) => n + r[key], 0),
    };
    /* 一轮跑完报来的是总数：多出来的文件添成新行，多出来的增删记到新行（没有新文件就记到头一行）上。
       带 commit { hash, text, squash? } 时记一笔提交，squash 是它合掉了前面几个 */
    c.on('usage', (u) => {
      const dAdd = u.add == null ? 0 : u.add - m.sum('add');
      const dDel = u.del == null ? 0 : u.del - m.sum('del');
      const fresh = [];
      for (let n = m.rows.length; u.files != null && n < u.files && LATER[n - CHANGED.length]; n += 1) {
        const [name, dir] = LATER[n - CHANGED.length];
        fresh.push({ name, dir, add: 0, del: 0, fresh: true });
      }
      m.rows.push(...fresh);
      const into = fresh[0] ?? m.rows[0];
      into.add = Math.max(0, into.add + dAdd);
      into.del = Math.max(0, into.del + dDel);
      if (u.commit) { m.commits.splice(0, u.commit.squash ?? 0); m.commits.unshift({ hash: u.commit.hash, text: u.commit.text, at: '刚刚' }); }
      if (fresh.length || dAdd || dDel || u.commit) for (const fn of m.subs) fn();
    });
    return m;
  }

  /* ---------- 信息：全部是「标签 值」一种行。上面一组能改，下面一组是事实 ---------- */
  const REQ = '点了「这一轮不用改了」之后，审查还停在等待里，没有往下走；预约的那一轮也没有起来。裁定之后应该放行等着的那一轮，再按预约派下一轮，记录里要看得出是谁放行的。';
  I.build.info = (c) => {
    const { st, task } = c;
    const m = changesOf(c);
    const req = h('button.insp-req', { type: 'button', 'aria-expanded': 'false', onclick: () => req.setAttribute('aria-expanded', String(req.getAttribute('aria-expanded') !== 'true')) }, h('span', REQ));

    /* 后续追问：折成一行，点开再看。回复框里再发一句，这里跟着多一条 */
    const asks = [['11/10 22:31', '两条都改。改完跑一遍那个闸的回归。']];
    const askList = h('ol.insp-asks');
    const askWide = h('dd.insp-wide', { hidden: true }, askList);
    const askBtn = h('button.insp-val', { type: 'button', 'aria-expanded': 'false', onclick: () => fold(askBtn, askWide) }, h('span'), icon('chev', 'sm insp-rot'));
    const paintAsks = () => {
      askBtn.firstChild.textContent = `${asks.length} 条`;
      askList.replaceChildren(...asks.map(([at, text]) => h('li', {}, h('time', at), h('p', text))));
    };
    c.on('send', (text) => { if (text) { asks.push(['刚刚', text]); paintAsks(); } });
    paintAsks();

    /* 状态：能手动设的是完成、失败、已取消，再加当前这一个 */
    const status = pair('状态');
    const paintStatus = (prev) => {
      const values = ['done', 'failed', 'stopped'];
      if (!values.includes(st.status)) values.unshift(st.status);
      const had = status.dd.contains(document.activeElement);
      const sel = ASH.select({ value: st.status, label: '状态', options: values.map((value) => ({ value, label: STATUS[value] })),
        onchange: (value) => { if (value !== st.status) ASH.emit('task:status', { id: ASH.data.current, status: value }); } });
      status.dd.replaceChildren(sel, ...(st.accepted ? [h('span.faint', '已验收')] : []));
      if (had) sel.focus({ preventScroll: true });
      if (prev && prev.status !== st.status) { sel.firstChild.textContent = STATUS[prev.status]; ASH.swap(sel.firstChild, STATUS[st.status]); }
    };

    const labels = ['审查链'];
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
    const schedule = ASH.select({ value: 'none', label: '调度', options: [{ value: 'none', label: '不定时' }, { value: 'once', label: '一次性' }, { value: 'cron', label: '循环 Cron' }], onchange: (value) => {
      whenWide.hidden = value === 'none';
      when.value = '';
      when.placeholder = value === 'cron' ? '分 时 日 月 周，如 0 9 * * 1-5' : '月/日 时:分，如 11/12 09:00';
      if (value !== 'none') { reenter(whenWide); when.focus(); }
    } });

    /* 队列：排着的时候说第几位、下一个是谁；还能入队的时候给「排在谁后面」；已经结束的任务不进队列，这一行不出 */
    const queue = pair('队列');
    const next = pair('下一个', h('span.cut', '导出周报'));
    const others = ASH.data.tasks.filter((t) => t.id !== task.id && (t.status === 'running' || t.status === 'queued'));
    const seeQueue = (e) => ASH.menu(e.currentTarget, ['这条队列 · 3 个任务', ...[others.find((t) => t.status === 'running')?.title ?? '斜杠补全', task.title, '导出周报'].map((label, i) => ({ label, kbd: `${i + 1} / 3` }))], { place: 'bottom-end' });
    const paintQueue = () => {
      const queued = st.status === 'queued';
      const open = st.status === 'running' || st.status === 'waiting';
      queue.show(queued || open);
      next.show(queued);
      if (queued) queue.dd.replaceChildren(h('span.num', '第 2 / 3 位'), h('button.insp-val.end', { type: 'button', 'aria-haspopup': 'menu', onclick: seeQueue }, '查看队列'));
      else if (open) queue.dd.replaceChildren(ASH.select({ value: '', label: '排在某任务之后', options: [{ value: '', label: '排在某任务之后…' }, ...others.map((t) => ({ value: t.id, label: `「${t.title}」之后` }))] }));
    };

    /* 用量：一个执行器一行、互不相加（负责人 8 月 7 日定的，照旧）。本轮是最近跑完的那一轮 */
    const use = { claude: { tokens: 28.36e6, wakes: 4 }, codex: { tokens: 20.49e6, wakes: 4 } };
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
    let elapsed = 4740000;
    ASH.roll(turn, 418000);
    ASH.roll(time, elapsed, { fmt: ASH.dur });

    /* 上下文：还剩多少。细条画的也是剩下的那一截，剩到 15% 以下变红 */
    const WINDOW = 200000;
    let remain = 65;
    const bar = h('span.insp-bar', {}, h('i'));
    const left = h('span.num');
    const paintCtx = () => {
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
        ASH.roll(turn, u.turn);
        ASH.roll(cells[name].tokens, use[name].tokens, { fmt: big });
        cells[name].wakes.textContent = String(use[name].wakes);
        if (u.elapsedMs != null) elapsed += u.elapsedMs;
      } else {
        if (u.tokens != null) { use.claude.tokens = u.tokens; ASH.roll(cells.claude.tokens, u.tokens, { fmt: big }); }
        if (u.elapsedMs != null) elapsed = u.elapsedMs;
      }
      ASH.roll(time, elapsed, { fmt: ASH.dur });
      if (u.ctx != null) { remain = Math.max(0, Math.min(100, u.ctx > 0 && u.ctx <= 1 ? u.ctx * 100 : u.ctx)); paintCtx(); }
    });
    c.on('status', (now, prev) => { paintStatus(prev); paintQueue(); });
    paintStatus();
    paintQueue();
    paintCtx();
    paintChanges();

    const top = kv(['追问', askBtn], askWide, status,
      ['分组', ASH.select({ value: '', label: '分组', options: [{ value: '', label: '无分组' }, { value: 'g1', label: '审查链修复' }, { value: 'g2', label: '回复框' }] })],
      ['标签', tags], ['调度', schedule], whenWide, queue, next,
      ['续跑指令', h('span.faint', { 'data-tip': '任务暂停时才能改；没设就用标准的「继续」' }, '未设置')]);
    return h('div', { 'data-m': 'insp-2' }, req, top, kv(
      ['来源', task.origin ?? '用户创建'],
      ['创建', h('span.num', '11/10 21:34')],
      ['用时', time],
      useRow('claude', '用量'), useRow('codex', ''),
      ['本轮', turn],
      ['上下文', bar, left, compactBtn],
      ['改动', h('button.insp-val', { type: 'button', onclick: () => c.open('scm') }, h('span', {}, files, ' 个文件'), h('span.plus', {}, '+', add), h('span.minus', {}, '−', del)), h('span.faint', {}, commits, ' 个提交')],
      ['分支', h('span.cut', D.branch)],
      ['目录', h('span.cut', D.dir)],
      ['会话', h('span.num', D.session)],
      ['续跑命令', h('span.cut', D.resume), copyBtn(D.resume, '复制续跑命令')]));
  };

  /* ---------- 文件：头上一行说清看的是哪条分支、哪个目录，下面是树。文件右边是大小 ---------- */
  const TREE = [
    ['node_modules', [], true],
    ['output', [['复现-裁定后卡住.png', '184 KB'], ['放行后接着审.png', '201 KB'], ['修复后走一遍.mp4', '2.1 MB'], ['dispute-gate.log', '48 KB']], true],
    ['docs', [['reviews', [['审查报告-第3轮.md', '6.2 KB'], ['回归记录.md', '3.1 KB']]], ['incidents.md', '41 KB']]],
    ['server', [['scripts', [['test-free-review-dispute-gate.ts', '7.4 KB']]], ['src', [['db', [['schema-free-workflow.ts', '5.8 KB']]], ['free-review-dispute.ts', '9.6 KB'], ['free-review-reservations.ts', '6.1 KB'], ['free-review-ruling-release.ts', '4.3 KB'], ['free-workflow.ts', '22 KB'], ['index.ts', '3.9 KB']]], ['package.json', '2.2 KB']]],
    ['shared', [['src', [['free-workflow.ts', '8.7 KB'], ['index.ts', '1.4 KB']]]]],
    ['web', [['src', [['free-workflow', [['FreeReviewDisputeCard.tsx', '11 KB']]]]], ['index.html', '925 B']]],
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
        } }, icon('file', 'sm'), h('span.cut', name), h('span.meta', kids)));
      }
      const sub = level(kids, `${path}/`, depth + 1);
      sub.hidden = !opened.has(path);
      return h(`li${hide ? '.is-ignored' : ''}`, {}, h('button.insp-row', { type: 'button', 'aria-expanded': String(!sub.hidden), style, onclick: (e) => { if (fold(e.currentTarget, sub)) opened.add(path); else opened.delete(path); } }, icon('chev', 'sm insp-rot'), h('span.cut', name)), sub);
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
      tool('code', '用编程 IDE 打开这个文件夹', (e) => ASH.menu(e.currentTarget, [{ label: 'VS Code' }, { label: 'Cursor' }, '-', { label: '重新探测本机 IDE', icon: 'redo' }], { place: 'bottom-end' }), { 'aria-haspopup': 'menu' }),
      eye,
      tool('redo', '重新读取文件列表', () => { paint(); reenter(box); }),
    ];
    paint();
    return [pathLine(false), box];
  };

  /* ---------- 生成物：按类型分节。图片和视频才有缩略图，其余一行一条；来自哪、在哪个目录，悬停或聚焦再给 ---------- */
  I.build.made = (c) => {
    const open = (name) => tool('ext', `用本机应用打开 ${name}`, () => ASH.emit('files:reveal', { name }));
    const thumb = (kind, glyph, name, size) => h('div.insp-shot', {}, h(`button.insp-thumb${kind}`, { type: 'button', 'data-tip': '未纳入版本管理 · output' }, h('i', {}, icon(glyph)), h('span.cut', name), h('small', size)), open(name));
    const line = (name, size, where) => h('li.insp-file', {}, h('button.insp-row', { type: 'button', 'data-tip': where, 'data-tip-side': 'left' }, icon('file', 'sm'), h('span.cut', name), h('span.meta', size)), open(name));
    const root = h('div', { 'data-m': 'insp-10' },
      sec('图片', 2), h('div.insp-thumbs', {}, thumb('', 'image', '复现-裁定后卡住.png', '184 KB'), thumb('', 'image', '放行后接着审.png', '201 KB')),
      sec('视频', 1), h('div.insp-thumbs', {}, thumb('.video', 'play', '修复后走一遍.mp4', '2.1 MB')),
      sec('文档', 3), h('ul', {}, line('审查报告-第3轮.md', '6.2 KB', '已提交 · docs/reviews'), line('回归记录.md', '3.1 KB', '已提交 · docs/reviews'), line('dispute-gate.log', '48 KB', '未纳入版本管理 · output')));
    c.acts.made = [tool('redo', '重新扫描生成物', () => reenter(root))];
    return root;
  };

  /* ---------- 改动：分支和目录一行，「只读」一行灰字；文件一行一条，同名的带上目录 ---------- */
  I.build.scm = (c) => {
    const { st } = c;
    const m = changesOf(c);
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
