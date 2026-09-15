# Git 工作台 · 设计 demo

> 打开 `index.html` 即可玩，全部状态在内存里，刷新即复位。多文件纯静态页面，无构建、无依赖。

## 这是什么

「让绝大部分 git 操作能在 ash 页面上完成」的完整交互设计，做成可点的自洽 demo。
mock 的仓库就是 harness 自己，工作区里的改动演的正是「给 ash 加 Git 工作台」这件事。

## 背景：ash 现有 git 能力与缺口（2026-09 调研）

现有能力围绕「一个任务一条分支 → 验收合并」流水线：

- **任务工作区面板**（`web/src/scm/`，`server/src/scm-routes.ts`）：status / stage / unstage / discard / commit / push，amend 后端有但前端无入口。
- **项目主仓浮层**（`web/src/workspace/ProjectGit*`，`server/src/project-git-routes.ts`）：切分支、fetch / pull（三策略）/ push、git 署名与凭证。
- **验收链路**（`server/src/git-accept*.ts`）：验收合并（ff / merge / squash / tag / no-commit）、分支计划、基线更新、worktree 清理。

页面上做不了、统一「去终端」的：**新建/删除/重命名分支、任意 merge、stash、cherry-pick、revert、reset、
交互式 rebase、tag 管理、commit graph、单提交 diff、文件历史/blame、冲突的实际编辑、手动 worktree 管理**。
本 demo 就是把这些缺口全部补成页面操作。

## 设计原则（详见 demo 右上「设计说明」）

1. **危险分级**：安全操作一步到位；有影响的红色确认；不可逆的要抄目标名。确认框先亮安全网。
2. **一切留痕、多数可撤销**：每个动作 = 操作日志一条（谁 / 等价命令 / 结果）+ 危险操作自动快照，一键撤销。
3. **仓库锁可视化**：页面操作与 agent 验收合并同走 `withRepoLock` 队列，锁被占就明说并排队，不报错不静默。
4. **与任务系统贯通**：ash/* 分支挂任务徽章；工作树卡片能「合并回 main」（即验收）、批量清理已验收。
5. **AI 在场不抢方向盘**：提交信息生成、冲突块建议、「整份交给 agent」，每一步都要用户点头。

## demo 怎么玩

- **变更**：文件 / 改动块 / 行三档暂存（diff 里点改动行试试）、丢弃、amend、AI 生成提交信息。
- **历史**：多分支泳道图；任意提交的 ⋯ 菜单发起 cherry-pick / revert / reset（三档）/ 交互式变基 / 建分支 / 打标签。
- **分支**：合并 `feature/conflict-demo` 会进入完整的冲突解决流程（逐块 我方/对方/都要/AI/手改）。
- **右上「演示剧本」**：① 远端长出新提交 → fetch / pull --rebase / push 被拒与保护强推；② agent 占锁 6 秒 → 操作排队与自动续跑。
- **操作日志**：看审计流水，点「撤销」回放快照。

## 落地对接草案（与现有代码的接缝）

| 设计件 | 复用 | 新增 |
|---|---|---|
| 数据读取 | `git-status.ts` / `git-diff.ts` / `git-exec.ts` | `GET /projects/:id/git/workbench` 聚合口（轮询沿用 SCM 面板 5s 节奏） |
| 写操作 | `repo-lock.ts` 的 `withRepoLock` | `POST …/git/{branches,merge,rebase,stash,tags,reset,sync}`，锁状态暴露 `GET …/git/lock` |
| 冲突解决 | `git-status.ts` 的冲突检测 | `GET …/git/conflicts`（逐块 ours/theirs/base）+ `POST …/resolve|continue|abort`；「交给 agent」= 派生带冲突上下文的任务 |
| 撤销 | — | 危险操作前 `git branch refs/ash-backup/<ts>`，操作日志表记 backup ref，撤销端点反做 |
| 工作树 | `git.ts` / `git-accept*.ts` / `git-worktree-*.ts` | 「合并回 main」直接走验收链路；清理复用 `workspaces/discard` |
| 入口 | 任务面板 SCM 区 | 项目页新增「Git」标签，SCM 区标题跳转 |

## 文件结构

| 文件 | 职责 |
|---|---|
| `data.js` | mock 数据种子（提交图 / 工作区 / 冲突剧本 / 贮藏 / 工作树…） |
| `engine.js` | mock git 引擎核心：快照-操作-日志-重渲染循环，图查询与工作区/提交/分支/合并/变基操作 |
| `engine-extra.js` | 同步 / 贮藏 / 标签 / 工作树 / 演示剧本 / AI / 撤销 |
| `ui.js` | DOM 工具、图标、toast、分级确认、菜单、diff 渲染器 |
| `view-*.js` | 七个视图：changes / history / branches / stash / refs(tags+worktrees) / oplog |
| `overlay-conflict.js` | 冲突解决器（全屏） |
| `overlay-rebase.js` | 交互式变基面板 |
| `about.js` | 内嵌设计说明 |
| `base.css` / `views.css` / `overlays.css` | 设计变量沿用 ash web（Linear 风浅色、accent `#5e6ad2`、diff 配色对齐 `review.css`） |
