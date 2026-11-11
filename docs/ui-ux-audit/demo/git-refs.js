/* Git 工作台 · 分支、贮藏、标签、工作树、操作日志五个视图。地基（确认框、动作、小件、编的数据）在 git-views.js。
   清单没点到这五个视图，结构、名字、次序、菜单项、确认框的原文都照现在的
   （Branches.tsx、RemoteSettings.tsx、Stashes.tsx、References.tsx、OperationLog.tsx、Backups.tsx）。
   抬头右边的「新建…」现在是实心主色；它不是当下该做的那一步，所以这里是普通按钮（git-1）。 */
(() => {
  const { h, icon } = ASH;
  const M = (ASH.gitMore ??= {});
  const s8 = (sha) => sha.slice(0, 8);
  const mini = (label, onclick, more = {}) => h(`button.btn.sm${more.danger ? '.danger' : ''}`, { type: 'button', disabled: more.off, onclick }, label);
  const dots = (G, label, items) => h('button.ico.sm.git-more', { type: 'button', 'aria-label': label, 'aria-haspopup': 'menu', disabled: G.busy,
    onclick: (e) => G.menu(e.currentTarget, items, { place: 'bottom-end' }) }, icon('more'));
  const create = (G, label, onclick) => h('button.btn', { type: 'button', disabled: G.busy, onclick }, icon('plus'), label);
  const subject = (P, sha) => P.commits.find((c) => c.sha === sha)?.subject ?? '';
  const drop = (list, item) => { const i = list.indexOf(item); if (i >= 0) list.splice(i, 1); };
  const remoteField = (P, label) => ({ key: 'remote', type: 'select', label, options: P.remotes.map((r) => ({ value: r.name, label: r.name })) });
  /* 一次提交或一份贮藏里的差异 → 工作区里的一份改动（压缩合并落成暂存的，应用贮藏落成未暂存的） */
  const asWork = (f, st) => ({ ...ASH.gitDiff.mk({ path: f.path, diff: '' }),
    hunks: f.hunks.map((k) => ({ ctx: k.ctx, a0: k.rows.find((r) => r.o != null)?.o ?? 1, rows: k.rows.map((r) => (r.sign === ' ' ? { sign: ' ', t: r.t } : { sign: r.sign, t: r.t, st })) })) });

  /* ---------- 分支 ---------- */
  const MERGE = [['ff', '优先快进，否则创建合并提交'], ['no-ff', '始终创建合并提交'], ['squash', '压缩为暂存改动，稍后手动提交']].map(([value, label]) => ({ value, label }));
  function branchMenu(G, r, tree, active) {
    const { P, T } = G;
    const head = () => G.ref(T.branch);
    const short = r.name.slice(r.name.indexOf('/') + 1);
    const items = [];
    const add = (label, onpick, danger) => items.push({ label, danger, disabled: G.busy, onpick });
    if (!active) {
      if (tree?.task) add('打开任务验收', () => ASH.go('#/task'));
      else add('合入当前分支', () => M.act(G, { label: '合并', cmd: (v) => `git merge ${v.how === 'ff' ? '' : `--${v.how} `}${r.name}`, text: '合并完成', clean: true,
        ask: { title: `合并 ${r.name}`, body: `将 ${r.name}（${s8(r.sha)}）合入当前分支 ${T.branch}。若出现冲突，工作台会保留现场供你处理。原 HEAD 会自动备份。`, fields: [{ key: 'how', type: 'select', label: '合并方式', options: MERGE }] },
        run: (v) => {
          const mine = M.reach(G, head().sha);
          if (mine.has(r.sha)) return;   /* 已经在当前分支里了 */
          M.keep(G);
          if (v.how === 'squash') T.files.push(...P.commits.filter((c) => M.reach(G, r.sha).has(c.sha) && !mine.has(c.sha)).reverse().flatMap((c) => c.files.map((f) => asWork(f, true))));
          else if (v.how === 'ff' && M.reach(G, r.sha).has(head().sha)) head().sha = r.sha;
          else {
            const sha = M.sha();
            P.commits.unshift({ sha, at: new Date(), author: M.me, subject: `Merge branch '${r.name}' into ${T.branch}`, parents: [head().sha, r.sha], files: [] });
            head().sha = sha;
          }
          M.count(G);
        } }));
      add('当前分支变基到这里', () => M.act(G, { label: '变基', cmd: `git rebase ${r.name}`, text: '变基完成', clean: true,
        ask: { title: `变基到 ${r.name}`, danger: true, body: `把当前分支 ${T.branch} 独有的提交重放到 ${r.name}（${s8(r.sha)}）之后。这会改写提交哈希，原 HEAD 会自动备份。` },
        run: () => {
          const base = M.reach(G, r.sha);
          const own = P.commits.filter((c) => M.reach(G, head().sha).has(c.sha) && !base.has(c.sha)).reverse();
          M.keep(G);
          M.onto(G, r.sha, own);
        } }));
    }
    if (r.kind === 'branch') {
      add('设置上游', () => M.act(G, { label: '设置上游', cmd: (v) => `git branch ${v.to ? `--set-upstream-to=${v.to}` : '--unset-upstream'} ${r.name}`,
        ask: { title: '设置上游分支', body: `设置 ${r.name} 的跟踪分支，影响后续拉取和推送。`, fields: [{ key: 'to', type: 'select', label: '远端分支', initial: r.up ?? '',
          options: [{ value: '', label: '取消上游跟踪' }, ...P.refs.filter((x) => x.kind === 'remote' && !x.name.endsWith('/HEAD')).map((x) => ({ value: x.name, label: x.name }))] }] },
        run: (v) => { r.up = v.to || null; if (tree) { tree.up = r.up; M.count(G, tree); } } }));
      /* 任务工作树的分支由任务管着，不给改名（现在就是这样） */
      if (!tree?.task) add('重命名', () => M.act(G, { label: '重命名分支', cmd: (v) => `git branch -m ${r.name} ${v.name.trim()}`, why: (v) => M.taken(G, v.name.trim()),
        ask: { title: '重命名分支', body: `重命名本地分支 ${r.name}。不会重命名远端分支。`, fields: [{ key: 'name', label: '新名称', initial: r.name, required: true }] },
        run: (v) => { if (tree) tree.branch = v.name.trim(); r.name = v.name.trim(); } }));
      if (!tree) {
        const del = (force) => M.act(G, { label: '删除分支', cmd: `git branch ${force ? '-D' : '-d'} ${r.name}`, run: () => drop(P.refs, r),
          why: () => (force || M.reach(G, head().sha).has(r.sha) ? null : `error: the branch '${r.name}' is not fully merged`),
          ask: { title: force ? '强制删除分支' : '删除已合并分支', danger: true,
            body: `删除本地分支 ${r.name}。${force ? '尚未合并的提交将失去此分支引用。请先为需要保留的提交打标签或创建备份分支。' : 'Git 会拒绝删除尚未合并的分支。'}远端分支保持原样。` } });
        add('删除已合并分支', () => del(false), true);
        add('强制删除…', () => del(true), true);
      }
    } else if (!r.name.endsWith('/HEAD')) {
      add('检出为本地分支', () => M.act(G, { label: '新建分支', cmd: (v) => `git switch -c ${v.name.trim()} ${r.name}`, clean: true, why: (v) => M.taken(G, v.name.trim()),
        ask: { title: '检出远端分支', body: `从 ${r.name} 建立本地分支并切换过去，之后可设置上游。`, fields: [{ key: 'name', label: '本地分支名', initial: short, required: true }] },
        run: (v) => { P.refs.push({ kind: 'branch', name: v.name.trim(), sha: r.sha }); M.switchTo(G, v.name.trim()); } }));
      add('删除远端分支…', () => M.act(G, { label: '删除远端引用', cmd: `git push --force-with-lease origin :refs/heads/${short}`, text: '远端配置或引用操作已完成',
        ask: { title: '删除远端分支', danger: true, body: `从 origin 删除服务器上的分支 ${short}。只有远端仍处于 ${s8(r.sha)} 时才会执行，远端新增提交时拒绝删除。此操作影响其他协作者。` },
        run: () => unhook(G, [r]) }), true);
    }
    return items;
  }
  /* 远端分支没了：指着它的上游一并断开 */
  function unhook(G, gone) {
    const names = gone.map((r) => r.name);
    G.P.refs = G.P.refs.filter((r) => !gone.includes(r));
    for (const r of G.P.refs) if (names.includes(r.up)) r.up = null;
    for (const t of G.P.trees) if (names.includes(t.up)) { t.up = null; M.count(G, t); }
  }
  function remotes(G) {
    const { P } = G;
    const text = '远端配置或引用操作已完成';
    return h('section.git-remotes',
      h('header', h('h3', '远端配置'), mini('添加远端', () => M.act(G, { label: '添加远端', text, cmd: (v) => `git remote add ${v.name.trim()} <url>`, run: (v) => P.remotes.push({ name: v.name.trim(), url: v.url.trim() }),
        why: (v) => (P.remotes.some((x) => x.name === v.name.trim()) ? `error: remote ${v.name.trim()} already exists.` : null),
        ask: { title: '添加远端', body: '登记一个远端仓库地址。添加后点击获取，读取它的分支和标签。HTTPS 令牌与 SSH 密钥在项目 Git 设置中配置。',
          fields: [{ key: 'name', label: '远端名称', initial: 'origin', required: true }, { key: 'url', label: '仓库地址', placeholder: 'git@github.com:owner/repo.git', required: true }] } }), { off: G.busy })),
      P.remotes.length ? P.remotes.map((x) => h('div.git-ref', h('span.git-ref-name', h('b', x.name)), h('span.git-ref-last.cut', `获取 / 默认推送：${x.url}`),
        h('div.git-ref-acts', { 'data-stay': '' }, mini('获取', () => G.fetch(x.name), { off: G.busy }),
          mini('修改地址', () => M.act(G, { label: '修改远端地址', text, cmd: `git remote set-url ${x.name} <url>`, run: (v) => { x.url = v.url.trim(); },
            ask: { title: '修改远端地址', body: `修改 ${x.name} 的主要获取地址。已单独配置的推送地址会继续使用。`, fields: [{ key: 'url', label: '新地址', initial: x.url, required: true }] } }), { off: G.busy }),
          mini('移除', () => M.act(G, { label: '移除远端', text, cmd: `git remote remove ${x.name}`, run: () => { drop(P.remotes, x); unhook(G, P.refs.filter((r) => r.kind === 'remote' && r.name.startsWith(`${x.name}/`))); },
            ask: { title: '移除远端配置', danger: true, body: `移除 ${x.name} 的本地配置和跟踪引用。不会删除服务器上的仓库或分支；使用该远端的上游配置也会失效。` } }), { danger: true, off: G.busy }))))
        : h('p.git-quiet', '尚未配置远端，添加后即可获取和发布分支。'));
  }
  M.branches = (G, ui) => {
    const { P, T } = G;
    const head = G.ref(T.branch);
    const treeOf = (name) => P.trees.find((t) => t.branch === name);
    const groupOf = (r) => (r.kind === 'remote' ? 'remote' : treeOf(r.name)?.task ? 'task' : 'local');
    const row = (r) => {
      const tree = r.kind === 'branch' ? treeOf(r.name) : null;
      const active = Boolean(tree) && tree === T;
      return h('div.git-ref', { 'data-on': String(active) },
        h('span.git-ref-name', icon('gitBranch', 'sm'), h('b.cut', r.name), active && h('em.git-cur', '当前')),
        tree?.task && h('button.git-chip.cut', { type: 'button', 'data-kind': 'task', onclick: () => ASH.go('#/task') }, tree.task),
        active && h('span.git-sync.num', h('i', `↑${T.ahead}`), h('i', `↓${T.behind}`)),
        h('span.git-ref-last.cut', h('code', r.sha.slice(0, 7)), ` ${subject(P, r.sha)}`),
        r.up && h('span.git-ref-up.cut', r.up),
        h('div.git-ref-acts',
          r.kind === 'branch' && !active && !tree && mini('切换', () => M.act(G, { label: '切换分支', cmd: `git switch ${r.name}`, clean: true, run: () => M.switchTo(G, r.name),
            ask: { title: `切换到 ${r.name}`, body: `当前工作区将切换到 ${r.name}。切换前要求工作区干净，不会自动贮藏改动。` } }), { off: G.busy }),
          tree && !active && mini('打开工作树', () => G.openTree(tree), { off: G.busy }),
          mini('历史', () => G.openView('history', { ref: r.name })),
          dots(G, `${r.name} 分支操作`, branchMenu(G, r, tree, active))));
    };
    const list = h('div');
    function paintList() {
      const rows = P.refs.filter((r) => r.kind !== 'tag' && r.name.toLowerCase().includes((ui.q ?? '').toLowerCase()));
      list.replaceChildren(...[['local', '本地分支'], ['task', '任务分支'], ['remote', '远端跟踪分支']].map(([id, name]) => {
        const mine = rows.filter((r) => groupOf(r) === id);
        return h('section.git-refs', h('h3.sec', name, h('b', String(mine.length))), mine.length ? mine.map(row) : h('p.git-quiet', '没有符合条件的分支'));
      }));
    }
    const search = h('input.field', { type: 'search', 'aria-label': '搜索分支', placeholder: '搜索分支…', spellcheck: 'false', oninput: () => { ui.q = search.value; paintList(); } });
    search.value = ui.q ?? '';
    paintList();
    return h('div.git-pane', M.head('分支', null, [search, create(G, '新建分支', () => M.act(G, { label: '新建分支', cmd: (v) => `git ${v.go ? 'switch -c' : 'branch'} ${v.name.trim()} ${head.sha}`, why: (v) => M.taken(G, v.name.trim()),
      ask: { title: '新建分支', body: `从当前 HEAD ${s8(head.sha)} 创建本地分支。`, fields: [{ key: 'name', label: '新分支名', placeholder: 'feature/…', required: true }, { key: 'go', type: 'check', label: '创建后切换到此分支' }] },
      run: (v) => { P.refs.push({ kind: 'branch', name: v.name.trim(), sha: head.sha }); if (v.go) M.switchTo(G, v.name.trim()); } }))]),
    list, M.fold(ui, 'remotes', '远端配置', () => remotes(G)));
  };

  /* ---------- 贮藏：一份一张卡，点开看差异。别人的只能应用 ---------- */
  M.stash = (G, ui) => {
    const { P, T } = G;
    const at = (s) => `stash@{${P.stashes.indexOf(s)}}`;
    const use = (s, pop) => M.act(G, { label: pop ? '弹出贮藏' : '应用贮藏', cmd: `git stash ${pop ? 'pop' : 'apply'} ${s.sha}`, clean: true,
      ask: { title: pop ? '弹出贮藏' : '应用贮藏', body: pop ? '应用成功后删除这份贮藏；发生冲突时 Git 会保留原记录。' : `将 ${at(s)} 的改动应用到 ${T.branch}，保留原记录。工作区需要干净。若有冲突，可在工作台解决。` },
      run: () => { T.files.push(...s.files.map((f) => asWork(f, false))); if (pop) drop(P.stashes, s); } });
    const card = (s) => {
      const open = ui.open === s.sha;
      return h('article.git-card', {},
        h('header', {}, h('button.git-card-pick', { type: 'button', 'aria-expanded': String(open), onclick: () => { ui.open = open ? null : s.sha; ui.paint(); } },
          icon('chev', 'sm'), icon('gitStash'), h('code', at(s)), h('span.cut', s.subject)),
        M.chip(s.mine ? '我的贮藏' : '共享 · 仅应用', s.mine ? 'own' : ''), h('time.num', s.at.toLocaleDateString('zh-CN')),
        mini('应用', () => use(s, false), { off: G.busy }), s.mine && mini('弹出', () => use(s, true), { off: G.busy }),
        s.mine && mini('删除', () => M.act(G, { label: '删除贮藏', cmd: `git stash drop ${s.sha}`, run: () => drop(P.stashes, s),
          ask: { title: '删除贮藏', danger: true, body: '删除这份保存的未提交改动。此操作不能从工作台直接撤销。' } }), { danger: true, off: G.busy })),
        open && h('div.git-card-body.enter', {}, M.diff(s.files)));
    };
    return h('div.git-pane', M.head('贮藏', '共享贮藏栈；他人的记录可应用，不能弹出或删除。', create(G, '贮藏改动', () => M.stashSave(G, true))),
      P.stashes.length ? h('section.git-cards', P.stashes.map(card)) : M.none('还没有贮藏记录', '可先把当前改动保存起来'));
  };

  /* ---------- 标签 ---------- */
  M.tags = (G) => {
    const { P, T } = G;
    const head = G.ref(T.branch);
    const far = (r, run) => (P.remotes.length ? run() : G.done('推送标签', `git push origin refs/tags/${r.name}`, '尚未配置远端', false));
    const row = (r) => h('div.git-ref', {}, h('span.git-ref-name', icon('gitTags', 'sm'), h('b.cut', r.name)), h('span.git-ref-last.cut', subject(P, r.sha)), h('code.git-ref-up', s8(r.sha)),
      h('div.git-ref-acts', mini('历史', () => G.openView('history', { ref: r.sha })),
        mini('推送', () => far(r, () => M.act(G, { label: '推送标签', cmd: (v) => `git push ${v.remote} refs/tags/${r.name}`, text: '远端操作已完成',
          ask: { title: '推送标签', body: `将 ${r.name} 发布到选定远端。只推送这一个标签。`, fields: [remoteField(P, '远端')] } })), { off: G.busy }),
        mini('删除', () => M.act(G, { label: '删除标签', cmd: `git tag -d ${r.name}`, run: () => drop(P.refs, r),
          ask: { title: '删除本地标签', danger: true, body: `移除本地标签 ${r.name}，原引用会保留备份，不删除提交或远端标签。` } }), { danger: true, off: G.busy }),
        dots(G, `${r.name} 标签操作`, [{ label: '从 origin 删除远端标签…', danger: true, disabled: G.busy, onpick: () => M.act(G, { label: '删除远端引用', cmd: `git push --force-with-lease origin :refs/tags/${r.name}`, text: '远端配置或引用操作已完成',
          ask: { title: '删除远端标签', danger: true, body: `从 origin 删除服务器上的标签 ${r.name}。仅当远端标签仍指向本地看到的 ${s8(r.sha)} 时执行；影响所有协作者。本地标签继续保留。` } }) }])));
    const tags = P.refs.filter((r) => r.kind === 'tag');
    return h('div.git-pane', M.head('标签', '为值得保留的版本命名，按需发布到远端。', create(G, '新建标签', () => M.tagAt(G, head.sha, { title: '新建标签',
      body: `为当前 HEAD ${s8(head.sha)} 打标签。暂时只创建本地标签，可以随后单独推送。`, fields: [{ key: 'name', label: '标签名', placeholder: 'v1.0.0', required: true }, { key: 'note', type: 'area', label: '附注（留空为轻量标签）' }] }))),
    tags.length ? h('section.git-refs', tags.map(row)) : M.none('还没有标签'));
  };

  /* ---------- 工作树：一棵一张卡。任务的去任务里验收，手动的可以锁、可以移除 ---------- */
  M.worktrees = (G) => {
    const { P, T } = G;
    const head = G.ref(T.branch);
    const card = (t, i) => {
      const manual = i > 0 && !t.task;
      return h('article.git-card.git-wt', { 'data-on': String(t === T) },
        h('header', {}, icon('gitWorktrees'), h('code.cut', t.path), M.chip(i === 0 ? '项目主仓' : t.task ? '任务' : '手动')),
        h('div.git-wt-meta', {}, M.chip(t.branch, 'branch'), t.task && M.chip(t.task, 'task')),
        h('small', {}, `HEAD ${s8(G.ref(t.branch).sha)}`, t.locked && h('b', '已锁定'), t === T && h('b', '正在浏览')),
        h('div.git-wt-acts', {}, mini('打开工作树', () => G.openTree(t), { off: t === T || G.busy }), t.task && mini('任务验收 / 释放工作区', () => ASH.go('#/task')),
          manual && mini(t.locked ? '解锁' : '锁定', () => M.act(G, { label: t.locked ? '解锁工作树' : '锁定工作树', cmd: `git worktree ${t.locked ? 'unlock' : 'lock'} ${t.path}`, run: () => { t.locked = !t.locked; } }), { off: G.busy }),
          manual && mini('移除', () => M.act(G, { label: '移除工作树', cmd: `git worktree remove ${t.path}`,
            why: () => (t.locked ? 'fatal: cannot remove a locked working tree' : t.files.length ? `fatal: '${t.path}' contains modified or untracked files, use --force to delete it` : null),
            ask: { title: '移除手动工作树', danger: true, body: `将移除目录 ${t.path}。Git 会拒绝删除含未提交改动或未跟踪文件的工作树；分支与提交继续保留。` },
            run: () => { drop(P.trees, t); if (t === T) G.openTree(P.trees[0]); } }), { danger: true, off: G.busy })));
    };
    return h('div.git-pane', M.head('工作树', '选择正在操作的目录，区分任务工作树与手动工作树。', create(G, '新建工作树', () => M.act(G, { label: '创建工作树',
      cmd: (v) => `git worktree add -b ${v.name.trim()} <new-directory> ${v.from.trim()}`,
      why: (v) => M.taken(G, v.name.trim()) ?? (G.ref(v.from.trim()) || P.commits.some((c) => c.sha === v.from.trim()) ? null : `fatal: invalid reference: ${v.from.trim()}`),
      ask: { title: '新建手动工作树', body: '从指定基点创建新分支与独立工作目录。ash 自动选择 .worktrees 下的空目录；这份工作树由你管理，不绑定任务。',
        fields: [{ key: 'name', label: '新分支名', required: true }, { key: 'from', label: '起始分支或提交', initial: head.sha, required: true }] },
      run: (v) => {
        const name = v.name.trim();
        P.refs.push({ kind: 'branch', name, sha: G.ref(v.from.trim())?.sha ?? v.from.trim() });
        P.trees.push(G.tree(name, `${P.path}/.worktrees/${name.replace(/\//g, '-')}`, { up: null }));
      } }))),
    h('section.git-cards', P.trees.map(card)));
  };

  /* ---------- 操作日志：仓库锁、一条一行的记录（点开看结果）、历史备份 ---------- */
  M.log = (G, ui) => {
    const { P } = G;
    const list = (P.journal ?? []).slice(0, 200);
    const entry = (e) => h('article.git-entry', {},
      h('header', {}, h('time.num', e.at.toLocaleTimeString('zh-CN', { hour12: false })), M.chip('本机'), h('strong', e.label), h('em.git-state', { 'data-ok': String(e.ok) }, e.ok ? '已完成' : '未完成'), h('code.cut', e.cmd)),
      M.fold(ui, `at${+e.at}`, '查看结果与备份', () => h('div.git-entry-more.enter', {}, h('pre', e.text), h('small', `本机 · ${e.branch || 'HEAD'} · ${e.root}`))));
    const backup = (b) => h('div.git-ref', {}, h('span.git-ref-name', h('b.cut', b.subject || '历史备份')), h('code.git-ref-last.cut', b.ref), h('code.git-ref-up', s8(b.sha)),
      h('div.git-ref-acts', { 'data-stay': '' }, mini('恢复为新分支', () => M.act(G, { label: '新建分支', cmd: (v) => `git branch ${v.name.trim()} ${b.sha}`, why: (v) => M.taken(G, v.name.trim()),
        ask: { title: '从备份找回分支', body: `从 ${s8(b.sha)} 建立新分支，不修改当前工作区。`, fields: [{ key: 'name', label: '恢复分支名', initial: `recovery/${s8(b.sha)}`, required: true }] },
        run: (v) => {
          /* 那条提交要是已经从历史里拿掉了（修订过），放回它父提交的前面 */
          if (b.commit && !P.commits.includes(b.commit)) { const i = P.commits.findIndex((c) => c.sha === b.commit.parents[0]); P.commits.splice(i < 0 ? P.commits.length : i, 0, b.commit); }
          P.refs.push({ kind: 'branch', name: v.name.trim(), sha: b.sha });
        } }), { off: G.busy }),
      mini('删除备份', () => M.act(G, { label: '删除备份', cmd: `git update-ref -d ${b.ref} ${b.sha}`, run: () => drop(P.backups, b),
        ask: { title: '删除备份', danger: true, body: `删除 ${s8(b.sha)} 的这条备份引用。仅由此备份保留的历史之后可能被 Git 回收，届时无法恢复；需要保留请先恢复为新分支。` } }), { danger: true, off: G.busy })));
    return h('div.git-pane',
      h('div.git-lockcard', { role: 'status' }, icon('lock'), h('b', '仓库锁'), h('span', G.busy ? '仓库正在操作；排队中的动作将在锁释放后继续。' : '空闲 · 页面操作与 agent 的 Git 操作在同一条队列上执行。')),
      M.head('操作日志', '最近 200 次工作台操作 · 排队、失败、中止和历史备份都会保留。'),
      list.length ? h('section.git-journal', list.map(entry)) : M.none('还没有通过工作台执行过 Git 操作'),
      M.fold(ui, 'backups', '历史备份与维护', () => h('section.git-refs', {},
        M.head(`历史备份 · ${P.backups.length}`, '全部工作树共享，不受 200 条日志上限影响。备份保留到你主动删除。', mini('清理变基辅助文件', () => M.act(G, { label: '清理变基辅助文件', cmd: '清理已结束变基的工作台辅助文件',
          ask: { title: '清理变基辅助文件', body: '清理已结束变基留下的临时脚本和提交信息。任一工作树仍在变基或无法检查时会保留文件；历史备份不会被删除。' } }), { off: G.busy })),
        P.backups.length ? P.backups.map(backup) : h('p.git-quiet', '没有保留的历史备份'))));
  };
})();
