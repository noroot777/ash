# 全量回归清单 — 2026-11-13（feat/ui-revamp @ 007c831c 合入后）

任务 S-VYYZGV-Ur1。每个测试文件一行；红的归类按 (a) 产品行为已改、测试过时 / (b) 测试本身写错或夹具没跟上 / (c) 产品真有 bug。

## 计数

| 结果 | 文件数 |
|---|---|
| 留给用户 | 1 |
| 有意不跑 | 6 |
| 绿（已修） | 30 |
| 绿（并发下闪红） | 8 |
| 绿（部分未执行） | 6 |
| 绿 | 660 |
| 拆分模块 | 40 |
| 不是测试 | 1 |
| 合计 | 752 |

「绿」只说明这台 macOS 上实际执行的那部分是绿的，**不代表 Windows 通过**：测试文件里 `IS_WINDOWS` / `process.platform === "win32"` 的分支这一轮一个都没执行（`git grep -nE "IS_WINDOWS|process\.platform|win32" -- '*test-*'` 可列全）。整份或整块 Windows 专属、在 Mac 上空跑的单独记成「有意不跑」或「绿（部分未执行）」；只是文件内零散几节按平台分叉的，仍记「绿」。

## 怎么跑的

- 枚举：root/server/web/mcp/mobile 所有 `test`/`test:*` 入口按 `scripts/test-runner.mjs` 的 `expandChain` 展开成叶子，再和盘上的测试文件逐个对上——测试文件取三者并集：`test-*`/`verify-*` 命名、`*.test.*`/`*.spec.*` 命名、导入 `node:test`/`vitest`/`@playwright/test`/`jest` 的文件（`git ls-files` + `git grep`，排除 `server/src` 里同名前缀的产品模块 `verify-override.ts`/`verify-until-known.ts`）。首轮只按 `test-*` 对账，漏了 `web/src/page-annotation/model.test.ts`，已补跑补记。没有 script 的按 `tsx`/`node` 直接跑；被别的测试 import 或当子进程起的算拆分模块，随父测试跑——父入口按平台条件 import 的，不算随父跑过。
- 执行：和门禁同形（`sh -c` 当进程组组长、叶子是组内成员、环境去掉 ASH_DB/ASH_RUNS_DIR、web 叶子共用 dom-stage 的 Chrome 与 vite），6 路并行，单条 300s 上限；红的再单并发复跑区分闪红。
- 防烧额度：整轮跑在 macOS `sandbox-exec` 里（所以这份清单只代表 macOS）——禁执行真 claude/codex/opencode/kimi/gemini、禁外网（含本机代理端口）、禁连 :4317、禁写主仓 data/.git 与 ~/.claude、~/.codex 等。被沙箱本身打红的，换「放开执行真 CLI、仍禁外网」或「放开外网、仍禁真凭据」的档复核，结论写在说明里。
- 残留：每条叶子带归属记号，退出后查同组与带记号的进程，记下再收掉。

## 链外测试的纳入建议（只是建议，验收链没改）

链外 + 无 script 共 457 个文件：

- **建议纳入**：377 个，单条 ≤15s、并行下稳定绿、不碰真 CLI，合计约 1353s CPU（按门禁 8 路并行约多 3 分钟墙钟；现在门禁 255 个文件约 3200s CPU）。
- **可纳入（较慢）**：53 个，15–60s，合计约 1491s CPU；全部纳入的话门禁墙钟大约翻倍。
- **留在链外**：
  - 并发闪红（8）：test-process-ownership.mjs、test-launch-abandon-races.ts、test-preview-static.ts、test-service-ports-script.ts、test-service-ports.ts、test-git-workbench-conflict-errors.mjs、test-git-workbench-review.mjs、verify-git-workbench-discard-menu.mjs
  - 真模型（4）：test-assistant-live.ts、test-chat-cli.ts、test-side-authorization-cli.ts、test-user-cli-smoke.ts
  - 真 CLI（6）：test-claude-goal-live.ts、test-claude-relay-settings-live.ts、test-claude-settings-live.ts、test-codex-archive-live.ts、test-goal-native-live.ts、test-kimi-live.ts
  - 待定（1）：test-codex-goal-bridge.ts
  - 慢（3）：test-scheduled-messages.ts、test-session-turn-identity.ts、test-chat-browser.mjs
  - 前置整包构建（2）：test-read-transcript.mjs、test-reconnect.mjs
  - 依赖 mobile 导出（2）：test-reply-command-ui.mjs、test-web-smoke.mjs
  - Windows 专属、Mac 上空跑（1）：test-user-shell-powershell.ts

「并发闪红」那几条进了并行门禁会偶发拦验收，得先查清再纳入：其中 launch-abandon-races 与 service-ports 两次都是**叶子所在进程组被整组发了信号**（SIGKILL / SIGTERM），说明被测代码或测试有一处会对不属于自己的组开枪，跟 11 月 2 日普查里 #481 同形。

## 明细

| 文件 | 归属 | 结果 | 用时 | 说明 | 纳入建议 |
|---|---|---|---|---|---|
| `server/scripts/test-codex-goal-bridge.ts` | 链外 | 留给用户 | 1s | 红：/review 完成事件早于 review/start 应答到达时永不结算（aaa2002d 去掉了 completeTurn 对应答的等待）；import 已修 | 留在链外 |
| `server/scripts/test-assistant-live.ts` | 无 script | 有意不跑 |  | 设计上就要调用真实 Claude 模型（需 ASH_ALLOW_REAL_AGENT=1） | 留在链外 |
| `server/scripts/test-chat-cli.ts` | 无 script | 有意不跑 |  | 设计上调用真实 CLI 跑模型回合（需 ASH_CHAT_SMOKE=1） | 留在链外 |
| `server/scripts/test-side-authorization-cli.ts` | 无 script | 有意不跑 |  | 同上，真实 CLI + 真实模型（需 ASH_CHAT_SMOKE=1） | 留在链外 |
| `server/scripts/test-user-cli-smoke.ts` | 链外 | 有意不跑 | 1s | 真起一次带 key 的 claude headless 首跑，要真模型出活 | 留在链外 |
| `mobile/scripts/test-reply-command-ui.mjs` | 链外 | 绿（已修） | 17s | (b) 缺 mobile/dist 时直说先 build:mobile | 留在链外 |
| `mobile/scripts/test-web-smoke.mjs` | 链外 | 绿（已修） | 17s | (b) 改用系统 Chrome + 自带假后端（原来依赖 playwright 下载的浏览器、反代 live :4317）；需先 build:mobile | 留在链外 |
| `server/scripts/test-claude-relay-settings-live.ts` | 链外 | 绿（已修） |  | 真 claude + 本地假上游；假上游没放行 CLI 的 HEAD /api/hello 探测，崩了还留下真 claude 进程 | 留在链外 |
| `server/scripts/test-codex-session-archive.ts` | 链外 | 绿（已修） | 39s | (b) readCodexAppServerState 搬到 codex-app-server-state | 可纳入（较慢） |
| `server/scripts/test-im-cards.ts` | 链外 | 绿（已修） | 9s | (b) 夹具没按生产占住 duet 回合锁（0a563a53 之后） | 建议纳入 |
| `server/scripts/test-monitor-delivery-batch.ts` | 链外 | 绿（已修） | 59s | (b) abortDelivery/markSent 只认领取时的行（ac19a7d7） | 可纳入（较慢） |
| `server/scripts/test-monitor-end-condition.ts` | 链外 | 绿（已修） | 7s | (a) 待发送合并成「积压 + 最新」两行（8cbcc0ff） | 建议纳入 |
| `server/scripts/test-monitor-result-lifecycle.ts` | 链外 | 绿（已修） | 3s | (b) isReviewSourceActive 查询多了 taskId（a1771e58），注入点打不中 | 建议纳入 |
| `server/scripts/test-multi-user.ts` | 链外 | 绿（已修） | 3s | (c) 产品已修：个人面写闸把免登录名单上的 relay 匿名回连拦成 403（9ab015ab） | 建议纳入 |
| `server/scripts/test-page-annotation-batches.ts` | 链外 | 绿（已修） | 3s | (b) markSent 要传领取时的行（ac19a7d7） | 建议纳入 |
| `server/scripts/test-reattach.ts` | 链外 | 绿（已修） | 13s | (b) 同上 | 建议纳入 |
| `server/scripts/test-scheduled-messages.ts` | 链外 | 绿（已修） | 163s | 泄漏已堵：常驻 fake-claude 等不到 stdin EOF 成孤儿（夹具改为临时目录没了就退出） | 留在链外 |
| `server/scripts/test-startup-receipt.ts` | 链外 | 绿（已修） | 5s | (b) 续跑交代由扫描接管、晚返回一拍回填，等租约落定再断言 | 建议纳入 |
| `server/scripts/test-task-artifact-scope.ts` | 链外 | 绿（已修） | 7s | (c) 产品已修：隔离工作区一支不分还在/已删（4be79fa3） | 建议纳入 |
| `server/scripts/test-turn-identity-bridge.ts` | 链外 | 绿（已修） | 1s | (b) 在 ash 回合里跑时继承 PATH 带身份目录，基线先洗 | 建议纳入 |
| `web/scripts/test-acceptance-host-layout.mjs` | 链内 | 绿（已修） | 5s | (c) 产品已修：窄屏动作簇不收缩戳出顶栏 17px（3a8a70b1） |  |
| `web/scripts/test-cli-commands-ui.mjs` | 链外 | 绿（已修） | 46s | (a) 原始需求成了第一颗「你」气泡（eab6cf39） | 可纳入（较慢） |
| `web/scripts/test-context-compact-quick.mjs` | 链内 | 绿（已修） | 2s | (a) 压缩预览按执行器自己的模型窗口算（db67fc7d），夹具模型补 [1m] |  |
| `web/scripts/test-conversation-self-turn.mjs` | 链内 | 绿（已修） | 1s | (a) 回合中间的记录不再切气泡（4293d526） |  |
| `web/scripts/test-copy-feedback-dom.mjs` | 链内 | 绿（已修） | 3s | (a) 气泡头平时透明、指到气泡才浮出（940aa547） |  |
| `web/scripts/test-data-layer.mjs` | 链外 | 绿（已修） | 1s | (b) 实时事件要带回合起点（d32c6cf3），夹具补上 | 建议纳入 |
| `web/scripts/test-free-workflow-inspector.mjs` | 链外 | 绿（已修） | 8s | (b) 夹具靠真后端答 /settings 与验收状态，补应答 | 建议纳入 |
| `web/scripts/test-handoff-source-addresses.mjs` | 链外 | 绿（已修） | 4s | (a) 「默认规则」页多了远程访问卡（40ef64cd），夹具补应答 | 建议纳入 |
| `web/scripts/test-personal-cli-settings.mjs` | 链内 | 绿（已修） | 3s | (a) 输入框改成随内容长高（ceed40be） |  |
| `web/scripts/test-question-card.tsx` | 链内 | 绿（已修） | 2s | (c) 产品已修：isUserFollowUp 认老答复前没 trimStart（shared） |  |
| `web/scripts/test-review-presentation.tsx` | 链内 | 绿（已修） | 2s | (b) 夹具用了服务端从不写的「第 1 轮验证通过」（9cdf5a7a 后认不出） |  |
| `web/scripts/test-reviewer-turn-dom.mjs` | 链外 | 绿（已修） | 5s | (b) 同上 | 建议纳入 |
| `web/scripts/test-settings-path-jump.mjs` | 链内 | 绿（已修） | 32s | (a) 同上 |  |
| `web/scripts/test-side-chat-browser.mjs` | 链内 | 绿（已修） | 18s | (b) 第二次投递等到了上一条的回执就放行（竞态，基线 3/3 红） |  |
| `web/scripts/test-task-memo-dom.mjs` | 链内 | 绿（已修） | 16s | (a) 悬浮卡只用现读的追问（f2eb0467） |  |
| `scripts/test-process-ownership.mjs` | 链外 | 绿（并发下闪红） | 42s | 单并发绿；并行时 setsid 后代先没了 | 留在链外 |
| `server/scripts/test-launch-abandon-races.ts` | 链外 | 绿（并发下闪红） | 3s | 单并发绿；6 路并行时叶子进程组被 SIGKILL，留下 worker.cjs | 留在链外 |
| `server/scripts/test-preview-static.ts` | 链外 | 绿（并发下闪红） | 1s | 终轮 6 路并行红，单并发复跑绿 | 留在链外 |
| `server/scripts/test-service-ports-script.ts` | 链外 | 绿（并发下闪红） | 23s | 单并发 4/5 绿；6 路并行时 'unresolved' !== 'verified' | 留在链外 |
| `server/scripts/test-service-ports.ts` | 链外 | 绿（并发下闪红） | 15s | 单并发绿；6 路并行时叶子进程组被 SIGTERM，留下 serve.js | 留在链外 |
| `web/scripts/test-git-workbench-conflict-errors.mjs` | 链外 | 绿（并发下闪红） | 9s | 终轮 6 路并行红，单并发复跑绿 | 留在链外 |
| `web/scripts/test-git-workbench-review.mjs` | 链外 | 绿（并发下闪红） | 22s | 终轮 6 路并行红，单并发复跑绿 | 留在链外 |
| `web/scripts/verify-git-workbench-discard-menu.mjs` | 链外 | 绿（并发下闪红） | 10s | 终轮 6 路并行红，单并发复跑绿 | 留在链外 |
| `mcp/scripts/test-read-transcript.mjs` | 链外 | 绿 | 1s |  | 留在链外 |
| `mcp/scripts/test-reconnect.mjs` | 链外 | 绿 | 4s |  | 留在链外 |
| `mobile/scripts/test-cli-capability.mjs` | 链外 | 绿 | 1s |  | 建议纳入 |
| `mobile/scripts/test-markdown-inline.mjs` | 链外 | 绿 | 1s |  | 建议纳入 |
| `mobile/scripts/test-monitor-strip.mjs` | 链外 | 绿 | 13s |  | 建议纳入 |
| `mobile/scripts/test-project-path.mjs` | 链外 | 绿 | 1s |  | 建议纳入 |
| `mobile/scripts/test-session-notices.mjs` | 链外 | 绿 | 1s |  | 建议纳入 |
| `mobile/scripts/test-task-branches.mjs` | 链外 | 绿 | 13s |  | 建议纳入 |
| `scripts/test-accept-test.mjs` | 链外 | 绿 | 20s |  | 可纳入（较慢） |
| `scripts/test-codex-mcp-setup.mjs` | 链外 | 绿（部分未执行） | 1s | 严格档禁执行真 codex，「问真 codex」那几条没拿到真 codex 的回答 | 建议纳入 |
| `scripts/test-kimi-mcp.mjs` | 链外 | 绿 | 1s |  | 建议纳入 |
| `web/src/page-annotation/model.test.ts` | 无 script | 绿 | 1s | 不叫 test-*，靠 `node:test`，首轮枚举漏了，补跑 5/5 过（`cd web && node --test src/page-annotation/model.test.ts`） | 建议纳入 |
| `scripts/test-macos-client.mjs` | 无 script | 绿 | 18s |  | 可纳入（较慢） |
| `scripts/test-process-identity.mjs` | 链外 | 绿 | 1s |  | 建议纳入 |
| `scripts/test-process-register.cjs` | 无 script | 绿 | 1s |  | 建议纳入 |
| `scripts/test-restart-options.mjs` | 链外 | 绿 | 7s |  | 建议纳入 |
| `scripts/test-restart.mjs` | 链外 | 绿 | 44s |  | 可纳入（较慢） |
| `scripts/test-test-process-cleanup.mjs` | 链外 | 绿 | 1s |  | 建议纳入 |
| `scripts/test-test-process-conventions.mjs` | 链外 | 绿 | 1s |  | 建议纳入 |
| `scripts/test-test-process-directory.mjs` | 链外 | 绿 | 8s |  | 建议纳入 |
| `scripts/test-test-process-failures.mjs` | 链外 | 绿 | 21s |  | 可纳入（较慢） |
| `scripts/test-test-process-lifecycle.mjs` | 链外 | 绿 | 4s |  | 建议纳入 |
| `scripts/test-test-process-ownership.mjs` | 链外 | 绿 | 3s |  | 建议纳入 |
| `scripts/test-test-process-resources.mjs` | 链外 | 绿 | 4s |  | 建议纳入 |
| `scripts/test-test-process.mjs` | 链外 | 绿 | 22s |  | 可纳入（较慢） |
| `scripts/test-windows-restart.mjs` | 链外 | 绿（部分未执行） | 1s | 纯逻辑段绿；`IS_WINDOWS` 的原生 Windows 段与 preservation 子模块在 Mac 上未执行 | 建议纳入 |
| `scripts/test-workspace-repair.mjs` | 链外 | 绿 | 2s |  | 建议纳入 |
| `server/scripts/test-accept-auto-commit.ts` | 链内 | 绿 | 15s |  |  |
| `server/scripts/test-accept-cleanup.ts` | 链内 | 绿 | 271s |  |  |
| `server/scripts/test-accept-commit-setting.ts` | 链内 | 绿 | 10s |  |  |
| `server/scripts/test-accept-gate-baseline-landing.ts` | 链内 | 绿 | 43s |  |  |
| `server/scripts/test-accept-gate-baseline.ts` | 链内 | 绿 | 69s |  |  |
| `server/scripts/test-accept-gate-borrow.ts` | 链内 | 绿 | 12s |  |  |
| `server/scripts/test-accept-gate-command.ts` | 链内 | 绿 | 1s |  |  |
| `server/scripts/test-accept-gate-confine.ts` | 链内 | 绿 | 16s |  |  |
| `server/scripts/test-accept-gate-handoff-verdict.ts` | 链外 | 绿 | 4s |  | 建议纳入 |
| `server/scripts/test-accept-gate-identity.ts` | 链内 | 绿 | 15s |  |  |
| `server/scripts/test-accept-gate-links.ts` | 链内 | 绿 | 2s |  |  |
| `server/scripts/test-accept-gate-pending.ts` | 链内 | 绿 | 3s |  |  |
| `server/scripts/test-accept-gate-plan.ts` | 链内 | 绿 | 24s |  |  |
| `server/scripts/test-accept-gate-process.ts` | 链内 | 绿 | 43s |  |  |
| `server/scripts/test-accept-gate-proof.ts` | 链内 | 绿 | 1s |  |  |
| `server/scripts/test-accept-gate-readonly.ts` | 链内 | 绿 | 6s |  |  |
| `server/scripts/test-accept-gate-reclaim.ts` | 链内 | 绿 | 2s |  |  |
| `server/scripts/test-accept-gate-relocate.ts` | 链内 | 绿 | 4s |  |  |
| `server/scripts/test-accept-gate-runs-inside.ts` | 链内 | 绿 | 2s |  |  |
| `server/scripts/test-accept-gate-source.ts` | 链内 | 绿 | 7s |  |  |
| `server/scripts/test-accept-gate-status.ts` | 链内 | 绿 | 21s |  |  |
| `server/scripts/test-accept-gate-supply.ts` | 链内 | 绿 | 12s |  |  |
| `server/scripts/test-accept-gate-watch.ts` | 链内 | 绿 | 16s |  |  |
| `server/scripts/test-accept-gate.ts` | 链内 | 绿 | 177s |  |  |
| `server/scripts/test-accept-merge.ts` | 链内 | 绿 | 12s |  |  |
| `server/scripts/test-accept-pending-merge.ts` | 链内 | 绿 | 6s |  |  |
| `server/scripts/test-adopt-replay.ts` | 链外 | 绿 | 1s |  | 建议纳入 |
| `server/scripts/test-agent-attachments.ts` | 链外 | 绿 | 1s |  | 建议纳入 |
| `server/scripts/test-agent-descendant-cleanup.ts` | 链外 | 绿 | 2s |  | 建议纳入 |
| `server/scripts/test-agent-image-entry.ts` | 链外 | 绿 | 5s |  | 建议纳入 |
| `server/scripts/test-agent-image-journal.ts` | 链外 | 绿 | 1s |  | 建议纳入 |
| `server/scripts/test-agent-image-meta.ts` | 链外 | 绿 | 1s |  | 建议纳入 |
| `server/scripts/test-agent-image-stream-window.ts` | 链外 | 绿 | 2s |  | 建议纳入 |
| `server/scripts/test-agent-image-stream.ts` | 链外 | 绿 | 4s |  | 建议纳入 |
| `server/scripts/test-agent-spawn-guard.ts` | 链外 | 绿 | 1s |  | 建议纳入 |
| `server/scripts/test-answer-routing.ts` | 链外 | 绿 | 1s |  | 建议纳入 |
| `server/scripts/test-anthropic-context-1m.ts` | 链外 | 绿 | 2s |  | 建议纳入 |
| `server/scripts/test-archive-cleanup.ts` | 链外 | 绿 | 10s |  | 建议纳入 |
| `server/scripts/test-archive-preview-guard.ts` | 链外 | 绿 | 2s |  | 建议纳入 |
| `server/scripts/test-ash-mcp-file.ts` | 链外 | 绿 | 2s |  | 建议纳入 |
| `server/scripts/test-ash-mcp-installer.ts` | 链外 | 绿 | 2s |  | 建议纳入 |
| `server/scripts/test-ash-mcp-launch.ts` | 链外 | 绿 | 2s |  | 建议纳入 |
| `server/scripts/test-ash-mcp-probe.ts` | 链外 | 绿 | 26s |  | 可纳入（较慢） |
| `server/scripts/test-ash-mcp-reach.ts` | 链外 | 绿（部分未执行） | 2s | 严格档禁执行真 CLI，需要启动真 claude/codex 的几组用例没在真 CLI 上执行 | 建议纳入 |
| `server/scripts/test-ash-mcp-registry.ts` | 链外 | 绿 | 2s |  | 建议纳入 |
| `server/scripts/test-assistant.ts` | 链外 | 绿 | 2s |  | 建议纳入 |
| `server/scripts/test-auto-title-run.ts` | 链外 | 绿 | 2s |  | 建议纳入 |
| `server/scripts/test-auto-title.ts` | 链外 | 绿 | 1s |  | 建议纳入 |
| `server/scripts/test-base-update-followups.ts` | 链外 | 绿 | 34s |  | 可纳入（较慢） |
| `server/scripts/test-base-update-recovery.ts` | 链外 | 绿 | 39s |  | 可纳入（较慢） |
| `server/scripts/test-branch-acceptance.ts` | 链外 | 绿 | 51s |  | 可纳入（较慢） |
| `server/scripts/test-branch-plan-creation.ts` | 链外 | 绿 | 14s |  | 建议纳入 |
| `server/scripts/test-branch-plan-scale.ts` | 链外 | 绿 | 10s |  | 建议纳入 |
| `server/scripts/test-branch-worktree-state.ts` | 链外 | 绿 | 21s |  | 可纳入（较慢） |
| `server/scripts/test-chat-ash-data.ts` | 链外 | 绿 | 6s |  | 建议纳入 |
| `server/scripts/test-chat-boundary.ts` | 链外 | 绿 | 15s |  | 建议纳入 |
| `server/scripts/test-chat-context.ts` | 链外 | 绿 | 3s |  | 建议纳入 |
| `server/scripts/test-chat-deletion.ts` | 链外 | 绿 | 2s |  | 建议纳入 |
| `server/scripts/test-chat-execution.ts` | 链外 | 绿 | 11s |  | 建议纳入 |
| `server/scripts/test-chat-git-metadata.ts` | 链外 | 绿 | 7s |  | 建议纳入 |
| `server/scripts/test-chat-large-workspace.ts` | 链外 | 绿 | 16s |  | 可纳入（较慢） |
| `server/scripts/test-chat-recovery.ts` | 链外 | 绿 | 5s |  | 建议纳入 |
| `server/scripts/test-chat-review.ts` | 链外 | 绿 | 2s |  | 建议纳入 |
| `server/scripts/test-chat-watch-load.ts` | 链外 | 绿 | 7s |  | 建议纳入 |
| `server/scripts/test-chat.ts` | 链外 | 绿 | 2s |  | 建议纳入 |
| `server/scripts/test-claude-background-hold.ts` | 链外 | 绿 | 2s |  | 建议纳入 |
| `server/scripts/test-claude-background-reaped.ts` | 链外 | 绿 | 3s |  | 建议纳入 |
| `server/scripts/test-claude-goal-live.ts` | 链外 | 绿 |  | 真 claude + 本地假上游（禁外网档跑） | 留在链外 |
| `server/scripts/test-claude-monitor-backfill.ts` | 链外 | 绿 | 2s |  | 建议纳入 |
| `server/scripts/test-claude-monitor-checkpoint.ts` | 链外 | 绿 | 4s |  | 建议纳入 |
| `server/scripts/test-claude-monitor-completeness.ts` | 链外 | 绿 | 10s |  | 建议纳入 |
| `server/scripts/test-claude-monitor-converge.ts` | 链外 | 绿 | 4s |  | 建议纳入 |
| `server/scripts/test-claude-monitor-hook.ts` | 链外 | 绿 | 5s |  | 建议纳入 |
| `server/scripts/test-claude-monitor-identity.ts` | 链外 | 绿 | 2s |  | 建议纳入 |
| `server/scripts/test-claude-monitor-ledger.ts` | 链外 | 绿 | 5s |  | 建议纳入 |
| `server/scripts/test-claude-monitor-origin.ts` | 链外 | 绿 | 2s |  | 建议纳入 |
| `server/scripts/test-claude-monitor-parse.ts` | 链外 | 绿 | 3s |  | 建议纳入 |
| `server/scripts/test-claude-monitor-pending-key.ts` | 链外 | 绿 | 1s |  | 建议纳入 |
| `server/scripts/test-claude-monitor-projection.ts` | 链外 | 绿 | 4s |  | 建议纳入 |
| `server/scripts/test-claude-monitor-reaped.ts` | 链外 | 绿 | 2s |  | 建议纳入 |
| `server/scripts/test-claude-monitor-recovery.ts` | 链外 | 绿 | 6s |  | 建议纳入 |
| `server/scripts/test-claude-monitor-unready.ts` | 链外 | 绿 | 2s |  | 建议纳入 |
| `server/scripts/test-claude-monitor-upgrade.ts` | 链外 | 绿 | 2s |  | 建议纳入 |
| `server/scripts/test-claude-monitor-wiring.ts` | 链外 | 绿 | 3s |  | 建议纳入 |
| `server/scripts/test-claude-reattach-background.ts` | 链外 | 绿 | 13s |  | 建议纳入 |
| `server/scripts/test-claude-retry-stall.ts` | 链外 | 绿 | 1s |  | 建议纳入 |
| `server/scripts/test-claude-settings-live.ts` | 链外 | 绿 |  | 真 claude，钩子在会话初始化就杀，不调模型（禁外网档跑） | 留在链外 |
| `server/scripts/test-claude-steer-ack.ts` | 链外 | 绿 | 7s |  | 建议纳入 |
| `server/scripts/test-claude-stream-errors.ts` | 链外 | 绿 | 12s |  | 建议纳入 |
| `server/scripts/test-claude-usage-accounting.ts` | 链外 | 绿 | 1s |  | 建议纳入 |
| `server/scripts/test-claude-usage-migration.ts` | 链外 | 绿 | 20s |  | 可纳入（较慢） |
| `server/scripts/test-cleanup-debt.ts` | 链外 | 绿 | 12s |  | 建议纳入 |
| `server/scripts/test-cleanup-ownership.ts` | 链外 | 绿 | 6s |  | 建议纳入 |
| `server/scripts/test-cleanup-pending.ts` | 链外 | 绿 | 1s |  | 建议纳入 |
| `server/scripts/test-cleanup-result.ts` | 链外 | 绿 | 1s |  | 建议纳入 |
| `server/scripts/test-cleanup-write-handoff.ts` | 链外 | 绿 | 13s |  | 建议纳入 |
| `server/scripts/test-cli-active-goal.ts` | 链外 | 绿 | 2s |  | 建议纳入 |
| `server/scripts/test-cli-catalog.ts` | 链外 | 绿 | 4s |  | 建议纳入 |
| `server/scripts/test-cli-command-startup.ts` | 链外 | 绿 | 2s |  | 建议纳入 |
| `server/scripts/test-cli-command-task.ts` | 链外 | 绿 | 2s |  | 建议纳入 |
| `server/scripts/test-cli-commands.ts` | 链外 | 绿 | 1s |  | 建议纳入 |
| `server/scripts/test-cli-goal-lifecycle.ts` | 链外 | 绿 | 7s |  | 建议纳入 |
| `server/scripts/test-cli-goal-queue.ts` | 链外 | 绿 | 20s |  | 可纳入（较慢） |
| `server/scripts/test-cli-goal-recovery.ts` | 链外 | 绿 | 7s |  | 建议纳入 |
| `server/scripts/test-cli-models.ts` | 链外 | 绿（部分未执行） | 5s | 机制段绿；严格档禁执行真 CLI，⑥「本机真实探测」与 codex 档位实探、claude control 探针按「没装」跳过 | 建议纳入 |
| `server/scripts/test-cli-overrides.ts` | 链外 | 绿 | 5s |  | 建议纳入 |
| `server/scripts/test-cli-plan-scheduling.ts` | 链外 | 绿 | 3s |  | 建议纳入 |
| `server/scripts/test-cli-state-scopes.ts` | 链外 | 绿 | 2s |  | 建议纳入 |
| `server/scripts/test-codex-archive-live.ts` | 链外 | 绿 |  | 真 codex + 本地假 provider；沙箱下 codex 的联网探测被挡，沙箱外绿 | 留在链外 |
| `server/scripts/test-codex-desktop-catalog.ts` | 链外 | 绿 | 1s |  | 建议纳入 |
| `server/scripts/test-codex-diagnostics.ts` | 链外 | 绿 | 1s |  | 建议纳入 |
| `server/scripts/test-codex-mcp-turn-token.ts` | 链外 | 绿 | 4s |  | 建议纳入 |
| `server/scripts/test-codex-provider.ts` | 链内 | 绿 | 1s |  |  |
| `server/scripts/test-codex-resident.ts` | 链外 | 绿 | 12s |  | 建议纳入 |
| `server/scripts/test-codex-resume-command.ts` | 链外 | 绿 | 2s |  | 建议纳入 |
| `server/scripts/test-context-1m-notice.ts` | 链外 | 绿 | 3s |  | 建议纳入 |
| `server/scripts/test-controllable-detached.ts` | 链外 | 绿 | 2s |  | 建议纳入 |
| `server/scripts/test-conversation-redact.ts` | 链外 | 绿 | 6s |  | 建议纳入 |
| `server/scripts/test-conversation-turn.ts` | 链外 | 绿 | 2s |  | 建议纳入 |
| `server/scripts/test-db-tx-ownership.ts` | 链外 | 绿 | 1s |  | 建议纳入 |
| `server/scripts/test-delivery-receipt.ts` | 链外 | 绿 | 15s |  | 建议纳入 |
| `server/scripts/test-detached-survival.ts` | 链外 | 绿 | 4s |  | 建议纳入 |
| `server/scripts/test-diagnostic-session-reply.ts` | 链外 | 绿 | 12s |  | 建议纳入 |
| `server/scripts/test-dir-picker.ts` | 链外 | 绿 | 1s |  | 建议纳入 |
| `server/scripts/test-duet-attachments.ts` | 链外 | 绿 | 2s |  | 建议纳入 |
| `server/scripts/test-duet-gate-version.ts` | 链外 | 绿 | 2s |  | 建议纳入 |
| `server/scripts/test-duet-image-ownership.ts` | 链外 | 绿 | 3s |  | 建议纳入 |
| `server/scripts/test-duet-native-trace.ts` | 链内 | 绿 | 2s |  |  |
| `server/scripts/test-duet-session-lost.ts` | 链外 | 绿 | 2s |  | 建议纳入 |
| `server/scripts/test-duet-stall-visibility.ts` | 链外 | 绿 | 2s |  | 建议纳入 |
| `server/scripts/test-executor-default-scope.ts` | 链外 | 绿 | 3s |  | 建议纳入 |
| `server/scripts/test-executor-overrides.ts` | 链外 | 绿 | 1s |  | 建议纳入 |
| `server/scripts/test-executor-resolution.ts` | 链外 | 绿 | 2s |  | 建议纳入 |
| `server/scripts/test-file-browser.ts` | 链外 | 绿 | 1s |  | 建议纳入 |
| `server/scripts/test-file-delete.ts` | 链内 | 绿 | 4s |  |  |
| `server/scripts/test-file-git-status.ts` | 链内 | 绿 | 1s |  |  |
| `server/scripts/test-file-search.ts` | 链外 | 绿 | 1s |  | 建议纳入 |
| `server/scripts/test-follow-up.ts` | 链外 | 绿 | 1s |  | 建议纳入 |
| `server/scripts/test-foreign-bins.ts` | 链外 | 绿 | 1s |  | 建议纳入 |
| `server/scripts/test-free-preview-review-turn.ts` | 链内 | 绿 | 3s |  |  |
| `server/scripts/test-free-review-anchor.ts` | 链内 | 绿 | 6s |  |  |
| `server/scripts/test-free-review-defer.ts` | 链内 | 绿 | 3s |  |  |
| `server/scripts/test-free-review-dispatch-delivery.ts` | 链内 | 绿 | 2s |  |  |
| `server/scripts/test-free-review-dispatch-ownership.ts` | 链内 | 绿 | 4s |  |  |
| `server/scripts/test-free-review-dispatch-retry.ts` | 链内 | 绿 | 4s |  |  |
| `server/scripts/test-free-review-dispute-gate.ts` | 链内 | 绿 | 13s |  |  |
| `server/scripts/test-free-review-dispute-target.ts` | 链内 | 绿 | 4s |  |  |
| `server/scripts/test-free-review-dispute.ts` | 链内 | 绿 | 2s |  |  |
| `server/scripts/test-free-review-reservation.ts` | 链内 | 绿 | 3s |  |  |
| `server/scripts/test-free-review-rounds.ts` | 链内 | 绿 | 3s |  |  |
| `server/scripts/test-free-review-settlement.ts` | 链内 | 绿 | 8s |  |  |
| `server/scripts/test-free-workflow-hardening.ts` | 链内 | 绿 | 7s |  |  |
| `server/scripts/test-free-workflow-lifecycle.ts` | 链内 | 绿 | 6s |  |  |
| `server/scripts/test-free-workflow-preview.ts` | 链内 | 绿 | 6s |  |  |
| `server/scripts/test-free-workflow.ts` | 链内 | 绿 | 4s |  |  |
| `server/scripts/test-git-workbench-change-stats.ts` | 链外 | 绿 | 1s |  | 建议纳入 |
| `server/scripts/test-git-workbench-maintenance.ts` | 链外 | 绿 | 19s |  | 可纳入（较慢） |
| `server/scripts/test-git-workbench-outcomes.ts` | 链外 | 绿 | 42s |  | 可纳入（较慢） |
| `server/scripts/test-git-workbench-partial-discard.ts` | 链外 | 绿 | 10s |  | 建议纳入 |
| `server/scripts/test-git-workbench-safety.ts` | 链外 | 绿 | 16s |  | 可纳入（较慢） |
| `server/scripts/test-git-workbench.ts` | 链外 | 绿 | 34s |  | 可纳入（较慢） |
| `server/scripts/test-goal-native-live.ts` | 链外 | 绿 |  | 同上 | 留在链外 |
| `server/scripts/test-handoff-accept-gate.ts` | 链外 | 绿 | 2s |  | 建议纳入 |
| `server/scripts/test-handoff-accepted-return.ts` | 链外 | 绿 | 5s |  | 建议纳入 |
| `server/scripts/test-handoff-auth.ts` | 链外 | 绿 | 11s | 严格档禁执行真 CLI 时对端报「没装 claude」；放开执行（仍禁外网）后绿 | 建议纳入 |
| `server/scripts/test-handoff-capability-e2e.ts` | 链外 | 绿 | 7s | 严格档禁执行真 CLI 时对端报「没装 claude」；放开执行（仍禁外网）后绿 | 建议纳入 |
| `server/scripts/test-handoff-capability.ts` | 链外 | 绿 | 4s |  | 建议纳入 |
| `server/scripts/test-handoff-cli-config-dir.ts` | 链外 | 绿 | 2s |  | 建议纳入 |
| `server/scripts/test-handoff-free-workflow-rows.ts` | 链外 | 绿 | 1s |  | 建议纳入 |
| `server/scripts/test-handoff-holder.ts` | 链外 | 绿 | 1s |  | 建议纳入 |
| `server/scripts/test-handoff-key-concurrency.ts` | 链外 | 绿 | 1s |  | 建议纳入 |
| `server/scripts/test-handoff-key-persistence.ts` | 链外 | 绿 | 2s |  | 建议纳入 |
| `server/scripts/test-handoff-local.ts` | 链外 | 绿 | 3s |  | 建议纳入 |
| `server/scripts/test-handoff-notice.ts` | 链外 | 绿 | 5s |  | 建议纳入 |
| `server/scripts/test-handoff-outbound-key.ts` | 链外 | 绿 | 1s |  | 建议纳入 |
| `server/scripts/test-handoff-peer-key.ts` | 链外 | 绿 | 1s |  | 建议纳入 |
| `server/scripts/test-handoff-remote-return.ts` | 链外 | 绿 | 2s |  | 建议纳入 |
| `server/scripts/test-handoff-return.ts` | 链外 | 绿 | 11s | 严格档禁执行真 CLI 时对端报「没装 claude」；放开执行（仍禁外网）后绿 | 建议纳入 |
| `server/scripts/test-handoff-source-address.ts` | 链外 | 绿 | 3s |  | 建议纳入 |
| `server/scripts/test-handoff.ts` | 链外 | 绿 | 7s | 严格档禁执行真 CLI 时对端报「没装 claude」；放开执行（仍禁外网）后绿 | 建议纳入 |
| `server/scripts/test-holder-scan.ts` | 链外 | 绿 | 19s |  | 可纳入（较慢） |
| `server/scripts/test-human-approval.ts` | 链外 | 绿 | 3s |  | 建议纳入 |
| `server/scripts/test-idle-delivery-verdict.ts` | 链内 | 绿 | 30s |  |  |
| `server/scripts/test-im-actor.ts` | 链外 | 绿 | 3s |  | 建议纳入 |
| `server/scripts/test-im-exits.ts` | 链外 | 绿 | 26s |  | 可纳入（较慢） |
| `server/scripts/test-im-gates.ts` | 链外 | 绿 | 9s |  | 建议纳入 |
| `server/scripts/test-im-inbound.ts` | 链外 | 绿 | 23s |  | 可纳入（较慢） |
| `server/scripts/test-im-outcomes.ts` | 链外 | 绿 | 17s |  | 可纳入（较慢） |
| `server/scripts/test-im-pairing.ts` | 链外 | 绿 | 9s |  | 建议纳入 |
| `server/scripts/test-im-recall.ts` | 链外 | 绿 | 8s |  | 建议纳入 |
| `server/scripts/test-im-recovery.ts` | 链外 | 绿 | 26s |  | 可纳入（较慢） |
| `server/scripts/test-im-replies.ts` | 链外 | 绿 | 21s |  | 可纳入（较慢） |
| `server/scripts/test-im-requests.ts` | 链外 | 绿 | 8s |  | 建议纳入 |
| `server/scripts/test-im-review.ts` | 链外 | 绿 | 15s |  | 建议纳入 |
| `server/scripts/test-im-settling.ts` | 链外 | 绿 | 8s |  | 建议纳入 |
| `server/scripts/test-im-wire.ts` | 链外 | 绿 | 2s |  | 建议纳入 |
| `server/scripts/test-kernel-confine.ts` | 链外 | 绿 | 1s |  | 建议纳入 |
| `server/scripts/test-kill-lineage.ts` | 链外 | 绿 | 2s |  | 建议纳入 |
| `server/scripts/test-kimi-live.ts` | 链外 | 绿 |  | 真 kimi + 本地假上游（禁外网档跑） | 留在链外 |
| `server/scripts/test-kimi.ts` | 链外 | 绿 | 2s |  | 建议纳入 |
| `server/scripts/test-late-refusal-identity.ts` | 链内 | 绿 | 4s |  |  |
| `server/scripts/test-launch-abandon.ts` | 链外 | 绿 | 3s |  | 建议纳入 |
| `server/scripts/test-llm-relay.ts` | 链外 | 绿 | 4s | 沙箱挡 ::ffff:127.0.0.1，放开外网档后绿 | 建议纳入 |
| `server/scripts/test-local-open.ts` | 链外 | 绿 | 1s |  | 建议纳入 |
| `server/scripts/test-mcp-handoff.ts` | 链外 | 绿 | 1s |  | 建议纳入 |
| `server/scripts/test-missing-task-writes.ts` | 链外 | 绿 | 2s |  | 建议纳入 |
| `server/scripts/test-model-effort-isolation.ts` | 链外 | 绿 | 2s | 严格档禁执行真 CLI 时对端报「没装 claude」；放开执行（仍禁外网）后绿 | 建议纳入 |
| `server/scripts/test-monitor-block-eligibility.ts` | 链外 | 绿 | 30s |  | 可纳入（较慢） |
| `server/scripts/test-monitor-checkpoint-recovery.ts` | 链内 | 绿 | 155s |  |  |
| `server/scripts/test-monitor-complete-columns.ts` | 链外 | 绿 | 1s |  | 建议纳入 |
| `server/scripts/test-monitor-complete-gate.ts` | 链外 | 绿 | 9s |  | 建议纳入 |
| `server/scripts/test-monitor-create-protocol.ts` | 链外 | 绿 | 6s |  | 建议纳入 |
| `server/scripts/test-monitor-create-window.ts` | 链外 | 绿 | 15s |  | 建议纳入 |
| `server/scripts/test-monitor-end-condition-gate.ts` | 链外 | 绿 | 3s |  | 建议纳入 |
| `server/scripts/test-monitor-end-owed.ts` | 链外 | 绿 | 18s |  | 可纳入（较慢） |
| `server/scripts/test-monitor-generation.ts` | 链外 | 绿 | 5s |  | 建议纳入 |
| `server/scripts/test-monitor-intent-handover.ts` | 链外 | 绿 | 19s |  | 可纳入（较慢） |
| `server/scripts/test-monitor-merge-window.ts` | 链外 | 绿 | 32s |  | 可纳入（较慢） |
| `server/scripts/test-monitor-offline.ts` | 链外 | 绿 | 20s |  | 可纳入（较慢） |
| `server/scripts/test-monitor-owed-batch.ts` | 链外 | 绿 | 12s |  | 建议纳入 |
| `server/scripts/test-monitor-perturbation.ts` | 链外 | 绿 | 1s |  | 建议纳入 |
| `server/scripts/test-monitor-races.ts` | 链外 | 绿 | 14s |  | 建议纳入 |
| `server/scripts/test-monitor-reclaim-debt.ts` | 链外 | 绿 | 43s |  | 可纳入（较慢） |
| `server/scripts/test-monitor-reclaim-identity.ts` | 链外 | 绿 | 12s |  | 建议纳入 |
| `server/scripts/test-monitor-reclaim-unit.ts` | 链外 | 绿 | 32s |  | 可纳入（较慢） |
| `server/scripts/test-monitor-review-lifecycle.ts` | 链外 | 绿 | 4s |  | 建议纳入 |
| `server/scripts/test-monitor-settle-handover.ts` | 链外 | 绿 | 33s |  | 可纳入（较慢） |
| `server/scripts/test-monitor-turn-handoff.ts` | 链外 | 绿 | 3s |  | 建议纳入 |
| `server/scripts/test-monitor-unit-proof.ts` | 链外 | 绿 | 41s |  | 可纳入（较慢） |
| `server/scripts/test-monitor-wake-data.ts` | 链外 | 绿 | 2s |  | 建议纳入 |
| `server/scripts/test-monitor-wake-role.ts` | 链外 | 绿 | 5s |  | 建议纳入 |
| `server/scripts/test-monitor-wake-turns.ts` | 链外 | 绿 | 2s |  | 建议纳入 |
| `server/scripts/test-monitors.ts` | 链外 | 绿 | 17s |  | 可纳入（较慢） |
| `server/scripts/test-multi-user-agent.ts` | 链外 | 绿 | 2s |  | 建议纳入 |
| `server/scripts/test-multi-user-git.ts` | 链外 | 绿 | 5s |  | 建议纳入 |
| `server/scripts/test-multi-user-members.ts` | 链外 | 绿 | 2s |  | 建议纳入 |
| `server/scripts/test-multi-user-paths.ts` | 链外 | 绿 | 1s |  | 建议纳入 |
| `server/scripts/test-multi-user-run.ts` | 链外 | 绿 | 9s |  | 建议纳入 |
| `server/scripts/test-multi-user-settings.ts` | 链外 | 绿 | 1s |  | 建议纳入 |
| `server/scripts/test-multi-user-setup.ts` | 链外 | 绿 | 3s |  | 建议纳入 |
| `server/scripts/test-native-activity-stream.ts` | 链内 | 绿 | 2s |  |  |
| `server/scripts/test-native-agent-models.ts` | 链内 | 绿 | 1s |  |  |
| `server/scripts/test-native-command-turn.ts` | 链外 | 绿 | 2s |  | 建议纳入 |
| `server/scripts/test-native-steer.ts` | 链外 | 绿 | 4s |  | 建议纳入 |
| `server/scripts/test-native-upload-visibility.ts` | 链内 | 绿 | 4s |  |  |
| `server/scripts/test-native-work.ts` | 链内 | 绿 | 2s |  |  |
| `server/scripts/test-no-libsql.ts` | 链外 | 绿 | 1s |  | 建议纳入 |
| `server/scripts/test-note-task-history.ts` | 链外 | 绿 | 2s |  | 建议纳入 |
| `server/scripts/test-onboarding-gate.ts` | 链外 | 绿 | 1s |  | 建议纳入 |
| `server/scripts/test-open-in-ide.ts` | 链外 | 绿 | 4s |  | 建议纳入 |
| `server/scripts/test-openai-converter.ts` | 链外 | 绿 | 1s |  | 建议纳入 |
| `server/scripts/test-openers-windows.ts` | 链外 | 绿 | 1s |  | 建议纳入 |
| `server/scripts/test-path-boundary.ts` | 链外 | 绿 | 1s |  | 建议纳入 |
| `server/scripts/test-peer-context.ts` | 链外 | 绿 | 1s |  | 建议纳入 |
| `server/scripts/test-pending-after-handoff.ts` | 链外 | 绿 | 2s |  | 建议纳入 |
| `server/scripts/test-pending-after.ts` | 链外 | 绿 | 3s |  | 建议纳入 |
| `server/scripts/test-personal-cli-settings.ts` | 链内 | 绿 | 1s |  |  |
| `server/scripts/test-post-merge-review.ts` | 链内 | 绿 | 2s |  |  |
| `server/scripts/test-powershell-command.ts` | 链外 | 绿（部分未执行） | 1s | 开头 4 条 CLIXML 判错断言绿；PowerShell 语义段需 Windows 或 ASH_TEST_POWERSHELL，本机无 pwsh，未执行 | 建议纳入 |
| `server/scripts/test-preview-annotation.ts` | 链外 | 绿 | 1s |  | 建议纳入 |
| `server/scripts/test-preview-assist.ts` | 链外 | 绿 | 13s |  | 建议纳入 |
| `server/scripts/test-preview-cache-path.ts` | 链外 | 绿 | 1s |  | 建议纳入 |
| `server/scripts/test-preview-command.ts` | 链外 | 绿 | 1s |  | 建议纳入 |
| `server/scripts/test-preview-cookies.ts` | 链外 | 绿 | 1s |  | 建议纳入 |
| `server/scripts/test-preview-deps.ts` | 链外 | 绿 | 3s |  | 建议纳入 |
| `server/scripts/test-preview-host-api.ts` | 链外 | 绿 | 4s |  | 建议纳入 |
| `server/scripts/test-preview-launch.ts` | 链外 | 绿 | 5s |  | 建议纳入 |
| `server/scripts/test-preview-lent-port.ts` | 链外 | 绿 | 2s |  | 建议纳入 |
| `server/scripts/test-preview-log.ts` | 链外 | 绿 | 1s |  | 建议纳入 |
| `server/scripts/test-preview-probe.ts` | 链外 | 绿 | 1s |  | 建议纳入 |
| `server/scripts/test-preview-process.ts` | 链外 | 绿 | 18s |  | 可纳入（较慢） |
| `server/scripts/test-preview-revocation.ts` | 链内 | 绿 | 17s |  |  |
| `server/scripts/test-preview-seed.ts` | 链外 | 绿 | 1s |  | 建议纳入 |
| `server/scripts/test-preview-settings-proxy.ts` | 链外 | 绿 | 14s |  | 建议纳入 |
| `server/scripts/test-preview-stop-notice.ts` | 链外 | 绿 | 3s |  | 建议纳入 |
| `server/scripts/test-preview-workspace.ts` | 链外 | 绿 | 6s |  | 建议纳入 |
| `server/scripts/test-process-identity.ts` | 链外 | 绿 | 34s |  | 可纳入（较慢） |
| `server/scripts/test-process-subtrees.ts` | 链外 | 绿 | 8s |  | 建议纳入 |
| `server/scripts/test-progress-boundary.ts` | 链外 | 绿 | 12s |  | 建议纳入 |
| `server/scripts/test-project-clone.ts` | 链外 | 绿 | 1s |  | 建议纳入 |
| `server/scripts/test-project-commands.ts` | 链外 | 绿 | 37s |  | 可纳入（较慢） |
| `server/scripts/test-project-dir.ts` | 链外 | 绿 | 2s |  | 建议纳入 |
| `server/scripts/test-project-git-config.ts` | 链外 | 绿 | 2s |  | 建议纳入 |
| `server/scripts/test-project-git.ts` | 链外 | 绿 | 8s |  | 建议纳入 |
| `server/scripts/test-prompt-budget.ts` | 链内 | 绿 | 2s |  |  |
| `server/scripts/test-protocol-evidence.ts` | 链外 | 绿 | 5s |  | 建议纳入 |
| `server/scripts/test-question-history.ts` | 链外 | 绿 | 2s |  | 建议纳入 |
| `server/scripts/test-question-supersede.ts` | 链外 | 绿 | 3s |  | 建议纳入 |
| `server/scripts/test-queue-order.ts` | 链外 | 绿 | 2s |  | 建议纳入 |
| `server/scripts/test-queue.ts` | 无 script | 绿 | 2s |  | 建议纳入 |
| `server/scripts/test-regression-availability.ts` | 链内 | 绿 | 3s |  |  |
| `server/scripts/test-regression-conclusion-atomicity.ts` | 链内 | 绿 | 6s |  |  |
| `server/scripts/test-regression-file-types.ts` | 链内 | 绿 | 3s |  |  |
| `server/scripts/test-regression-input.ts` | 链内 | 绿 | 7s |  |  |
| `server/scripts/test-regression-lifecycle.ts` | 链内 | 绿 | 4s |  |  |
| `server/scripts/test-regression-order.ts` | 链内 | 绿 | 7s |  |  |
| `server/scripts/test-regression-recovery.ts` | 链内 | 绿 | 39s |  |  |
| `server/scripts/test-regression-reuse.ts` | 链内 | 绿 | 10s |  |  |
| `server/scripts/test-regression-settlement.ts` | 链内 | 绿 | 24s |  |  |
| `server/scripts/test-regression-start.ts` | 链内 | 绿 | 3s |  |  |
| `server/scripts/test-relay-proxy.ts` | 链外 | 绿 | 1s |  | 建议纳入 |
| `server/scripts/test-remote-access.ts` | 链内 | 绿 | 4s |  |  |
| `server/scripts/test-reopen-acceptance.ts` | 链外 | 绿 | 1s |  | 建议纳入 |
| `server/scripts/test-repair-start.ts` | 链内 | 绿 | 12s |  |  |
| `server/scripts/test-repo-lock.ts` | 链外 | 绿 | 7s |  | 建议纳入 |
| `server/scripts/test-request-timing.ts` | 链外 | 绿 | 1s |  | 建议纳入 |
| `server/scripts/test-response-compression.ts` | 链外 | 绿 | 1s |  | 建议纳入 |
| `server/scripts/test-resume-prompt-broadcast.ts` | 链外 | 绿 | 1s |  | 建议纳入 |
| `server/scripts/test-retry-turn-queue.ts` | 链外 | 绿 | 8s |  | 建议纳入 |
| `server/scripts/test-retry-turn.ts` | 链外 | 绿 | 2s |  | 建议纳入 |
| `server/scripts/test-review-accepted-policy.ts` | 链内 | 绿 | 13s |  |  |
| `server/scripts/test-review-accepted-tail.ts` | 链内 | 绿 | 13s |  |  |
| `server/scripts/test-review-boundaries.ts` | 链内 | 绿 | 22s |  |  |
| `server/scripts/test-review-delivery-freeze.ts` | 链内 | 绿 | 18s |  |  |
| `server/scripts/test-review-entry.ts` | 链内 | 绿 | 12s |  |  |
| `server/scripts/test-review-flow.ts` | 链内 | 绿 | 3s |  |  |
| `server/scripts/test-review-gate-repair.ts` | 链内 | 绿 | 5s |  |  |
| `server/scripts/test-review-history.ts` | 链内 | 绿 | 48s |  |  |
| `server/scripts/test-review-no-verdict.ts` | 链外 | 绿 | 2s |  | 建议纳入 |
| `server/scripts/test-review-ownership.ts` | 链内 | 绿 | 35s |  |  |
| `server/scripts/test-review-recurrence.ts` | 链内 | 绿 | 2s |  |  |
| `server/scripts/test-review-recurs-boundary.ts` | 链内 | 绿 | 2s |  |  |
| `server/scripts/test-review-repair-delivery.ts` | 链内 | 绿 | 19s |  |  |
| `server/scripts/test-review-resume.ts` | 链内 | 绿 | 1s |  |  |
| `server/scripts/test-review-start-recovery.ts` | 链内 | 绿 | 114s |  |  |
| `server/scripts/test-review-sweep.ts` | 链内 | 绿 | 1s |  |  |
| `server/scripts/test-review-transfer.ts` | 链内 | 绿 | 5s |  |  |
| `server/scripts/test-review-wait-storage.ts` | 链内 | 绿 | 29s |  |  |
| `server/scripts/test-review-wait.ts` | 链内 | 绿 | 32s |  |  |
| `server/scripts/test-run-notices.ts` | 链外 | 绿 | 4s |  | 建议纳入 |
| `server/scripts/test-run-trace-retention.ts` | 链内 | 绿 | 1s |  |  |
| `server/scripts/test-scm-guard.ts` | 链外 | 绿 | 8s |  | 建议纳入 |
| `server/scripts/test-scm-nested.ts` | 链外 | 绿 | 3s |  | 建议纳入 |
| `server/scripts/test-scm-workspace.ts` | 链外 | 绿 | 5s |  | 建议纳入 |
| `server/scripts/test-search-experience.ts` | 链内 | 绿 | 1s |  |  |
| `server/scripts/test-search-query.ts` | 链外 | 绿 | 1s |  | 建议纳入 |
| `server/scripts/test-search-scan.ts` | 链外 | 绿 | 1s |  | 建议纳入 |
| `server/scripts/test-search-stream.ts` | 链内 | 绿 | 13s |  |  |
| `server/scripts/test-search-visibility.ts` | 链外 | 绿 | 4s |  | 建议纳入 |
| `server/scripts/test-seat-ownership.ts` | 链外 | 绿 | 3s |  | 建议纳入 |
| `server/scripts/test-service-ports-scan.ts` | 链外 | 绿 | 1s |  | 建议纳入 |
| `server/scripts/test-session-lost.ts` | 链外 | 绿 | 2s |  | 建议纳入 |
| `server/scripts/test-session-notice.ts` | 链外 | 绿 | 2s |  | 建议纳入 |
| `server/scripts/test-session-read-errors.ts` | 链外 | 绿 | 2s |  | 建议纳入 |
| `server/scripts/test-session-trace.ts` | 链外 | 绿 | 1s |  | 建议纳入 |
| `server/scripts/test-session-turn-identity.ts` | 链外 | 绿 | 93s |  | 留在链外 |
| `server/scripts/test-session-turn-migration.ts` | 链外 | 绿 | 1s |  | 建议纳入 |
| `server/scripts/test-session-turn-persist.ts` | 链外 | 绿 | 2s |  | 建议纳入 |
| `server/scripts/test-session-waiting.ts` | 链外 | 绿 | 1s |  | 建议纳入 |
| `server/scripts/test-settlement-note.ts` | 链外 | 绿 | 2s |  | 建议纳入 |
| `server/scripts/test-side-authorization.ts` | 链内 | 绿 | 1s |  |  |
| `server/scripts/test-side-chat-deletion.ts` | 链内 | 绿 | 2s |  |  |
| `server/scripts/test-side-chat.ts` | 链内 | 绿 | 7s |  |  |
| `server/scripts/test-silence-tier.ts` | 链外 | 绿 | 12s |  | 建议纳入 |
| `server/scripts/test-singleton.ts` | 链外 | 绿 | 21s |  | 可纳入（较慢） |
| `server/scripts/test-skills.ts` | 链外 | 绿 | 1s |  | 建议纳入 |
| `server/scripts/test-ssh-profile-retire.ts` | 链外 | 绿 | 2s |  | 建议纳入 |
| `server/scripts/test-stall-flag.ts` | 链外 | 绿 | 1s |  | 建议纳入 |
| `server/scripts/test-stall-journal.ts` | 链外 | 绿 | 5s |  | 建议纳入 |
| `server/scripts/test-stall-restart.ts` | 链外 | 绿 | 39s |  | 可纳入（较慢） |
| `server/scripts/test-stall-settle.ts` | 链外 | 绿 | 2s |  | 建议纳入 |
| `server/scripts/test-steer-refused-reply.ts` | 链外 | 绿 | 7s |  | 建议纳入 |
| `server/scripts/test-stop-evidence.ts` | 链外 | 绿 | 1s |  | 建议纳入 |
| `server/scripts/test-stop-review.ts` | 链外 | 绿 | 5s |  | 建议纳入 |
| `server/scripts/test-stop-turn-observation.ts` | 链外 | 绿 | 2s |  | 建议纳入 |
| `server/scripts/test-stop-verification.ts` | 链外 | 绿 | 9s |  | 建议纳入 |
| `server/scripts/test-system-resume.ts` | 链内 | 绿 | 3s |  |  |
| `server/scripts/test-task-activity.ts` | 链外 | 绿 | 3s |  | 建议纳入 |
| `server/scripts/test-task-artifacts-concurrent.ts` | 链外 | 绿 | 5s |  | 建议纳入 |
| `server/scripts/test-task-artifacts-evidence.ts` | 链外 | 绿 | 5s |  | 建议纳入 |
| `server/scripts/test-task-artifacts.ts` | 链外 | 绿 | 4s |  | 建议纳入 |
| `server/scripts/test-task-background-state.ts` | 链内 | 绿 | 2s |  |  |
| `server/scripts/test-task-creation-origin.ts` | 链外 | 绿 | 2s |  | 建议纳入 |
| `server/scripts/test-task-delete-disk.ts` | 链内 | 绿 | 2s |  |  |
| `server/scripts/test-task-derivation-policy.ts` | 链外 | 绿 | 2s |  | 建议纳入 |
| `server/scripts/test-task-direction-epoch-entries.ts` | 链外 | 绿 | 9s |  | 建议纳入 |
| `server/scripts/test-task-event-timestamps.ts` | 链外 | 绿 | 2s |  | 建议纳入 |
| `server/scripts/test-task-file-raw.ts` | 链外 | 绿 | 2s |  | 建议纳入 |
| `server/scripts/test-task-list-body.ts` | 链外 | 绿 | 2s |  | 建议纳入 |
| `server/scripts/test-task-memos.ts` | 链外 | 绿 | 1s |  | 建议纳入 |
| `server/scripts/test-task-page.ts` | 链外 | 绿 | 1s |  | 建议纳入 |
| `server/scripts/test-task-reply-fork.ts` | 链内 | 绿 | 2s |  |  |
| `server/scripts/test-task-star.ts` | 链外 | 绿 | 2s |  | 建议纳入 |
| `server/scripts/test-task-steer-hardening.ts` | 链外 | 绿 | 2s |  | 建议纳入 |
| `server/scripts/test-task-steer-rollback.ts` | 链外 | 绿 | 2s |  | 建议纳入 |
| `server/scripts/test-task-workspace.ts` | 链外 | 绿 | 5s |  | 建议纳入 |
| `server/scripts/test-team-accept-crew.ts` | 链外 | 绿 | 3s |  | 建议纳入 |
| `server/scripts/test-team-inbound-durability.ts` | 链外 | 绿 | 4s |  | 建议纳入 |
| `server/scripts/test-team-inbound-interleave.ts` | 链外 | 绿 | 2s |  | 建议纳入 |
| `server/scripts/test-team-inbound-resilience.ts` | 链外 | 绿 | 4s |  | 建议纳入 |
| `server/scripts/test-team-lead-resilience.ts` | 链外 | 绿 | 5s |  | 建议纳入 |
| `server/scripts/test-team-native-command.ts` | 链外 | 绿 | 2s |  | 建议纳入 |
| `server/scripts/test-team-notice-trace.ts` | 链外 | 绿 | 2s |  | 建议纳入 |
| `server/scripts/test-team-session-notice.ts` | 链外 | 绿 | 4s |  | 建议纳入 |
| `server/scripts/test-team-silence-tier.ts` | 链外 | 绿 | 5s |  | 建议纳入 |
| `server/scripts/test-team-turn-artifacts.ts` | 链外 | 绿 | 19s |  | 可纳入（较慢） |
| `server/scripts/test-team-user-interrupt.ts` | 链外 | 绿 | 2s |  | 建议纳入 |
| `server/scripts/test-terminal-capacity.ts` | 链外 | 绿 | 25s |  | 可纳入（较慢） |
| `server/scripts/test-terminal-lifecycle.ts` | 链外 | 绿 | 6s |  | 建议纳入 |
| `server/scripts/test-terminal-pty.ts` | 链外 | 绿 | 6s |  | 建议纳入 |
| `server/scripts/test-terminal.ts` | 链外 | 绿 | 15s |  | 建议纳入 |
| `server/scripts/test-turn-baseline.ts` | 链外 | 绿 | 3s |  | 建议纳入 |
| `server/scripts/test-turn-end-wake.ts` | 链内 | 绿 | 13s |  |  |
| `server/scripts/test-turn-freeze.ts` | 链外 | 绿 | 2s |  | 建议纳入 |
| `server/scripts/test-turn-outcomes.ts` | 链外 | 绿 | 2s |  | 建议纳入 |
| `server/scripts/test-turn-output.ts` | 链外 | 绿 | 1s |  | 建议纳入 |
| `server/scripts/test-turn-ownership.ts` | 链外 | 绿 | 2s |  | 建议纳入 |
| `server/scripts/test-turn-reclaim.ts` | 链外 | 绿 | 6s |  | 建议纳入 |
| `server/scripts/test-turn-release-ownership.ts` | 链外 | 绿 | 1s |  | 建议纳入 |
| `server/scripts/test-turn-stall-progress.ts` | 链外 | 绿 | 1s |  | 建议纳入 |
| `server/scripts/test-turn-stall.ts` | 链外 | 绿 | 12s |  | 建议纳入 |
| `server/scripts/test-turn-visibility.ts` | 链外 | 绿 | 2s |  | 建议纳入 |
| `server/scripts/test-undriven-turn.ts` | 链外 | 绿 | 38s |  | 可纳入（较慢） |
| `server/scripts/test-upload-names.ts` | 链外 | 绿 | 1s |  | 建议纳入 |
| `server/scripts/test-upload-visibility.ts` | 链外 | 绿 | 6s |  | 建议纳入 |
| `server/scripts/test-usage-accounting.ts` | 链外 | 绿 | 3s |  | 建议纳入 |
| `server/scripts/test-user-cli-mcp.ts` | 链外 | 绿 | 2s |  | 建议纳入 |
| `server/scripts/test-user-cli-write-identity.ts` | 链外 | 绿 | 1s |  | 建议纳入 |
| `server/scripts/test-user-directives.ts` | 链外 | 绿 | 1s |  | 建议纳入 |
| `server/scripts/test-user-shell-powershell.ts` | 链外 | 有意不跑 | 1s | Windows 专属：非 Windows 只打印 `skipped: requires Windows` 就退出，全部用例在 else 里，Mac 上一条没执行；退出码 0 不算绿 | 留在链外 |
| `server/scripts/test-verify-override.ts` | 链外 | 绿 | 2s |  | 建议纳入 |
| `server/scripts/test-win-launch.ts` | 链外 | 绿 | 1s |  | 建议纳入 |
| `server/scripts/test-windows-detached.ts` | 链外 | 绿（部分未执行） | 1s | 前半段（证据核对外壳身份）绿；`process.platform === "win32"` 的真进程清理段在 Mac 上未执行 | 建议纳入 |
| `server/scripts/test-workflow-def.ts` | 链外 | 绿 | 1s |  | 建议纳入 |
| `server/scripts/test-workflow-gate.ts` | 链外 | 绿 | 3s |  | 建议纳入 |
| `server/scripts/test-workflow-library.ts` | 链外 | 绿 | 1s |  | 建议纳入 |
| `server/scripts/test-workflow-mode-default.ts` | 链外 | 绿 | 2s |  | 建议纳入 |
| `server/scripts/test-workflow-run.ts` | 链外 | 绿 | 5s |  | 建议纳入 |
| `server/scripts/test-workspace-cleanup.ts` | 链外 | 绿 | 2s |  | 建议纳入 |
| `server/scripts/test-workspace-dirty.ts` | 链外 | 绿 | 1s |  | 建议纳入 |
| `server/scripts/test-worktree-default.ts` | 链外 | 绿 | 3s |  | 建议纳入 |
| `server/scripts/test-worktree-leftover.ts` | 链外 | 绿 | 2s |  | 建议纳入 |
| `server/scripts/test-worktree-porcelain.ts` | 链外 | 绿 | 3s |  | 建议纳入 |
| `server/scripts/test-worktree-recovery.ts` | 链外 | 绿 | 3s |  | 建议纳入 |
| `web/scripts/test-accept-gate-dom.mjs` | 链内 | 绿 | 173s |  |  |
| `web/scripts/test-acceptance-workspace-commit-dom.mjs` | 链内 | 绿 | 6s |  |  |
| `web/scripts/test-agent-plate.mjs` | 链外 | 绿 | 2s |  | 建议纳入 |
| `web/scripts/test-agent-profile-add-gate.mjs` | 链外 | 绿 | 2s |  | 建议纳入 |
| `web/scripts/test-annotation-review-presentation.tsx` | 链外 | 绿 | 3s |  | 建议纳入 |
| `web/scripts/test-annotation-review.ts` | 链外 | 绿 | 1s |  | 建议纳入 |
| `web/scripts/test-assistant-entry.mjs` | 链内 | 绿 | 34s |  |  |
| `web/scripts/test-auth-boot.mjs` | 链内 | 绿 | 5s |  |  |
| `web/scripts/test-branch-acceptance.mjs` | 链内 | 绿 | 138s |  |  |
| `web/scripts/test-bulk-handoff-dialog.mjs` | 链内 | 绿 | 4s |  |  |
| `web/scripts/test-bulk-handoff.mjs` | 链内 | 绿 | 1s |  |  |
| `web/scripts/test-catch-up.mjs` | 链内 | 绿 | 1s |  |  |
| `web/scripts/test-chat-browser.mjs` | 链外 | 绿 | 76s |  | 留在链外 |
| `web/scripts/test-claude-trace-accounting.mjs` | 链内 | 绿 | 1s |  |  |
| `web/scripts/test-cli-effort-policy.mjs` | 链内 | 绿 | 3s |  |  |
| `web/scripts/test-cli-goal-lifecycle-ui.mjs` | 链外 | 绿 | 15s |  | 建议纳入 |
| `web/scripts/test-client-id.mjs` | 链内 | 绿 | 1s |  |  |
| `web/scripts/test-command-placeholders.mjs` | 链内 | 绿 | 5s |  |  |
| `web/scripts/test-command-session-state.mjs` | 链内 | 绿 | 1s |  |  |
| `web/scripts/test-compaction-markers.mjs` | 链内 | 绿 | 3s |  |  |
| `web/scripts/test-composer-branches.mjs` | 链内 | 绿 | 14s |  |  |
| `web/scripts/test-composer-delete-race.mjs` | 链内 | 绿 | 10s |  |  |
| `web/scripts/test-composer-draft.mjs` | 链内 | 绿 | 3s |  |  |
| `web/scripts/test-composer-studio.mjs` | 链内 | 绿 | 16s |  |  |
| `web/scripts/test-composer-upload.mjs` | 链内 | 绿 | 3s |  |  |
| `web/scripts/test-confirm-enter.mjs` | 链内 | 绿 | 4s |  |  |
| `web/scripts/test-context-meter.tsx` | 链内 | 绿 | 3s |  |  |
| `web/scripts/test-conversation-continuation.tsx` | 链内 | 绿 | 3s |  |  |
| `web/scripts/test-conversation-fork-dom.mjs` | 链内 | 绿 | 4s |  |  |
| `web/scripts/test-conversation-fork.ts` | 链内 | 绿 | 1s |  |  |
| `web/scripts/test-conversation-input-rail-dom.mjs` | 链内 | 绿 | 12s |  |  |
| `web/scripts/test-conversation-inputs.ts` | 链内 | 绿 | 1s |  |  |
| `web/scripts/test-conversation-keys.mjs` | 链内 | 绿 | 1s |  |  |
| `web/scripts/test-conversation-live-turn-owner.mjs` | 链内 | 绿 | 1s |  |  |
| `web/scripts/test-conversation-mid-turn-notes.ts` | 链内 | 绿 | 1s |  |  |
| `web/scripts/test-conversation-notes-dom.mjs` | 链内 | 绿 | 2s |  |  |
| `web/scripts/test-conversation-notes.mjs` | 链内 | 绿 | 1s |  |  |
| `web/scripts/test-conversation-steer.mjs` | 链内 | 绿 | 1s |  |  |
| `web/scripts/test-conversation-system-note.mjs` | 链内 | 绿 | 1s |  |  |
| `web/scripts/test-conversation-task-switch.mjs` | 链内 | 绿 | 20s |  |  |
| `web/scripts/test-create-project-scope.mjs` | 链内 | 绿 | 4s |  |  |
| `web/scripts/test-created-task-merge.mjs` | 链外 | 绿 | 1s |  | 建议纳入 |
| `web/scripts/test-debate-lane.mjs` | 链内 | 绿 | 4s |  |  |
| `web/scripts/test-diff-model.ts` | 链内 | 绿 | 1s |  |  |
| `web/scripts/test-dispute-timeline-cta.mjs` | 链内 | 绿 | 3s |  |  |
| `web/scripts/test-duet-timeline.mjs` | 链外 | 绿 | 1s |  | 建议纳入 |
| `web/scripts/test-duet-upload.mjs` | 链内 | 绿 | 3s |  |  |
| `web/scripts/test-executor-picker-field.mjs` | 链外 | 绿 | 2s |  | 建议纳入 |
| `web/scripts/test-feishu-settings.mjs` | 链内 | 绿 | 15s |  |  |
| `web/scripts/test-file-diff-view.mjs` | 链内 | 绿 | 5s |  |  |
| `web/scripts/test-file-entry-delete.mjs` | 链内 | 绿 | 4s |  |  |
| `web/scripts/test-file-layout-surfaces.mjs` | 链外 | 绿 | 5s |  | 建议纳入 |
| `web/scripts/test-file-link-target.mjs` | 链内 | 绿 | 1s |  |  |
| `web/scripts/test-file-mention-dom.mjs` | 链外 | 绿 | 4s |  | 建议纳入 |
| `web/scripts/test-file-mention.mjs` | 链外 | 绿 | 1s |  | 建议纳入 |
| `web/scripts/test-file-reel.mjs` | 链内 | 绿 | 4s |  |  |
| `web/scripts/test-file-tree-git.mjs` | 链内 | 绿 | 8s |  |  |
| `web/scripts/test-file-view-zoom.mjs` | 链内 | 绿 | 4s |  |  |
| `web/scripts/test-free-review-copy.mjs` | 链外 | 绿 | 1s |  | 建议纳入 |
| `web/scripts/test-free-review-defer-dom.mjs` | 链内 | 绿 | 4s |  |  |
| `web/scripts/test-free-review-delete.mjs` | 链内 | 绿 | 21s |  |  |
| `web/scripts/test-fresh-text.tsx` | 链内 | 绿 | 3s |  |  |
| `web/scripts/test-git-workbench-conflict-gates.mjs` | 链外 | 绿 | 29s |  | 可纳入（较慢） |
| `web/scripts/test-git-workbench-polling.mjs` | 链外 | 绿 | 33s |  | 可纳入（较慢） |
| `web/scripts/test-git-workbench-review-fixes.mjs` | 链外 | 绿 | 19s |  | 可纳入（较慢） |
| `web/scripts/test-git-workbench.mjs` | 链外 | 绿 | 34s |  | 可纳入（较慢） |
| `web/scripts/test-handoff-dialog-lifetime.mjs` | 链内 | 绿 | 1s |  |  |
| `web/scripts/test-image-preview.mjs` | 链内 | 绿 | 3s |  |  |
| `web/scripts/test-image-zoom.mjs` | 链内 | 绿 | 3s |  |  |
| `web/scripts/test-inspector-attachments.mjs` | 链外 | 绿 | 2s |  | 建议纳入 |
| `web/scripts/test-inspector-queue.mjs` | 链内 | 绿 | 2s |  |  |
| `web/scripts/test-inspector-shortcut-stack.mjs` | 链内 | 绿 | 2s |  |  |
| `web/scripts/test-inspector-shortcuts.mjs` | 链内 | 绿 | 1s |  |  |
| `web/scripts/test-key-chord.mjs` | 链内 | 绿 | 1s |  |  |
| `web/scripts/test-legacy-notice-decode.mjs` | 链内 | 绿 | 1s |  |  |
| `web/scripts/test-markdown-images.mjs` | 链内 | 绿 | 3s |  |  |
| `web/scripts/test-message-quote.mjs` | 链内 | 绿 | 2s |  |  |
| `web/scripts/test-monitor-composer-dom.mjs` | 链内 | 绿 | 2s |  |  |
| `web/scripts/test-monitor-inspector-dom.mjs` | 链内 | 绿 | 19s |  |  |
| `web/scripts/test-monitor-inspector.tsx` | 链内 | 绿 | 2s |  |  |
| `web/scripts/test-monitor-wake-delivery.tsx` | 链内 | 绿 | 4s |  |  |
| `web/scripts/test-monitor-wake-fold.ts` | 链内 | 绿 | 1s |  |  |
| `web/scripts/test-monitor-wake.tsx` | 链内 | 绿 | 2s |  |  |
| `web/scripts/test-native-agent-segments.mjs` | 链外 | 绿 | 1s |  | 建议纳入 |
| `web/scripts/test-native-work-dom.mjs` | 链内 | 绿 | 7s |  |  |
| `web/scripts/test-native-work-metadata.ts` | 链内 | 绿 | 1s |  |  |
| `web/scripts/test-native-work-presentation.tsx` | 链内 | 绿 | 2s |  |  |
| `web/scripts/test-notes-delete-race.mjs` | 链内 | 绿 | 7s |  |  |
| `web/scripts/test-notes-empty-body.mjs` | 链内 | 绿 | 8s |  |  |
| `web/scripts/test-notes-filter.mjs` | 链外 | 绿 | 1s |  | 建议纳入 |
| `web/scripts/test-notes-upload.mjs` | 链内 | 绿 | 2s |  |  |
| `web/scripts/test-open-in-ide-menu.mjs` | 链外 | 绿 | 3s |  | 建议纳入 |
| `web/scripts/test-open-with-menu.mjs` | 链外 | 绿 | 3s |  | 建议纳入 |
| `web/scripts/test-outbound-state.mjs` | 链外 | 绿 | 1s |  | 建议纳入 |
| `web/scripts/test-page-interactions.tsx` | 链内 | 绿 | 2s |  |  |
| `web/scripts/test-page-token-delivery.mjs` | 链内 | 绿 | 5s |  |  |
| `web/scripts/test-palette-keys.mjs` | 链内 | 绿 | 1s |  |  |
| `web/scripts/test-palette-search.mjs` | 链内 | 绿 | 7s |  |  |
| `web/scripts/test-preview-assist-ui.mjs` | 链内 | 绿 | 132s |  |  |
| `web/scripts/test-preview-error-toast.mjs` | 链内 | 绿 | 8s |  |  |
| `web/scripts/test-preview-lifecycle-notices.tsx` | 链内 | 绿 | 2s |  |  |
| `web/scripts/test-preview-log-live.mjs` | 链内 | 绿 | 50s |  |  |
| `web/scripts/test-preview-port-guide.mjs` | 链内 | 绿 | 2s |  |  |
| `web/scripts/test-preview-preset-links.mjs` | 链内 | 绿 | 29s |  |  |
| `web/scripts/test-preview-task-switch.mjs` | 链内 | 绿 | 2s |  |  |
| `web/scripts/test-preview-url.tsx` | 链内 | 绿 | 1s |  |  |
| `web/scripts/test-preview-workspace-launch.tsx` | 链内 | 绿 | 31s |  |  |
| `web/scripts/test-project-git-lifetime.mjs` | 链内 | 绿 | 4s |  |  |
| `web/scripts/test-project-member-role.mjs` | 链内 | 绿 | 3s |  |  |
| `web/scripts/test-project-settings-draft.mjs` | 链内 | 绿 | 7s |  |  |
| `web/scripts/test-provider-visibility.mjs` | 链内 | 绿 | 6s |  |  |
| `web/scripts/test-qr.ts` | 链内 | 绿 | 1s |  |  |
| `web/scripts/test-question-history-dom.mjs` | 链内 | 绿 | 27s |  |  |
| `web/scripts/test-queue-after.mjs` | 链外 | 绿 | 1s |  | 建议纳入 |
| `web/scripts/test-receipt-phrases.mjs` | 链内 | 绿 | 1s |  |  |
| `web/scripts/test-remote-return.mjs` | 链内 | 绿 | 29s |  |  |
| `web/scripts/test-remote-task.mjs` | 链内 | 绿 | 1s |  |  |
| `web/scripts/test-reply-drafts.mjs` | 链外 | 绿 | 2s |  | 建议纳入 |
| `web/scripts/test-reply-quote.ts` | 链内 | 绿 | 1s |  |  |
| `web/scripts/test-reply-rail-dom.mjs` | 链内 | 绿 | 3s |  |  |
| `web/scripts/test-reply-resize.mjs` | 链外 | 绿 | 3s |  | 建议纳入 |
| `web/scripts/test-reply-standing-executor.mjs` | 链内 | 绿 | 6s |  |  |
| `web/scripts/test-report-roots.mjs` | 链内 | 绿 | 1s |  |  |
| `web/scripts/test-review-diff-zoom.mjs` | 链内 | 绿 | 4s |  |  |
| `web/scripts/test-review-lane-monitor-wake.mjs` | 链内 | 绿 | 1s |  |  |
| `web/scripts/test-review-navigation-dom.mjs` | 链内 | 绿 | 3s |  |  |
| `web/scripts/test-review-no-verdict-retry.mjs` | 链内 | 绿 | 2s |  |  |
| `web/scripts/test-review-report-boundary.mjs` | 链内 | 绿 | 1s |  |  |
| `web/scripts/test-review-report-claim.mjs` | 链内 | 绿 | 1s |  |  |
| `web/scripts/test-review-report-fallback.mjs` | 链内 | 绿 | 1s |  |  |
| `web/scripts/test-review-report-format.mjs` | 链内 | 绿 | 1s |  |  |
| `web/scripts/test-review-report-split-dom.mjs` | 链内 | 绿 | 3s |  |  |
| `web/scripts/test-review-report-summary-fold-dom.mjs` | 链内 | 绿 | 2s |  |  |
| `web/scripts/test-review-report-summary-fold.mjs` | 链内 | 绿 | 1s |  |  |
| `web/scripts/test-reviewer-profile-summary.mjs` | 链外 | 绿 | 2s |  | 建议纳入 |
| `web/scripts/test-reviewer-turn.mjs` | 链内 | 绿 | 1s |  |  |
| `web/scripts/test-roving-choice.mjs` | 链内 | 绿 | 2s |  |  |
| `web/scripts/test-run-activity.mjs` | 链外 | 绿 | 1s |  | 建议纳入 |
| `web/scripts/test-run-target-picker.mjs` | 链外 | 绿 | 2s |  | 建议纳入 |
| `web/scripts/test-scheduled-message-reply.mjs` | 链内 | 绿 | 5s |  |  |
| `web/scripts/test-scheduled-message-tray-dom.mjs` | 链内 | 绿 | 6s |  |  |
| `web/scripts/test-scheduled-message-tray.tsx` | 链内 | 绿 | 2s |  |  |
| `web/scripts/test-scm-file-layout.mjs` | 链外 | 绿 | 4s |  | 建议纳入 |
| `web/scripts/test-scm-nested-ui.mjs` | 链外 | 绿 | 2s |  | 建议纳入 |
| `web/scripts/test-scm-paths.mjs` | 链外 | 绿 | 1s |  | 建议纳入 |
| `web/scripts/test-scm-race.mjs` | 链外 | 绿 | 13s |  | 建议纳入 |
| `web/scripts/test-scm-stale.mjs` | 链外 | 绿 | 2s |  | 建议纳入 |
| `web/scripts/test-search-reveal-dom.mjs` | 链内 | 绿 | 3s |  |  |
| `web/scripts/test-segment-layout-dom.mjs` | 链内 | 绿 | 6s |  |  |
| `web/scripts/test-select-all-on-focus.mjs` | 链内 | 绿 | 1s |  |  |
| `web/scripts/test-select-reopen-dom.mjs` | 链内 | 绿 | 2s |  |  |
| `web/scripts/test-selection-content.mjs` | 链内 | 绿 | 6s |  |  |
| `web/scripts/test-send-after.tsx` | 链外 | 绿 | 1s |  | 建议纳入 |
| `web/scripts/test-send-key.mjs` | 链内 | 绿 | 14s |  |  |
| `web/scripts/test-session-merge.mjs` | 链外 | 绿 | 1s |  | 建议纳入 |
| `web/scripts/test-settings-card-fit.mjs` | 链内 | 绿 | 3s |  |  |
| `web/scripts/test-settings-popover-follow.mjs` | 链内 | 绿 | 2s |  |  |
| `web/scripts/test-settle-created-task.mjs` | 链外 | 绿 | 1s |  | 建议纳入 |
| `web/scripts/test-settled-turn-memo.mjs` | 链内 | 绿 | 2s |  |  |
| `web/scripts/test-settlement-note.mjs` | 链内 | 绿 | 1s |  |  |
| `web/scripts/test-side-chat-direct-browser.mjs` | 链内 | 绿 | 9s |  |  |
| `web/scripts/test-side-chat-selection-browser.mjs` | 链内 | 绿 | 14s |  |  |
| `web/scripts/test-side-chat-state.ts` | 链内 | 绿 | 1s |  |  |
| `web/scripts/test-side-chat-upload.mjs` | 链内 | 绿 | 9s |  |  |
| `web/scripts/test-sidebar-navigation.mjs` | 链内 | 绿 | 4s |  |  |
| `web/scripts/test-sidebar-remote-race.mjs` | 链内 | 绿 | 2s |  |  |
| `web/scripts/test-slash-match.mjs` | 链外 | 绿 | 1s |  | 建议纳入 |
| `web/scripts/test-spread-filter.mjs` | 链外 | 绿 | 1s |  | 建议纳入 |
| `web/scripts/test-stick-to-bottom-dom.mjs` | 链内 | 绿 | 12s |  |  |
| `web/scripts/test-stick-to-bottom.mjs` | 链内 | 绿 | 1s |  |  |
| `web/scripts/test-system-notices-dom.mjs` | 链内 | 绿 | 15s |  |  |
| `web/scripts/test-task-catch-up-dom.mjs` | 链内 | 绿 | 21s |  |  |
| `web/scripts/test-task-creation-origin.mjs` | 链内 | 绿 | 6s |  |  |
| `web/scripts/test-task-file-locator.mjs` | 链内 | 绿 | 1s |  |  |
| `web/scripts/test-task-mode-paging.mjs` | 链外 | 绿 | 8s |  | 建议纳入 |
| `web/scripts/test-task-read-state.mjs` | 链内 | 绿 | 1s |  |  |
| `web/scripts/test-task-review-rounds.mjs` | 链外 | 绿 | 3s |  | 建议纳入 |
| `web/scripts/test-task-sync.mjs` | 链外 | 绿 | 1s |  | 建议纳入 |
| `web/scripts/test-task-tree-offline.mjs` | 链外 | 绿 | 2s |  | 建议纳入 |
| `web/scripts/test-task-tree-paging.mjs` | 链外 | 绿 | 3s |  | 建议纳入 |
| `web/scripts/test-task-tree-preview.mjs` | 链外 | 绿 | 3s |  | 建议纳入 |
| `web/scripts/test-task-tree.mjs` | 链外 | 绿 | 1s |  | 建议纳入 |
| `web/scripts/test-team-review-inspector.mjs` | 链外 | 绿 | 2s |  | 建议纳入 |
| `web/scripts/test-terminal-dock.mjs` | 链内 | 绿 | 3s |  |  |
| `web/scripts/test-tool-summary.mjs` | 链外 | 绿 | 1s |  | 建议纳入 |
| `web/scripts/test-turn-cause.ts` | 链内 | 绿 | 1s |  |  |
| `web/scripts/test-turn-failure.mjs` | 链内 | 绿 | 1s |  |  |
| `web/scripts/test-turn-fold-dom.mjs` | 链外 | 绿 | 4s |  | 建议纳入 |
| `web/scripts/test-turn-fold.mjs` | 链内 | 绿 | 1s |  |  |
| `web/scripts/test-turn-images.mjs` | 链内 | 绿 | 1s |  |  |
| `web/scripts/test-turn-remedy-catch-up-dom.mjs` | 链内 | 绿 | 16s |  |  |
| `web/scripts/test-turn-remedy-dom.mjs` | 链内 | 绿 | 4s |  |  |
| `web/scripts/test-turn-retry.mjs` | 链外 | 绿 | 1s |  | 建议纳入 |
| `web/scripts/test-ui-polish.mjs` | 链内 | 绿 | 2s |  |  |
| `web/scripts/test-upstream-retry-placement.tsx` | 链内 | 绿 | 3s |  |  |
| `web/scripts/test-users-role.mjs` | 链内 | 绿 | 6s |  |  |
| `web/scripts/test-withdraw-scheduled.mjs` | 链内 | 绿 | 2s |  |  |
| `web/scripts/test-workflow-edit.mjs` | 链外 | 绿 | 1s |  | 建议纳入 |
| `web/scripts/test-workflow-rail.mjs` | 链外 | 绿 | 1s |  | 建议纳入 |
| `web/scripts/test-workspace-history.mjs` | 链外 | 绿 | 1s |  | 建议纳入 |
| `web/scripts/test-workspace-shortcuts.mjs` | 链内 | 绿 | 1s |  |  |
| `web/scripts/verify-git-workbench-busy-discard.mjs` | 链外 | 绿 | 22s |  | 可纳入（较慢） |
| `web/scripts/verify-git-workbench-design.mjs` | 链外 | 绿 | 17s |  | 可纳入（较慢） |
| `web/scripts/verify-git-workbench-diff-prefixes.mjs` | 链外 | 绿 | 19s |  | 可纳入（较慢） |
| `web/scripts/verify-git-workbench-header-resize.mjs` | 链外 | 绿 | 19s |  | 可纳入（较慢） |
| `web/scripts/verify-git-workbench-refresh-paths.mjs` | 链外 | 绿 | 44s |  | 可纳入（较慢） |
| `scripts/test-process-cleanup.mjs` | 拆分模块 | 拆分模块 |  | 随 test-test-process-lifecycle.mjs 一起跑 |  |
| `scripts/test-process-conventions.mjs` | 拆分模块 | 拆分模块 |  | 随 check-conventions.mjs、test-test-process-conventions.mjs 一起跑 |  |
| `scripts/test-process-directory.mjs` | 拆分模块 | 拆分模块 |  | 随 test-process-job.mjs、test-process-ownership.mjs、test-process-posix.mjs 一起跑 |  |
| `scripts/test-process-job.mjs` | 拆分模块 | 拆分模块 |  | Windows Job 执行域：Mac 上只经桩化的 native 跑模拟路径；随 test-process-scope.mjs、test-test-process-cleanup.mjs、test-test-process-directory.mjs、test-test-process-lifecycle.mjs 一起跑 |  |
| `scripts/test-process-native.cjs` | 拆分模块 | 拆分模块 |  | Windows 原生 Job 工具：Mac 上父测试把 invoke/dispose/executable 换成桩，真实原生调用未执行；随 test-process-job.mjs、test-process-scope.mjs、test-test-process-cleanup.mjs、test-test-process-directory.mjs、test-test-process-lifecycle.mjs、test-test-process-ownership.mjs 一起跑 |  |
| `scripts/test-process-posix.mjs` | 拆分模块 | 拆分模块 |  | 随 test-process-job.mjs、test-process-scope.mjs 一起跑 |  |
| `scripts/test-process-probe.mjs` | 拆分模块 | 拆分模块 |  | 随 test-process-identity.mjs、test-process-posix.mjs、test-process-stop.mjs 一起跑 |  |
| `scripts/test-process-registry.mjs` | 拆分模块 | 拆分模块 |  | 随 test-process-job.mjs、test-process-posix.mjs、test-process-scope.mjs 一起跑 |  |
| `scripts/test-process-resources.mjs` | 拆分模块 | 拆分模块 |  | 随 test-process-directory.mjs、test-process-job.mjs、test-process-ownership.mjs、test-process-scope.mjs、test-test-process-cleanup.mjs、test-test-process-directory.mjs、test-test-process-failures.mjs、test-test-process-lifecycle.mjs、test-test-process-ownership.mjs、test-test-process-resources.mjs、test-test-process.mjs、test-windows-restart.mjs 一起跑 |  |
| `scripts/test-process-scope.mjs` | 拆分模块 | 拆分模块 |  | 随 test-process-cleanup.mjs、test-process-ownership.mjs、test-process.mjs、test-restart.mjs、test-test-process-cleanup.mjs、test-test-process-directory.mjs、test-test-process-failures.mjs、test-test-process-lifecycle.mjs、test-test-process-ownership.mjs、test-test-process.mjs、test-windows-restart.mjs 一起跑 |  |
| `scripts/test-process-stop.mjs` | 拆分模块 | 拆分模块 |  | 随 test-process-posix.mjs 一起跑 |  |
| `scripts/test-process-terminate.mjs` | 拆分模块 | 拆分模块 |  | 随 test-process-posix.mjs、test-process-stop.mjs 一起跑 |  |
| `scripts/test-process.mjs` | 拆分模块 | 拆分模块 |  | 随 test-process-ownership.mjs、test-restart-options.mjs、test-restart.mjs、test-test-process-failures.mjs、test-test-process-lifecycle.mjs、test-test-process-ownership.mjs、test-test-process.mjs、test-windows-restart.mjs 一起跑 |  |
| `scripts/test-runner-processes.mjs` | 拆分模块 | 拆分模块 |  | 随 test-runner.mjs 一起跑 |  |
| `scripts/test-windows-restart-preservation.mjs` | 拆分模块 | 有意不跑 |  | Windows 专属：父入口 test-windows-restart.mjs 只在 `IS_WINDOWS` 时才 import 它，Mac 上没加载、没执行 |  |
| `server/scripts/test-accept-dependencies.ts` | 拆分模块 | 拆分模块 |  | 随 test-accept-cleanup.ts 一起跑 |  |
| `server/scripts/test-accept-finalize.ts` | 拆分模块 | 拆分模块 |  | 随 test-accept-cleanup.ts 一起跑 |  |
| `server/scripts/test-accept-gate-forwarded.ts` | 拆分模块 | 拆分模块 |  | 随 test-accept-gate.ts 一起跑 |  |
| `server/scripts/test-accept-gate-legacy.ts` | 拆分模块 | 拆分模块 |  | 随 test-accept-gate.ts 一起跑 |  |
| `server/scripts/test-accept-gate-lifecycle.ts` | 拆分模块 | 拆分模块 |  | 随 test-accept-gate-startup.ts、test-accept-gate-takeover-settle.ts、test-accept-gate-takeover.ts、test-accept-gate.ts 一起跑 |  |
| `server/scripts/test-accept-gate-missing.ts` | 拆分模块 | 拆分模块 |  | 随 test-accept-gate.ts 一起跑 |  |
| `server/scripts/test-accept-gate-notice.ts` | 拆分模块 | 拆分模块 |  | 随 test-accept-gate-command.ts 一起跑 |  |
| `server/scripts/test-accept-gate-startup.ts` | 拆分模块 | 拆分模块 |  | 随 test-accept-gate.ts 一起跑 |  |
| `server/scripts/test-accept-gate-takeover-settle.ts` | 拆分模块 | 拆分模块 |  | 随 test-accept-gate.ts 一起跑 |  |
| `server/scripts/test-accept-gate-takeover.ts` | 拆分模块 | 拆分模块 |  | 随 test-accept-gate.ts 一起跑 |  |
| `server/scripts/test-accept-ignored-links.ts` | 拆分模块 | 拆分模块 |  | 随 test-accept-dependencies.ts 一起跑 |  |
| `server/scripts/test-accept-remnants.ts` | 拆分模块 | 拆分模块 |  | 随 test-accept-cleanup.ts 一起跑 |  |
| `server/scripts/test-accept-verification-stations.ts` | 拆分模块 | 拆分模块 |  | 随 test-accept-verification.ts 一起跑 |  |
| `server/scripts/test-accept-verification.ts` | 拆分模块 | 拆分模块 |  | 随 test-accept-merge.ts 一起跑 |  |
| `server/scripts/test-claude-usage-isolation.ts` | 无 script | 拆分模块 |  | 被 test-claude-usage-migration 当子进程起，单跑只打印用法 | 建议纳入 |
| `server/scripts/test-handoff-payload.ts` | 拆分模块 | 拆分模块 |  | 随 test-handoff-auth.ts 一起跑 |  |
| `server/scripts/test-preview-stop-links.ts` | 拆分模块 | 拆分模块 |  | 随 test-accept-cleanup.ts 一起跑 |  |
| `server/scripts/test-review-ownership-acceptance.ts` | 拆分模块 | 拆分模块 |  | 随 test-review-ownership.ts 一起跑 |  |
| `server/scripts/test-service-ports-fixtures.ts` | 拆分模块 | 拆分模块 |  | 随 test-service-ports-script.ts、test-service-ports.ts 一起跑 |  |
| `server/scripts/test-team-accept-verification.ts` | 拆分模块 | 拆分模块 |  | 随 test-accept-verification.ts 一起跑 |  |
| `web/scripts/test-accept-gate-actions.mjs` | 拆分模块 | 拆分模块 |  | 随 test-accept-gate-dom.mjs 一起跑 |  |
| `web/scripts/test-accept-gate-reads.mjs` | 拆分模块 | 拆分模块 |  | 随 test-accept-gate-actions.mjs 一起跑 |  |
| `web/scripts/test-accept-gate-recovery.mjs` | 拆分模块 | 拆分模块 |  | 随 test-accept-gate-dom.mjs 一起跑 |  |
| `web/scripts/test-accept-gate-wait-bar.mjs` | 拆分模块 | 拆分模块 |  | 随 test-accept-gate-dom.mjs 一起跑 |  |
| `web/scripts/test-preview-workspace-dom.mjs` | 拆分模块 | 拆分模块 |  | 随 test-preview-workspace-launch.tsx 一起跑 |  |
| `web/scripts/test-task-background-sync.mjs` | 拆分模块 | 拆分模块 |  | 随 test-task-sync.mjs 一起跑 |  |
| `scripts/test-runner.mjs` | 链外 | 不是测试 |  | 门禁并行执行器本身（root test:web 用它整链重跑 web） | 建议纳入 |
