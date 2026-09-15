/* Git 工作台 demo · mock 数据种子。
   自指故事：仓库就是 harness 自己，工作区里的改动是「正在给 ash 做 Git 工作台」。
   所有数据只活在内存里，刷新页面即重置。 */
window.GW = window.GW || {};

(function () {
  const now = Date.now();
  const min = 60 * 1000, hour = 60 * min, day = 24 * hour;

  /* ---------- 提交图 ----------
     parents 数组第一项是 first-parent。时间只用于排序展示。 */
  const commits = [
    { sha: "3f8a21c", parents: ["9c01eba"], msg: "feat(web): 变更视图支持行级暂存", author: "fjh", time: now - 35 * min,
      files: [{ path: "web/src/scm/ScmChangeGroup.tsx", kind: "M", add: 46, del: 8 }, { path: "web/src/styles/scm.css", kind: "M", add: 22, del: 3 }] },
    { sha: "9c01eba", parents: ["136b2c9"], msg: "feat(mobile): 已验收但「合并后不提交」的任务多一张「待提交」牌", author: "fjh", time: now - 3 * hour,
      files: [{ path: "mobile/app/task/[id].tsx", kind: "M", add: 38, del: 5 }] },
    { sha: "136b2c9", parents: ["92bc159", "b5b7690"], msg: "Merge branch 'ash/kW9xTb2v'", author: "ash 验收", time: now - 5 * hour, files: [] },
    { sha: "92bc159", parents: ["31f70c4"], msg: "feat(accept): 「合并后不提交」那一档的收尾", author: "claude", time: now - 6 * hour,
      files: [{ path: "server/task-accept-finalize.ts", kind: "M", add: 64, del: 12 }, { path: "web/src/task-detail/AcceptCard.tsx", kind: "M", add: 31, del: 9 }] },
    { sha: "b5b7690", parents: ["31f70c4"], msg: "style(web): 选文浮条两颗按钮合成一条，整体缩小一圈", author: "claude", time: now - 7 * hour,
      files: [{ path: "web/src/page-annotation/SelectionBar.tsx", kind: "M", add: 18, del: 27 }] },
    { sha: "31f70c4", parents: ["e02d114"], msg: "fix(server): 验收合并前重读工作区状态", author: "claude", time: now - 9 * hour,
      files: [{ path: "server/task-accept-preflight.ts", kind: "M", add: 12, del: 4 }] },
    { sha: "e02d114", parents: ["7ac31f9", "d441c02"], msg: "Merge branch 'ash/eFWYDdx6'", author: "ash 验收", time: now - 1 * day, files: [] },
    { sha: "7ac31f9", parents: ["55d902e"], msg: "chore: 提交锁审计日志", author: "fjh", time: now - 1 * day - 2 * hour,
      files: [{ path: "server/repo-lock.ts", kind: "M", add: 21, del: 2 }] },
    { sha: "d441c02", parents: ["55d902e"], msg: "feat(web): 派审面板记住上次的审查档位", author: "codex", time: now - 1 * day - 3 * hour,
      files: [{ path: "web/src/review/ReviewPanel.tsx", kind: "M", add: 27, del: 6 }] },
    { sha: "55d902e", parents: ["c9a8b31"], msg: "fix(mobile): 会话页下拉刷新丢滚动位置", author: "claude", time: now - 2 * day,
      files: [{ path: "mobile/app/session.tsx", kind: "M", add: 9, del: 3 }] },
    { sha: "c9a8b31", parents: ["8f2e6a0"], msg: "feat(server): 终端会话 GBK 编解码", author: "claude", time: now - 2 * day - 4 * hour,
      files: [{ path: "server/terminal.ts", kind: "M", add: 44, del: 10 }] },
    { sha: "8f2e6a0", parents: ["2b90dd4"], msg: "docs: 事故记录补充 CUA 旁路会话", author: "fjh", time: now - 3 * day,
      files: [{ path: "docs/incidents.md", kind: "M", add: 35, del: 0 }] },
    { sha: "2b90dd4", parents: ["ab17e55"], msg: "feat(web): 工作流站点执行器跟随任务", author: "claude", time: now - 3 * day - 5 * hour,
      files: [{ path: "web/src/workflow/StepEditors.tsx", kind: "M", add: 52, del: 17 }] },
    { sha: "ab17e55", parents: ["f60c2d8"], msg: "fix(server): duet 合稿轮丢失引用", author: "codex", time: now - 4 * day,
      files: [{ path: "server/duet/merge.ts", kind: "M", add: 15, del: 8 }] },
    { sha: "f60c2d8", parents: ["0d3a9e1"], msg: "feat: 团队预设支持共享执行者", author: "claude", time: now - 5 * day,
      files: [{ path: "server/team-presets.ts", kind: "M", add: 71, del: 22 }] },
    { sha: "0d3a9e1", parents: ["77b40cc"], msg: "refactor(web): 工作区外壳抽离 openComposer", author: "claude", time: now - 6 * day,
      files: [{ path: "web/src/workspace/WorkspaceShell.tsx", kind: "M", add: 88, del: 61 }] },
    { sha: "77b40cc", parents: [], msg: "chore: v0.9 起点", author: "fjh", time: now - 8 * day, files: [] },
  ];

  /* 侧线分支的提交 */
  const sideCommits = [
    // feature/conflict-demo：从 9c01eba 分叉，改了与 main 后续提交相同的文件 → 合并必冲突
    { sha: "aa10f3e", parents: ["9c01eba"], msg: "feat(scm): 变更分组改为可折叠的小节", author: "codex", time: now - 100 * min,
      files: [{ path: "web/src/scm/ScmChangeGroup.tsx", kind: "M", add: 30, del: 12 }] },
    { sha: "aa2c881", parents: ["aa10f3e"], msg: "style(scm): 角标配色跟随冲突态", author: "codex", time: now - 80 * min,
      files: [{ path: "web/src/styles/scm.css", kind: "M", add: 14, del: 6 }, { path: "shared/scm-types.ts", kind: "M", add: 6, del: 2 }] },
    // fix/scrollbar-hover：从 3f8a21c 分叉 → 可快进合并
    { sha: "bb31d90", parents: ["3f8a21c"], msg: "fix(web): 滚动条 hover 显形在嵌套滚动区失效", author: "claude", time: now - 20 * min,
      files: [{ path: "web/src/styles/global.css", kind: "M", add: 7, del: 2 }] },
    // ash/pFq2LmXc：进行中任务分支，从 136b2c9 分叉
    { sha: "cc90ab2", parents: ["136b2c9"], msg: "feat(server): git 工作台读接口骨架", author: "claude", time: now - 4 * hour,
      files: [{ path: "server/git-workbench-routes.ts", kind: "A", add: 120, del: 0 }] },
    { sha: "cc91be7", parents: ["cc90ab2"], msg: "feat(server): 分支列表与 ahead/behind", author: "claude", time: now - 2 * hour,
      files: [{ path: "server/git-workbench-routes.ts", kind: "M", add: 58, del: 4 }] },
  ];

  /* fetch 剧本解锁的远端新提交（挂在 origin/main 上，本地看不见直到 fetch） */
  const remotePending = [
    { sha: "ee77a02", parents: ["9c01eba"], msg: "fix(server): usage 统计漏算 cache 命中", author: "codex", time: now - 50 * min,
      files: [{ path: "server/usage.ts", kind: "M", add: 11, del: 3 }] },
    { sha: "ee78c44", parents: ["ee77a02"], msg: "chore: 依赖例行升级", author: "fjh", time: now - 40 * min,
      files: [{ path: "package-lock.json", kind: "M", add: 210, del: 190 }] },
  ];

  /* ---------- 工作区改动 ----------
     hunk.loc 决定这一块此刻在暂存区还是工作树；同一文件两处都有 = 部分暂存。 */
  const workingFiles = [
    {
      path: "web/src/scm/ScmInspector.tsx", kind: "M",
      hunks: [
        { loc: "staged", header: "@@ -18,6 +18,9 @@ export function ScmInspector({ taskId }: Props) {", lines: [
          { t: "ctx", s: "  const model = useScmWorkspace(taskId);" },
          { t: "ctx", s: "  const [diffTarget, setDiffTarget] = useState<ScmDiffTarget | null>(null);" },
          { t: "add", s: "  // 工作台入口：从任务面板跳到项目级 Git 工作台，带上当前分支。" },
          { t: "add", s: "  const openWorkbench = useOpenWorkbench(model.overview?.status.branch);" },
          { t: "add", s: "" },
          { t: "ctx", s: "  const status = model.overview?.status ?? null;" },
        ] },
        { loc: "unstaged", header: "@@ -64,7 +67,12 @@ export function ScmInspector({ taskId }: Props) {", lines: [
          { t: "ctx", s: "      <header className=\"scm-head\">" },
          { t: "del", s: "        <span className=\"scm-title\">源代码管理</span>" },
          { t: "add", s: "        <button className=\"scm-title scm-title-link\" onClick={openWorkbench}>" },
          { t: "add", s: "          源代码管理" },
          { t: "add", s: "          <ArrowUpRight size={12} />" },
          { t: "add", s: "        </button>" },
          { t: "ctx", s: "        <ScmSyncBadge status={status} />" },
        ] },
      ],
    },
    {
      path: "server/scm-routes.ts", kind: "M",
      hunks: [
        { loc: "unstaged", header: "@@ -102,6 +102,14 @@ export function registerScmRoutes(app: App) {", lines: [
          { t: "ctx", s: "  app.post(\"/api/tasks/:id/scm/commit\", async (req, res) => {" },
          { t: "ctx", s: "    const body = commitBody.parse(req.body);" },
          { t: "add", s: "    // 工作台改造第一步：提交动作统一走 withRepoLock，" },
          { t: "add", s: "    // 页面操作和验收合并在同一条队列里排队，互不踩踏。" },
          { t: "add", s: "    await withRepoLock(repoPath, \"scm:commit\", async () => {" },
          { t: "add", s: "      await commitStaged(repoPath, body.message, body.amend);" },
          { t: "add", s: "    });" },
          { t: "ctx", s: "    res.json(await readOverview(repoPath));" },
        ] },
        { loc: "unstaged", header: "@@ -140,4 +148,12 @@ export function registerScmRoutes(app: App) {", lines: [
          { t: "ctx", s: "  });" },
          { t: "add", s: "" },
          { t: "add", s: "  // 工作台只读接口：分支、贮藏、标签一次带全，面板一次渲染。" },
          { t: "add", s: "  app.get(\"/api/projects/:id/git/workbench\", async (_req, res) => {" },
          { t: "add", s: "    res.json(await readWorkbench(repoPath));" },
          { t: "add", s: "  });" },
          { t: "ctx", s: "}" },
        ] },
      ],
    },
    {
      path: "web/src/styles/scm.css", kind: "M",
      hunks: [
        { loc: "unstaged", header: "@@ -88,3 +88,15 @@ .scm-diff-line-add {", lines: [
          { t: "ctx", s: ".scm-diff-line-del {" },
          { t: "ctx", s: "  background: color-mix(in lch, var(--red) 9%, transparent);" },
          { t: "ctx", s: "}" },
          { t: "add", s: "" },
          { t: "add", s: ".scm-title-link {" },
          { t: "add", s: "  display: inline-flex;" },
          { t: "add", s: "  align-items: center;" },
          { t: "add", s: "  gap: 4px;" },
          { t: "add", s: "  color: var(--muted);" },
          { t: "add", s: "}" },
        ] },
      ],
    },
    {
      path: "web/src/scm/old-notes.md", kind: "D",
      hunks: [
        { loc: "unstaged", header: "@@ -1,4 +0,0 @@", lines: [
          { t: "del", s: "# SCM 面板遗留笔记" },
          { t: "del", s: "" },
          { t: "del", s: "- 轮询 5s，页面不可见时停" },
          { t: "del", s: "- 分支 diff 与工作区 diff 各走各的接口" },
        ] },
      ],
    },
    {
      path: "web/src/scm/GitWorkbench.tsx", kind: "U",
      hunks: [
        { loc: "untracked", header: "@@ -0,0 +1,12 @@", lines: [
          { t: "add", s: "import { useWorkbenchModel } from \"./workbenchModel.ts\";" },
          { t: "add", s: "" },
          { t: "add", s: "/** 项目级 Git 工作台：变更 / 历史 / 分支 / 贮藏 / 工作树 一屏管完。 */" },
          { t: "add", s: "export function GitWorkbench({ projectId }: { projectId: string }) {" },
          { t: "add", s: "  const model = useWorkbenchModel(projectId);" },
          { t: "add", s: "  if (!model.ready) return <WorkbenchSkeleton />;" },
          { t: "add", s: "  return (" },
          { t: "add", s: "    <div className=\"gw-shell\">" },
          { t: "add", s: "      <WorkbenchNav model={model} />" },
          { t: "add", s: "      <WorkbenchView model={model} />" },
          { t: "add", s: "    </div>" },
          { t: "add", s: "  );" },
        ] },
      ],
    },
  ];

  /* ---------- 合并冲突剧本 ----------
     merge feature/conflict-demo 时进入冲突态。每块给 ours/theirs 和一份 AI 建议。 */
  const conflictScript = {
    branch: "feature/conflict-demo",
    files: [
      {
        path: "web/src/scm/ScmChangeGroup.tsx",
        blocks: [
          {
            context: "export function ScmChangeGroup({ group, changes }: Props) {",
            ours: [
              "  // 行级暂存：每一行前面有勾选位，选中后浮出「暂存所选行」。",
              "  const [picked, setPicked] = useState<Set<number>>(new Set());",
            ],
            theirs: [
              "  // 可折叠小节：分组标题可点击收起，记忆在 localStorage。",
              "  const [collapsed, setCollapsed] = useLocalToggle(group.key);",
            ],
            ai: [
              "  // 行级暂存 + 可折叠小节：两个能力互不冲突，都保留。",
              "  const [picked, setPicked] = useState<Set<number>>(new Set());",
              "  const [collapsed, setCollapsed] = useLocalToggle(group.key);",
            ],
          },
          {
            context: "  return (",
            ours: ["    <section className=\"scm-group scm-group-lines\">"],
            theirs: ["    <section className={collapsed ? \"scm-group is-collapsed\" : \"scm-group\"}>"],
            ai: ["    <section className={cx(\"scm-group scm-group-lines\", collapsed && \"is-collapsed\")}>"],
          },
        ],
      },
      {
        path: "web/src/styles/scm.css",
        blocks: [
          {
            context: ".scm-group {",
            ours: ["  border-radius: 10px;", "  background: var(--panel);"],
            theirs: ["  border-radius: 8px;", "  background: var(--raised);"],
            ai: ["  border-radius: 10px;", "  background: var(--panel);"],
          },
        ],
      },
      {
        path: "shared/scm-types.ts",
        blocks: [
          {
            context: "export type ScmGroupKey =",
            ours: ["  | \"staged\" | \"unstaged\" | \"untracked\" | \"conflict\";"],
            theirs: ["  | \"staged\" | \"unstaged\" | \"untracked\";"],
            ai: ["  | \"staged\" | \"unstaged\" | \"untracked\" | \"conflict\";"],
          },
        ],
      },
    ],
  };

  /* ---------- 其余引用 ---------- */
  GW.seed = {
    repo: { name: "harness", path: "~/code/harness", remoteUrl: "github.com/fjh/harness.git" },
    commits: commits.concat(sideCommits),
    remotePending,
    head: { branch: "main" },
    branches: [
      { name: "main", sha: "3f8a21c", upstream: "origin/main" },
      { name: "feature/conflict-demo", sha: "aa2c881", upstream: null },
      { name: "fix/scrollbar-hover", sha: "bb31d90", upstream: null },
      { name: "ash/pFq2LmXc", sha: "cc91be7", upstream: null,
        task: { id: "pFq2LmXc", title: "Git 工作台后端接口", state: "running" } },
      { name: "ash/kW9xTb2v", sha: "b5b7690", upstream: null,
        task: { id: "kW9xTb2v", title: "选文浮条缩小一圈", state: "accepted" } },
    ],
    remoteBranches: [
      { name: "origin/main", sha: "9c01eba" },
      { name: "origin/feature/import-map", sha: "8f2e6a0" },
    ],
    workingFiles,
    conflictScript,
    stashes: [
      { id: 0, msg: "wip(ash:本会话): 工作台导航草稿", branch: "main", time: now - 2 * hour, session: "本会话",
        files: [{ path: "web/src/scm/WorkbenchNav.tsx", kind: "A", add: 40, del: 0 }] },
      { id: 1, msg: "wip(ash:会话 eFWY): 移动端牌面试验", branch: "main", time: now - 1 * day, session: "会话 eFWY",
        files: [{ path: "mobile/app/cards.tsx", kind: "M", add: 18, del: 7 }] },
    ],
    tags: [
      { name: "v0.9.1", sha: "e02d114", annotated: true, msg: "验收链路收尾", pushed: true },
      { name: "v0.9.0", sha: "77b40cc", annotated: true, msg: "0.9 起点", pushed: true },
    ],
    worktrees: [
      { path: "~/code/harness", branch: "main", isMain: true, dirty: true, task: null },
      { path: ".worktrees/pFq2LmXc", branch: "ash/pFq2LmXc", isMain: false, dirty: true,
        task: { id: "pFq2LmXc", title: "Git 工作台后端接口", state: "running" } },
      { path: ".worktrees/kW9xTb2v", branch: "ash/kW9xTb2v", isMain: false, dirty: false,
        task: { id: "kW9xTb2v", title: "选文浮条缩小一圈", state: "accepted" } },
    ],
    oplog: [
      { id: 1, time: now - 5 * hour, actor: "accept", cmd: "git merge --no-ff ash/kW9xTb2v", summary: "验收合并 ash/kW9xTb2v → main", result: "ok", undoable: false },
      { id: 2, time: now - 2 * hour, actor: "agent", cmd: "git commit -m \"feat(server): 分支列表与 ahead/behind\"", summary: "任务 pFq2LmXc 在其工作树提交", result: "ok", undoable: false },
      { id: 3, time: now - 35 * min, actor: "user", cmd: "git commit -m \"feat(web): 变更视图支持行级暂存\"", summary: "提交 3f8a21c", result: "ok", undoable: false },
    ],
  };

  /* 老提交点开详情时的占位 diff：按扩展名生成一段像样的补丁，免得每个提交都手写。 */
  GW.genDiff = function (path, add, del) {
    const base = path.split("/").pop() || path;
    const lines = [];
    lines.push({ t: "ctx", s: "// " + base + " —— 此提交的补丁片段（示意）" });
    for (let i = 0; i < Math.min(del || 2, 4); i++) lines.push({ t: "del", s: "  // 调整前的第 " + (i + 1) + " 处实现" });
    for (let i = 0; i < Math.min(add || 3, 6); i++) lines.push({ t: "add", s: "  // 调整后的第 " + (i + 1) + " 处实现" });
    lines.push({ t: "ctx", s: "  // …其余上下文略…" });
    return [{ header: "@@ -1," + (del || 2) + " +1," + (add || 3) + " @@", lines }];
  };
})();
