# Git 工作台实现与验证

实现日期：2026-09-15。设计原型位于 `docs/ui-demo-git-workbench/`；本次实现已接入 ash 的 React 页面与真实 Git 后端。

## 页面入口

- 项目侧栏的分支胶囊 →「打开 Git 工作台」。
- 任务 SCM 面板 →「打开此工作区的 Git 工作台」。
- 命令面板的 Git 分支和工作树结果。
- 验收冲突通知中的工作台入口，以及工作台内的任务验收跳转。

工作台在主区域打开，地址保存项目、工作树、视图和历史引用。支持刷新、浏览器后退及从工作台返回任务。

## 已接通的能力

| 视图 | 真实操作 |
| --- | --- |
| 变更 | 文件差异、整文件/改动块/所选行暂存与取消暂存、丢弃、提交、amend |
| 历史 | 提交图、分页、单提交差异、文件历史和 blame、cherry-pick、revert、三种 reset、交互式 rebase、从提交建分支/标签 |
| 分支 | 本地/远端分支搜索、新建、切换、重命名、删除、设置上游、merge、rebase、远端分支删除、远端配置 |
| 贮藏 | 创建（可包含未跟踪文件）、查看差异、apply、pop、drop |
| 标签 | 轻量/附注标签创建、本地删除、推送、带租约检查的远端删除 |
| 工作树 | 创建手动工作树、打开、锁定/解锁、安全删除、跳转任务验收与清理 |
| 操作日志 | 操作者、等价命令、排队/执行/冲突/失败/中止结果、全部历史备份、条件撤销、恢复为新分支、确认删除备份及清理已结束变基的辅助文件 |

顶部提供 fetch、三种 pull 策略、push 和显式 `force-with-lease`。冲突解决器支持共同基线/我方/对方对照、逐块取舍、手动编辑、文件删除、继续/跳过/中止。二进制冲突使用 Git 原始版本选边。

「AI 协助」把当前工作树、分支、HEAD、冲突与暂存文件上下文带入现有任务创建器，沿用 ash 的智能体选择与启动流程。

## 与现有系统的接缝

- 类型：`shared/src/git-workbench.ts`，使用独立的 shared 子路径导出。
- 后端：`server/src/git-workbench/`，由 `server/src/routes.ts` 挂载。
- 前端：`web/src/git-workbench/`，由 `WorkspaceShell` 懒加载。
- 聚合读取、历史、差异、冲突和动作端点均位于 `/api/projects/:id/git/workbench` 下。
- 写操作复用仓库锁、SCM 路径验证、凭证注入和工作区占用机制。
- 任务管理的分支/工作树接回已有验收与清理流程；归档工作树和预览实例只读。项目成员可读，项目/实例管理员可写。
- 操作记录位于 Git common directory 下的 `ash-workbench/operations.jsonl`；历史备份位于 `refs/ash-backup/`。

## 操作边界

状态版本、目标引用和冲突内容在写入前重新核对。保护强推及远端删除携带期望 SHA，远端发生变化时 Git 拒绝覆盖。历史改写先保存原 HEAD；删除本地分支/标签先保存原引用对象。

切分支、合并、变基和重置要求工作区干净，包括未跟踪文件。任务托管工作树的分支和基线由 ash 管理，工作台限制切分支及重置/变基入口。

当前交互式 rebase 支持最多 100 条线性历史中的排序、pick、reword、squash、fixup 和 drop。含合并提交的计划显示明确错误。新增/删除/重命名/无末尾换行等差异使用整文件暂存；文本冲突编辑上限为 1 MB。未提交内容的丢弃无法靠历史备份找回，执行前需输入「丢弃」。

贮藏采用创建者标记；其他用户或外部创建的贮藏可应用副本，pop/drop 限制为本用户在工作台创建的记录。

## 验证记录

- `npm -w shared run build`、`npm -w server run build`、`npm -w web run build`：通过。
- `npm -w server run test:git-workbench`：14 个真实临时仓库场景及 4 组安全回归通过，包含本地 bare 远端、中文/特殊字符、四种冲突流程、二进制选边、引用租约、托管任务、权限、并发和恢复保护。
- 既有 `test:repo-lock`、`test:project-git`、`test:scm`、`test:scm-guard`、`test:scm-nested`：通过。
- `npm -w web run test:git-workbench`：真实后端浏览器回归通过，包含入口、后退/刷新、七视图、部分暂存、提交、贮藏、失败持久化、冲突继续/中止、hard reset、交互式 rebase 和工作树切换。
- 任务返回上下文回归：同工作树内切视图/查看分支历史保留 `gitTask`，切换工作树后清除。浏览器夹具通过 IPC 关闭数据库与服务，父测试检查临时目录确实删除。
- 连续操作回归：挂起写入后的状态请求，确认控件继续禁用；放行最新状态后才恢复操作。执行与排队期间仍轮询日志，最终状态重读期间暂停轮询竞争。
- 前端全量回归：首次执行在既有 `test-remote-return.mjs` 的「后续正常轮询不能清掉移回失败」断言停止；单独重跑 `test:remote-task` 通过，其后的全部子套件按顺序执行通过。
- 桌面和 390px 移动布局已查看截图；移动页面无横向溢出。
- Windows 真机 `192.168.1.187`：在独立 detached worktree 中通过 `git format-patch` / 局域网传输应用当前实现；`npm -w server run test:git-workbench` 退出码 0，14 个核心场景与 4 组安全回归通过。POSIX 符号链接专用案例由 macOS 覆盖。
- Windows 隔离目录安装完整依赖后，server/web build 均退出码 0；最终专用无头浏览器回归退出码 0，Chrome 正常退出并完成 profile 清理。
- Windows 初轮暴露测试数据库句柄未关闭的问题，已补关闭与目录删除断言。浏览器前两轮曾出现页面关闭及等待冲突栏超时；随后补齐请求诊断、提前观察 Promise 拒绝，并修复写入后状态尚未刷新就开放下一次操作的窗口。最终以明确的冲突错误断言和延迟响应场景完成全流程验证。
- 清理审计退出码 0：Windows 隔离工作树已删除并取消注册，测试/浏览器临时目录和补丁无残留，已知进程及精确匹配的测试进程为 0，所有远端终端会话已删除。本机传输服务已停止，传输目录、辅助脚本和截图临时目录已清理。

浏览器通道降级原因：扩展入口返回 `Browsers: Error: unsupported Codex auth method: apikey`，因此使用独立临时 profile 的无头 Chromium。验证没有接管普通 Chrome 标签，也没有激活用户的浏览器窗口。

所有 Git 写入测试使用临时仓库；本次没有重启或部署用户正在运行的 ash 实例。

## 第 1 轮审查修复（2026-09-15）

本轮限于审查报告的三项问题：

- 冲突块按当前位置切片替换，保留源码里的 `$` 字面内容，重复的相同块也按所选位置处理。
- 操作日志页独立列出 `refs/ash-backup/` 下的全部备份，超出最近 200 条日志后仍可恢复为新分支或删除。删除要求输入完整引用并原子核对 SHA；日志中的已删除备份不再提供恢复按钮。
- 交互式变基完成、失败且已结束、中止或跳过至结束时清理辅助目录。任一注册工作树仍在变基或无法检查时保留辅助文件，避免破坏待执行的 reword 步骤。页面另有手动清理入口，处理旧版本或外部结束操作留下的目录；只清理严格匹配的辅助目录，备份引用由用户单独删除。
- 冲突和中途操作期间禁用获取、拉取、推送及保护强推，解决并继续或中止后恢复。

本轮本机验证：`shared/server/web build` 均通过；`server test:git-workbench` 的原有 14 场景、4 组安全回归和新增 4 组维护回归全部通过。维护回归覆盖超过 200 条日志后的备份可见性、恢复、确认/命名空间/SHA 拦截、删除不改 HEAD/索引/文件、变基完成/继续/中止/跳过/钩子失败后的目录生命周期，以及其他工作树暂停或不可访问时的保留行为。

`web test:git-workbench` 的原有完整流程与新增审查回归均通过。新增场景逐字比较三种冲突选边的编辑器、磁盘、索引内容，覆盖 `$$`、`$&`、`` $` ``、`$'` 等源码、重复块的位置、冲突期间同步控件禁用且没有动作请求，以及真实备份恢复/确认删除/辅助文件清理。桌面和 390px 备份页面截图已检查，无横向溢出。

本轮再次检查扩展通道，返回 `Browsers: Error: unsupported Codex auth method: apikey`，浏览器列表为空，因此降级到独立临时 profile 的无头 Chromium；没有接管普通标签、激活 Chrome 或使用有头浏览器。

Windows 真机本轮验证：通过局域网传输 `git format-patch`，校验 SHA-256 后应用到独立 detached worktree；依赖安装、新增 `test-git-workbench-maintenance.ts`（4 组）、shared/server/web build 均退出码 0。新增 `test-git-workbench-review.mjs` 最终退出码 0，Chrome 正常退出并清理临时 profile。浏览器首轮被测试夹具的 CRLF/LF 预期差异拦下，特殊字符保持原样；为隔离用户全局 Git 配置，在临时仓库设置 `core.autocrlf=false` 后通过，生产换行处理未改动。

本轮清理已核对：远端隔离工作树、依赖、补丁、截图、测试夹具和终端会话，以及本机传输服务与辅助文件均已清理；浏览器 PID 与临时 profile 不再存在。修改的 18 个代码文件均未超过 700 行，最长 455 行；`git diff --check` 通过。

## 第 2 轮审查修复（2026-09-15）

冲突期间的动作判定集中到 shared 的 `gitActionBlockReason`，前后端共同使用。工作台所有视图的普通写入口统一禁用；整文件暂存、取消暂存、冲突解决、继续、中止和跳过按同一允许列表放行。视图切换、历史和差异查看仍可用。动作执行函数及弹窗确认也检查当前状态，覆盖打开弹窗之后仓库进入冲突的情况。

服务端用仓库锁内取得的 `freshStatus` 先做冲突预检，再把日志设为 `running`。被既有冲突挡下的请求记录为 `failed`，不追加暗示本次操作留下冲突的文案；真正执行后留下冲突的合并、拣选、变基和反做保留原来的处理状态。

本轮本机 `shared/server/web build` 通过；`server test:git-workbench` 的 15 个核心场景、4 组安全回归、4 组维护回归均通过。新增案例覆盖 12 种跨视图动作的预检拒绝：409、日志仅 `queued → failed`、无误导追加文案，且 HEAD、引用、索引、冲突文件、工作树列表均未变化；整文件暂存和取消暂存仍能实际执行。

新增 `test-git-workbench-conflict-gates.mjs` 单独通过，挂接后的 `web test:git-workbench` 三套浏览器回归也全部退出码 0。真实冲突场景遍历七视图，核对报告所列写入口禁用、差异和历史查看可用；冲突期间实际写请求严格为 `stage / unstage / abort / resolve / continue / skip`，六种允许动作均成功。冲突结束后代表入口恢复；普通动作弹窗打开后外部发生冲突，自动刷新使确认按钮禁用，模拟点击没有请求，也没有创建分支。

本轮浏览器先选择 Chrome 扩展通道，创建具名后台会话时返回 `unsupported Codex auth method: apikey`，因此使用独立临时 profile 的无头 Chromium。未接管普通标签、激活用户 Chrome 或使用有头浏览器。fixture、Vite、Chromium 及测试截图临时目录均已退出或清理；`git diff --check` 通过。本轮没有修改平台路径或 win32 分支，验证在本机执行。

## 第 3 轮审查修复（2026-09-15）

变更标签计数与工作区摘要共用 `gitChangeCount`，包含未合并文件。存在冲突时摘要明确显示待解决数量并指向上方冲突面板；冲突已解决但 Git 操作尚未结束时，显示继续或中止指引。只有没有变更、没有中途操作且状态未截断时才显示「所有改动已提交」。长摘要可在窄文件面板内换行。

日志归因改为显式记录本次是否实际尝试了合并或重放命令。标记只在调用 merge、rebase（含计划及 pull 整合）、cherry-pick、revert、stash apply/pop、continue/skip 的 Git 命令时设置；这些命令失败后仍有冲突或中途操作，才记为 `conflict`。暂存或冲突保存失败、继续/跳过的前置校验拒绝，以及中止失败均记为 `failed`，不会借用已有冲突追加误导文案。

本轮本机后端 `test:git-workbench` 全部通过：15 个核心场景、4 组安全、4 组维护及新增 4 组结果归因回归。新增回归比较错误请求前后的 Git 状态、引用、索引和冲突文件，验证原现场未变；同时验证真正推进到下一处冲突的 continue/skip、交互式 rebase、stash apply/pop、pull merge/rebase 保留 `conflict`，无冲突的 ff-only 拒绝记录为 `failed`。

本轮 `shared/server/web build` 均通过，最终 `web test:git-workbench` 三套浏览器回归全部退出码 0。新增断言覆盖仅 UU 的 merge 冲突、已解决但尚待 continue、无 operation 的 stash pop 冲突，以及继续或提交后的真实干净状态。390px 冲突页面无横向溢出。完整回归首轮在旧长流程的 abort 遇到一次 Git `index.lock`；该用例单独复跑和随后的完整回归均通过。旧长流程的截图目录也已补上 finally 清理。

浏览器先尝试扩展具名后台会话，命名失败原文为 `unsupported Codex auth method: apikey`，随后采用独立临时 profile 的无头 Chromium；未接管普通标签、激活用户 Chrome 或使用有头浏览器。本轮 fixture、Vite、Chromium、截图和临时目录均已清理，`git diff --check` 通过。验证在本机执行，未修改平台路径或 win32 分支。
