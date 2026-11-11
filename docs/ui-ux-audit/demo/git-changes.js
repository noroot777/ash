/* Git 工作台 ·「变更」视图（改后）：文件清单（平铺 / 目录树）、提交框、差异和按块按行的暂存。外壳在 git.js，另外六个视图在 git-views.js。
   结构、名字、原文都照现在的（Changes.tsx、ChangeFileList.tsx、DiffView.tsx），变的是清单里的两条：
   git-1 提交键只在「现在能提交」时才是实心主色；git-3 空的分组整组不画，干净时整页只说一句。
   （提交说明随内容长高、没有拖拽角，是会话流那一条里点了名的。）
   对外：ASH.gitDiff = 差异的算法和画法（另外六个视图也用）；ASH.gitChanges(G) → { mid, diffEl, paint(), want(), record(), load(), stageAll() }。 */
(() => {
  const { h, icon } = ASH;
  ASH.icons.gitMinus ??= '<path d="M3.5 8h9"/>';

  const LABEL = { staged: '已暂存', unstaged: '未暂存', untracked: '未跟踪' };
  const HINT = { staged: '将进入下一次提交', unstaged: '工作树里的改动', untracked: '新文件' };
  /* 按行操作时的那段提醒，原文照 DiffView.tsx */
  const GUIDE = {
    staged: '按行取消暂存时，所选 + 行会从暂存区删除，所选 - 行会恢复到暂存区。修改只选 + 行时，原始行不会恢复到暂存区，该删除会留待提交；只选 - 行时，新增内容仍留在暂存区。完整取消这处修改的暂存需同时勾选对应的 - / + 行。工作区文件保持不变。',
    unstaged: '丢弃时，所选＋行会从文件中删除，所选−行会恢复。修改只选＋行时，被替换的原始行不会恢复；只选−行时，新增内容会保留。完整还原修改需同时勾选对应的 − / + 行。',
  };

  /* 编的仓库：路径、分支、地址都是占位。一次像真的提交——回复框长高时会话不再回弹 */
  const FILES = [
    { path: 'web/src/hooks/useStickToBottom.ts', diff: `@@ -18,14 +18,20 @@ export function useStickToBottom(ref, { near = NEAR_BOTTOM } = {}) {
   const stuck = useRef(true);
+  const frame = useRef(0);

   const onScroll = useCallback(() => {
     const el = ref.current;
     if (!el) return;
-    stuck.current = el.scrollHeight - el.scrollTop - el.clientHeight < 4;
+    // 流式输出时内容每帧都在长，4px 的阈值会被一行字顶破，
+    // 误判成「用户往上翻了」
+    const gap = el.scrollHeight - el.scrollTop - el.clientHeight;
+    stuck.current = gap < near;
   }, [ref, near]);

   const toBottom = useCallback(() => {
-    ref.current?.scrollTo({ top: ref.current.scrollHeight });
+    cancelAnimationFrame(frame.current);
+    frame.current = requestAnimationFrame(() => {
+      const el = ref.current;
+      if (el && stuck.current) el.scrollTop = el.scrollHeight;
+    });
   }, [ref]);
@@ -41,3 +47,5 @@ export function useStickToBottom(ref, { near = NEAR_BOTTOM } = {}) {
+  useEffect(() => () => cancelAnimationFrame(frame.current), []);
+
   return { stuck, onScroll, toBottom };
 }` },
    { path: 'web/src/components/reply/ReplyBox.tsx', diff: `@@ -42,11 +42,12 @@ export function ReplyBox({ taskId, feedRef, disabled }: Props) {
   const box = useRef<HTMLTextAreaElement>(null);
-  const { stuck, toBottom } = useStickToBottom(feedRef);
+  const { toBottom } = useStickToBottom(feedRef, { near: 48 });

   useEffect(() => {
-    if (stuck.current) toBottom();
-  }, [draft]);
+    // 输入框长高会把会话往上顶；贴着底的时候跟着走，
+    // 往上翻着的时候不动（判断收进 toBottom 里了）
+    toBottom();
+  }, [draft, toBottom]);

   return (
     <form className="reply-box" onSubmit={send}>` },
    { path: 'web/src/styles/reply.css', diff: `@@ -61,7 +61,7 @@ .reply-box textarea {
   min-height: 44px;
   max-height: 40vh;
-  resize: vertical;
+  resize: none;
   field-sizing: content;
 }
 ` },
    { path: 'web/scripts/test-stick-to-bottom.ts', kind: 'A', diff: `@@ -0,0 +1,14 @@
+import { strict as assert } from "node:assert";
+import { nearBottom } from "../src/hooks/useStickToBottom";
+
+// 流式输出：内容一帧长 22px，仍然算贴底
+assert.equal(nearBottom({ scrollHeight: 1222, scrollTop: 600, clientHeight: 600 }, 48), true);
+
+// 用户往上翻了 200px：不算
+assert.equal(nearBottom({ scrollHeight: 1400, scrollTop: 600, clientHeight: 600 }, 48), false);
+
+// 刚好停在阈值上：不算（严格小于）
+assert.equal(nearBottom({ scrollHeight: 1248, scrollTop: 600, clientHeight: 600 }, 48), false);
+
+console.log("stick-to-bottom ok");
+` },
  ];
  const MSG = '回复框长高时，贴底的会话不再回弹\n\n贴底的判断从 4px 放宽到 48px，滚动合并到下一帧。';

  /* 差异文本 → 文件（改动块、行）。行上的 st 记着这一行改动暂存了没有；块头只留「所在函数」，不印 @@ 区间（现在就是这样） */
  function mk(f, st = true) {
    const cut = f.path.lastIndexOf('/');
    const hunks = [];
    for (const line of f.diff.split('\n')) {
      const m = /^@@ -(\d+)(?:,(\d+))? \+\S+ @@ ?(.*)$/.exec(line);
      if (m) hunks.push({ ctx: m[3], a0: Number(m[1]) + (m[2] === '0' ? 1 : 0), rows: [] });
      else hunks.at(-1)?.rows.push(line[0] === '+' || line[0] === '-' ? { sign: line[0], t: line.slice(1) || ' ', st } : { sign: ' ', t: line.slice(1) || ' ' });
    }
    return { path: f.path, kind: f.kind ?? 'M', name: f.path.slice(cut + 1), dir: f.path.slice(0, cut + 1), hunks };
  }
  const isChange = (r) => r.sign !== ' ';
  const hasSide = (f, st) => f.hunks.some((hk) => hk.rows.some((r) => isChange(r) && r.st === st));

  /* 同一个文件，两边各看到什么：「已暂存」是 HEAD → 暂存区，「未暂存 / 未跟踪」是 暂存区 → 工作区。
     不归这一边的改动：加的行在它前头那一版里要么还没有（略过）要么已经是普通行；删的行反过来。两端多出来的上下文裁回三行 */
  function side(f, src) {
    const staged = src === 'staged';
    const out = { hunks: [], add: 0, del: 0 };
    let ds = 0;
    let du = 0;
    for (const hk of f.hunks) {
      let o = hk.a0 + (staged ? 0 : ds);
      let n = hk.a0 + ds + (staged ? 0 : du);
      const rows = [];
      for (const r of hk.rows) {
        const mine = isChange(r) && r.st === staged;
        if (isChange(r)) { if (r.st) ds += r.sign === '+' ? 1 : -1; else du += r.sign === '+' ? 1 : -1; }
        if (isChange(r) && !mine && (r.sign === '+') === staged) continue;
        const sign = mine ? r.sign : ' ';
        rows.push({ of: r, sign, t: r.t, o: sign === '+' ? null : o++, n: sign === '-' ? null : n++ });
        if (mine) out[sign === '+' ? 'add' : 'del'] += 1;
      }
      const first = rows.findIndex(isChange);
      if (first >= 0) out.hunks.push({ ctx: hk.ctx, rows: rows.slice(Math.max(0, first - 3), rows.findLastIndex(isChange) + 4) });
    }
    return out;
  }

  /* 目录树的摆法（照 lib/fileLayout.ts）：单链目录压成一行，同级先目录后文件 */
  function treeRows(files, folded, key) {
    const root = { path: '', dirs: new Map(), files: [] };
    for (const f of files) {
      let at = root;
      for (const seg of f.dir.split('/').filter(Boolean)) {
        if (!at.dirs.has(seg)) at.dirs.set(seg, { name: seg, path: `${at.path}${seg}/`, dirs: new Map(), files: [] });
        at = at.dirs.get(seg);
      }
      at.files.push(f);
    }
    const byName = (a, b) => a.name.localeCompare(b.name);
    const all = (dir) => [...[...dir.dirs.values()].sort(byName).flatMap(all), ...dir.files.sort(byName)];
    const rows = [];
    (function walk(dir, depth) {
      for (let kid of [...dir.dirs.values()].sort(byName)) {
        let label = kid.name;
        while (!kid.files.length && kid.dirs.size === 1) { [kid] = kid.dirs.values(); label += `/${kid.name}`; }
        const shut = folded.has(key + kid.path);
        rows.push({ dir: kid.path, label, depth, shut, items: all(kid) });
        if (!shut) walk(kid, depth + 1);
      }
      for (const f of dir.files.sort(byName)) rows.push({ file: f, depth });
    })(root, 0);
    return rows;
  }

  const group = (t, src) => t.files.filter((f) => (src === 'staged' ? hasSide(f, true) : hasSide(f, false) && (f.kind === 'A') === (src === 'untracked')));
  const count = (t) => group(t, 'staged').length + group(t, 'unstaged').length + group(t, 'untracked').length;
  const stat = (v) => h('span.git-stat.num', v.add ? h('span.a', `+${v.add}`) : null, v.del ? h('span.d', `−${v.del}`) : null);

  /* 一份差异的各个改动块（块头只写所在函数），行是两列行号、正负号、代码。pick 给了才能按块、按行选——别的视图只看不选 */
  function hunksOf(list, pick) {
    let at = 0;
    return list.map((hk, n) => {
      const changes = hk.rows.filter(isChange).map((r) => r.of);
      const title = hk.ctx ? `⋯ ${hk.ctx}` : '⋯';
      const head = pick
        ? h('button.git-hunk-pick.cut', { type: 'button', 'aria-pressed': 'false', 'aria-label': `选择改动块 ${n + 1}${hk.ctx ? `：${hk.ctx}` : ''}`, onclick: () => pick.toggle(changes) }, title)
        : h('code.cut', title);
      pick?.heads.push([head, changes]);
      return h('section.git-hunk', {}, h('header', {}, head, pick?.acts(changes)), h('div.git-lines', hk.rows.map((r) => {
        at += 1;
        const cls = r.sign === '+' ? '.add' : r.sign === '-' ? '.del' : '';
        const cells = [h('span.n', String(r.o ?? '')), h('span.n', String(r.n ?? '')), h('span.s', r.sign), h('code', r.t)];
        if (!pick || r.sign === ' ') return h(`div.git-line${cls}`, {}, cells);
        const el = h(`button.git-line${cls}`, { type: 'button', 'aria-pressed': 'false', 'aria-label': `选择第 ${at} 行 ${r.sign}${r.t}`, onclick: () => pick.toggle([r.of]) }, cells);
        pick.lines.set(r.of, el);
        return el;
      })));
    });
  }

  ASH.gitDiff = { mk, side, group, count, stat, hunksOf, isChange, MSG, files: () => FILES.map((f) => mk(f)) };

  /* G 是外壳（git.js）交过来的那一把：当前的工作树 G.T、锁没锁 G.busy、落结果 G.done、叫别的视图里的动作 G.more */
  ASH.gitChanges = (G) => {
    const { done, more, ref, keepFocus } = G;
    const groupOf = (src) => group(G.T, src);
    let layout = 'flat';   /* 文件清单：平铺 / 目录树 */

    /* ---------- 文件栏：平铺 / 目录树的切换在最上面；三组照现在的次序，空的组不画（git-3） ---------- */
    const layoutBtn = h('button.ico.sm', { type: 'button', 'data-tip-side': 'left', onclick: () => { layout = layout === 'tree' ? 'flat' : 'tree'; paintFiles(); } });
    const groupsEl = h('div');
    const filesEl = h('section.git-files', { 'aria-label': '工作区变更' }, h('div.git-tools', layoutBtn), groupsEl);
    const act = (label, glyph, onclick, danger) => h(`button.ico.sm${danger ? '.git-danger' : ''}`, { type: 'button', 'aria-label': label, 'data-tip': label.split(' ')[0], disabled: G.busy, onclick }, icon(glyph));
    /* 行上的动作：一个文件，或者目录树里的一整个目录 */
    const rowActs = (list, src, scope) => h('span.git-row-acts', act(`${src === 'staged' ? '取消暂存' : '暂存'} ${scope}`, src === 'staged' ? 'gitMinus' : 'plus', () => stage(list, src)),
      src !== 'staged' && act(`丢弃 ${scope}`, 'trash', () => discard(list, src), true));
    const indent = (depth) => (depth ? `--indent:${depth * 12}px` : null);
    function fileRow(f, src, depth, flat) {
      const st = src === 'untracked' ? 'U' : f.kind;
      return h('li.git-row', { 'data-on': String(G.T.sel?.path === f.path && G.T.sel.src === src), 'data-key': `${src}:${f.path}`, style: indent(depth) },
        h('button.git-file', { type: 'button', 'aria-label': f.path, onclick: () => select(f.path, src) },
          h('span.git-st', { 'data-st': st }, st), h('span.git-name', h('span', f.name), flat && h('i.cut', f.dir))),
        stat(side(f, src)), rowActs([f], src, f.path));
    }
    function dirRow(d, src) {
      const key = `${src}:${d.dir}`;
      const n = d.items.length;
      const sum = d.items.map((f) => side(f, src)).reduce((a, v) => ({ add: a.add + v.add, del: a.del + v.del }), { add: 0, del: 0 });
      return h('li.git-row.git-dir', { 'data-key': key, style: indent(d.depth) },
        h('button.git-file', { type: 'button', 'aria-expanded': String(!d.shut), 'aria-label': `${d.label}（${n} 个文件）`, onclick: () => { if (!G.T.folded.delete(key)) G.T.folded.add(key); paintFiles(); } },
          icon(d.shut ? 'chev' : 'caret', 'sm'), h('span.git-name', h('span', d.label), h('i', `${n} 个文件`))),
        stat(sum), rowActs(d.items, src, `${d.label} 下的 ${n} 个文件`));
    }
    function paintFiles() {
      const had = new Set([...groupsEl.querySelectorAll('[data-key]')].map((el) => el.dataset.key));
      const next = layout === 'tree' ? '按平铺列表展示文件' : '按目录树展示文件';   /* 按钮说的是「按下去会变成什么」 */
      layoutBtn.replaceChildren(icon(layout === 'tree' ? 'list' : 'gitTree'));
      layoutBtn.setAttribute('aria-label', next);
      layoutBtn.dataset.tip = next;
      const groups = ['staged', 'unstaged', 'untracked'].map((src) => [src, groupOf(src)]).filter(([, list]) => list.length);
      keepFocus(groupsEl, () => groupsEl.replaceChildren(...groups.map(([src, list]) => h('section.git-group', {},
        h('header.sec', {}, h('span', LABEL[src]), h('b', String(list.length)), h('i.cut', HINT[src]),
          h('span.git-group-acts', h('button.btn.sm', { type: 'button', disabled: G.busy, onclick: () => stage(list, src) }, icon(src === 'staged' ? 'gitMinus' : 'plus'), src === 'staged' ? '全部取消暂存' : '全部暂存'),
            src === 'unstaged' && h('button.btn.sm', { type: 'button', disabled: G.busy, onclick: () => more('stashSave') }, icon('gitStash'), '贮藏…'))),
        h('ul', layout === 'tree' ? treeRows(list, G.T.folded, `${src}:`).map((r) => (r.file ? fileRow(r.file, src, r.depth) : dirRow(r, src))) : list.map((f) => fileRow(f, src, 0, true)))))));
      if (had.size) for (const li of groupsEl.querySelectorAll('[data-key]')) li.classList.toggle('enter', !had.has(li.dataset.key));
    }
    function select(path, src) {
      G.T.sel = { path, src };
      for (const li of groupsEl.querySelectorAll('.git-row')) li.dataset.on = String(li.dataset.key === `${src}:${path}`);
      paintDiff();
    }
    /* 选中的那一份不在了（暂存走了、提交了、丢弃了）：先跟着同一个文件走，再按 未暂存 → 已暂存 → 未跟踪 找第一份 */
    function fixSel() {
      const order = ['unstaged', 'staged', 'untracked'];
      const at = (src) => groupOf(src).find((f) => f.path === G.T.sel?.path);
      if (G.T.sel && at(G.T.sel.src)) return;
      const src = order.find(at) ?? order.find((s) => groupOf(s).length);
      G.T.sel = src ? { src, path: (at(src) ?? groupOf(src)[0]).path } : null;
    }
    const prune = () => { G.T.files = G.T.files.filter((f) => (f.hunks = f.hunks.filter((hk) => hk.rows.some(isChange))).length); };
    function stage(list, src) {
      if (G.busy || !list.length) return;
      const to = src !== 'staged';
      for (const f of list) for (const hk of f.hunks) for (const r of hk.rows) if (isChange(r)) r.st = to;
      const paths = list.map((f) => f.path).join(' ');
      done(to ? '暂存' : '取消暂存', to ? `git add -A -- ${paths}` : `git restore --staged -- ${paths}`, to ? `已暂存 ${list.length} 个路径` : '已取消暂存，内容保留在工作区');
    }
    /* 按块、按行：只挪选中的那几行 */
    function patch(src, rows) {
      if (G.busy || !rows.length) return;
      for (const r of rows) r.st = src !== 'staged';
      done('部分暂存', `git apply --cached (${rows.length} selected lines)`, src === 'staged' ? '已取消所选改动的暂存' : '已暂存所选改动');
    }
    /* 丢弃回不去：走统一的确认框（现在还要再手打「丢弃」两个字）。rows 给了就只丢这几行，whole = 这几行是一整块 */
    async function discard(list, src, rows, whole) {
      if (G.busy) return;
      const title = rows ? (whole ? '丢弃这个改动块' : '丢弃所选改动') : src === 'untracked' ? '删除未跟踪文件' : '丢弃未暂存改动';
      const body = rows
        ? `${list[0].path}：${whole ? '还原这个改动块内的全部改动。' : `逐行撤销勾选的 ${rows.length} 行差异。${GUIDE.unstaged}`}保留其他未暂存改动及暂存区。未提交内容无法从历史备份找回。`
        : `将处理 ${list.length} 个文件：${list.slice(0, 8).map((f) => f.path).join('、')}。${src === 'untracked' ? '文件将从磁盘删除。' : '工作区内容将恢复到暂存区版本。'}这些未提交内容不在 Git 历史里，不能通过撤销找回。`;
      if (!(await ASH.confirm({ title, ok: title, danger: true, body })) || !G.alive) return;
      const gone = new Set(rows ?? list.flatMap((f) => f.hunks.flatMap((hk) => hk.rows.filter((r) => isChange(r) && !r.st))));
      for (const f of list) for (const hk of f.hunks) hk.rows = hk.rows.flatMap((r) => (!gone.has(r) ? [r] : r.sign === '+' ? [] : [{ sign: ' ', t: r.t }]));
      prune();
      const paths = list.map((f) => f.path).join(' ');
      if (rows) done('丢弃改动块', `git apply (reverse patch, ${rows.length} selected lines in ${paths})`, '已丢弃选定改动，其他工作区改动与暂存区保持不变');
      else done('丢弃改动', src === 'untracked' ? `git clean -f -- ${paths}` : `git restore --worktree -- ${paths}`, '已丢弃指定改动');
    }

    const diffEl = h('section.git-diff', { 'aria-label': '差异' });
    function paintDiff() {
      const sel = G.T.sel;
      const f = sel && G.T.files.find((x) => x.path === sel.path);
      if (!f) {   /* 干净时整页只在这里说一句（git-3） */
        if (!diffEl.querySelector('.git-empty')) diffEl.replaceChildren(h('div.git-empty.enter', h('p.none', { 'data-m': 'git-3' }, '工作区是干净的')));
        return;
      }
      const isStaged = sel.src === 'staged';
      const v = side(f, sel.src);
      const picked = new Set();
      const tipText = h('span');
      const apply = h('button.btn.sm', { type: 'button', onclick: () => patch(sel.src, [...picked]) }, isStaged ? '取消所选暂存' : '暂存所选改动');
      const toss = !isStaged && h('button.btn.sm.danger', { type: 'button', onclick: () => discard([f], sel.src, [...picked]) }, icon('trash'), '丢弃所选改动');
      const clear = h('button.btn.sm', { type: 'button', hidden: true, onclick: () => { picked.clear(); sync(); } }, '清除选择');
      const guide = h('p.git-guide', { role: 'note', hidden: true }, GUIDE[sel.src]);
      const tossBlocks = [];
      /* 新文件只能整份操作，现在也是这样 */
      const pick = f.kind === 'A' ? null : { heads: [], lines: new Map(),
        toggle(rows) { const off = rows.every((r) => picked.has(r)); for (const r of rows) { if (off) picked.delete(r); else picked.add(r); } sync(); },
        acts(rows) {
          const one = !isStaged && h('button.btn.sm.danger', { type: 'button', onclick: () => discard([f], sel.src, rows, true) }, icon('trash'), '丢弃此块');
          if (one) tossBlocks.push(one);
          return h('span.git-hunk-acts', h('button.btn.sm', { type: 'button', disabled: G.busy, onclick: () => patch(sel.src, rows) }, icon(isStaged ? 'gitMinus' : 'plus'), isStaged ? '取消暂存此块' : '暂存此块'), one);
        } };
      function sync() {
        for (const [r, el] of pick.lines) el.setAttribute('aria-pressed', String(picked.has(r)));
        for (const [el, rows] of pick.heads) el.setAttribute('aria-pressed', String(rows.every((r) => picked.has(r))));
        tipText.textContent = `点选具体改动行可${isStaged ? '只操作那几行' : '暂存或丢弃所选内容'} · 已选 ${picked.size} 行`;
        apply.disabled = G.busy || !picked.size;
        if (toss) toss.disabled = G.busy || !picked.size;
        for (const btn of tossBlocks) btn.disabled = G.busy || picked.size > 0;   /* 选了行，就只丢所选的（现在也是） */
        clear.hidden = guide.hidden = !picked.size;
      }
      const key = `${sel.src}:${sel.path}`;
      const was = diffEl.querySelector('.git-diff-body');
      const top = was?.dataset.key === key ? was.scrollTop : 0;
      keepFocus(diffEl, () => diffEl.replaceChildren(...[
        h('header.git-diff-head', {}, h('code.cut', f.path), stat(v), h('span.grow'),
          h('button.btn.sm', { type: 'button', disabled: G.busy, onclick: () => stage([f], sel.src) }, icon(isStaged ? 'gitMinus' : 'plus'), isStaged ? '取消暂存' : '暂存'),
          !isStaged && h('button.btn.sm.danger', { type: 'button', disabled: G.busy, onclick: () => discard([f], sel.src) }, icon('trash'), '丢弃改动')),
        h('div.git-diff-body', { tabindex: '0', 'aria-label': `${f.name} 的差异`, 'data-key': key }, h('div.git-hunks', { 'aria-label': 'Git 差异' }, hunksOf(v.hunks, pick))),
        pick && h('footer.git-diff-foot', {}, guide, h('div.git-diff-tip', {}, icon('spark', 'sm'), tipText, apply, toss, clear)),
      ].filter(Boolean)));
      diffEl.querySelector('.git-diff-body').scrollTop = top;
      if (pick) sync();
    }

    /* ---------- 提交框在文件栏下面：说明（随内容长高）、AI 生成、修补上一次提交、提交键 ---------- */
    const msg = h('textarea.field.git-msg', { 'aria-label': '提交信息', placeholder: '提交信息（第一行是标题）', rows: '3', spellcheck: 'false' });
    const fit = () => { msg.style.height = 'auto'; msg.style.height = `${msg.scrollHeight}px`; };
    msg.addEventListener('input', () => { G.T.msg = msg.value; fit(); paintMain(); });
    const amendBox = h('input', { type: 'checkbox', onchange: () => paintMain() });
    const mainLabel = h('span');
    const mainBtn = h('button.btn.git-main', { type: 'button', onclick: () => commit() }, icon('commit'), mainLabel);
    const genBtn = h('button.btn.sm', { type: 'button', onclick: () => ASH.go('#/new') }, icon('spark'), 'AI 生成');
    const mid = h('div.git-mid', filesEl, h('div.git-commit', { role: 'group', 'aria-label': '提交' }, msg, h('div.git-commit-row', genBtn, h('label.git-amend', amendBox, '修补上一次提交'), mainBtn)));

    /* 主色只给当下该做的那件事（git-1）：现在能提交，提交键才是实心的；外壳据此决定顶栏的「推送」要不要接过主色 */
    const want = () => Boolean(msg.value.trim() && (amendBox.checked || groupOf('staged').length));
    function paintMain() {
      mainBtn.classList.toggle('pri', want());
      mainBtn.disabled = !want() || G.busy;
      genBtn.disabled = amendBox.disabled = G.busy;
      const label = amendBox.checked ? '修订提交' : `提交（${groupOf('staged').length} 个文件）`;
      if (mainLabel.textContent !== label) { if (mainLabel.textContent) ASH.swap(mainLabel, label); else mainLabel.textContent = label; }
      G.sync();
    }
    const paint = () => { fixSel(); paintFiles(); paintDiff(); paintMain(); if (!mid.hidden) fit(); };
    /* 换了一棵工作树：提交说明换成它的那一份 */
    const load = () => { msg.value = G.T.msg; amendBox.checked = false; };
    const stageAll = () => { for (const f of G.T.files) for (const hk of f.hunks) for (const r of hk.rows) if (isChange(r)) r.st = true; };
    /* 把暂存的改动记成一次提交：并进 HEAD——加的行成了普通行，删的行没了，后面各块的起始行跟着挪 */
    function record(amend) {
      const head = ref(G.T.branch);
      const files = groupOf('staged').map((f) => ({ path: f.path, hunks: side(f, 'staged').hunks }));
      const [subject, ...rest] = msg.value.trim().split('\n');
      const was = head.sha;
      head.sha = Math.random().toString(16).slice(2, 10).padEnd(8, '0');
      more('hist', 'commit', { sha: head.sha, was, amend, subject, body: rest.join('\n').trim(), files });
      for (const f of G.T.files) {
        let shift = 0;
        for (const hk of f.hunks) {
          hk.a0 += shift;
          hk.rows = hk.rows.flatMap((r) => { if (!isChange(r) || !r.st) return [r]; shift += r.sign === '+' ? 1 : -1; return r.sign === '+' ? [{ sign: ' ', t: r.t }] : []; });
        }
      }
      prune();
      G.T.msg = msg.value = '';
      amendBox.checked = false;
      fit();
      return files.length;
    }
    async function commit() {
      if (mainBtn.disabled) return;
      const amend = amendBox.checked;
      if (amend && !(await ASH.confirm({ title: '修订最近一次提交', ok: '修订最近一次提交', danger: true, body: `将改写 ${ref(G.T.branch).sha}，包括暂存区内容与提交信息。原提交会保存为备份。已发布的提交改写后通常需要保护强推。` }))) return;
      if (!G.alive) return;
      const n = record(amend);
      done('提交', `git commit ${amend ? '--amend ' : ''}-F -`, amend ? '已修订最近一次提交，原提交已保留备份' : '已提交暂存区内容');
      ASH.emit('git:commit', { files: n });
    }

    return { mid, diffEl, paint, want, record, load, stageAll, layout: () => layout };
  };
})();
