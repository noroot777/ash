# 还留在验收命令之外的测试脚本

验收命令（`npm run test:accept`）现在跑三步：server 的 `test:accept`、web 的 `test`、仓库根的 `test:accept-scripts`（根目录 `scripts/` 下的脚本回归，加手机端不用构建产物的几条）。2026-11-16 把门禁外又快又稳的 375 条并了进来（任务 bmUQwwxZCbSb），门禁从 302 条变成 677 条。这里列的是**并完之后还留在外面**的：有哪些、为什么。

「11-13 普查」一栏是 `docs/test-audit-2026-11-13.md` 那轮全量普查实测到的结果和用时；「保什么」取自各文件头的说明（没有文件头的，取它跑完打印的那一句）。

## 一览

| 分组 | 条数 | 为什么在外面 |
|---|---|---|
| 这一轮看过、没并进来 | 2 | 一条要整包构建产物，一条要编译、可能联网，还会往检出里写东西 |
| 较慢 | 51 | 单条 15–60 秒，全并进来门禁用时大约翻倍。这一轮没动、没跑 |
| 留在链外 | 27 | 真模型 / 真 CLI（手动跑）、并发下闪红、依赖整包构建或 mobile 导出、太慢、Windows 专属。这一轮没动、没跑 |
| 合 main 时才发现、还没看过 | 3 | 两条是并之前就在、但当时那份清单里没有的；一条是之后 main 新带进来的。都没普查、没跑，留给下一次挑着并 |
| 被别的测试引用的模块 | 17 | 不是独立的测试，名字以 `test-` 开头而已，跟着引用它的那条走 |

## 这一轮看过、没并进来（2）

| 文件 | 保什么 | 为什么留在外面 |
|---|---|---|
| `scripts/test-macos-update.mjs` | mac app 自更新的定点回归（仅 macOS）：装新版之前那道闸（UpdateGate）和发版脚本（release.mjs）。 | 要 swiftc 现编；没有 Sparkle 缓存时要联网下载；会往检出的 `desktop/macos/build/` 里写东西；一条 40–60 秒。跑它用 `node scripts/test-macos-update.mjs` |
| `web/scripts/test-cli-goal-lifecycle-ui.mjs` | `/goal` 生命周期在界面上的端到端。 | 要先有 `server/dist` 和 `web/dist`（整包构建产物），门禁不做构建 |

另有两处清单上的条目不是测试、或者已经不存在：`scripts/test-runner.mjs` 是执行器本身；`server/scripts/test-task-star.ts` 文件已经没有了。

## 合 main 时才发现、还没看过（3）

| 文件 | 保什么 | 为什么在外面 |
|---|---|---|
| `server/scripts/test-pending-wait-normal.ts` | 排队消息等的是看得见的事就不算滞留（pending-messages 的 waitReason）：任务正在跑一轮长的，排队消息等它跑完是排队本身。 | 并的时候照的那份清单还没有它（main 审查时补进了旧清单）。在 `test:turn-reclaim` 链里 |
| `server/scripts/test-queue-rank.ts` | 队列名次：对外的 queuePosition 是连续的名次(0..N-1)，删过任务留下缺号的老队列名次照样连续。 | 同上。在 `test:queue` 链里 |
| `server/scripts/test-discussion-delete.ts` | 删掉一整场讨论之后哪个 agent 都读不到这一场；删普通消息时讨论的背景副本跟着抹。 | 并完之后 main 才带进来。在 `test:discussion` 链里 |

## 留在外面的那两组里，这一轮顺带看到的

没有改这两组的测试，下面只是跑别的东西时看到的现象，留给以后挑着并的人：

- 「留在链外」里标着「并发下闪红」、现象是「叶子进程组被 SIGTERM / SIGKILL」的那几条（`test-launch-abandon-races`、`test-service-ports` 等）：这一轮查到一个会造成这个现象的产品问题并修掉了 —— 退了的终端会话还按它当年的 pty 设备号去杀人，并行的另一条终端测试正好领到同一个号（`server/src/terminal-session-kill.ts` 的 `liveTty`，回归 `test-terminal-stale-tty.ts`）。修完之后它们是不是就稳了，没有专门压过。
- 修完之后把 `test:terminal` 整条链并行 8 份跑过一次：`test-project-commands`（restart 回 500）、`test-service-ports`（回 500）、`test-service-ports-script`（`'unresolved' !== 'verified'`，单跑偶尔也红）、`test-launch-abandon-races`（等守护进程的启动器退出超时）还会红，不再是被信号打死。
- `server/scripts/test-scheduled-messages.ts`：跑完不再留假 claude 进程了（收尾会等它们退干净，不退的收掉）；并行 3 份时见过一次「拒收必须持久可见」红，没查。

## 较慢（51）

| 文件 | 保什么 | 11-13 普查 | 备注 |
|---|---|---|---|
| `scripts/test-accept-test.mjs` | （文件头没有说明；入口 npm run test:accept-gate） | 绿 20s |  |
| `scripts/test-macos-client.mjs` | mac app 的定点回归（仅 macOS）。 | 绿 18s |  |
| `scripts/test-restart.mjs` | 回归 restart.mjs 的本机探测：即使环境里有 HTTP_PROXY，:PORT 的探活也必须直连， 不能把「代理暂时连不上刚重启的服务」误报成「服务没起来」。 | 绿 44s |  |
| `scripts/test-test-process-failures.mjs` | （文件头没有说明；跑完打印）✓ 清理异常保留原超时/原因/诊断双流,并汇总清理失败 | 绿 21s |  |
| `scripts/test-test-process.mjs` | （文件头没有说明；跑完打印）✓ 子进程执行域:超时后代/拒绝信号/登记失败均清场,保留诊断及晚写双流,独立日志服务显式登记 | 绿 22s |  |
| `server/scripts/test-base-update-followups.ts` | （文件头没有说明；跑完打印）✓ ${view.manual!.fileCount} changed paths (>16 MB listing): bounded preview, complete count and explicit recovery succee | 绿 34s |  |
| `server/scripts/test-base-update-recovery.ts` | （文件头没有说明；跑完打印）✓ missing parent record: suggested retargeting is executable and leads to successful acceptance | 绿 39s |  |
| `server/scripts/test-branch-acceptance.ts` | （文件头没有说明；跑完打印）✓ partial family result reports accepted parent and blocked child separately | 绿 51s |  |
| `server/scripts/test-branch-worktree-state.ts` | （文件头没有说明；跑完打印）✓ unregistered orphan: acceptance and ordinary deletion preserve files and report unreadable state | 绿 21s |  |
| `server/scripts/test-chat-large-workspace.ts` | （文件头没有说明；跑完打印）chat large workspace: 目录观察零枚举、体量不影响咨询；依赖与项目文件的变更如实附注且不作废回复；其他工作树的并发写不附注；当前工作树自身仍观察 | 绿 16s |  |
| `server/scripts/test-cli-goal-queue.ts` | （文件头没有说明；跑完打印）${agentType}: timed/legacy execution intent and 15 atomic recovery/manual-start queue races: passed | 绿 20s |  |
| `server/scripts/test-codex-session-archive.ts` | （文件头没有说明；跑完打印）✓ 兼容归档日期子目录；配置、skills 和其他用户会话逐字节未变 | 绿（已修） 39s | (b) readCodexAppServerState 搬到 codex-app-server-state |
| `server/scripts/test-git-workbench-maintenance.ts` | （文件头没有说明；跑完打印）ok · active or inaccessible sibling worktree prevents cleanup; explicit cleanup removes only abandoned helper dirs | 绿 19s |  |
| `server/scripts/test-git-workbench-outcomes.ts` | （文件头没有说明；跑完打印）ok · pull merge/rebase conflicts stay actionable; ff-only refusal without a conflict logs failed | 绿 42s |  |
| `server/scripts/test-git-workbench-safety.ts` | （文件头没有说明；跑完打印）ok · project members can read but cannot mutate Git | 绿 16s |  |
| `server/scripts/test-git-workbench.ts` | （文件头没有说明；跑完打印）Git workbench: ${checks} scenarios passed | 绿 34s |  |
| `server/scripts/test-holder-scan.ts` | **半截查询不许当查全** —— 第 5 轮审查 F1 的机制本身。 | 绿 19s |  |
| `server/scripts/test-im-exits.ts` | 飞书发件的出口：每一行都按入队时记下的授权来源（scope）在发出、改卡那一刻现核，结局与待改卡一起落库。 | 绿 26s |  |
| `server/scripts/test-im-inbound.ts` | 飞书里发来的消息：绑定码、没绑定的人、群里 @、回复任务卡、斜杠命令、附件、助手房间与群聊房间的来回。 | 绿 23s |  |
| `server/scripts/test-im-outcomes.ts` | 飞书卡片发出去之后任务又变了、完成与门禁通知、同时到的几句话建房间（自由审查第 1 轮的三条）。 | 绿 17s |  |
| `server/scripts/test-im-recovery.ts` | 飞书通道的「收不回来」那几处：唯一键、发件边界、重启接管、慢的确认卡。 | 绿 26s |  |
| `server/scripts/test-im-replies.ts` | 回给发话人的那一句（scope.ts reply）：他自己这次操作的结局 —— 接口报错、拒绝的原因、投不进房间、 拿不到回复。 | 绿 21s |  |
| `server/scripts/test-monitor-block-eligibility.ts` | 哨兵**硬拦资格**的回归:一条命令凭什么被当成「它自己永远不会结束」、在起进程之前就 409。 | 绿 30s |  |
| `server/scripts/test-monitor-delivery-batch.ts` | （文件头没有说明；跑完打印）monitor delivery batch: all targeted cases passed | 绿（已修） 59s | (b) abortDelivery/markSent 只认领取时的行（ac19a7d7） |
| `server/scripts/test-monitor-end-owed.ts` | 「还欠着一声结束的哨兵,名下的行谁都领不走」(monitor-end-owed.ts,第 5 轮审查 1)。 | 绿 18s |  |
| `server/scripts/test-monitor-intent-handover.ts` | **创建意图行的责任接管** —— 第 19 轮审查 F2 的回归。 | 绿 19s |  |
| `server/scripts/test-monitor-merge-window.ts` | 「最后一批输出 + 结束」并成一次唤醒(monitor-events.ts 的合并窗口),外加哨兵时间线记录带上 monitorId。 | 绿 32s |  |
| `server/scripts/test-monitor-offline.ts` | 哨兵**跨 Navi 重启**那一半的回归:进程活过重启、停服期间跑完的活要补完、补读到的证据要 折进结局。 | 绿 20s |  |
| `server/scripts/test-monitor-reclaim-debt.ts` | **撤销是一段时间,而「停止函数正常返回」不等于资源已经回收。 | 绿 43s |  |
| `server/scripts/test-monitor-reclaim-unit.ts` | **记号凭证这一问:每次创建独有的那条资源记号,到底能签发什么。 | 绿 32s |  |
| `server/scripts/test-monitor-settle-handover.ts` | **收尾交接的那一族回归** —— 第 21、22、23 轮审查钉下来的那几幕,从 `test-monitor-intent-handover.ts` 拆出来(全局约定:单文件不超过 700 行)。 | 绿 33s |  |
| `server/scripts/test-monitor-unit-proof.ts` | **记号这一问答得有多实,以及最后那份身份有没有真的落盘** —— 第 14 轮审查两条拦验收项的回归。 | 绿 41s |  |
| `server/scripts/test-monitors.ts` | 哨兵（Monitor）这个功能本身的回归：起、推、合并、停、回看、闸。 | 绿 17s |  |
| `server/scripts/test-preview-process.ts` | 预览进程的两条生命线：Navi 自己的 dev 脚本不能在拉起 vite 后因 TDZ 崩掉； | 绿 18s |  |
| `server/scripts/test-process-identity.ts` | 「这个号此刻还是它吗」—— kill / cleanup 的进程身份判据(第 1 轮审查 F2)。 | 绿 34s |  |
| `server/scripts/test-project-commands.ts` | 常用命令回归:命令会话的生命周期(活着豁免闲置回收 / 退出落 exitCode / 退出后回到 普通回收轨道)+ parseProjectCommands 的校验 + service 的停止命令(脚本先跑、杀进程兜底、 脚本失败不偷偷强杀、启动脚本自退的形状也停得掉)。 | 绿 37s |  |
| `server/scripts/test-singleton.ts` | Single-instance startup guard regression test. Requires a built server because it validates the production entrypoint: | 绿 21s |  |
| `server/scripts/test-stall-restart.ts` | 熔断判决**跨得过 server 重启**吗 —— 两个独立进程、同一个库,真 `consumeSingleRun`。 | 绿 39s |  |
| `server/scripts/test-team-turn-artifacts.ts` | 团队调度台的**回合身份 ↔ 产物归属**：插话之后新做出来的东西必须还在生成物清单里。 | 绿 19s |  |
| `server/scripts/test-terminal-capacity.ts` | （文件头没有说明；跑完打印）terminal capacity passed: full start/restart, reserved replacement, pending startup, full rejection, failed-start releas | 绿 25s |  |
| `server/scripts/test-undriven-turn.ts` | 「回合起来了,输入却从未送到」—— 这一类现场的三道闸。 | 绿 38s |  |
| `web/scripts/test-cli-commands-ui.mjs` | （文件头没有说明；跑完打印）screenshots: ${screenshots} | 绿（已修） 46s | (a) 原始需求成了第一颗「你」气泡（eab6cf39） |
| `web/scripts/test-git-workbench-conflict-gates.mjs` | （文件头没有说明；跑完打印）Git workbench conflict gate browser test passed | 绿 29s |  |
| `web/scripts/test-git-workbench-polling.mjs` | （文件头没有说明；跑完打印）git workbench polling test passed | 绿 33s |  |
| `web/scripts/test-git-workbench-review-fixes.mjs` | （文件头没有说明；跑完打印）Git workbench review fixes passed\nEvidence: ${output} | 绿 19s |  |
| `web/scripts/test-git-workbench.mjs` | （文件头没有说明；跑完打印）Git workbench browser test passed | 绿 34s |  |
| `web/scripts/verify-git-workbench-busy-discard.mjs` | （文件头没有说明；跑完打印）Git workbench busy/discard verification passed\nEvidence: ${output} | 绿 22s |  |
| `web/scripts/verify-git-workbench-design.mjs` | （文件头没有说明；跑完打印）Git workbench design verification passed\nURL: ${url.href}\nScreenshots: ${output} | 绿 17s |  |
| `web/scripts/verify-git-workbench-diff-prefixes.mjs` | （文件头没有说明；跑完打印）Git workbench diff-prefix verification passed\nEvidence: ${output} | 绿 19s |  |
| `web/scripts/verify-git-workbench-header-resize.mjs` | （文件头没有说明；跑完打印）Git workbench header and resize verification passed\nScreenshots: ${output} | 绿 19s |  |
| `web/scripts/verify-git-workbench-refresh-paths.mjs` | （文件头没有说明；跑完打印）Git workbench refresh/path verification passed\nEvidence: ${output} | 绿 44s |  |

## 留在链外（27）

| 文件 | 保什么 | 11-13 普查 | 备注 |
|---|---|---|---|
| `mcp/scripts/test-read-transcript.mjs` | 端到端验证 read_task_transcript：起真实的 mcp/dist/index.js，ASH_URL 指向一个**假 Navi**（固定语料，不碰真库），然后按断言逐条核对它拼出来的对话。 | 绿 1s |  |
| `mcp/scripts/test-reconnect.mjs` | 端到端验证 MCP 的重启重试： 1. 起真实的 mcp/dist/index.js，ASH_URL 指向一个没人监听的端口 2. 立刻发一个 tools/call（此刻必然 ECONNREFUSED） 3. 3 秒后才把一个假 Navi 拉起来 4. 断言：调用最终成功（说明它等过去了），且 s… | 绿 4s |  |
| `mobile/scripts/test-reply-command-ui.mjs` | （文件头没有说明；跑完打印）screenshots: ${shots} | 绿（已修） 17s | (b) 缺 mobile/dist 时直说先 build:mobile |
| `mobile/scripts/test-web-smoke.mjs` | SDK 升级后的渲染冒烟：把 worktree 自己的 `mobile/dist`（expo export -p web 的产物） 挂在临时端口上，用 headless Chromium 逐条路由打开，断言「React 真的挂载出了内容」且 控制台没有报错。 | 绿（已修） 17s | (b) 改用系统 Chrome + 自带假后端（原来依赖 playwright 下载的浏览器、反代 live :4317）；需先 build:mobile |
| `scripts/test-process-ownership.mjs` | （文件头没有说明；跑完打印）process ownership regressions ok | 绿（并发下闪红） 42s | 单并发绿；并行时 setsid 后代先没了 |
| `server/scripts/test-assistant-live.ts` | （文件头没有说明；跑完打印）assistant live passed: ${cases.length} 个真实 Claude 回合，无工具事件或工具重试 | 有意不跑 | 设计上就要调用真实 Claude 模型（需 ASH_ALLOW_REAL_AGENT=1） |
| `server/scripts/test-chat-cli.ts` | （文件头没有说明；跑完打印）${agentType} real CLI chat passed: ${answer.reply} | 有意不跑 | 设计上调用真实 CLI 跑模型回合（需 ASH_CHAT_SMOKE=1） |
| `server/scripts/test-claude-goal-live.ts` | （文件头没有说明；跑完打印）real Claude /goal stayed connected through ${working.length} locally mocked working turns; private context cleaned | 绿 | 真 claude + 本地假上游（禁外网档跑） |
| `server/scripts/test-claude-relay-settings-live.ts` | 用真 Claude CLI 打本地假上游，验证 Navi 供应商配置不会被用户级 settings / CC Switch 覆盖。 | 绿（已修） | 真 claude + 本地假上游；假上游没放行 CLI 的 HEAD /api/hello 探测，崩了还留下真 claude 进程 |
| `server/scripts/test-claude-settings-live.ts` | 拿**真 claude** 对一遍 `claude-settings.ts` 里那套分层假设。 | 绿 | 真 claude，钩子在会话初始化就杀，不调模型（禁外网档跑） |
| `server/scripts/test-codex-archive-live.ts` | （文件头没有说明；跑完打印）✓ 终端 codex unarchive 可恢复归档，不启动模型回合 | 绿 | 真 codex + 本地假 provider；沙箱下 codex 的联网探测被挡，沙箱外绿 |
| `server/scripts/test-codex-goal-bridge.ts` | （文件头没有说明；跑完打印）Codex multi-turn goal, early completion, late verdict, startup failure, review lifecycle, fork, fast override: passed | 留给用户 1s | 红：/review 完成事件早于 review/start 应答到达时永不结算（aaa2002d 去掉了 completeTurn 对应答的等待）；import 已修 |
| `server/scripts/test-goal-native-live.ts` | （文件头没有说明；跑完打印）real Navi continuation: plan scope, side-turn isolation, native multi-turn goal, durable budget pause and inspection: pas | 绿 | 同上 |
| `server/scripts/test-kimi-live.ts` | （文件头没有说明；跑完打印）kimi ${version} live CLI tests passed: tools, MCP identity, effort, session resume, auth failure | 绿 | 真 kimi + 本地假上游（禁外网档跑） |
| `server/scripts/test-launch-abandon-races.ts` | （文件头没有说明；跑完打印）test-launch-abandon-races: all assertions passed | 绿（并发下闪红） 3s | 单并发绿；6 路并行时叶子进程组被 SIGKILL，留下 worker.cjs |
| `server/scripts/test-preview-static.ts` | （文件头没有说明；跑完打印）preview-static 全部通过；临时目录已清理 | 绿（并发下闪红） 1s | 终轮 6 路并行红，单并发复跑绿 |
| `server/scripts/test-scheduled-messages.ts` | （文件头没有说明；跑完打印）✓ 进程死在投递中途:行留在 pending + 租约,重启后开机第一件事就把它补发出去 | 绿（已修） 163s | 泄漏已堵：常驻 fake-claude 等不到 stdin EOF 成孤儿（夹具改为临时目录没了就退出） |
| `server/scripts/test-service-ports-script.ts` | 端口兜底那一档里**用户自己写了停止命令**的那条路。 | 绿（并发下闪红） 23s | 单并发 4/5 绿；6 路并行时 'unresolved' !== 'verified' |
| `server/scripts/test-service-ports.ts` | 「停止命令留空 = 杀掉启动起来的东西」最后一档的回归:**端口兜底**(server/src/service-ports.ts)。 | 绿（并发下闪红） 15s | 单并发绿；6 路并行时叶子进程组被 SIGTERM，留下 serve.js |
| `server/scripts/test-session-turn-identity.ts` | 回合身份与完整性：**走真实起跑链路**（`runTask` / `continueTask` + PATH 上的假 CLI）， 不是往库里种好看的数字。 | 绿 93s |  |
| `server/scripts/test-side-authorization-cli.ts` | （文件头没有说明；跑完打印）✓ 真实 Codex CLI 独立语义核验 ${records.length} 条通过；未调用投递层。 | 有意不跑 | 同上，真实 CLI + 真实模型（需 ASH_CHAT_SMOKE=1） |
| `server/scripts/test-user-cli-smoke.ts` | 个人 CLI 环境的**零交互冒烟测试**(计划 §九 探针③ / 审查修订 D12 的硬前置)。 | 有意不跑 1s | 真起一次带 key 的 claude headless 首跑，要真模型出活 |
| `server/scripts/test-user-shell-powershell.ts` | （文件头没有说明；跑完打印）PowerShell file semantics passed (${shell}): instrumentation-fails-closed | 有意不跑 1s | Windows 专属：非 Windows 只打印 `skipped: requires Windows` 就退出，全部用例在 else 里，Mac 上一条没执行；退出码 0 不算绿 |
| `web/scripts/test-chat-browser.mjs` | （文件头没有说明；跑完打印）chat review browser passed: running 停止文案精确校验、短群无虚构整理状态、三成员前台整理时停止和 /clear 刷新后均无内部英文异常。 | 绿 76s |  |
| `web/scripts/test-git-workbench-conflict-errors.mjs` | （文件头没有说明；跑完打印）Git workbench conflict error browser test passed | 绿（并发下闪红） 9s | 终轮 6 路并行红，单并发复跑绿 |
| `web/scripts/test-git-workbench-review.mjs` | （文件头没有说明；跑完打印）Git workbench review browser test passed | 绿（并发下闪红） 22s | 终轮 6 路并行红，单并发复跑绿 |
| `web/scripts/verify-git-workbench-discard-menu.mjs` | （文件头没有说明；跑完打印）Git workbench discard/menu verification passed\nEvidence: ${output} | 绿（并发下闪红） 10s | 终轮 6 路并行红，单并发复跑绿 |

## 被别的测试引用的模块（17）

| 文件 | 保什么 | 11-13 普查 | 备注 |
|---|---|---|---|
| `scripts/test-process-cleanup.mjs` | （文件头没有说明；跑完打印）ASH_TEST_SCOPE_CLEANUP=${JSON.stringify(retired)} | 拆分模块 | 随 test-test-process-lifecycle.mjs 一起跑 |
| `scripts/test-process-conventions.mjs` | （文件头没有说明） | 拆分模块 | 随 check-conventions.mjs、test-test-process-conventions.mjs 一起跑 |
| `scripts/test-process-directory.mjs` | （文件头没有说明） | 拆分模块 | 随 test-process-job.mjs、test-process-ownership.mjs、test-process-posix.mjs 一起跑 |
| `scripts/test-process-job.mjs` | （文件头没有说明） | 拆分模块 | Windows Job 执行域：Mac 上只经桩化的 native 跑模拟路径；随 test-process-scope.mjs、test-test-process-cleanup.mjs、test-test-process-directory.mjs、test-test-process-lifecycle.mjs 一 |
| `scripts/test-process-posix.mjs` | ── 测试执行域:一次 runTestProcess 创建的全部进程,以及「它们真的都停了」这个证明 ────── | 拆分模块 | 随 test-process-job.mjs、test-process-scope.mjs 一起跑 |
| `scripts/test-process-probe.mjs` | ── 观察这台机器:进程表、环境段、边界 inode 的持有者,以及「这还是当初那一个吗」 ──────── | 拆分模块 | 随 test-process-identity.mjs、test-process-posix.mjs、test-process-stop.mjs 一起跑 |
| `scripts/test-process-registry.mjs` | （文件头没有说明） | 拆分模块 | 随 test-process-job.mjs、test-process-posix.mjs、test-process-scope.mjs 一起跑 |
| `scripts/test-process-resources.mjs` | （文件头没有说明） | 拆分模块 | 随 test-process-directory.mjs、test-process-job.mjs、test-process-ownership.mjs、test-process-scope.mjs、test-test-process-cleanup.mjs、test-test-process-directory.mj |
| `scripts/test-process-scope.mjs` | （文件头没有说明） | 拆分模块 | 随 test-process-cleanup.mjs、test-process-ownership.mjs、test-process.mjs、test-restart.mjs、test-test-process-cleanup.mjs、test-test-process-directory.mjs、test-test- |
| `scripts/test-process-stop.mjs` | ── 收场:一次 `stop()` 的全过程,以及最后那份「到底清没清干净」的结论 ────────────────── | 拆分模块 | 随 test-process-posix.mjs 一起跑 |
| `scripts/test-process-terminate.mjs` | ── 终止:**这一层唯一的下刀口,而且只有内核钉得住的绑定才算刀** ────────────────────── | 拆分模块 | 随 test-process-posix.mjs、test-process-stop.mjs 一起跑 |
| `scripts/test-process.mjs` | ── 跑一个子进程,并且**证明**它创建的东西都停了 ───────────────────────────────── 结果校验(退出码、信号、双流收齐)与所有权证明都收在这里,调用方只拿一个结论。 | 拆分模块 | 随 test-process-ownership.mjs、test-restart-options.mjs、test-restart.mjs、test-test-process-failures.mjs、test-test-process-lifecycle.mjs、test-test-process-ownershi |
| `scripts/test-runner-processes.mjs` | 并行执行器（test-runner.mjs）收场时怎么看进程、怎么发信号。 | 拆分模块 | 随 test-runner.mjs 一起跑 |
| `scripts/test-windows-restart-preservation.mjs` | （文件头没有说明；跑完打印）✓ 原生 Windows:未知后代不阻塞重启,整棵保留,agent 持续输出,服务端身份仍拒杀 | 有意不跑 | Windows 专属：父入口 test-windows-restart.mjs 只在 `IS_WINDOWS` 时才 import 它，Mac 上没加载、没执行 |
| `server/scripts/test-handoff-payload.ts` | 接力鉴权回归的后两节:**载荷**这一面(线上传的是不是密文、超大 body 会不会把内存吃光)。 | 拆分模块 | 随 test-handoff-auth.ts 一起跑 |
| `server/scripts/test-service-ports-fixtures.ts` | 端口兜底那一档的**共享夹具**:真守护进程、真端口、真停止。 | 拆分模块 | 随 test-service-ports-script.ts、test-service-ports.ts 一起跑 |
| `web/scripts/test-task-background-sync.mjs` | （文件头没有说明；跑完打印）task background sync: every snapshot entrance preserves independently versioned facts | 拆分模块 | 随 test-task-sync.mjs 一起跑 |
