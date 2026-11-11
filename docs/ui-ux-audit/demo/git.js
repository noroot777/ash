/* Git 工作台（改后）。整页占满、侧栏隐藏。结构、名字、次序都照现在的（web/src/git-workbench）：
   顶栏（项目 · 分支 · 工作树 ·〔空白〕· 拉取引用 · 拉取 · 推送 · AI 协助 · 工作台选项）、七项视图导航、视图本身。
   这个文件是外壳：顶栏、导航、顶栏下面那一句、拉取和推送。「变更」视图在 git-changes.js；另外六个视图和带输入框的确认框在 git-views.js（历史）、git-refs.js（分支、贮藏、标签、工作树、操作日志）。
   变的只有清单里的三条：
   git-1 返回挪到最左、变成一颗箭头，「工作台选项」里不再有第二个出口；实心主色只给当下该做的那一步（提交或推送）。
   git-2 推送失败是一句原因 + 一个动作 + 查看详情，只说一次。
   git-3 干净时整页只说一句，空的分组整组不画。
   （提交说明随内容长高、没有拖拽角，是会话流那一条里点了名的。）
   对外：ASH.parts.git = { showFail(), clean(), state(), view(id) }；事件 git:commit、git:push（{ ok }）。 */
(() => {
  const { h, icon } = ASH;
  ASH.icons.gitLeft ??= '<path d="M13 8H3M7.5 3.5 3 8l4.5 4.5"/>';
  ASH.icons.gitTree ??= '<rect x="2" y="6" width="4" height="4" rx="1"/><rect x="10" y="2.5" width="4" height="4" rx="1"/><rect x="10" y="9.5" width="4" height="4" rx="1"/><path d="M6 8h2M10 4.5H8.5a.5.5 0 0 0-.5.5v6a.5.5 0 0 0 .5.5H10"/>';
  /* 视图导航的七个图标照 WorkbenchNavIcon.tsx 的原形 */
  ASH.icons.gitChanges ??= '<path d="M3 5.5h7M3 8h10M3 10.5h6"/><circle cx="12.5" cy="5.5" r="1.6"/>';
  ASH.icons.gitHistory ??= '<circle cx="8" cy="8" r="5.6"/><path d="M8 5v3.2l2.2 1.4"/>';
  ASH.icons.gitBranch ??= '<circle cx="4.5" cy="4" r="1.7"/><circle cx="4.5" cy="12" r="1.7"/><circle cx="11.5" cy="6.5" r="1.7"/><path d="M4.5 5.7v4.6M11.5 8.2c0 2.6-4 1.6-6.2 3"/>';
  ASH.icons.gitStash ??= '<path d="M2.5 6.5 8 3.5l5.5 3L8 9.5z"/><path d="M2.5 9.5 8 12.5l5.5-3"/>';
  ASH.icons.gitTags ??= '<path d="M8.6 2.5H13v4.4l-6 6a1.2 1.2 0 0 1-1.7 0L2.6 10a1.2 1.2 0 0 1 0-1.7z"/><circle cx="10.6" cy="5" r="1" fill="currentColor" stroke="none"/>';
  ASH.icons.gitWorktrees ??= '<rect x="2.5" y="2.5" width="4.6" height="11" rx="1"/><rect x="9" y="2.5" width="4.6" height="5" rx="1"/><rect x="9" y="9.5" width="4.6" height="4" rx="1"/>';
  ASH.icons.gitLog ??= '<path d="M3 3.5h10M3 8h10M3 12.5h6.5"/><circle cx="12.5" cy="12.5" r="1.4"/>';

  const VIEWS = [['changes', '变更', 'gitChanges'], ['history', '历史', 'gitHistory'], ['branches', '分支', 'gitBranch'], ['stash', '贮藏', 'gitStash'], ['tags', '标签', 'gitTags'], ['worktrees', '工作树', 'gitWorktrees'], ['log', '操作日志', 'gitLog']];

  /* 另外三个文件：git-changes.js（ASH.gitChanges、ASH.gitDiff）、git-views.js 和 git-refs.js（两个合起来是 ASH.gitMore）。demo.html 里还没有它们那几行时，这里自己接上 */
  const here = document.currentScript.src;
  const ready = Promise.all(['git-changes.js', 'git-views.js', 'git-refs.js'].map((file) => new Promise((ok) => {
    if (document.querySelector(`script[src$="${file}"]`)) { ok(); return; }
    const tag = h('script', { src: new URL(file, here).href });
    tag.onload = tag.onerror = ok;
    document.head.append(tag);
  })));

  const DIRTY = '工作区有未提交或未跟踪的文件，请先提交或贮藏后再操作';
  /* 一棵工作树连同它此刻的状态。up 是上游；remoteAhead = 远端有本地还没取回来的提交（拉取引用之前不知道，所以推送会被拒） */
  const tree = (branch, path, more) => ({ branch, path, up: `origin/${branch}`, files: [], sel: null, ahead: 0, behind: 0, push: 'idle', remoteAhead: false, msg: '', folded: new Set(), ...more });
  const PROJECTS = () => [
    { name: 'harness', path: '~/code/harness', url: 'git@example.com:team/harness.git',
      refs: [['branch', 'feat/slash-complete', 'a83f02d1'], ['branch', 'fix/reply-stick-bottom', '4c1d9e7a'], ['branch', 'fix/side-width-memory', '9be2f0c4'], ['branch', 'main', '9be2f0c4'],
        ['remote', 'origin/HEAD', '9be2f0c4'], ['remote', 'origin/fix/reply-stick-bottom', '4c1d9e7a'], ['remote', 'origin/main', '9be2f0c4'], ['tag', 'v0.9.2', '5d2c8e16'], ['tag', 'v0.9.1', '3aa1f6d2']],
      trees: [tree('main', '~/code/harness'), tree('feat/slash-complete', '~/code/harness/.worktrees/slash-complete', { task: '斜杠补全：已有正文后面敲 / 也弹', up: null }),
        tree('fix/reply-stick-bottom', '~/code/harness/.worktrees/reply-stick-bottom', { files: ASH.gitDiff.files(), msg: ASH.gitDiff.MSG, remoteAhead: true })] },
    { name: 'ash-docs', path: '~/code/ash-docs', url: 'git@example.com:team/ash-docs.git',
      refs: [['branch', 'main', '2e7c5b19'], ['remote', 'origin/HEAD', '2e7c5b19'], ['remote', 'origin/main', '2e7c5b19']], trees: [tree('main', '~/code/ash-docs')] },
  ].map((p) => ({ ...p, refs: p.refs.map(([kind, name, sha]) => ({ kind, name, sha })) }));

  /* 推送被拒时 git 的原话：只在「查看详情」里露出 */
  const rawFail = (t, url) => `$ git push origin HEAD:${t.branch}
To ${url}
 ! [rejected]        ${t.branch} -> ${t.branch} (${t.remoteAhead ? 'fetch first' : 'non-fast-forward'})
error: failed to push some refs to '${url}'
hint: Updates were rejected because ${t.remoteAhead ? 'the remote contains work that you do\nhint: not have locally.' : 'the tip of your current branch is behind\nhint: its remote counterpart.'} Integrate the remote changes before pushing again.`;

  /* 上下键在一组按钮里走（两张选择浮层用；普通菜单 ASH.menu 自己带） */
  const arrows = (e) => {
    const all = [...e.currentTarget.querySelectorAll('button:not([disabled])')];
    const i = all.indexOf(document.activeElement);
    const to = all.length && { ArrowDown: all[(i + 1) % all.length], ArrowUp: all[(i - 1 + all.length) % all.length], Home: all[0], End: all.at(-1) }[e.key];
    if (to) { e.preventDefault(); to.focus(); }
  };

  /* 项目、工作树的选择浮层：抬头（名字 + 条数），一条两行（名字、说明），当前那条标「当前」。照 WorkbenchMenu 的 picker 形态 */
  function picker(anchor, label, items) {
    const list = h('div.git-pick-list', items.map((it) => h('button', { type: 'button', role: 'menuitem', disabled: it.current, 'aria-current': it.current ? 'true' : null,
      'aria-label': `${it.label} · ${it.desc}`, onclick: () => { ASH.closePop(); anchor.focus({ preventScroll: true }); it.onpick(); } },
      h('span.git-pick-ico', { 'aria-hidden': 'true' }, icon(it.icon)),
      h('span.git-pick-copy', h(`b.cut${it.mono ? '.mono' : ''}`, it.label), h(`span${it.descMono ? '.mono' : ''}`, it.desc)),
      it.current && h('span.git-pick-cur', { 'aria-hidden': 'true' }, icon('check', 'sm'), '当前'))));
    const box = h('div.git-pick', { role: 'menu', 'aria-label': label, tabindex: '-1', onkeydown: arrows },
      h('div.git-pick-head', { 'aria-hidden': 'true' }, h('b', label), h('span.num', String(items.length))), list);
    if (ASH.pop(anchor, box, { cls: 'git-pick-pop' })) (list.querySelector('button:not([disabled])') ?? box).focus({ preventScroll: true });
  }

  /* 普通菜单：在 ASH.menu 上补一样它没有的——危险项标红 */
  function menu(anchor, items, opts) {
    const close = ASH.menu(anchor, items, opts);
    const defs = items.filter((it) => typeof it === 'object');
    close?.el.querySelectorAll('.menu > button').forEach((btn, i) => btn.classList.toggle('git-danger', Boolean(defs[i]?.danger)));
  }

  let live = null;

  ASH.surface('git', {
    chrome: 'full',
    /* 另外三个文件已经在了就当场装好；是这里自己接上的，就等它们到了再装 */
    mount(main) {
      /* 对照清单直接跳到这两处；另外三个文件还在路上，就等它们到了再跳 */
      ASH.prep['git-2'] = () => (live ? live.showFail() : ready.then(() => live?.showFail()));
      ASH.prep['git-3'] = () => (live ? live.clean() : ready.then(() => live?.clean()));
      let stop = ASH.gitChanges ? start(main) : null;
      let gone = false;
      if (!stop) ready.then(() => { if (!gone && ASH.gitChanges) stop = start(main); });
      return () => { gone = true; stop?.(); delete ASH.prep['git-2']; delete ASH.prep['git-3']; };
    },
  });

  function start(main) {
    const D = ASH.gitDiff;
    const projects = PROJECTS();
    let P = projects[0];          /* 正在看的项目 */
    let T = P.trees[2];           /* 正在看的工作树（连同它的状态） */
    let view = 'changes';
    let busy = false;
    let alive = true;
    const timers = new Set();
    const later = (ms, fn) => { const t = setTimeout(() => { timers.delete(t); fn(); }, ms); timers.add(t); };
    const ref = (name) => P.refs.find((r) => r.name === name);
    const count = () => D.count(T);
    const more = (name, ...args) => ASH.gitMore?.[name]?.(G, ...args);

    /* ---------- 顶栏：返回在最左（git-1），其余照 WorkbenchHeader.tsx 的名字和次序 ---------- */
    const back = h('button.ico', { type: 'button', 'aria-label': '返回 ash 工作区', 'data-tip': '返回', 'data-m': 'git-1', onclick: () => ASH.go('#/task') }, icon('gitLeft'));
    const projName = h('span.cut');
    const projPath = h('i.cut');
    const projBtn = h('button.git-proj', { type: 'button', 'aria-label': '选择 Git 项目', 'aria-haspopup': 'menu' }, h('b', projName, icon('caret', 'sm')), projPath);
    projBtn.addEventListener('click', () => picker(projBtn, '选择 Git 项目', projects.map((p) => ({ label: p.name, desc: p.path, descMono: true, icon: 'gitBranch', current: p === P, onpick: () => openTree(p.trees[0], p) }))));
    const branchName = h('b.cut');
    const branchBtn = h('button.git-branch', { type: 'button', 'aria-label': '当前分支', 'aria-haspopup': 'menu' }, icon('gitBranch', 'sm'), branchName, icon('chev', 'sm'));
    /* 分支菜单：当前分支和已经被某棵工作树检出的分支点不动，末尾是「新建分支…」 */
    branchBtn.addEventListener('click', () => menu(branchBtn, [
      ...P.refs.filter((r) => r.kind === 'branch').map((r) => ({ label: r.name, icon: 'gitBranch', disabled: busy || P.trees.some((t) => t.branch === r.name), onpick: () => more('checkout', r.name) })),
      '-', { label: '新建分支…', icon: 'plus', disabled: busy, onpick: () => more('newBranch') }]));
    const treeBtn = h('button.btn.git-tree', { type: 'button', 'aria-label': '选择工作树', 'aria-haspopup': 'menu', 'data-tip': '选择工作树' }, icon('gitTree'), icon('caret', 'sm'));
    treeBtn.addEventListener('click', () => picker(treeBtn, '选择工作树', P.trees.map((t) => ({ label: t.branch, mono: true, desc: t === P.trees[0] ? '项目主仓' : t.task || '手动工作树', icon: 'gitTree', current: t === T, onpick: () => openTree(t) }))));

    const behindEl = h('em.git-badge.num', { hidden: true });
    const aheadEl = h('em.git-badge.num', { hidden: true });
    const fetchBtn = h('button.btn', { type: 'button', onclick: () => fetchRefs() }, icon('redo'), h('span', '拉取引用'));
    const pullBtn = h('button.btn', { type: 'button', 'aria-haspopup': 'menu' }, icon('down'), h('span', '拉取'), behindEl);
    /* 任务工作树不给变基（现在就是这样） */
    pullBtn.addEventListener('click', () => menu(pullBtn, [
      { label: '仅快进 · 分叉时停止', onpick: () => pull('ff-only') }, { label: '拉取并合并', onpick: () => pull('merge') },
      !T.task && { label: '拉取并变基', onpick: () => pull('rebase') }].filter(Boolean)));
    const pushLabel = h('span');
    const pushBtn = h('button.btn', { type: 'button', onclick: () => askPush() }, icon('up'), pushLabel, aheadEl);
    const lock = h('span.git-lock', icon('lock', 'sm'), '仓库正在操作');
    const assistBtn = h('button.btn', { type: 'button', onclick: () => ASH.go('#/new') }, icon('spark'), h('span', 'AI 协助'));
    const moreBtn = h('button.ico', { type: 'button', 'aria-label': '工作台选项', 'aria-haspopup': 'menu', 'data-tip': '工作台选项' }, icon('more'));
    /* 「返回 ash」不在这里了：出口只有最左那一颗（git-1） */
    moreBtn.addEventListener('click', () => menu(moreBtn, [
      { label: '刷新 Git 工作台', icon: 'redo', disabled: busy, onpick: () => paintAll() },
      { label: '保护强推…', danger: true, disabled: busy || !T.up, onpick: () => askPush(true) }], { place: 'bottom-end' }));
    const bar = h('header.git-bar', back, projBtn, branchBtn, treeBtn, h('span.grow'), fetchBtn, pullBtn, pushBtn, assistBtn, moreBtn);
    function paintHead() {
      projName.textContent = P.name;
      projPath.textContent = T.path;
      branchName.textContent = T.branch;
      pushLabel.textContent = T.up ? '推送' : '发布';
      pushBtn.setAttribute('aria-label', pushLabel.textContent);
    }

    /* ---------- 七项视图：变更、贮藏、工作树带条数（是零就不画）。「变更」以外的六个由 git-views.js 画 ---------- */
    const badges = { changes: h('b.num'), stash: h('b.num'), worktrees: h('b.num') };
    const tabs = Object.fromEntries(VIEWS.map(([id, name, glyph]) => [id, h('button', { type: 'button', onclick: () => openView(id) }, icon(glyph), h('span', name), badges[id])]));
    const views = h('nav.git-views', { 'aria-label': 'Git 工作台视图' }, Object.values(tabs));
    const pageEl = h('div.git-page', { hidden: true });
    const ui = {};   /* 各视图自己的临时状态（搜索词、选中的提交、展开的贮藏），重画时不丢 */
    function openView(id, state) {
      if (!alive || (id !== 'changes' && !ASH.gitMore)) return;
      view = id;
      if (state) ui[id] = { paint: paintView, ...ui[id], ...state };
      paintAll();
    }
    function paintView() {
      for (const [id] of VIEWS) tabs[id].setAttribute('aria-current', id === view ? 'page' : 'false');
      C.mid.hidden = C.diffEl.hidden = view !== 'changes';
      pageEl.hidden = view === 'changes';
      pageEl.dataset.view = view;
      const state = (ui[view] ??= { paint: paintView });   /* 视图自己要重画时调 paint */
      keepFocus(pageEl, () => pageEl.replaceChildren(...(view === 'changes' ? [] : [ASH.gitMore[view](G, state)])));
      const n = { changes: count(), stash: P.stashes?.length ?? 0, worktrees: P.trees.length };
      for (const id of Object.keys(badges)) { badges[id].textContent = String(n[id]); badges[id].hidden = !n[id]; }
    }
    if (ASH.gitMore) ASH.gitMore.seed(projects); else for (const [id] of VIEWS.slice(1)) tabs[id].disabled = true;

    /* ---------- 顶栏下面那一条：正在执行 / 上一步的结果 / 推送失败（git-2）。同一时刻只有一条 ---------- */
    let slot = null;
    let failEl = null;
    function setSlot(node) {
      failEl = node?.classList.contains('git-fail') ? node : null;
      if (!failEl && T.push === 'failed') T.push = 'idle';   /* 失败那句被别的话顶掉了，推送回到「可以再试」 */
      ASH.flip(root, () => { slot?.remove(); slot = node; if (node) bar.after(node); });
    }
    const result = (text) => setSlot(h('div.git-result', { role: 'status' }, h('span', text), h('button.btn.sm', { type: 'button', onclick: () => openView('log') }, '查看日志')));
    /* 每做完一件事：记进操作日志，顶栏下面落一句结果（失败也是这一句；推送被拒另有 git-2 那一条） */
    function done(label, cmd, text, ok = true, quiet = false) {
      (P.journal ??= []).unshift({ at: new Date(), label, cmd, text, ok, branch: T.branch, root: T.path });
      if (!quiet) result(text);
      paintHead();
      paintAll();
    }
    /* 执行期间照现在的：顶栏多一颗「仓库正在操作」，下面一句话，会动仓库的按钮都点不了 */
    function run(ms, fn) {
      busy = true;
      if (!slot?.classList.contains('git-banner')) setSlot(h('p.git-banner', { role: 'status' }, 'Git 操作正在执行，结果会保存在操作日志中。'));
      paintBusy();
      later(ms, () => { busy = false; paintBusy(); fn(); });
    }
    function paintBusy() {
      for (const btn of [projBtn, treeBtn, fetchBtn, pushBtn, assistBtn]) btn.disabled = busy;
      pullBtn.disabled = busy || !T.up;
      if (busy !== lock.isConnected) ASH.flip(bar, () => (busy ? assistBtn.before(lock) : lock.remove()));
      paintAll();
    }
    /* 换一棵工作树（或换项目，落在它的主仓）：视图不变，上一句结果不带过去 */
    function openTree(next, project = P) {
      P = project;
      T = next;
      setSlot(null);
      C.load();
      paintHead();
      paintBusy();
    }
    /* 重画一块时把键盘焦点留在原处（同一条下标路径上的那个元素） */
    function keepFocus(box, render) {
      const path = [];
      for (let el = box.contains(document.activeElement) ? document.activeElement : null; el && el !== box; el = el.parentElement) path.unshift([...el.parentElement.children].indexOf(el));
      render();
      let el = path.length ? box : null;
      for (const i of path) el = el?.children[Math.min(i, el.children.length - 1)];
      if (el?.matches('button:not([disabled]), input, textarea, [tabindex]')) el.focus({ preventScroll: true });
    }

    /* 主色只给当下该做的那件事（git-1）：能提交 → 提交键（在 git-changes.js）；提交完 → 顶栏的推送；推送被拒时让给提示里的「先拉取」。
       领先、落后的数还是挂在推送、拉取两颗键上（还没有上游的分支没有这两个数） */
    function paintSync() {
      pushBtn.classList.toggle('pri', Boolean(T.ahead) && !C.want() && T.push !== 'failed');
      aheadEl.textContent = String(T.ahead);
      aheadEl.hidden = !T.ahead || !T.up;
      behindEl.textContent = String(T.behind);
      behindEl.hidden = !T.behind || !T.up;
    }
    /* 推送照现在的先问一句；确认框的字是原文。还没有上游的分支是「发布」，要先选远端（在 git-views.js） */
    async function askPush(force) {
      if (busy) return;
      if (!T.up) { more('publish'); return; }
      const yes = await ASH.confirm(force
        ? { title: '保护强推', ok: '保护强推', danger: true, body: `将本地历史推送到 ${T.up}，前提是远端仍停在你看到的 ${ref(T.up).sha}。远端新增提交时 Git 会拒绝覆盖。` }
        : { title: '推送当前分支', ok: '推送当前分支', body: `推送 ${T.branch} 已提交的历史。未提交文件不会被推送。` });
      if (yes && alive && !busy) doPush(force);
    }
    function doPush(force) {
      T.push = 'busy';
      run(1000, () => {
        const ok = !T.remoteAhead && (force === true || !T.behind);
        const cmd = `git push ${force === true ? `--force-with-lease=<upstream>:${ref(T.up).sha}` : 'origin'} HEAD:<upstream>`;
        if (ok) { T.ahead = T.behind = 0; T.push = 'done'; more('hist', 'pushed'); done('推送', cmd, '远端操作已完成'); }
        else { T.push = 'failed'; done('推送', cmd, rawFail(T, P.url), false, true); showFail(); }
        ASH.emit('git:push', { ok });
      });
    }
    /* 远端上那条本地还没有的提交：拉取引用、拉取都会把它取回来，落后数这才知道 */
    const meet = () => { if (T.remoteAhead) { T.remoteAhead = false; T.behind = 1; more('hist', 'fetched'); } };
    /* 拉取要求工作区干净（现在就是这样）。then 是从失败提示里点「先拉取」时接着做的事 */
    function pull(how, then) {
      if (busy || !T.up) return;
      const cmd = `git fetch; git ${how === 'rebase' ? 'rebase' : `merge ${how === 'ff-only' ? '--ff-only' : '--no-edit'}`} @{upstream}`;
      if (count()) { done('拉取', cmd, DIRTY, false); return; }
      run(800, () => {
        meet();
        if (how === 'ff-only' && T.ahead && T.behind) { done('拉取', cmd, 'fatal: Not possible to fast-forward, aborting.', false); return; }
        more('hist', 'pulled', how);   /* 领先、落后由提交图重新数 */
        done('拉取', cmd, '远端操作已完成', true, Boolean(then));
        then?.();
      });
    }
    function fetchRefs(remote) {
      if (busy) return;
      run(600, () => { if (!remote || T.up?.startsWith(`${remote}/`)) meet(); done('获取远端', `git fetch --prune ${remote ?? '--all'}`, '远端操作已完成'); });
    }

    /* ---------- 推送失败（git-2）：一句原因 + 一个动作 +「查看详情」。只说这一次，不再弹提示 ---------- */
    function showFail() {
      let raw = null;
      const text = rawFail(T, P.url);
      const copy = h('button.ico.sm', { type: 'button', 'aria-label': '复制', 'data-tip': '复制', onclick: () => {
        navigator.clipboard?.writeText(text).catch(() => {});
        copy.replaceChildren(icon('check'));
        copy.dataset.tip = '已复制';
        later(1400, () => { copy.replaceChildren(icon('copy')); copy.dataset.tip = '复制'; });
      } }, icon('copy'));
      const body = h('div.git-fail-main', h('b', '推送被拒：'), '远端有你本地没有的提交。');
      const detail = h('button.btn.sm.quiet', { type: 'button', 'aria-expanded': 'false', onclick: () => ASH.flip(root, () => {
        if (raw) { raw.remove(); raw = null; } else { raw = h('div.git-raw.enter', h('pre', { tabindex: '0', 'aria-label': 'git 的原始输出' }, text), copy); body.append(raw); }
        detail.textContent = raw ? '收起' : '查看详情';
        detail.setAttribute('aria-expanded', String(Boolean(raw)));
      }) }, '查看详情');
      setSlot(h('div.note.bad.git-fail', { role: 'alert', 'data-m': 'git-2' }, icon('warn'), body,
        h('div.git-fail-acts', h('button.btn.sm.pri', { type: 'button', onclick: () => pull('merge', doPush) }, '先拉取'), detail)));
      paintSync();
    }

    /* ---------- 装起来 ---------- */
    /* 交给另外三个文件的那一把：看得到当前的项目和工作树，能落结果、能锁住仓库、能换视图 */
    const G = { projects, DIRTY, tree, menu, ref, count, done, run, more, openView, openTree, askPush, fetch: fetchRefs, keepFocus, sync: paintSync, repaint: () => { paintHead(); paintBusy(); },
      get P() { return P; }, get T() { return T; }, get busy() { return busy; }, get alive() { return alive; } };
    const C = ASH.gitChanges(G);
    const paintAll = () => { paintView(); C.paint(); };
    const root = h('div.sv-git', bar, h('div.git-cols', views, C.mid, C.diffEl, pageEl));
    main.append(root);
    C.load();
    paintHead();
    paintAll();

    /* 把进行中的拉取 / 推送停下来，回到一个确定的样子（对照清单直接跳状态时用） */
    const settle = () => {
      for (const t of timers) clearTimeout(t);
      timers.clear();
      busy = false;
      view = 'changes';
      if (T.push === 'busy') T.push = 'idle';
    };
    live = ASH.parts.git = {
      /* 直接看推送失败的提示：没有可推的就先备一次像样的提交，暂存着的当作已经提交 */
      showFail() {
        if (failEl && view === 'changes') return;
        settle();
        if (!T.up) openTree(projects[0].trees[2], projects[0]);
        if (!T.ahead && !D.group(T, 'staged').length) {
          if (!T.files.length) T.files = D.files();
          C.stageAll();
        }
        if (D.group(T, 'staged').length) { if (!T.msg.trim()) { T.msg = D.MSG; C.load(); } C.record(false); }
        Object.assign(T, { remoteAhead: true, push: 'failed' });
        done('推送', 'git push origin HEAD:<upstream>', rawFail(T, P.url), false, true);
        paintBusy();
        showFail();
      },
      /* 直接看干净的工作区 */
      clean() {
        settle();
        Object.assign(T, { files: [], sel: null, ahead: 0, behind: 0, push: 'idle', remoteAhead: false, msg: '' });
        more('hist', 'pushed');
        C.load();
        setSlot(null);
        paintBusy();
      },
      view: (id) => openView(id),
      state: () => ({ view, layout: C.layout(), staged: D.group(T, 'staged').length, unstaged: D.group(T, 'unstaged').length, untracked: D.group(T, 'untracked').length, ahead: T.ahead, behind: T.behind, push: T.push, failed: Boolean(failEl), clean: !count() && !T.ahead }),
    };

    return () => {
      alive = false;
      for (const t of timers) clearTimeout(t);
      timers.clear();
      if (live === ASH.parts.git) live = null;
    };
  }
})();
