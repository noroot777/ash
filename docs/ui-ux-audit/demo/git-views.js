/* Git 工作台 · 另外六个视图的地基，加上「历史」视图。外壳在 git.js，「变更」在 git-changes.js，分支 / 贮藏 / 标签 / 工作树 / 操作日志在 git-refs.js。
   这六个视图清单里一条都没点到，所以结构、名字、次序、菜单里有哪几项、确认框的原文都照现在的（History.tsx、CommitGraph.tsx、ActionDialog.tsx），
   只跟着全应用的尺子走：下拉是 ASH.select，按钮和输入框用公共件，字不小于 12px，颜色只用令牌。
   对外：ASH.gitMore = { seed(projects)、history(G, ui)、hist(G, evt, data)、checkout / newBranch / stashSave / publish(G)、ask(spec)、act(G, spec)、几样两个文件共用的小件 }。 */
(() => {
  const { h, icon } = ASH;
  const M = (ASH.gitMore ??= {});
  const D = () => ASH.gitDiff;
  const ME = 'zhoulan';
  const MATE = 'linyue';

  /* 编的提交历史：[sha, 几小时前, 作者, 标题, 父提交, [[路径, 差异]]] */
  const HARNESS = [
    ['4c1d9e7a', 2, ME, '回复框：发送后把高度收回一行', ['9be2f0c4'], [['web/src/components/ReplyBox.tsx', `@@ -52,6 +52,8 @@ export function ReplyBox({ onSend, disabled }: Props) {
     if (!text.trim() || disabled) return;
     onSend(text);
     setText('');
+    // 清空以后高度还停在上一条的行数上，要等下一次输入才会收
+    if (box.current) box.current.style.height = 'auto';
   }, [text, disabled, onSend]);

   return (`]]],
    ['a83f02d1', 5, ME, '斜杠补全：输入法组字时回车不选中菜单项', ['1f6b7c90'], [['web/src/composer/useSlashMenu.ts', `@@ -41,6 +41,8 @@ export function useSlashMenu(input: RefObject<HTMLTextAreaElement>) {
   const onKeyDown = useCallback((e: KeyboardEvent) => {
     if (!open) return false;
     if (e.key === 'Enter') {
+      // 输入法还在组字时的回车是「上屏」，不是「选这一项」
+      if (e.isComposing) return false;
       pick(items[active]);
       e.preventDefault();
       return true;`]]],
    ['9be2f0c4', 26, ME, '侧栏宽度写进本地存储，刷新后不丢', ['e07a5d3b'], [['web/src/shell/useSideWidth.ts', `@@ -6,8 +6,12 @@ const MIN = 220;
 const MAX = 420;

 export function useSideWidth() {
-  const [width, setWidth] = useState(280);
+  const [width, setWidth] = useState(() => {
+    const saved = Number(localStorage.getItem(KEY));
+    return saved >= MIN && saved <= MAX ? saved : 280;
+  });
   const drag = useCallback((x: number) => setWidth(clamp(x, MIN, MAX)), []);
+  useEffect(() => localStorage.setItem(KEY, String(width)), [width]);
   return { width, drag };
 }`]]],
    ['1f6b7c90', 30, ME, '斜杠补全：已有正文后面敲 / 也弹', ['e07a5d3b'], [['web/src/composer/slashQuery.ts', `@@ -3,8 +3,10 @@ const NAME = /^[\\w:-]*$/;

 /** 光标前那一段是不是正在敲的技能名；是就返回 / 后面的字 */
 export function slashQuery(text: string, caret: number): string | null {
-  if (!text.startsWith('/')) return null;
-  const name = text.slice(1, caret);
+  const at = text.lastIndexOf('/', caret - 1);
+  // 开头的 /，或者前面是空白的 /；路径里的斜杠不算
+  if (at < 0 || (at > 0 && !/\\s/.test(text[at - 1]))) return null;
+  const name = text.slice(at + 1, caret);
   return NAME.test(name) ? name : null;
 }`]]],
    ['e07a5d3b', 52, ME, '任务头：标题过长时省略，悬停看全文', ['5d2c8e16'], [['web/src/task-detail/TaskTitle.tsx', `@@ -12,7 +12,7 @@ export function TaskTitle({ task }: { task: Task }) {
   return (
     <h1 className="task-title">
       <KindIcon kind={task.kind} />
-      <span>{task.title}</span>
+      <span className="task-title-text" data-tip={task.title}>{task.title}</span>
     </h1>
   );
 }`], ['web/src/styles/task-header.css', `@@ -31,3 +31,10 @@ .task-title {
   gap: 8px;
   min-width: 0;
 }
+
+.task-title-text {
+  min-width: 0;
+  overflow: hidden;
+  text-overflow: ellipsis;
+  white-space: nowrap;
+}`]]],
    ['5d2c8e16', 75, ME, '发布 0.9.2', ['c4419a07'], [['package.json', `@@ -1,6 +1,6 @@
 {
   "name": "harness",
-  "version": "0.9.1",
+  "version": "0.9.2",
   "private": true,
   "type": "module",`]]],
    ['c4419a07', 98, ME, '设置页：切换主题不再闪一下白底', ['70be3f29'], [['web/src/theme/applyTheme.ts', `@@ -9,6 +9,9 @@ export function applyTheme(next: Theme) {
   const root = document.documentElement;
+  // 先关掉过渡再换主题：否则每个带过渡的底色都要从旧值滑到新值，中间那几帧是白的
+  root.classList.add('no-transition');
   root.dataset.theme = next;
+  requestAnimationFrame(() => root.classList.remove('no-transition'));
   localStorage.setItem('theme', next);
 }`]]],
    ['70be3f29', 124, MATE, '文件面板：大文件只取前两百行预览', ['3aa1f6d2'], [['server/src/files/preview.ts', `@@ -14,7 +14,9 @@ export async function readPreview(path: string): Promise<Preview> {
   const stat = await fs.stat(path);
   if (stat.size > MAX_BYTES) return { kind: 'too-large', size: stat.size };
-  const text = await fs.readFile(path, 'utf8');
-  return { kind: 'text', text };
+  const lines = (await fs.readFile(path, 'utf8')).split('\\n');
+  const text = lines.slice(0, PREVIEW_LINES).join('\\n');
+  return { kind: 'text', text, more: Math.max(0, lines.length - PREVIEW_LINES) };
 }`]]],
    ['3aa1f6d2', 170, ME, '发布 0.9.1', ['d18e02aa'], [['package.json', `@@ -1,6 +1,6 @@
 {
   "name": "harness",
-  "version": "0.9.0",
+  "version": "0.9.1",
   "private": true,
   "type": "module",`]]],
    ['d18e02aa', 400, ME, '初始提交', [], [['README.md', `@@ -0,0 +1,3 @@
+# harness
+
+把几个命令行智能体的任务排成队，一个一个跑。`]]],
  ];
  const DOCS = [
    ['2e7c5b19', 20, ME, '补一页：提交前的检查命令怎么写', ['a40c1d77'], [['guide/checks.md', `@@ -0,0 +1,5 @@
+# 提交前的检查命令
+
+在项目设置里填一条命令，每次合并之前都会先跑它。
+
+退出码是 0 才会继续；不是 0 的时候，输出会原样交回给任务。`]]],
    ['a40c1d77', 140, MATE, '初始提交', [], [['README.md', `@@ -0,0 +1,3 @@
+# ash 文档
+
+安装、上手、常见问题。`]]],
  ];
  /* 远端上那条本地还没有的提交：拉取引用之后才看得到 */
  const INCOMING = ['b7e3a902', 1, MATE, '回复框：粘贴图片时不抢焦点', ['4c1d9e7a'], [['web/src/components/PasteZone.tsx', `@@ -22,7 +22,9 @@ export function PasteZone({ onFiles, children }: Props) {
     const files = [...e.clipboardData.files].filter(isImage);
     if (!files.length) return;
     e.preventDefault();
+    const back = document.activeElement as HTMLElement | null;
     onFiles(files);
+    back?.focus({ preventScroll: true });
   };

   return (`]]];
  const STASH = [['web/src/shell/SideResizer.tsx', `@@ -17,6 +17,8 @@ export function SideResizer({ onDrag }: { onDrag: (x: number) => void }) {
   const start = (e: React.PointerEvent) => {
     const move = (ev: PointerEvent) => onDrag(ev.clientX);
+    // 拖的时候别把旁边的字选中
+    document.body.style.userSelect = 'none';
     window.addEventListener('pointermove', move);
     window.addEventListener('pointerup', () => window.removeEventListener('pointermove', move), { once: true });
   };`]];

  const ago = (hours) => new Date(Date.now() - hours * 3600e3);
  const view = (files) => files.map(([path, diff]) => ({ path, ...D().side(D().mk({ path, diff }), 'staged') }));
  const commit = ([sha, hours, author, subject, parents, files]) => ({ sha, at: ago(hours), author, subject, parents, files: view(files) });
  const newSha = () => Math.random().toString(16).slice(2, 10).padEnd(8, '0');

  /* 每个项目补上历史、贮藏、远端、操作日志（只补一次） */
  M.seed = (projects) => {
    for (const P of projects) {
      if (P.commits) continue;
      const main = P.name === 'harness';
      P.commits = (main ? HARNESS : DOCS).map(commit);
      P.remotes = [{ name: 'origin', url: P.url }];
      for (const t of P.trees) { P.refs.find((r) => r.name === t.branch).up = t.up; tally(P, t); }   /* 上游记在分支上，工作树换了分支也不丢 */
      P.backups = [];
      P.stashes = main ? [
        { sha: 'e19d04b7', at: ago(27), mine: true, subject: 'On fix/side-width-memory: 拖到一半的宽度手柄', files: view(STASH) },
        { sha: '6a02c7f3', at: ago(96), mine: false, subject: 'WIP on main: 试一下更窄的状态栏', files: view([HARNESS[6][5][0]]) }] : [];
      const past = (hours, label, cmd, text, ok, t) => ({ at: ago(hours), label, cmd, text, ok, branch: t.branch, root: t.path });
      P.journal = [...(P.journal ?? []), ...(main ? [
        past(2.2, '提交', 'git commit -F -', '已提交暂存区内容', true, P.trees[2]),
        past(3.4, '拉取', 'git fetch; git merge --ff-only @{upstream}', '工作区有未提交或未跟踪的文件，请先提交或贮藏后再操作', false, P.trees[2]),
        past(26.6, '贮藏改动', 'git stash push --include-untracked', '操作已完成', true, P.trees[0]),
        past(27.9, '获取远端', 'git fetch --prune --all', '远端操作已完成', true, P.trees[0])] : [])];
    }
  };

  /* 外壳和「变更」视图那边发生的事，历史跟着记：提交、取回远端、拉取、推送 */
  M.hist = (G, evt, data) => {
    const { P, T } = G;
    const head = G.ref(T.branch);
    const far = T.up && G.ref(T.up);
    if (evt === 'commit') {
      const old = P.commits.find((c) => c.sha === data.was);
      if (data.amend && old) {
        M.keep(G, old);
        if (far?.sha !== old.sha) P.commits.splice(P.commits.indexOf(old), 1);   /* 已经推上去的那条，远端还指着它 */
      }
      P.commits.unshift({ sha: data.sha, at: new Date(), author: ME, subject: data.subject, parents: data.amend && old ? old.parents : [data.was],
        files: data.files.map((f) => ({ path: f.path, hunks: f.hunks, add: f.hunks.flatMap((k) => k.rows).filter((r) => r.sign === '+').length, del: f.hunks.flatMap((k) => k.rows).filter((r) => r.sign === '-').length })) });
    }
    if (evt === 'fetched' && far && !P.commits.some((c) => c.sha === INCOMING[0])) {
      const c = commit(INCOMING);
      c.parents = [far.sha];
      P.commits.splice(P.commits.findIndex((x) => x.sha === far.sha), 0, c);
      far.sha = c.sha;
    }
    if (evt === 'pulled' && far && T.behind) {
      if (!T.ahead) head.sha = far.sha;                      /* 快进 */
      else if (data === 'rebase') {                           /* 变基：本地独有的那几条换了哈希，接到远端后面 */
        const own = [];
        for (let c = P.commits.find((x) => x.sha === head.sha); c && own.length < T.ahead; c = P.commits.find((x) => x.sha === c.parents[0])) own.push(c);
        M.onto(G, far.sha, own.reverse());
      } else {                                                /* 合并：多一条合并提交 */
        const sha = newSha();
        P.commits.unshift({ sha, at: new Date(), author: ME, subject: `Merge remote-tracking branch '${T.up}' into ${T.branch}`, parents: [head.sha, far.sha], files: [] });
        head.sha = sha;
      }
    }
    if (evt === 'pushed' && far) far.sha = head.sha;
    M.count(G);
  };

  /* ---------- 两个文件共用的小件 ---------- */
  const day = (d) => d.toLocaleDateString('zh-CN', { month: 'short', day: 'numeric' });
  /* 一块小牌子。引用名是等宽字：当前分支实心主色、别的分支和远端灰、标签琥珀；任务名青、自己的贮藏淡主色 */
  M.chip = (name, kind) => h('em.git-chip', { 'data-kind': kind || null }, name);
  /* 视图抬头：标题、一句说明（现在有的才写）、右边一颗新建。新建不是「当下该做的那一步」，所以不是实心的（git-1） */
  M.head = (title, hint, btn) => h('header.git-page-head', h('div', h('h2', title), hint && h('p', hint)), btn);
  M.none = (text, sub) => h('div.none', text, sub && h('small', sub));
  /* 一次提交或一份贮藏里的差异：文件不止一个时，各自带一行路径 */
  M.diff = (files) => (files.length
    ? h('div.git-hunks', { 'aria-label': 'Git 差异' }, files.map((f) => [files.length > 1 && h('div.git-file-head', h('code', f.path)), D().hunksOf(f.hunks)]))
    : M.none('没有可显示的文本差异'));
  /* 一颗能收能放的小标题（现在是 details / summary） */
  M.fold = (ui, key, label, body) => {
    const open = Boolean(ui[key]);
    return [h('button.git-fold', { type: 'button', 'aria-expanded': String(open), onclick: () => { ui[key] = !open; ui.paint(); } }, icon('chev', 'sm'), label), open && body()];
  };
  M.sha = newSha;
  M.me = ME;
  /* 改写历史之前，原来的 HEAD 留一份备份（连同那条提交本身，找回时用） */
  M.keep = (G, c = G.P.commits.find((x) => x.sha === G.ref(G.T.branch).sha)) => { if (c) G.P.backups.unshift({ sha: c.sha, ref: `refs/ash/backups/${c.sha}`, subject: c.subject, commit: c }); };
  /* 把一串提交（从早到晚）换个哈希接到 base 后面，当前分支指到最后一条 */
  M.onto = (G, base, list) => {
    G.P.commits = G.P.commits.filter((c) => !list.includes(c));
    G.ref(G.T.branch).sha = list.reduce((to, c) => { const sha = newSha(); G.P.commits.unshift({ ...c, sha, parents: [to] }); return sha; }, base);
    M.count(G);
  };
  /* 从某个提交往回能走到的所有提交；领先、落后就是两边各自独有的条数 */
  const reach = (P, sha, seen = new Set()) => {
    const c = P.commits.find((x) => x.sha === sha);
    if (c && !seen.has(sha)) { seen.add(sha); for (const p of c.parents) reach(P, p, seen); }
    return seen;
  };
  M.reach = (G, sha) => reach(G.P, sha);
  /* 一棵工作树领先、落后各几条：照提交图数出来。还没有上游的分支，领先 = 哪个远端都还没有的提交 */
  const tally = (P, t) => {
    const at = (name) => P.refs.find((r) => r.name === name)?.sha;
    const a = reach(P, at(t.branch));
    const b = new Set((t.up ? [t.up] : P.refs.filter((r) => r.kind === 'remote').map((r) => r.name)).flatMap((name) => [...reach(P, at(name))]));
    Object.assign(t, { ahead: [...a].filter((s) => !b.has(s)).length, behind: t.up ? [...b].filter((s) => !a.has(s)).length : 0 });
  };
  M.count = (G, t = G.T) => tally(G.P, t);

  /* 带输入框的确认框（现在的 ActionDialog）：没有输入框的直接走 ASH.confirm。确认键上写的就是标题（另给了 ok 的除外）。
     note 是输入框下面跟着所填内容变的一句。回 { 字段: 值 }，取消回 null */
  M.ask = ({ title, body, ok = title, danger = false, fields = [], note }) => {
    if (!fields.length) return ASH.confirm({ title, body, ok, danger }).then((yes) => (yes ? {} : null));
    return new Promise((done) => {
      ASH.closePop();
      const back = document.activeElement;
      const v = Object.fromEntries(fields.map((f) => [f.key, f.initial ?? (f.type === 'check' ? false : f.type === 'select' ? f.options[0].value : '')]));
      const yes = h(`button.btn${danger ? '.danger' : '.pri'}`, { type: 'button', onclick: () => close(v) }, ok);
      const noteEl = note && h('p.git-ask-note');
      const no = h('button.btn', { type: 'button', onclick: () => close(null) }, '取消');
      const check = () => { yes.disabled = fields.some((f) => f.required && !String(v[f.key]).trim()); if (noteEl) noteEl.textContent = note(v); };
      const rows = fields.map((f) => {
        if (f.type === 'check') return h('label.git-ask-check', h('input', { type: 'checkbox', checked: v[f.key], onchange: (e) => { v[f.key] = e.target.checked; } }), f.label);
        if (f.type === 'select') return h('div.git-ask-row', h('span', f.label), ASH.select({ value: v[f.key], options: f.options, label: f.label, onchange: (to) => { v[f.key] = to; check(); } }));
        const input = h(f.type === 'area' ? 'textarea.field' : 'input.field', { placeholder: f.placeholder, spellcheck: 'false', rows: f.type === 'area' ? '3' : null,
          oninput: () => { v[f.key] = input.value; check(); },
          onkeydown: (e) => { if (e.key === 'Enter' && f.type !== 'area' && !e.isComposing && !yes.disabled) close(v); } });
        input.value = v[f.key];
        return h('label.git-ask-row', h('span', f.label), input);
      });
      const dlg = h('div.dlg', { role: 'dialog', 'aria-modal': 'true', 'aria-label': title }, h('h2', title), body && h('p', body), h('div.git-ask', rows, noteEl), h('div.dlg-acts', no, yes));
      const veil = h('div.veil.git-ask-veil', dlg);
      const key = (e) => {
        if (document.querySelector('.pop.is-in')) return;   /* 下拉开着：Esc、Tab 先归它 */
        if (e.key === 'Escape') { e.stopPropagation(); close(null); }
        if (e.key !== 'Tab') return;
        const all = [...dlg.querySelectorAll('input, textarea, button:not([disabled])')];
        e.preventDefault();
        all[(all.indexOf(document.activeElement) + (e.shiftKey ? -1 : 1) + all.length) % all.length].focus();
      };
      function close(answer) {
        removeEventListener('keydown', key, true);
        ASH.closePop();
        veil.classList.remove('is-in');
        setTimeout(() => veil.remove(), 130);
        back?.focus?.({ preventScroll: true });
        done(answer);
      }
      veil.addEventListener('pointerdown', (e) => { if (e.target === veil) close(null); });
      addEventListener('keydown', key, true);
      document.body.append(veil);
      requestAnimationFrame(() => veil.classList.add('is-in'));
      check();
      (dlg.querySelector('.field') ?? no).focus();
    });
  };

  /* 一个动作从头到尾：先问（原文的确认框）→ 要求工作区干净的先查 → 仓库锁住跑一会儿 → 改状态 → 落一句结果、记进操作日志。
     cmd、text、why 可以是函数（拿到确认框里填的值）；why 回一句话就是失败，那句话是 git 或工作台的原话 */
  M.act = async (G, { ask, label, cmd, text = '操作已完成', clean = false, why, run }) => {
    if (G.busy) return;
    const v = ask ? await M.ask(ask) : {};
    if (!v || !G.alive || G.busy) return;
    const line = typeof cmd === 'function' ? cmd(v) : cmd;
    const bad = clean && G.count() ? G.DIRTY : why?.(v);
    if (bad) { G.done(label, line, bad, false); return; }
    G.run(500, () => { run?.(v); G.done(label, line, typeof text === 'function' ? text(v) : text); });
  };
  const taken = M.taken = (G, name) => (G.ref(name) ? `fatal: a branch named '${name}' already exists` : null);

  /* ---------- 顶栏分支菜单里的两件事、「变更」里的贮藏、还没有上游时的「发布」 ---------- */
  M.switchTo = (G, name) => {
    const { T } = G;
    Object.assign(T, { branch: name, up: G.ref(name).up ?? null, remoteAhead: false, push: 'idle' });
    M.count(G);
  };
  M.checkout = (G, name) => M.act(G, { label: '切换分支', cmd: `git switch ${name}`, clean: true, run: () => M.switchTo(G, name),
    ask: { title: `切换到 ${name}`, body: '切换前要求工作区干净；未提交的改动可先贮藏。' } });
  M.newBranch = (G) => M.act(G, { label: '新建分支', cmd: (v) => `git branch ${v.name} ${G.ref(G.T.branch).sha}`, why: (v) => taken(G, v.name),
    run: (v) => G.P.refs.push({ kind: 'branch', name: v.name.trim(), sha: G.ref(G.T.branch).sha }),
    ask: { title: '新建分支', body: '从当前提交创建本地分支。', fields: [{ key: 'name', label: '分支名', required: true }] } });
  /* 贮藏：把还没提交的改动整份收走，记成共享贮藏栈最上面的一条 */
  M.stashSave = (G, fromView) => M.act(G, { label: '贮藏改动', cmd: (v) => `git stash push${v.all ? ' --include-untracked' : ''}`,
    why: (v) => (G.T.files.length > (v.all ? 0 : D().group(G.T, 'untracked').length) ? null : '没有可贮藏的改动'),
    run: (v) => {
      const loose = v.all ? [] : D().group(G.T, 'untracked');   /* 没勾「包含未跟踪文件」：还没暂存过的新文件留在原地 */
      const gone = G.T.files.filter((f) => !loose.includes(f));
      G.P.stashes.unshift({ sha: newSha(), at: new Date(), mine: true, subject: `On ${G.T.branch}: ${v.note.trim() || '未命名'}`,
        files: gone.map((f) => { const s = D().mk({ path: f.path, diff: '' }); s.hunks = f.hunks.map((k) => ({ ...k, rows: k.rows.map((r) => ({ ...r, st: true })) })); return { path: f.path, ...D().side(s, 'staged') }; }) });
      G.T.files = G.T.files.filter((f) => !gone.includes(f));
      G.T.sel = null;
    },
    ask: fromView
      ? { title: '贮藏当前改动', body: '将当前暂存区与工作区的改动保存到共享贮藏栈。该记录标记为当前用户所有，之后可以应用或弹出。',
        fields: [{ key: 'note', label: '说明', placeholder: '例如：切换任务前保存' }, { key: 'all', type: 'check', label: '同时包含未跟踪文件' }] }
      : { title: '贮藏改动', body: '保存当前未提交改动，稍后可以在贮藏页恢复。', fields: [{ key: 'note', label: '说明', required: true }, { key: 'all', type: 'check', label: '包含未跟踪文件', initial: true }] } });
  M.publish = (G) => M.act(G, { label: '推送', cmd: (v) => `git push ${v.remote} HEAD:<upstream>`, text: '远端操作已完成',
    why: () => (G.P.remotes.length ? null : '尚未配置远端'),
    run: (v) => { G.T.up = G.ref(G.T.branch).up = `${v.remote}/${G.T.branch}`; G.P.refs.push({ kind: 'remote', name: G.T.up, sha: G.ref(G.T.branch).sha }); Object.assign(G.T, { ahead: 0, behind: 0, push: 'done' }); },
    ask: { title: '发布当前分支', body: `推送 ${G.T.branch} 已提交的历史。未提交文件不会被推送。`,
      fields: [{ key: 'remote', type: 'select', label: '发布到远端', options: (G.P.remotes.length ? G.P.remotes : [{ name: 'origin' }]).map((r) => ({ value: r.name, label: r.name })) }] } });

  /* ---------- 历史：左边提交图和列表，右边是选中那条的详情（History.tsx、CommitGraph.tsx） ---------- */
  const LANES = ['accent', 'green', 'amber', 'violet', 'cyan', 'red'];
  const lane = (i) => `var(--${LANES[i % LANES.length]})`;
  /* 提交图的排法照原样：每条提交占一列，父提交接着占；一行里画经过的竖线、到各个父提交的弯线、自己的圆点 */
  function graph(commits) {
    const lanes = [];
    let width = 1;
    const rows = commits.map((c) => {
      let column = lanes.indexOf(c.sha);
      if (column < 0) { column = lanes.indexOf(null); if (column < 0) column = lanes.length; lanes[column] = c.sha; }
      const before = [...lanes];
      lanes[column] = null;
      const parents = c.parents.map((p, i) => {
        let to = lanes.indexOf(p);
        if (to < 0) { to = i === 0 && lanes[column] === null ? column : lanes.indexOf(null); if (to < 0) to = lanes.length; lanes[to] = p; }
        return to;
      });
      width = Math.max(width, lanes.length);
      return { column, before, parents };
    });
    return { rows, width: width * 15 + 18 };
  }
  function graphRow(row, width) {
    const x = (c) => 12 + c * 15;
    const line = (d, c) => `<path d="${d}" style="stroke:${lane(c)}"/>`;
    return h('span.git-graph', { 'aria-hidden': 'true', html: `<svg width="${width}" height="34">${row.before.map((sha, c) => (sha && c !== row.column ? line(`M ${x(c)} 0 V 34`, c) : '')).join('')}${line(`M ${x(row.column)} 0 V 17`, row.column)}${row.parents.map((to) => line(`M ${x(row.column)} 17 C ${x(row.column)} 27 ${x(to)} 24 ${x(to)} 34`, to)).join('')}<circle cx="${x(row.column)}" cy="17" r="3" style="fill:${lane(row.column)}"/></svg>` });
  }

  /* 提交菜单里的六件事。确认框的字是原文；会动当前分支的三件都要求工作区干净 */
  const RESET = [['soft', 'soft · 保留暂存'], ['mixed', 'mixed · 保留文件，取消暂存'], ['hard', 'hard · 同时重置文件']].map(([value, label]) => ({ value, label }));
  const PLAN = [['pick', 'pick · 保留'], ['reword', 'reword · 改信息'], ['squash', 'squash · 合并'], ['fixup', 'fixup · 并入前条'], ['drop', 'drop · 丢弃']].map(([value, label]) => ({ value, label }));
  const flip = (files) => files.map((f) => ({ ...f, add: f.del, del: f.add, hunks: f.hunks.map((k) => ({ ...k, rows: k.rows.map((r) => ({ ...r, sign: r.sign === '+' ? '-' : r.sign === '-' ? '+' : ' ' })) })) }));
  /* 在当前分支顶上落一条新提交 */
  const land = (G, subject, files) => {
    const head = G.ref(G.T.branch);
    const sha = newSha();
    G.P.commits.unshift({ sha, at: new Date(), author: ME, subject, parents: [head.sha], files });
    head.sha = sha;
    M.count(G);
  };
  M.tagAt = (G, sha, ask) => M.act(G, { label: '新建标签', cmd: (v) => `git tag ${v.note.trim() ? '-a ' : ''}${v.name} ${sha}`, ask,
    why: (v) => (G.ref(v.name.trim()) ? `fatal: tag '${v.name.trim()}' already exists` : null), run: (v) => G.P.refs.push({ kind: 'tag', name: v.name.trim(), sha }) });
  function commitMenu(G, c) {
    const s8 = c.sha.slice(0, 8);
    const about = `${s8} · ${c.subject}`;
    return [
      { label: '拣选（cherry-pick）', disabled: G.busy, onpick: () => M.act(G, { label: '拣选', cmd: `git cherry-pick ${c.sha}`, text: '提交操作已完成', clean: true, run: () => land(G, c.subject, c.files),
        ask: { title: '拣选提交到当前分支', body: `${about}。把这次改动复制为当前分支的新提交。若遇冲突，可在工作台解决。` } }) },
      { label: '反做（revert）', disabled: G.busy, onpick: () => M.act(G, { label: '反做', cmd: `git revert ${c.sha}`, text: '提交操作已完成', clean: true, run: () => land(G, `Revert "${c.subject}"`, flip(c.files)),
        ask: { title: '反做此提交', danger: true, body: `${about}。生成一个反向提交，保留原历史。若遇冲突，可在工作台解决。` } }) },
      { label: '从这里建分支', disabled: G.busy, onpick: () => M.act(G, { label: '新建分支', cmd: (v) => `git branch ${v.name} ${c.sha}`, why: (v) => taken(G, v.name.trim()), run: (v) => G.P.refs.push({ kind: 'branch', name: v.name.trim(), sha: c.sha }),
        ask: { title: '从提交新建分支', body: about, fields: [{ key: 'name', label: '分支名', required: true }] } }) },
      { label: '打标签', disabled: G.busy, onpick: () => M.tagAt(G, c.sha, { title: '为提交打标签', body: about, fields: [{ key: 'name', label: '标签名', required: true }, { key: 'note', type: 'area', label: '附注（留空创建轻量标签）' }] }) },
      { label: '重置到这里…', danger: true, disabled: G.busy, onpick: () => M.act(G, { label: '重置', cmd: (v) => `git reset --${v.mode} ${c.sha}`, clean: true, text: (v) => `已执行 ${v.mode} 重置，原 HEAD 已保留备份`,
        ask: { title: '重置当前分支', danger: true, body: `将当前分支移到 ${s8}。soft 保留索引和工作区；mixed 取消暂存但保留工作区；hard 同时恢复工作区。操作要求工作区干净，执行前备份原 HEAD。`, fields: [{ key: 'mode', type: 'select', label: '重置方式', options: RESET, initial: 'mixed' }] },
        run: () => { M.keep(G); G.ref(G.T.branch).sha = c.sha; M.count(G); } }) },
      { label: '编辑此提交之后的历史…', disabled: G.busy, onpick: () => {
        /* 基点之后、当前分支上的提交，从早到晚 */
        const base = reach(G.P, c.sha);
        const own = G.P.commits.filter((x) => reach(G.P, G.ref(G.T.branch).sha).has(x.sha) && !base.has(x.sha)).reverse();
        const cmd = `git rebase -i ${c.sha}`;
        if (!own.length) { G.done('交互式变基', cmd, '基点之后没有可编辑的提交', false); return; }
        M.act(G, { label: '交互式变基', cmd, text: '交互式变基完成', clean: true,
          ask: { title: '交互式变基', ok: '执行变基计划', body: `基点 ${s8} · 从上到下重放提交。可以排序、改写信息、合并或丢弃。执行前保存原 HEAD；发生冲突时可继续或中止。已发布历史改写后需要保护强推。`,
            fields: own.map((x) => ({ key: x.sha, type: 'select', label: `${x.sha.slice(0, 7)} ${x.subject}`, options: PLAN })),
            note: (v) => `结果预计 ${own.filter((x, i) => v[x.sha] === 'pick' || v[x.sha] === 'reword' || (i === 0 && v[x.sha] !== 'drop')).length} 个提交 · squash 合并提交信息，fixup 使用前一条的信息` },
          run: (v) => {
            M.keep(G);
            const kept = [];
            for (const x of own) {
              if (v[x.sha] === 'drop') continue;
              if ((v[x.sha] === 'squash' || v[x.sha] === 'fixup') && kept.length) kept.at(-1).files.push(...x.files); else kept.push({ ...x, files: [...x.files] });
            }
            G.P.commits = G.P.commits.filter((x) => !own.includes(x));
            M.onto(G, c.sha, kept);
          } });
      } },
    ];
  }

  M.history = (G, ui) => {
    const { P, T } = G;
    const head = G.ref(T.branch);
    ui.ref ??= '';
    /* 范围：全部分支 / 当前分支 / 某条分支或远端分支 / 从别处带过来的某条提交 */
    const tip = ui.ref === 'HEAD' ? head.sha : G.ref(ui.ref)?.sha ?? ui.ref;
    const inRange = ui.ref ? reach(P, tip) : null;
    const touches = (c) => !ui.path || c.files.some((f) => f.path.startsWith(ui.path));
    const commits = P.commits.filter((c) => (!inRange || inRange.has(c.sha)) && touches(c));
    const g = graph(commits);
    const chips = (c) => P.refs.filter((r) => r.sha === c.sha).sort((a, b) => (b.name === T.branch) - (a.name === T.branch)).map((r) =>
      M.chip(r.name, r.name === T.branch ? 'head' : r.kind === 'tag' ? 'tag' : r.kind === 'remote' ? 'remote' : 'branch'));
    const text = (c) => `${c.subject} ${c.author} ${c.sha} ${P.refs.filter((r) => r.sha === c.sha).map((r) => r.name).join(' ')}`.toLowerCase();

    const rowsEl = h('div.git-ci-rows');
    const detail = h('section.git-detail', { 'aria-label': '提交详情' });
    function paintRows() {
      const shown = commits.map((c, i) => [c, i]).filter(([c]) => !ui.q || text(c).includes(ui.q.toLowerCase()));
      if (!shown.some(([c]) => c.sha === ui.sel)) ui.sel = shown[0]?.[0].sha ?? null;
      G.keepFocus(rowsEl, () => rowsEl.replaceChildren(...(shown.length ? shown.map(([c, i]) => h('div.git-ci', { 'data-on': String(c.sha === ui.sel) },
        h('button.git-ci-pick', { type: 'button', 'aria-label': `${c.subject} ${c.sha}`, onclick: () => { ui.sel = c.sha; paintRows(); } },
          graphRow(g.rows[i], g.width), h('code', c.sha.slice(0, 7)), h('span.git-ci-main', chips(c), h('span.cut', c.subject)), h('span.git-ci-who.cut', c.author), h('time', day(c.at))),
        h('button.ico.sm.git-more', { type: 'button', 'aria-label': `${c.sha} 提交操作`, 'aria-haspopup': 'menu', onclick: (e) => G.menu(e.currentTarget, commitMenu(G, c), { place: 'bottom-end' }) }, icon('more'))))
        : [M.none('没有符合条件的提交')])));
      const c = commits.find((x) => x.sha === ui.sel);
      detail.replaceChildren(...(c ? [
        h('header.git-detail-head', h('code.git-sha', c.sha), h('strong.cut', c.subject),
          h('div.git-detail-meta', h('span', c.author), h('time', c.at.toLocaleString('zh-CN', { hour12: false })), h('span', `${c.parents.length} 个父提交`)),
          h('button.ico.sm', { type: 'button', 'aria-label': '提交操作', 'aria-haspopup': 'menu', onclick: (e) => G.menu(e.currentTarget, commitMenu(G, c), { place: 'bottom-end' }) }, icon('more'))),
        h('div.git-diff-body', { tabindex: '0', 'aria-label': `${c.sha} 的差异` }, M.diff(c.files.filter((f) => !ui.path || f.path.startsWith(ui.path)))),
      ] : [h('header.git-detail-head', h('strong', '提交详情'))]));
    }

    const search = h('input.field.grow', { type: 'search', 'aria-label': '搜索提交', placeholder: '搜索提交 / 作者 / SHA…', spellcheck: 'false', oninput: () => { ui.q = search.value; paintRows(); } });
    search.value = ui.q ?? '';
    const range = ASH.select({ value: ui.ref, label: '历史范围', width: 150, onchange: (to) => { ui.ref = to; ui.paint(); },
      options: [{ value: '', label: '全部分支' }, { value: 'HEAD', label: '当前分支' }, ...(/^[0-9a-f]{7,40}$/.test(ui.ref) ? [{ value: ui.ref, label: `提交 ${ui.ref.slice(0, 8)} 及更早` }] : []),
        ...P.refs.filter((r) => r.kind !== 'tag').map((r) => ({ value: r.name, label: r.name }))] });
    const pathIn = h('input.field.grow', { 'aria-label': '文件历史路径', placeholder: '按文件路径查看历史…', spellcheck: 'false' });
    pathIn.value = ui.path ?? '';
    const setPath = (to) => { ui.path = to.trim(); ui.paint(); };
    const box = h('div.git-hist',
      h('section.git-hist-list', { 'aria-label': '提交历史' },
        h('div.git-hist-bar', h('div', search, range),
          M.fold(ui, 'file', '文件历史与逐行归属', () => h('form', { onsubmit: (e) => { e.preventDefault(); setPath(pathIn.value); } }, pathIn,
            h('button.btn.sm', { type: 'submit' }, '查看文件历史'), ui.path && h('button.btn.sm', { type: 'button', onclick: () => setPath('') }, '清除')))),
        rowsEl),
      detail);
    paintRows();
    return box;
  };
})();
