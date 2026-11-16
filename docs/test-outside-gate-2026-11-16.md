# 验收命令之外的测试脚本 — 2026-11-16

任务 dD5fPlC20-vE 的交付附件。验收命令（`npm run test:accept`）只跑两条链：server 的 `test:accept` 和 web 的 `test`。这里列的是**不在这两条链里**的测试脚本：有哪些、各自保什么、建议并进门禁还是留在外面。

这一轮**没有改、没有删、也没有跑**它们。合 main（`4db389a0`）之后按文件清单重新核过一遍：main 删掉的 `test-task-star.ts` 拿掉，main 新带进来、没进门禁的两条（`test-pending-wait-normal.ts`、`test-queue-rank.ts`）补进「11-13 之后新增」。「11-13 普查」一栏是三天前那轮全量普查（`docs/test-audit-2026-11-13.md`）实测到的结果和用时，分组沿用它的建议；「保什么」取自各文件头的说明（没有文件头的，取它跑完打印的那一句）。

## 结论

| 分组 | 条数 | 建议 |
|---|---|---|
| 11-13 之后新增 | 23 | **并进门禁**。几乎都是最近几条任务自己写的回归（前置、开工那一份账、派出的任务停下/接着跑、删任务的原子性、回合收尾…），功能在线上跑着，测试却不在验收里。先整组跑一遍确认是绿的再并 |
| 建议纳入 | 356 | 并进门禁。普查时单条 15 秒以内、并行下稳定绿、不碰真 CLI，全并进来约多 3 分钟。并之前要先整组跑一遍：这三天产品动得多，门禁里就有 20 条因此变红，这一组里一定也有 |
| 可纳入（较慢） | 51 | 看取舍。单条 15–60 秒，全并进来门禁用时大约翻倍；建议只挑保着要紧事的并 |
| 留在链外 | 27 | 留在外面。真模型 / 真 CLI（10 条，手动跑）、并发下闪红（8 条，要先查清为什么）、依赖整包构建或 mobile 导出（4 条）、太慢（3 条）、Windows 专属（1 条）、待定（1 条） |
| 被别的测试引用的模块 | 17 | 不是独立的测试，名字以 `test-` 开头而已，跟着引用它的那条走 |

没有发现该删的。这一轮顺带看到的两处问题（没动）：

- `server/scripts/test-answer-follow-up.ts` 收尾调了一个已经删掉的函数（`runs.runningTaskIds`），现在跑会红；
- `server/scripts/test-scheduled-messages.ts` 以前留下过常驻的假 claude 孤儿进程（这台机器上还有两个，11-06 和 11-13 起的）。

## 明细

## 11-13 之后新增（23）

| 文件 | 保什么 | 11-13 普查 | 备注 |
|---|---|---|---|
| `scripts/test-macos-update.mjs` | mac app 自更新的定点回归（仅 macOS）：装新版之前那道闸（UpdateGate）和发版脚本（release.mjs）。 | 未普查 |  |
| `scripts/test-restart-lock-owner.mjs` | 回归:restart.mjs 停谁只认「谁在监听端口」,单实例锁里的号码不当线索(用户 2026-11-16 选定)。 | 未普查 |  |
| `server/scripts/test-accept-memory.ts` | 验收确认层点确认时记什么的后端回归(写入规则见 server/src/accept-memory.ts)：「运行」那一勾不记，跳过只管当次；老库里记着跳过的那张表启动时退役。 | 未普查 |  |
| `server/scripts/test-answer-follow-up.ts` | 终态任务上的提问答复是续聊,不认领队列执行占位(2026-11-13 现场:队列里已完成的任务在续聊 回合里提了问,用户答复后落成执行型待发送消息,等整条队列跑完)。 | 未普查 |  |
| `server/scripts/test-claude-monitor-legacy-lifetime.ts` | 内置 Monitor 投影的**旧期限纠偏**（db/migrations.ts 的 relaxUnfoundedClaudeMonitorLifetimes）。 | 未普查 |  |
| `server/scripts/test-claude-monitor-transient.ts` | 内置 Monitor 实时投影的**写库责任**：事件一旦从流里消费掉，来源侧不会再发一遍，库里也没有 别的地方能补回来（翻会话记录的历史扫描已经删了）。 | 未普查 |  |
| `server/scripts/test-dispatch-hold.ts` | 「派出的任务」格头那一对键：全部停下 / 接着跑（src/dispatch-hold.ts、判定 src/task-hold.ts）。 | 未普查 |  |
| `server/scripts/test-launch-request.ts` | 自动开工的那一份账（launch-request.ts）和「同组同时最多四条」（launch-capacity.ts）。 | 未普查 |  |
| `server/scripts/test-launch-restart.ts` | 重启之后名额照样数得对：名额数的是此刻占着执行回合的条数，重启接回的回合重新占上锁，就自然算在里面 —— 没有要在接回时补记的计数。 | 未普查 |  |
| `server/scripts/test-monitor-reclaim-superseded.ts` | **号被复用的那几笔账:能证明原进程已经不在,就自己了结;证明不了,一笔都不许了结。 | 未普查 |  |
| `server/scripts/test-pending-wait-normal.ts` | 排队消息等的是看得见的事就不算滞留（pending-messages 的 waitReason）：任务正在跑一轮长的，排队消息等它跑完是排队本身。 | 未普查 | 合 main 后新增 |
| `server/scripts/test-prerequisite-candidates.ts` | 「建在谁上面」的候选（prerequisite-candidates.ts）和界面那条建任务的路： | 未普查 |  |
| `server/scripts/test-prerequisites-gate.ts` | 前置的底层闸、工作区与并发（审查第 1 轮 F1–F7、N1、N2 那几类）。 | 未普查 |  |
| `server/scripts/test-prerequisites-recovery.ts` | 前置的交付证明、起点、恢复与并发（审查第 2 轮 F1–F6、N1、N2，第 3 轮 1–3，第 4 轮 1 那几类）。 | 未普查 |  |
| `server/scripts/test-prerequisites.ts` | 前置（shared/src/prerequisites.ts）：一条任务建在几条任务上面。 | 未普查 |  |
| `server/scripts/test-queue-ownership-race.ts` | 队列/分组归属的写方与起跑认领争同一个原子边界(src/queue-claim-chain.ts)。 | 未普查 |  |
| `server/scripts/test-queue-rank.ts` | 队列名次：对外的 queuePosition 是连续的名次(0..N-1)，删过任务留下缺号的老队列名次照样连续。 | 未普查 | 合 main 后新增 |
| `server/scripts/test-task-delete-atomic.ts` | 删任务的**原子性**,以及它收口时那道删除门闸(`settleTaskRevocation`)。 | 未普查 |  |
| `server/scripts/test-task-dispatched-by.ts` | 「派它的那条任务」（tasks.dispatched_by）：存量回填认得出、新建时自动记上、显式给的能收， 团队那一套（执行者 parentId、调度台用 MCP 另建的任务）一处不碰。 | 未普查 |  |
| `server/scripts/test-task-reads.ts` | 任务「看过没有」的后端回归(为什么进库见 server/src/db/schema-task-reads.ts，新旧口径见 shared/src/task-reads.ts): · 新旧只认 round：迟到的旧一轮(断网后补送、停在旧数据上的页面)盖不掉已经记下的新一轮； | 未普查 |  |
| `server/scripts/test-turn-interruption.ts` | 普通回合异常结束以后，给页面的那份「怎么断的」（turn-interruption.ts → session_turns.interruption → Session.turnInterruptions； | 未普查 |  |
| `server/scripts/test-turn-wind-down.ts` | 回合收尾**有界**、卡住时**说得清**、占锁之后的出路**都还锁**(turn-wind-down.ts)。 | 未普查 |  |
| `web/scripts/test-prerequisite-options.mjs` | （文件头没有说明；跑完打印）prerequisite options: all assertions passed | 未普查 |  |

## 建议纳入（356）

| 文件 | 保什么 | 11-13 普查 | 备注 |
|---|---|---|---|
| `mobile/scripts/test-cli-capability.mjs` | 手机端「智能水平档位目录什么时候取」。跑：cd mobile && npm run test:cli-capability （mobile 不是 npm workspace 成员，自己一套 node_modules，所以不走 `npm -w`。） | 绿 1s |  |
| `mobile/scripts/test-markdown-inline.mjs` | 手机端那个轻量 Markdown 解析器:agent 写的 `![](…)` 不许变成一个点不开的链接。 | 绿 1s |  |
| `mobile/scripts/test-monitor-strip.mjs` | 手机端哨兵条的**请求与操作状态生命周期**（第 9、10 轮审查实测的四条）。 | 绿 13s |  |
| `mobile/scripts/test-project-path.mjs` | 手机端新建项目的路径推导。跑：cd mobile && npm run test:project-path （mobile 不是 npm workspace 成员，自己一套 node_modules，所以不走 `npm -w`。） | 绿 1s |  |
| `mobile/scripts/test-session-notices.mjs` | 手机端看不看得见「上游在重试 / 已经等了 N 分钟」。 | 绿 1s |  |
| `mobile/scripts/test-task-branches.mjs` | （文件头没有说明；跑完打印）✓ 迟到候选被丢弃，换项目清掉手选和旧列表 | 绿 13s |  |
| `scripts/test-codex-mcp-setup.mjs` | （文件头没有说明；跑完打印）✅ setup 给 codex 接 ash MCP:整条迁移在沙盘里做、批准了才写、写不改文件身份 | 绿（部分未执行） 1s | 严格档禁执行真 codex，「问真 codex」那几条没拿到真 codex 的回答 |
| `scripts/test-kimi-mcp.mjs` | （文件头没有说明；跑完打印）kimi MCP registration tests passed | 绿 1s |  |
| `scripts/test-process-identity.mjs` | ── 两条**纯判据**:这还是当初那一个吗 / 环境段里真有这么一个变量吗 ────────────────── | 绿 1s |  |
| `scripts/test-restart-options.mjs` | （文件头没有说明；跑完打印）RESTART_ARGV= | 绿 7s |  |
| `scripts/test-runner.mjs` | 回归的并行执行器：把 package.json 里用 `&&` 串起来的测试链展开成一条条叶子，直接起叶子 命令（不再一层套一层 `npm run`），N 条同时跑，任何一条红就把在跑的全部收掉、拒绝放行。 | 不是测试 | 门禁并行执行器本身（root test:web 用它整链重跑 web） |
| `scripts/test-test-process-cleanup.mjs` | （文件头没有说明；跑完打印）✓ 同一执行域初始化失败后保持原始诊断,重复启动不被 EEXIST 等次生错误替换 | 绿 1s |  |
| `scripts/test-test-process-conventions.mjs` | （文件头没有说明；跑完打印）✓ AST 闸拦截 finally 裸析构及条件/循环/可选调用,资源回调/注释/字符串不误报且不重复计数 | 绿 1s |  |
| `scripts/test-test-process-directory.mjs` | （文件头没有说明；跑完打印）⏭ ${process.platform}: POSIX 可观测监管已启用,Windows Job 专属断言留给真机 | 绿 8s |  |
| `scripts/test-test-process-lifecycle.mjs` | （文件头没有说明；跑完打印）✓ 捕获输出临时目录使用与执行域对称的有界删除重试 | 绿 4s |  |
| `scripts/test-test-process-ownership.mjs` | （文件头没有说明；跑完打印）✓ 陈旧 PID/错误出生代次登记不恢复归属,整域终止不触碰另一实例域,完成后立即退役 | 绿 3s |  |
| `scripts/test-test-process-resources.mjs` | （文件头没有说明；跑完打印）✓ 真实生命周期脚本注入业务断言后原错仍可见,模拟域/临时目录全部回收 | 绿 4s |  |
| `scripts/test-windows-restart.mjs` | （文件头没有说明；跑完打印）✓ 原生 Windows:代次区间核得准,容错只跳过对不上的那一个 | 绿（部分未执行） 1s | 纯逻辑段绿；`IS_WINDOWS` 的原生 Windows 段与 preservation 子模块在 Mac 上未执行 |
| `scripts/test-workspace-repair.mjs` | （文件头没有说明；跑完打印）✓ empty workspace recovery: deletion, index protection, existing files, links, sparse checkout, archive, invalid JSON | 绿 2s |  |
| `server/scripts/test-accept-gate-handoff-verdict.ts` | 门禁红了交回修复(`handOffGateFailure`)按协议三档裁决交代:收下 / 拒收 / 说不清。 | 绿 4s |  |
| `server/scripts/test-adopt-replay.ts` | **接管时从协议日志重放出来的状态**:同一回合的完成事实不许被较弱的证据回滚。 | 绿 1s |  |
| `server/scripts/test-agent-attachments.ts` | （文件头没有说明；跑完打印）Agent 图片附件持久化验证通过 | 绿 1s |  |
| `server/scripts/test-agent-descendant-cleanup.ts` | 一次性 agent 正常退出后,它用 `&` / `start /b` 留下的后台后代也必须被收掉。 | 绿 2s |  |
| `server/scripts/test-agent-image-entry.ts` | 「正文里那张图的字节,是不是在**协议读到那一行的那一刻**冻住的」——审查第 5 轮 R1、 第 6 轮 R1/R2/R3。 | 绿 5s |  |
| `server/scripts/test-agent-image-journal.ts` | 「正文里的图」的持久账本(agent-image-journal.ts)回归 —— 审查第 7 轮 R2 第 2 行、R3。 | 绿 1s |  |
| `server/scripts/test-agent-image-meta.ts` | 子智能体 message/result(快照式正文)的图片账(markdown-image-meta.ts)回归 —— 审查第 8 轮 R2 开的口子,复审 R1 钉死身份与版本:同一线程、同一路径、同一字段都不能证明属于同一份 正文。 | 绿 1s |  |
| `server/scripts/test-agent-image-stream-window.ts` | 「withMarkdownImages 的滑动窗口」—— 从 test-agent-image-stream.ts 拆出来的那一族 (单文件 700 行闸),编号沿用原文件: ⑬ 超长块的放慢档 ⑭ 裁剪保快照 ⑮/⑮b 分片到达的引用式定义 ⑯ 隔任意距离的定义 ⑰ 永无定义的候选 ⑲/⑲b/… | 绿 2s |  |
| `server/scripts/test-agent-image-stream.ts` | 「自定义解析器的那十个 CLI,正文里的图到底会不会落盘」—— 审查第 1 轮 F3。 | 绿 4s |  |
| `server/scripts/test-agent-spawn-guard.ts` | 真库测试不得启动真智能体。这道闸放在最底层 spawn 边界，所以普通管道、 输出落盘的 detached 管道、常驻会话都绕不过。 | 绿 1s |  |
| `server/scripts/test-answer-routing.ts` | 答复要送回给「提问的那一个」,而不是任务的常设执行器。 | 绿 1s |  |
| `server/scripts/test-anthropic-context-1m.ts` | （文件头没有说明；跑完打印）anthropic context 1m tests passed | 绿 2s |  |
| `server/scripts/test-archive-cleanup.ts` | 归档时的 worktree/分支去留（server/src/task-archive-cleanup.ts + 归档路由）。 | 绿 10s |  |
| `server/scripts/test-archive-preview-guard.ts` | 预览实例里归档不许碰真仓库（第 1 轮审查确定性复现的那条）。 | 绿 2s |  |
| `server/scripts/test-ash-mcp-installer.ts` | 安装器那一侧的回归:`scripts/mcp-hosts.mjs` + `scripts/mcp-host-sources.mjs` + `scripts/config-publish.mjs`(裸 Node)。 | 绿 2s |  |
| `server/scripts/test-ash-mcp-registry.ts` | ash MCP 登记表 + 通用补接器的回归。 | 绿 2s |  |
| `server/scripts/test-assistant.ts` | （文件头没有说明；跑完打印）assistant regression passed | 绿 2s |  |
| `server/scripts/test-auto-title-run.ts` | 自动命名跑在**真事件流**上的两条要害（纯解析那半在 test-auto-title.ts）。 | 绿 2s |  |
| `server/scripts/test-auto-title.ts` | 首轮输出里认标题（server/src/auto-title.ts）。 | 绿 1s |  |
| `server/scripts/test-branch-plan-creation.ts` | （文件头没有说明；跑完打印）✓ serial isolated workers branch at their own start and preserve that workspace on retry | 绿 14s |  |
| `server/scripts/test-branch-plan-scale.ts` | （文件头没有说明；跑完打印）✓ 41-member family: bounded shared reads, stable plans, immediate target/checkout freshness | 绿 10s |  |
| `server/scripts/test-chat-ash-data.ts` | （文件头没有说明；跑完打印）chat ash data: 项目文件与 data 同前缀的兄弟文件仍照常附注 | 绿 6s |  |
| `server/scripts/test-chat-boundary.ts` | （文件头没有说明；跑完打印）chat boundary: 只读工具通过；写入/未知命令的工具事件仍硬中止；无工具事件的目录变化（含并发合并）不再中止、附注如实持久展示且不进模型回复；观察器失效时如实附注不可用；解析失败/任务启动失败的终态正文保留附注；ash 自身写入 | 绿 15s |  |
| `server/scripts/test-chat-context.ts` | （文件头没有说明；跑完打印）chat context regression passed | 绿 3s |  |
| `server/scripts/test-chat-deletion.ts` | 删群聊：DELETE /chats/:roomId 的不变量。 | 绿 2s |  |
| `server/scripts/test-chat-execution.ts` | （文件头没有说明；跑完打印）chat execution: ${AGENT_TYPES.length} 类执行器均使用原 run 通道，保留模型与参数；工具事件不中断回复；当前项目可读且不被清理；~ 开头的工作目录被展开、目录不存在时诚实报错；撤权/停止不启动进程 | 绿 11s |  |
| `server/scripts/test-chat-git-metadata.ts` | （文件头没有说明；跑完打印）chat git metadata: 豁免只到 .git 边界为止；源码、依赖、.gitignore 及同名普通文件的变更仍如实附注 | 绿 7s |  |
| `server/scripts/test-chat-recovery.ts` | 崩溃恢复回归，两个场景都用两个真实 Node 进程共享同一个 SQLite——单进程测试盖不住： reply() 闭包里的 notice 在同进程内总能靠 preserveNotice 补写。 | 绿 5s |  |
| `server/scripts/test-chat-review.ts` | （文件头没有说明；跑完打印）✓ ${name} | 绿 2s |  |
| `server/scripts/test-chat-watch-load.ts` | 目录观察并发负载回归（审查第 5 轮 P1）：以 4 路并发（与 ChatService 最多 4 个 active 回复一致）重复真实写入/编辑/改名，observer 不得漏报。 | 绿 7s |  |
| `server/scripts/test-chat.ts` | （文件头没有说明；跑完打印）chat regression passed | 绿 2s |  |
| `server/scripts/test-claude-background-hold.ts` | claude 单飞「回合说完了、后台还有工作在跑」的生命周期(任务 SGK-4lWyRQCX;自由审查 c2vZ4d3LmL1q、 i8RAcPM3zvgD):先不收台、空档插话直接送、到期杀进程、进程退了按未完成结算,以及「后台跑完」与 「下一回合开始」分开判。 | 绿 2s |  |
| `server/scripts/test-claude-background-reaped.ts` | 「派了个后台子代理去查，结束回合等它回来」——2026-11-03 任务 Yx0fsyjeZC3X 的事故。 | 绿 3s |  |
| `server/scripts/test-claude-monitor-hook.ts` | Monitor 改道的回归：agent 调 claude 内置 `Monitor` 时，ash 到底替它做了什么。 | 绿 5s |  |
| `server/scripts/test-claude-monitor-origin.ts` | **来源身份是绑定下来的，不是落库那一刻查出来的**（新一轮第 1 轮审查 F1）。 | 绿 2s |  |
| `server/scripts/test-claude-monitor-parse.ts` | 认人那一侧：claude 的 stream-json 里，哪些 `local_bash` 后台任务是内置 `Monitor` 起的。 | 绿 3s |  |
| `server/scripts/test-claude-monitor-projection.ts` | claude 自带 `Monitor` 的只读投影：认得出、列得全、停不掉、不被 ash 的进程管理碰。 | 绿 4s |  |
| `server/scripts/test-claude-monitor-reaped.ts` | 「全都停止了，为什么也没唤醒监听？」——用户 2026-10-16 的原话，钉的就是那个问题。 | 绿 2s |  |
| `server/scripts/test-claude-monitor-wiring.ts` | **接线**：claude-stream.ts 真的把内置 Monitor 的事件喂给了投影层吗。 | 绿 3s |  |
| `server/scripts/test-claude-reattach-background.ts` | claude 单飞接管与连续插话这两条「后台工作生命周期」的回归(自由审查 KqmEd8oQLV5_ 第 1、2 轮)。 | 绿 13s |  |
| `server/scripts/test-claude-retry-stall.ts` | Claude 的重试走**真实 parser**出来之后,停滞看门狗还认不认。 | 绿 1s |  |
| `server/scripts/test-claude-steer-ack.ts` | （文件头没有说明；跑完打印）✓ Claude 原生引导等待真实 control_response 后才发送新方向 | 绿 7s |  |
| `server/scripts/test-claude-stream-errors.ts` | parseClaudeStream 对 **API 层失败** 的上报。 | 绿 12s |  |
| `server/scripts/test-claude-usage-accounting.ts` | claude 的 result 是**线程累计快照**，不是本轮增量 —— 这个文件钉住这件事的两面。 | 绿 1s |  |
| `server/scripts/test-cleanup-debt.ts` | 「这一次运行的后代没收干净」这件事的**责任闭环**:落账 → 披露 → 重试 → 销账/收档。 | 绿 12s |  |
| `server/scripts/test-cleanup-ownership.ts` | **一个活身份必须随时有一个落脚处** —— 第 10 轮审查 F1 的那条不变量,写成一句可执行的话。 | 绿 6s |  |
| `server/scripts/test-cleanup-pending.ts` | **账本的内存那一摊**:落库失败之后谁扛着、补投怎么投、点过的名会不会在交接里丢。 | 绿 1s |  |
| `server/scripts/test-cleanup-result.ts` | **判空的不变量**:根与后代两问都要有正面答案,弃权不算空。 | 绿 1s |  |
| `server/scripts/test-cleanup-write-handoff.ts` | **「尝试写入」不等于「身份已经接住」** —— 第 13 轮审查 F1 的那条不变量。 | 绿 13s |  |
| `server/scripts/test-cli-active-goal.ts` | （文件头没有说明；跑完打印）Codex live handle retains precedence over persisted snapshots: passed | 绿 2s |  |
| `server/scripts/test-cli-catalog.ts` | 智能体目录(server/src/executors/catalog/)的回归测试。 | 绿 4s |  |
| `server/scripts/test-cli-command-startup.ts` | （文件头没有说明；跑完打印）native creation errors return 400; edited/legacy startup failures persist and remain visible after reload: passed | 绿 2s |  |
| `server/scripts/test-cli-command-task.ts` | （文件头没有说明；跑完打印）native HTTP bypass, resume preflight, startup rollback, cleared queue holds, settlement, scoped state: passed | 绿 2s |  |
| `server/scripts/test-cli-commands.ts` | （文件头没有说明；跑完打印）cli command parsing, catalog, native RPC, privacy, Claude context, exec rejection: passed | 绿 1s |  |
| `server/scripts/test-cli-goal-lifecycle.ts` | （文件头没有说明；跑完打印）${agentType}: a completed queue member | 绿 7s |  |
| `server/scripts/test-cli-goal-recovery.ts` | （文件头没有说明；跑完打印）legacy single-slot goals, stale/tampered selectors, and immediate-only scope commands: passed | 绿 7s |  |
| `server/scripts/test-cli-models.ts` | CLI 模型清单探测(server/src/executors/model-probe.ts + 各 spec 的 models 解析器)的回归测试: | 绿（部分未执行） 5s | 机制段绿；严格档禁执行真 CLI，⑥「本机真实探测」与 codex 档位实探、claude control 探针按「没装」跳过 |
| `server/scripts/test-cli-overrides.ts` | 「覆盖 CLI 自己的配置」回归测试。钉住三件事: ① 声明表之外的 key 不落库、超范围的值被夹进 CLI 真认得的区间 ② profile 上配的值,真的以环境变量的形式出现在**子进程**里 ③ 没配的 profile 不注入(不是注入空串 —— 空串对 claude 是「配过但为空」) | 绿 5s |  |
| `server/scripts/test-cli-plan-scheduling.ts` | （文件头没有说明；跑完打印）verification wake executes in temporary default mode and preserves saved state: passed | 绿 3s |  |
| `server/scripts/test-cli-state-scopes.ts` | （文件头没有说明；跑完打印）Claude idle HTTP snapshots resolve the selected/default profile and owner, without scope leakage: passed | 绿 2s |  |
| `server/scripts/test-codex-desktop-catalog.ts` | （文件头没有说明；跑完打印）✓ 不兼容 schema / 缺失元数据失败回滚，不误报完成 | 绿 1s |  |
| `server/scripts/test-codex-diagnostics.ts` | （文件头没有说明；跑完打印）codex diagnostics tests passed | 绿 1s |  |
| `server/scripts/test-codex-resident.ts` | codex 的「会话级常驻」状态机(`openCodexResident`)。 | 绿 12s |  |
| `server/scripts/test-codex-resume-command.ts` | （文件头没有说明；跑完打印）✓ ${windows ? | 绿 2s |  |
| `server/scripts/test-context-1m-notice.ts` | 「执行器配了大压缩窗口、模型却没开 1M」这件事的判定与一键开启。 | 绿 3s |  |
| `server/scripts/test-controllable-detached.ts` | 可引导单飞的 stdin 也必须活过 server 重启：v1 发第一条后退出，v2 重开 writer 发第二条 与 stop； | 绿 2s |  |
| `server/scripts/test-conversation-redact.ts` | 删除会话消息的回归测试（conversation-redact.ts + history-reseed.ts + orchestrator 的 reseed）。 | 绿 6s |  |
| `server/scripts/test-conversation-turn.ts` | （文件头没有说明；跑完打印）conversation turn persistence/live parity passed | 绿 2s |  |
| `server/scripts/test-db-tx-ownership.ts` | 共享连接上的**事务归属**：一笔写返回成功，到底算不算「已经提交」。 | 绿 1s |  |
| `server/scripts/test-delivery-receipt.ts` | **一次投递的在途生命周期** —— 回执三档各自怎么处置那张租约,以及「协议层收下了」之后谁都 不许把它退回重投。 | 绿 15s |  |
| `server/scripts/test-detached-survival.ts` | 证明「agent 活得过 server 重启」这件事本身。 | 绿 4s |  |
| `server/scripts/test-diagnostic-session-reply.ts` | （文件头没有说明；跑完打印）diagnostic replies/invitations isolate worktrees and restore task context; genuine sessions retain resume behavior: pass | 绿 12s |  |
| `server/scripts/test-dir-picker.ts` | 系统文件选择窗口(dir-picker.ts)的纯逻辑部分。 | 绿 1s |  |
| `server/scripts/test-duet-attachments.ts` | 讨论附件链路的回归钉子,两处成稿共一套规矩: · 收敛门 GateAction.attachments → 讨论者 prompt / 时间线气泡 · 新建面板的附件 → duet.topic → 开场 prompt 的「议题」 读端(shared 的 parseAttachmentText)必须… | 绿 2s |  |
| `server/scripts/test-duet-gate-version.ts` | duet 收敛闸口的版本号回归:旧卡片上的点击不能放行新的一扇门,也不能把已经结束的讨论拉起来。 | 绿 2s |  |
| `server/scripts/test-duet-image-ownership.ts` | 讨论里 agent 说的那张图,**普通成员打不打得开**(审查第 2 轮 F4)。 | 绿 3s |  |
| `server/scripts/test-duet-session-lost.ts` | duet 撞上「CLI 说这条会话我不认识」时,一整轮要**跑完**、并且把该清的清掉。 | 绿 2s |  |
| `server/scripts/test-duet-stall-visibility.ts` | 讨论里的停滞诊断**跨不跨得过刷新**,以及执行过程那 200 格满了之后它会不会被挤掉。 | 绿 2s |  |
| `server/scripts/test-executor-default-scope.ts` | 「同一类型至多一个默认执行器」里的 **类型** 这一维。 | 绿 3s |  |
| `server/scripts/test-executor-overrides.ts` | 任务级 model / reasoningEffort 覆盖的继承规则（shared/src/executor-overrides.ts）。 | 绿 1s |  |
| `server/scripts/test-executor-resolution.ts` | 执行器解析优先级回归测试: executorId 命中 → 用该 profile executorId 悬空 → 按 type 默认执行器降级 executorId 缺省 → 按 type 默认执行器 | 绿 2s |  |
| `server/scripts/test-file-browser.ts` | 任务文件浏览的安全边界与识别口径（server/src/file-browser.ts）。 | 绿 1s |  |
| `server/scripts/test-file-search.ts` | `@` 引用文件的候选来源（server/src/file-search.ts）。 | 绿 1s |  |
| `server/scripts/test-follow-up.ts` | 「后续追问」判据的回归测试（纯函数，不碰 DB 也不摸盘）： isUserFollowUp —— 哪几种话算「我自己发的」，哪几种是机器代发/代写的 parseSessionOutput —— 落盘的 by:"system" 标记要能原样解回来 latestFollowUp —— 一个任务的多条… | 绿 1s |  |
| `server/scripts/test-foreign-bins.ts` | PATH 里「别人家的 node_modules/.bin」怎么摘（server/src/executors/bin-resolve.ts）。 | 绿 1s |  |
| `server/scripts/test-git-workbench-change-stats.ts` | （文件头没有说明；跑完打印）ok · real staged/unstaged statistics preserve tabbed paths, renames, binary files and repository state | 绿 1s |  |
| `server/scripts/test-git-workbench-partial-discard.ts` | （文件头没有说明；跑完打印）ok · hunk stage/unstage/discard include separator, comment, increment and header-like content; actual file headers remai | 绿 10s |  |
| `server/scripts/test-handoff-accept-gate.ts` | （文件头没有说明；跑完打印）handoff-accept-gate: outbound/return receipts, history, logs, absent logs, idempotency and active-run protection passed | 绿 2s |  |
| `server/scripts/test-handoff-accepted-return.ts` | 「在别的机器上跑完 + 验收完，再移回原机」这条路上的回归（用户 2026-09-01 报的）： 移回后**不该**自动续跑。 | 绿 5s |  |
| `server/scripts/test-handoff-auth.ts` | 接力鉴权回归:**身份**而不是口令。分两个方向验,它们防的不是同一件事。 | 绿 11s | 严格档禁执行真 CLI 时对端报「没装 claude」；放开执行（仍禁外网）后绿 |
| `server/scripts/test-handoff-capability-e2e.ts` | 能力握手的**端到端**回归:真起一台对端 ash,走真 HTTP。 | 绿 7s | 严格档禁执行真 CLI 时对端报「没装 claude」；放开执行（仍禁外网）后绿 |
| `server/scripts/test-handoff-capability.ts` | 接力的能力握手:目标机跑不跑得动这个任务(server/src/handoff-capability.ts)。 | 绿 4s |  |
| `server/scripts/test-handoff-cli-config-dir.ts` | 接力搬 CLI 会话文件时,「放哪」和「起跑时 CLI 去哪找」必须是同一个目录。 | 绿 2s |  |
| `server/scripts/test-handoff-free-workflow-rows.ts` | 接力导入侧「审查历史翻译」的边界:哪些本机外键解析得到、解析不到时哪些东西可以撤、 哪些**绝不能**撤。 | 绿 1s |  |
| `server/scripts/test-handoff-holder.ts` | 出站行的持有机怎么认（shared 的 outboundHolder）。 | 绿 1s |  |
| `server/scripts/test-handoff-key-concurrency.ts` | （文件头没有说明；跑完打印）handoff key concurrency: delete, re-add, address change, clear, competing save, pending scope and rollback passed | 绿 1s |  |
| `server/scripts/test-handoff-key-persistence.ts` | （文件头没有说明；跑完打印）handoff key persistence: atomic deletion rollback/retry, verified saves, unchanged failures and usable retries passed | 绿 2s |  |
| `server/scripts/test-handoff-local.ts` | 任务接力——单进程回归(进程内直调导入,不 spawn 对端 server): 1. 上下文感知的附件路径改写纯函数:POSIX 源机 → Windows 目标机时,原始/JSON 转义 两种形态的 from 相同、to 不同(歧义),必须按文本上下文分组替换——纯文本得原始 形态,JSONL … | 绿 3s |  |
| `server/scripts/test-handoff-notice.ts` | 接力前言的投递:「你被搬过机器了」这段话必须**两条起跑路径都收得到**,而且只收一次。 | 绿 5s |  |
| `server/scripts/test-handoff-outbound-key.ts` | （文件头没有说明；跑完打印）handoff outbound keys: signed verification before credentials, task identity, replacement host, legacy binding and user  | 绿 1s |  |
| `server/scripts/test-handoff-peer-key.ts` | 「我在对端的账号 key」的回归:**它是接力的第二把钥匙,而且两种实例模式都要有地方填**。 | 绿 1s |  |
| `server/scripts/test-handoff-remote-return.ts` | （文件头没有说明；跑完打印）handoff remote return tests passed: unchanged/pending archives rejected, confirmed ownership accepted | 绿 2s |  |
| `server/scripts/test-handoff-return.ts` | （文件头没有说明；跑完打印）test-handoff-return ok | 绿 11s | 严格档禁执行真 CLI 时对端报「没装 claude」；放开执行（仍禁外网）后绿 |
| `server/scripts/test-handoff-source-address.ts` | （文件头没有说明；跑完打印）handoff source address: persistence, signed identity, return discovery, credentials and user scope passed | 绿 3s |  |
| `server/scripts/test-handoff.ts` | 任务接力(handoff)端到端回归:测试进程自己当**源机**(进程内直调 preflight/export, ASH_DB 指向临时源库),再真 spawn 一个 ash server 当**对端**(PORT=0 随机端口、 独立临时库),两边走真 HTTP 协议。 | 绿 7s | 严格档禁执行真 CLI 时对端报「没装 claude」；放开执行（仍禁外网）后绿 |
| `server/scripts/test-human-approval.ts` | （文件头没有说明；跑完打印）human-approval regressions ok | 绿 3s |  |
| `server/scripts/test-im-actor.ts` | 飞书通道的身份边界：经飞书发起的请求是「绑定的那个人」，而且只是他能做的事里的一小部分。 | 绿 3s |  |
| `server/scripts/test-im-cards.ts` | 飞书决策卡片的一生：推出去 → 点按钮 → 结果就地换上； | 绿（已修） 9s | (b) 夹具没按生产占住 duet 回合锁（0a563a53 之后） |
| `server/scripts/test-im-gates.ts` | 预设工作流上接连几道「等我点头」× 飞书待验收卡（理由见 server/src/task-human-gate.ts 文件头）。 | 绿 9s |  |
| `server/scripts/test-im-pairing.ts` | 新设备申请连进来 × 飞书配对卡（理由见 server/src/im/pairing.ts 文件头）。 | 绿 9s |  |
| `server/scripts/test-im-recall.ts` | 卡上那件事在别处了结、任务接着跑了：撤回那张卡，不在聊天里留一张「继续在跑」的灰卡（理由见 reconcile.ts、outbox.ts 的文件头）。 | 绿 8s |  |
| `server/scripts/test-im-requests.ts` | 回给一次请求的业务内容（scope.ts requestScope）：命令回执、确认卡、/todo 清单、房间回复都按消息进来那一刻的 绑定实例盖，不按办完时的现状； | 绿 8s |  |
| `server/scripts/test-im-review.ts` | 有审查的任务：审查出结论之前不推「完成了，等你验收」，审查通过时推的那张就说「审查通过」（理由见 shared task-attention.ts humanTurnOf、reconcile.ts resolutionLine）。 | 绿 15s |  |
| `server/scripts/test-im-settling.ts` | 任务停下来的那一刻，机器自己马上就会接着跑：不推「等你验收」，免得一张卡发出去转眼就撤回（理由见 reconcile.ts 文件头、 shared task-attention.ts humanTurnOf）。 | 绿 8s |  |
| `server/scripts/test-im-wire.ts` | 飞书通道的「线」这一层：长连接帧编解码、分片合并与回执、REST 调用的 token 与额度闸、月额度 计数与降级、消息正文解析、文本脱敏、命令与绑定码识别。 | 绿 2s |  |
| `server/scripts/test-kernel-confine.ts` | **内核圈定**这台设备的回归(`executors/kernel-confine.ts` / `confine-job.ts`)。 | 绿 1s |  |
| `server/scripts/test-kill-lineage.ts` | **从拓扑生成可击杀目标时,每一条父子边都要自己拿得出凭证** —— 第 17 轮审查 F1/F2/F3。 | 绿 2s |  |
| `server/scripts/test-kimi.ts` | （文件头没有说明；跑完打印）kimi executor tests passed | 绿 2s |  |
| `server/scripts/test-launch-abandon.ts` | （文件头没有说明；跑完打印）test-launch-abandon: all assertions passed | 绿 3s |  |
| `server/scripts/test-llm-relay.ts` | （文件头没有说明；跑完打印）llm relay tests passed | 绿 4s | 沙箱挡 ::ffff:127.0.0.1，放开外网档后绿 |
| `server/scripts/test-local-open.ts` | （文件头没有说明；跑完打印）✓ local-open：项目 worktree 可打开，家目录里的音视频可打开，越界/软链/非可信来源被拒绝 | 绿 1s |  |
| `server/scripts/test-mcp-handoff.ts` | 「交卷丢了回头补捞」的回归。 | 绿 1s |  |
| `server/scripts/test-missing-task-writes.ts` | 「任务不存在」时的写型端点:一律不许 2xx,一行都不许落库。 | 绿 2s |  |
| `server/scripts/test-model-effort-isolation.ts` | 「宿主机 CLI 额度隔离」与「已探到的档位表」必须同步翻面。 | 绿 2s | 严格档禁执行真 CLI 时对端报「没装 claude」；放开执行（仍禁外网）后绿 |
| `server/scripts/test-monitor-complete-columns.ts` | 这一版新加的三列，在**存量库**上补得上吗 —— 而且补上之后不改写任何既有事实。 | 绿 1s |  |
| `server/scripts/test-monitor-complete-gate.ts` | 完成确认这一刻的哨兵闸 —— 「挂着哨兵就不许收工」「结果没收到就不许收工」「先撤再收工要留痕」。 | 绿 9s |  |
| `server/scripts/test-monitor-create-protocol.ts` | **命令开工 ⇒ 身份已经可恢复。** 等价说法:身份没落库 ⇒ 那条命令一个字都没跑过。 | 绿 6s |  |
| `server/scripts/test-monitor-create-window.ts` | **创建是一段时间**:这中间的撤销与结局都要被同一份协议接住(第 8 轮审查 F1/F3 起)。 | 绿 15s |  |
| `server/scripts/test-monitor-end-condition-gate.ts` | 哨兵结束条件的**闸**与**判据**:命令自己不会结束、又没给结束条件 ⇒ 一个字都不许跑。 | 绿 3s |  |
| `server/scripts/test-monitor-end-condition.ts` | 哨兵的**结束条件**（`stopWhen`）这一块的回归:它什么时候算完、谁来保证它一定给得出。 | 绿（已修） 7s | (a) 待发送合并成「积压 + 最新」两行（8cbcc0ff） |
| `server/scripts/test-monitor-generation.ts` | **归属证明必须跟「读到它的那一代」绑在一起** —— 第 15 轮审查 F1 的回归。 | 绿 5s |  |
| `server/scripts/test-monitor-owed-batch.ts` | 一批行的**归宿**:已交付 / 已明确放弃 / 已持久移交,三者之一（消费层文件头 ⑤）。 | 绿 12s |  |
| `server/scripts/test-monitor-perturbation.ts` | 硬拦资格的**最后一道**:这条命令的执行语义，我这一层还读得懂吗（见 shared/src/command-never-exits.ts 文件头 ⑪⑫）。 | 绿 1s |  |
| `server/scripts/test-monitor-races.ts` | 哨兵的**终态与投递**回归：任务自己结束的那一瞬间，谁还能把它叫醒。 | 绿 14s |  |
| `server/scripts/test-monitor-reclaim-identity.ts` | **身份这一问的判定本身:问出来的那个答案到底证明了什么。 | 绿 12s |  |
| `server/scripts/test-monitor-result-lifecycle.ts` | **命令的命 ≠ 结果的命**，以及「谁来收、按什么资格收」。 | 绿（已修） 3s | (b) isReviewSourceActive 查询多了 taskId（a1771e58），注入点打不中 |
| `server/scripts/test-monitor-review-lifecycle.ts` | 审查者挂的哨兵，**活到那次审查结束**，而不是活到任务状态变回终态。 | 绿 4s |  |
| `server/scripts/test-monitor-turn-handoff.ts` | 哨兵结果的回合内交付(monitor-turn-handoff.ts):交出去、带回回执号才算送到(monitor-turn-ack.ts)、 收口时结清。 | 绿 3s |  |
| `server/scripts/test-monitor-wake-data.ts` | （文件头没有说明；跑完打印）monitor data: real producer, failure result, hostile delimiters, checkpoint retry and legacy merge passed | 绿 2s |  |
| `server/scripts/test-monitor-wake-role.ts` | 哨兵醒来时**叫哪条会话**。 | 绿 5s |  |
| `server/scripts/test-monitor-wake-turns.ts` | 「N 轮,其中哨兵唤醒 M 轮」:M 必须是 N 所数那批回合里带哨兵来源的子集。 | 绿 2s |  |
| `server/scripts/test-multi-user-agent.ts` | agent 回合凭证的**边界**:它代表的是那一条任务,不是任务 owner 的账号(§三, `docs/multi-user-plan.md:50`「有效回合凭证 → 任务归属项目」)。 | 绿 2s |  |
| `server/scripts/test-multi-user-git.ts` | 多人模式下**三条「不是网页登录态」的路**的回归。 | 绿 5s |  |
| `server/scripts/test-multi-user-members.ts` | 项目成员表的写侧(§六)。判据只有一条,但它有**两个入口**: | 绿 2s |  |
| `server/scripts/test-multi-user-paths.ts` | 路径钳制的**判据层**回归(§七)。从 test-multi-user.ts 的 ③ 组搬出来单开一份: 那个文件是十几组横切判据的合集,而路径钳制自己已经长成一整块 —— 一份三态判据 (`auth/path-scope.ts`)喂着六个入口(建项目 / 按路径找回 / 改路径 / 路径体检… | 绿 1s |  |
| `server/scripts/test-multi-user-run.ts` | 「这一次起跑是谁点的」——多人模式下**真的起进程**那一段的回归。 | 绿 9s |  |
| `server/scripts/test-multi-user-settings.ts` | 「默认规则」的**个人面 / 实例面之分**(§八)回归。 | 绿 1s |  |
| `server/scripts/test-multi-user-setup.ts` | 首启转换与建用户的**失败半途**回归。判据只有一条,但它两处都栽了同一跤: | 绿 3s |  |
| `server/scripts/test-multi-user.ts` | 多人模式的横切回归。挑的都是「改一处就会静默塌掉别处」的判据: | 绿（已修） 3s | (c) 产品已修：个人面写闸把免登录名单上的 relay 匿名回连拦成 403（9ab015ab） |
| `server/scripts/test-native-command-turn.ts` | `/compact` 这类 CLI 原生命令回合的边界:它**只是让 CLI 把上下文压一压**,没有模型 输出、没有产出、也没有结论。 | 绿 2s |  |
| `server/scripts/test-native-steer.ts` | （文件头没有说明；跑完打印）✓ Claude/Codex 新生产路径都保留 detached 接管信息 | 绿 4s |  |
| `server/scripts/test-no-libsql.ts` | 回归测试：**运行时不许再加载 `@libsql/client`**。 | 绿 1s |  |
| `server/scripts/test-note-task-history.ts` | （文件头没有说明；跑完打印）note task history tests passed | 绿 2s |  |
| `server/scripts/test-onboarding-gate.ts` | 首启向导后半段(供应商 / 执行器 / 项目)的放行判据回归,对着 `src/onboarding.ts` 与 `src/db/migrate-onboarding.ts`。 | 绿 1s |  |
| `server/scripts/test-open-in-ide.ts` | 「用 IDE 打开这个文件夹」的回归测试。 | 绿 4s |  |
| `server/scripts/test-openai-converter.ts` | （文件头没有说明；跑完打印）openai converter tests passed | 绿 1s |  |
| `server/scripts/test-openers-windows.ts` | Windows「用哪个应用打开」的注册表解析 + 命令行拼装。 | 绿 1s |  |
| `server/scripts/test-page-annotation-batches.ts` | （文件头没有说明；跑完打印）annotation batches: concurrent HTTP retries, atomic queue receipt, immutable confirmation, restart recovery, draft failu | 绿（已修） 3s | (b) markSent 要传领取时的行（ac19a7d7） |
| `server/scripts/test-path-boundary.ts` | 跨平台的**路径安全边界**（platform.ts 的 boundaryKey / isInsidePath / windowsPathRejection，以及吃它们的两个端点：file-browser、local-open-routes）。 | 绿 1s |  |
| `server/scripts/test-peer-context.ts` | 「本任务还有其他智能体参与」的告知规则（server/src/peer-context.ts）。 | 绿 1s |  |
| `server/scripts/test-pending-after-handoff.ts` | 「等某任务完成后发送」(mode=after)在依赖核验与跨机交接上的回归: ① resolveAfterTarget:回复与接力导入共用的那道核验(自己 / 不存在 / 跨项目 / 团队调度台 / 基线) ② 消费侧兜底:哪个写入口漏核了,跨项目的前置完成也放行不了这条消息 ③ 导出:载荷成形… | 绿 2s |  |
| `server/scripts/test-pending-after.ts` | 「等某任务完成后发送」(mode=after)与「已结束任务不能入队」的回归。 | 绿 3s |  |
| `server/scripts/test-powershell-command.ts` | （文件头没有说明；跑完打印）PowerShell semantics passed (${shell}): ${testCase.name} | 绿（部分未执行） 1s | 开头 4 条 CLIXML 判错断言绿；PowerShell 语义段需 Windows 或 ASH_TEST_POWERSHELL，本机无 pwsh，未执行 |
| `server/scripts/test-preview-annotation.ts` | （文件头没有说明；跑完打印）preview annotation: CSP rewrite, dormancy, source/port handshake, Escape forwarding/defaultPrevented/cleanup, modes, sha | 绿 1s |  |
| `server/scripts/test-preview-assist.ts` | AI 协助的两件硬事：**结论怎么抠出来**、**试跑怎么判定**。 | 绿 13s |  |
| `server/scripts/test-preview-cache-path.ts` | （文件头没有说明；跑完打印）preview cache path: symlink/junction aliases preserve held caches and release expired unused caches | 绿 1s |  |
| `server/scripts/test-preview-command.ts` | 「这个项目怎么起服务」的识别（server/src/preview-command.ts）。 | 绿 1s |  |
| `server/scripts/test-preview-cookies.ts` | 预览代理那个 cookie 罐子（server/src/preview-cookies.ts）。 | 绿 1s |  |
| `server/scripts/test-preview-deps.ts` | 「预览缺 node 依赖时，ash 在**项目之外**备一份」（server/src/preview-deps.ts）。 | 绿 3s |  |
| `server/scripts/test-preview-host-api.ts` | 「只起前端」那一档的 /api 到底打到哪台 ash 上 —— 拿**真的 `npm run dev`** 跑一遍。 | 绿 4s |  |
| `server/scripts/test-preview-launch.ts` | 预览起多大一摊（`$ASH_PREVIEW_MODE`）照谁的意思来。 | 绿 5s |  |
| `server/scripts/test-preview-lent-port.ts` | 「起来了，但没起在我借给它的那个端口上」——拿**真的进程**跑一遍两种命令。 | 绿 2s |  |
| `server/scripts/test-preview-log.ts` | 预览日志判读（server/src/preview-log.ts）。 | 绿 1s |  |
| `server/scripts/test-preview-probe.ts` | 预览的就绪探测（server/src/preview-probe.ts）。 | 绿 1s |  |
| `server/scripts/test-preview-seed.ts` | 预览播种（server/src/preview-seed.ts）。 | 绿 1s |  |
| `server/scripts/test-preview-settings-proxy.ts` | （文件头没有说明；跑完打印）preview settings/proxy tests passed: persisted selection, processes, HTTP, resources, SSE, WebSocket, credentials, permi | 绿 14s |  |
| `server/scripts/test-preview-stop-notice.ts` | 预览子进程的那条看门狗（preview-start.ts 的 child.on("exit")）必须分得清两件事： 服务自己死了，和**我们把它杀了**。 | 绿 3s |  |
| `server/scripts/test-preview-workspace.ts` | （文件头没有说明；跑完打印）preview workspace: task-local static/framework/custom/config launches, proxy + annotation document, missing workspace, l | 绿 6s |  |
| `server/scripts/test-process-subtrees.ts` | **进程树快照与子树归属** —— 「这棵树凭什么算我们的」(第 1 轮审查 F1、第 2 轮审查 F1/F3)。 | 绿 8s |  |
| `server/scripts/test-progress-boundary.ts` | **「有过进展」在协议层读到就算数,而且落盘之前水位不许越过它。 | 绿 12s |  |
| `server/scripts/test-project-clone.ts` | 「从 Git 检出新项目」的回归测试。钉住 `project-clone.ts` 顶部那五条决定里靠通读发现 不了的四条:非空目录一律拒绝、失败不留半个坑(且只收拾自己造的,连上级目录一起)、 克隆成功才写库、克隆当场用上的凭证要留在新项目上。 | 绿 1s |  |
| `server/scripts/test-project-dir.ts` | 「本地目录」这条路上唯一会动磁盘的那一小块：`createDir`。 | 绿 2s |  |
| `server/scripts/test-project-git-config.ts` | 项目级 git 配置的回归。钉住的是五件靠通读发现不了的事： | 绿 2s |  |
| `server/scripts/test-project-git.ts` | 项目主仓 git 面板的回归测试。钉住 `git-project-ops.ts` 顶部那四条决定里最容易被 「优化」掉的三条：脏工作区不动手且绝不 stash、分支被别的 worktree 占着要拦在前面、 拉取失败不许把主仓留在 merge/rebase 中途。 | 绿 8s |  |
| `server/scripts/test-protocol-evidence.ts` | **协议证据只许按它真说了什么下结论** —— 坏行不是否证,明确的 error 应答不是「说不上来」。 | 绿 5s |  |
| `server/scripts/test-question-history.ts` | （文件头没有说明；跑完打印）question history: durable snapshots, concise replies, stale/concurrent guards and legacy recovery passed | 绿 2s |  |
| `server/scripts/test-question-supersede.ts` | 用户没答提问、直接发新消息时，那道提问要撤下（task-question-supersede.ts）。 | 绿 3s |  |
| `server/scripts/test-queue-order.ts` | 队列顺序语义的回归测试(纯函数,不碰 DB): selectNextInQueue —— 谁该被拉起来 / 什么时候一个都不拉 isOvertaken / tailOrder —— 重新排队该不该去队尾、去了以后顺序对不对 | 绿 2s |  |
| `server/scripts/test-queue.ts` | E2E 测试:队列调度 + 迁移自检 + 跨 group 校验。 | 绿 2s |  |
| `server/scripts/test-reattach.ts` | 验证「重启接管」的接线本身（detached 机制的存活性由 test-detached-survival 证明）。 | 绿（已修） 13s | (b) 同上 |
| `server/scripts/test-relay-proxy.ts` | （文件头没有说明；跑完打印）relay proxy tests passed | 绿 1s |  |
| `server/scripts/test-reopen-acceptance.ts` | （文件头没有说明；跑完打印）reopen acceptance: single/team/duet × accepted/merged 回归验证通过 | 绿 1s |  |
| `server/scripts/test-repo-lock.ts` | 仓库级串行锁回归测试:并行验收必须排队依次合并,而不是一起冲进同一个 `.git`。 | 绿 7s |  |
| `server/scripts/test-request-timing.ts` | 输出速度的计时样本(TokenUsage.timed)从执行器一路走到界面,钉住三段: | 绿 1s |  |
| `server/scripts/test-response-compression.ts` | （文件头没有说明；跑完打印）✓ 声明了长度的小响应、SSE、Range 响应、LLM 中继不压 | 绿 1s |  |
| `server/scripts/test-resume-prompt-broadcast.ts` | resume_prompt 变了必须能到客户端。 | 绿 1s |  |
| `server/scripts/test-retry-turn-queue.ts` | 「重试这一回合 / 继续本轮审查」与串行队列:队列那道闸只挡续跑档(真正的任务执行)。 | 绿 8s |  |
| `server/scripts/test-retry-turn.ts` | 「重跑上一回合」认输入的判据（纯函数，不碰 DB 也不摸盘）。 | 绿 2s |  |
| `server/scripts/test-review-no-verdict.ts` | 一轮审查没给出结论时，ash 说的那句话和写进轮次的那份原因（review-channel-gap.ts 的 noteReviewerChannelGap + review-no-verdict.ts）。 | 绿 2s |  |
| `server/scripts/test-run-notices.ts` | （文件头没有说明；跑完打印）✓ Codex 含 exec 专属参数时保留完整 CLI 语义并安全回退硬引导 | 绿 4s |  |
| `server/scripts/test-scm-guard.ts` | SCM 写接口的门禁回归测试（路由级，跑在临时库 + 临时仓库上）。 | 绿 8s |  |
| `server/scripts/test-scm-nested.ts` | 嵌套 Git 仓库在面板上的行为（路由级，跑在临时库 + 临时仓库上）。 | 绿 3s |  |
| `server/scripts/test-scm-workspace.ts` | 工作区 SCM 面板回归测试：porcelain v2 的解析和四个写操作，全部跑在临时仓库里。 | 绿 5s |  |
| `server/scripts/test-search-query.ts` | （文件头没有说明；跑完打印）search query + task-id + git overview parser tests passed | 绿 1s |  |
| `server/scripts/test-search-scan.ts` | ⌘K 搜索的**扫描策略**回归：早停必须不改结果，该下盘时不能偷懒。 | 绿 1s |  |
| `server/scripts/test-search-visibility.ts` | ⌘K 全局搜索的**可见性**回归:它是全库里最危险的一个读口 —— 返回的不是标题列表, 而是任务正文、磁盘上的会话原文和随手记正文的**片段**。 | 绿 4s |  |
| `server/scripts/test-seat-ownership.ts` | 「谁有权改这个状态」的回归(任务 hprbvyaE6SDy 第 1 轮独立审查 F1/F2/F3)。 | 绿 3s |  |
| `server/scripts/test-service-ports-scan.ts` | 端口兜底那一档里**不需要真进程**的部分:从输出里认端口(含流式切块等价)、以及探测的 三态合并。 | 绿 1s |  |
| `server/scripts/test-session-lost.ts` | 「CLI 否认了这条会话」的识别与清理。 起因(2026-08-21,172.16.88.252):任务第一次起跑就被 claude 的 root 闸拒掉,stdout 0 字节 —— 会话压根没建起来,但 ash 在 spawn 那一刻就把自己发的 session id 落了库。 之后每一次重… | 绿 2s |  |
| `server/scripts/test-session-notice.ts` | 会话轮换（Codex thread 被判 poisoned）跟**本回合成败正交**：exit 0、正文完整的一轮 照样会带一条轮换诊断。 | 绿 2s |  |
| `server/scripts/test-session-read-errors.ts` | transcript / trace 读不出来的时候，路由到底说什么。 | 绿 2s |  |
| `server/scripts/test-session-trace.ts` | （文件头没有说明；跑完打印）会话执行轨迹持久化验证通过 | 绿 1s |  |
| `server/scripts/test-session-turn-migration.ts` | 老库升到「回合一行」这套形状时的契约：`ended_at` 得能为空、同一回合不能有两行、升级前 的历史要变成一个**说得出来的基数**而不是悄悄当成完整。 | 绿 1s |  |
| `server/scripts/test-session-turn-persist.ts` | 回合记录的**持久化契约**：同一个身份在库里只能往前走——「无行 → 开了 → 收了」。 | 绿 2s |  |
| `server/scripts/test-session-waiting.ts` | 窄出口(`GET /sessions/:id/notices`)那两种投影各自的判据。 | 绿 1s |  |
| `server/scripts/test-settlement-note.ts` | 结算说明的落盘往返：server 写下的那一行，读端必须认得出它是「说明」而不是输入/故障。 | 绿 2s |  |
| `server/scripts/test-silence-tier.ts` | **看门狗静默档的判据本体** —— 「回合起来了,输入却从未送到」那一类现场的第三道闸。 | 绿 12s |  |
| `server/scripts/test-skills.ts` | `/` 技能补全的数据层回归测试(不起 CLI,读写全关在 mkdtemp 里): listSkills / withSkillInvocation —— 扫盘、调用注入、不认识的 CLI 不假装 指纹 —— 改 SKILL.md 的 description,不重启也要跟着变 calibrate… | 绿 1s |  |
| `server/scripts/test-ssh-profile-retire.ts` | 老库升级回归:注册过 ssh 执行器的库升上来之后,那条 profile 必须消失,而不是丢掉 「它在远端」这件事继续当本机 profile 用(第 1 轮审查:label 还是 claude@build.example, resume 却已经是本机的 `cd /repo && claude -… | 绿 2s |  |
| `server/scripts/test-stall-flag.ts` | 「上游停滞」那个**持久标记**的生命周期:置上、撤掉、按停滞身份比对、以及开始边界的清理。 | 绿 1s |  |
| `server/scripts/test-stall-journal.ts` | 熔断判决的**落盘事实**那一层:日志本身,以及「存住了没有」这个结论怎么一路传到用户眼前。 | 绿 5s |  |
| `server/scripts/test-stall-settle.ts` | 看门狗熔断掉的那一轮**最后显示成什么**:落位优先级。 | 绿 2s |  |
| `server/scripts/test-startup-receipt.ts` | **spawn 之后本地记账失败,输入事实照样交给调用方** —— 不多执行一次,也不丢一段交代。 | 绿（已修） 5s | (b) 续跑交代由扫描接管、晚返回一拍回填，等租约落定再断言 |
| `server/scripts/test-steer-refused-reply.ts` | **引导请求必须有终局答复** —— 即使新方向被协议层拒收、租约也已经被别人还掉了。 | 绿 7s |  |
| `server/scripts/test-stop-evidence.ts` | （文件头没有说明；跑完打印）stop evidence passed: completeness survives PID merges and inspection failures stay unknown | 绿 1s |  |
| `server/scripts/test-stop-review.ts` | （文件头没有说明；跑完打印）stop review passed: exact session, uncertain DTO, query handoff, sync ownership, real stop escape | 绿 5s |  |
| `server/scripts/test-stop-turn-observation.ts` | （文件头没有说明；跑完打印）stop-turn observation regressions ok | 绿 2s |  |
| `server/scripts/test-stop-verification.ts` | （文件头没有说明；入口 npm run test:terminal） | 绿 9s |  |
| `server/scripts/test-task-activity.ts` | 「与任务活动正交的写入不推进 updatedAt」的回归测试。 | 绿 3s |  |
| `server/scripts/test-task-artifact-scope.ts` | 产物面板的**归属证据**（server/src/task-artifact-{scope,windows,paths}.ts）。 | 绿（已修） 7s | (c) 产品已修：隔离工作区一支不分还在/已删（4be79fa3） |
| `server/scripts/test-task-artifacts-concurrent.ts` | 共享目录上**同时在跑**的任务，生成物怎么分开（server/src/task-artifacts.ts 顶部那几条）。 | 绿 5s |  |
| `server/scripts/test-task-artifacts-evidence.ts` | 生成物归属的 git 那一半（非 git 共享目录那一半在 test-task-artifacts-concurrent.ts）。 | 绿 5s |  |
| `server/scripts/test-task-artifacts.ts` | 「这个任务做出来了什么」的判据（server/src/task-artifacts.ts）。 | 绿 4s |  |
| `server/scripts/test-task-creation-origin.ts` | （文件头没有说明；跑完打印）✓ user vs agent, user derivation, actual source session vs worker, stale identity, external MCP, batch, team dispatch, i | 绿 2s |  |
| `server/scripts/test-task-derivation-policy.ts` | （文件头没有说明；跑完打印）task derivation policy tests passed | 绿 2s |  |
| `server/scripts/test-task-direction-epoch-entries.ts` | 方向世代的**两个真实起跑入口**，以及完成票的**另一半**（内存那条快路）。 | 绿 9s |  |
| `server/scripts/test-task-event-timestamps.ts` | （文件头没有说明；跑完打印）task event timestamps: 状态水位、系统旁注时间与类型均保持实时/落盘一致 | 绿 2s |  |
| `server/scripts/test-task-file-raw.ts` | 「正文里那张图去哪儿取」的边界：`GET /tasks/:id/file/raw` 的 workspaceOnly 档。 | 绿 2s |  |
| `server/scripts/test-task-list-body.ts` | 列表接口**不带正文**的回归（起临时库 + 挂真路由，不 spawn agent）。 | 绿 2s |  |
| `server/scripts/test-task-memos.ts` | 任务备忘的后端回归：CRUD、校验、批量摘要。 | 绿 1s |  |
| `server/scripts/test-task-page.ts` | 网页产物的沙箱预览（server/src/task-page.ts）。 | 绿 1s |  |
| `server/scripts/test-task-steer-hardening.ts` | （文件头没有说明；跑完打印）✓ complete_task 严格绑定当前回合 token，旧回合迟到确认返回 409 | 绿 2s |  |
| `server/scripts/test-task-steer-rollback.ts` | 原生引导**发送失败那一程**：旧方向的三张票各自回得去吗。 | 绿 2s |  |
| `server/scripts/test-task-workspace.ts` | （文件头没有说明；跑完打印）✓ 三种工作目录去向各自的措辞对得上，同回合的两条 marker 不互相打架 | 绿 5s |  |
| `server/scripts/test-team-accept-crew.ts` | 团队验收期间成员集合不能长（team-acceptance-hold.ts 文件头）：验收占住的是开始那一刻的那一批，多出来的那位 不在占位里、照样能起跑改共享目录（审查实测：团队落了「已验收」，新建的执行者正在跑）。 | 绿 3s |  |
| `server/scripts/test-team-inbound-durability.ts` | 待送的执行者汇报必须**活过 server 重启**。 | 绿 4s |  |
| `server/scripts/test-team-inbound-interleave.ts` | 回合收尾合并投递的那段 await 里,**又来了一条执行者汇报**。 | 绿 2s |  |
| `server/scripts/test-team-inbound-resilience.ts` | （文件头没有说明；跑完打印）test:team-resilience inbound ok | 绿 4s |  |
| `server/scripts/test-team-lead-resilience.ts` | （文件头没有说明；跑完打印）test:team-resilience core ok | 绿 5s |  |
| `server/scripts/test-team-native-command.ts` | 调度台离线时收到 `/compact`:必须原样告诉用户「没送出去」,而不是把它拼进唤醒语 发给模型。 | 绿 2s |  |
| `server/scripts/test-team-notice-trace.ts` | 常驻调度台**自发开的那一轮**里,上游重试提示归谁。 | 绿 2s |  |
| `server/scripts/test-team-session-notice.ts` | 团队调度台的**收尾**那一段:一个 exit 0、正文完整、但恢复 thread 被判 poisoned 的 回合,随后用户按「停止全组」。 | 绿 4s |  |
| `server/scripts/test-team-silence-tier.ts` | 常驻调度台这条链的**静默档** —— 「回合起来了,一条事件都不来」在团队台上也得有人管。 | 绿 5s |  |
| `server/scripts/test-team-user-interrupt.ts` | 用户插话必须**当场转向**,哪怕它是排在别的投递后面进来的。 | 绿 2s |  |
| `server/scripts/test-terminal-lifecycle.ts` | （文件头没有说明；跑完打印）terminal lifecycle passed: invalidated reservations, rollback, pending cancellation and shutdown | 绿 6s |  |
| `server/scripts/test-terminal-pty.ts` | （文件头没有说明；跑完打印）✓ isolated PTY: bounded startup, responsive event loop, error propagation, input, resize, single exit, cleanup | 绿 6s |  |
| `server/scripts/test-terminal.ts` | （文件头没有说明；跑完打印）terminal session test passed | 绿 15s |  |
| `server/scripts/test-turn-baseline.ts` | 「这一轮到底产出新一版没有」的前后快照比对，在**真数据库 + 真 git 仓库**上钉住。 | 绿 3s |  |
| `server/scripts/test-turn-freeze.ts` | 起跑前那道冻结闸的回归（第 1 轮审查 finding 1）。 | 绿 2s |  |
| `server/scripts/test-turn-identity-bridge.ts` | 回合身份搭 `PATH` 那班车的那条通路(copilot 这类只自动继承 `PATH` 的 CLI 靠它交卷)。 | 绿（已修） 1s | (b) 在 ash 回合里跑时继承 PATH 带身份目录，基线先洗 |
| `server/scripts/test-turn-outcomes.ts` | 每一回合**自己**的结局要交到页面上:快照(`GET /tasks/:id/sessions` 的 `turnOutcomes`)和直播 (回合结尾 `done` / `turnEnd` 上的 `turnOutcome`)两路,口径跟落进 `session_turns.outcome` 的同一份。 | 绿 2s |  |
| `server/scripts/test-turn-output.ts` | 「活干了、就是忘了交卷」的探针，在**真 git 仓库**上钉住。 | 绿 1s |  |
| `server/scripts/test-turn-ownership.ts` | 第 11 轮审查修复回归（ML6MSHoXU2Il r1）：回合所有权与预约槽的原子性。 | 绿 2s |  |
| `server/scripts/test-turn-reclaim.ts` | 唤醒链路三缺陷的回归（任务 hprbvyaE6SDy）。 | 绿 6s |  |
| `server/scripts/test-turn-release-ownership.ts` | 「放锁只能放自己那一把」的回归(第 2 轮独立审查 F1)。 | 绿 1s |  |
| `server/scripts/test-turn-stall-progress.ts` | 回合级停滞看门狗的**解除条件**:到底什么算「上游真回话了」。 | 绿 1s |  |
| `server/scripts/test-turn-stall.ts` | 回合级停滞看门狗的两档判据,以及它**绝不该**动手的那几种形状。 | 绿 12s |  |
| `server/scripts/test-turn-visibility.ts` | 起跑失败的回合，用户到底能看见什么。 | 绿 2s |  |
| `server/scripts/test-upload-names.ts` | 附件文件名的字符集契约(`server/src/upload-names.ts`)。 | 绿 1s |  |
| `server/scripts/test-upload-visibility.ts` | 上传附件的**授权面**回归(§八)。 | 绿 6s |  |
| `server/scripts/test-usage-accounting.ts` | Token 账本的三处要害，在**真数据库**上钉住。 | 绿 3s |  |
| `server/scripts/test-user-cli-mcp.ts` | 个人 CLI 配置目录里的 ash MCP 登记(`auth/user-cli-mcp.ts`)的回归测试。 | 绿 2s |  |
| `server/scripts/test-user-cli-write-identity.ts` | 个人 CLI 配置的写入器:**换上去那份要跟原来那份同身份**（审查第 3 轮 F2）。 | 绿 1s |  |
| `server/scripts/test-user-directives.ts` | 「中途追加的需求要跟着原始正文一起交给验证者」的回归测试（纯函数，不碰 DB 也不摸盘）。 | 绿 1s |  |
| `server/scripts/test-verify-override.ts` | 「人工强制通过这一站自动验证」在**真数据库 + 真 git 仓库**上走一遍。 | 绿 2s |  |
| `server/scripts/test-win-launch.ts` | Windows 上「命令名 → 真正能 spawn 的东西」这条链（platform.ts / bin-resolve.ts / win-command.ts），在 macOS 上就能跑。 | 绿 1s |  |
| `server/scripts/test-windows-detached.ts` | （文件头没有说明；跑完打印）✓ Windows:外壳延迟 12 秒,首次接管的同一个 stdin 等就绪后完成写入 | 绿（部分未执行） 1s | 前半段（证据核对外壳身份）绿；`process.platform === "win32"` 的真进程清理段在 Mac 上未执行 |
| `server/scripts/test-workflow-def.ts` | 工作流定义层的闸（shared/src/workflow.ts）。 | 绿 1s |  |
| `server/scripts/test-workflow-gate.ts` | 一条把「等我点头」画在「自动验证」前面的线，在**真数据库 + 真 git 仓库**上走两条路： ① 推进器（干活结算之后必须停在关口，不许自己往下验、更不许自己合）； | 绿 3s |  |
| `server/scripts/test-workflow-library.ts` | 起手式库的「三种来源合成一种条目」语义（server/src/workflows.ts）。 | 绿 1s |  |
| `server/scripts/test-workflow-mode-default.ts` | 建任务时 `workflowMode` 落哪种、什么请求要拒（`createWorkflowMode`）。 | 绿 2s |  |
| `server/scripts/test-workflow-run.ts` | 工作流接管审查链的回归：一条线上写的「自动验证 / 没过怎么办 / 等我点头」到底有没有 真的管住派审。 | 绿 5s |  |
| `server/scripts/test-workspace-cleanup.ts` | 删除任务时的 worktree/分支去留（server/src/workspace-cleanup.ts）。 | 绿 2s |  |
| `server/scripts/test-workspace-dirty.ts` | 「这个工作区相对 HEAD 变了吗」的判据（server/src/git.ts workspaceDirty）。 | 绿 1s |  |
| `server/scripts/test-worktree-default.ts` | 「设置 → 项目设置 → 工作目录」那颗开关必须真的**按项目**生效：某个项目关掉之后， 这个项目里任何一条没有显式说过 useWorktree 的普通创建路径都不许再偷偷开 worktree （界面上没有任何地方能解释那种任务为什么多出一个分支和一个目录），同时**不许波及 别的项目** —… | 绿 3s |  |
| `server/scripts/test-worktree-leftover.ts` | worktree 被删到一半留下空壳之后，还能不能收拾干净。 | 绿 2s |  |
| `server/scripts/test-worktree-porcelain.ts` | （文件头没有说明；跑完打印）ok · helper cleanup protects active rebase; NUL attempts=${nulReads}, legacy reads=${legacyReads} | 绿 3s |  |
| `server/scripts/test-worktree-recovery.ts` | worktree 被删之后再动这个任务，会发生什么。 | 绿 3s |  |
| `web/scripts/test-agent-plate.mjs` | 对话框的执行器水印:斜体大字铺在框中心,按框的宽高一起定大小,换智能体跟着换字。 | 绿 2s |  |
| `web/scripts/test-agent-profile-add-gate.mjs` | 用户点了「检测本地智能体」、检测出 Codex 0.147.x 之后，Profile 组右上角那颗「新增」 必须跟着改口：不然点下去只会被服务端 409 打回一句「请先去点检测」——用户刚做完这件事， 界面又把他送回同一步，形成走不出去的死循环（自由工作流第 1 轮审查）。 | 绿 2s |  |
| `web/scripts/test-annotation-review-presentation.tsx` | （文件头没有说明；跑完打印）annotation presentation: readable conversation summary, noninteractive waiting evidence, missing-image fallback, dismiss | 绿 3s |  |
| `web/scripts/test-annotation-review.ts` | （文件头没有说明；跑完打印）review preference: durable explicit close, task isolation and manual restoration passed | 绿 1s |  |
| `web/scripts/test-cli-goal-lifecycle-ui.mjs` | （文件头没有说明；跑完打印）screenshots: ${screenshots} | 绿 15s |  |
| `web/scripts/test-created-task-merge.mjs` | 创建完成回写合并策略(createdTaskMerge)的回归。 | 绿 1s |  |
| `web/scripts/test-data-layer.mjs` | （文件头没有说明；跑完打印）数据层回归验证通过 | 绿（已修） 1s | (b) 实时事件要带回合起点（d32c6cf3），夹具补上 |
| `web/scripts/test-duet-timeline.mjs` | （文件头没有说明；跑完打印）duet timeline ok | 绿 1s |  |
| `web/scripts/test-executor-picker-field.mjs` | 三段胶囊选完执行器再选模型时，智能体不许被同一轮的第二次回调打回原样。 | 绿 2s |  |
| `web/scripts/test-file-layout-surfaces.mjs` | 平铺/目录树在另外两处清单上（Git 工作台「更改」、审查页「改动文件」轨），以及三处共用同一份偏好。 | 绿 5s |  |
| `web/scripts/test-file-mention-dom.mjs` | 对话框里 `@` 的回归：同一个 `@` 既能召唤智能体、又能引用随手记和工作区文件，三类候选 混在一张列表里走同一条上下键。 | 绿 4s |  |
| `web/scripts/test-file-mention.mjs` | （文件头没有说明；跑完打印）file-mention: ok | 绿 1s |  |
| `web/scripts/test-free-review-copy.mjs` | （文件头没有说明；跑完打印）free review dispute view tests passed | 绿 1s |  |
| `web/scripts/test-free-workflow-inspector.mjs` | （文件头没有说明；跑完打印）free workflow inspector preview test passed | 绿（已修） 8s | (b) 夹具靠真后端答 /settings 与验收状态，补应答 |
| `web/scripts/test-handoff-source-addresses.mjs` | 来源机器地址完整路径回归：覆盖任务移回失败提示到真实设置页的导航、旧地址预填、 核对失败反馈、目标机地址同步，以及刷新后的读回。 | 绿（已修） 4s | (a) 「默认规则」页多了远程访问卡（40ef64cd），夹具补应答 |
| `web/scripts/test-inspector-attachments.mjs` | （文件头没有说明；跑完打印）inspector attachment preview links test passed | 绿 2s |  |
| `web/scripts/test-native-agent-segments.mjs` | 子智能体抽屉的展示归约:一条「上游在重试」不许显示成执行异常。 | 绿 1s |  |
| `web/scripts/test-notes-filter.mjs` | （文件头没有说明；跑完打印）notes conversion filter tests passed | 绿 1s |  |
| `web/scripts/test-open-in-ide-menu.mjs` | 「用 IDE 打开这个文件夹」的交互回归（web/src/files/OpenInIdeMenu.tsx + FolderViewer 工具条）。 | 绿 3s |  |
| `web/scripts/test-open-with-menu.mjs` | 「打开方式」菜单的交互回归（web/src/files/OpenWithMenu.tsx）。 | 绿 3s |  |
| `web/scripts/test-outbound-state.mjs` | （文件头没有说明；跑完打印）outbound state tests passed | 绿 1s |  |
| `web/scripts/test-queue-after.mjs` | （文件头没有说明；跑完打印）queue-after: all assertions passed | 绿 1s |  |
| `web/scripts/test-reply-drafts.mjs` | （文件头没有说明；跑完打印）task reply draft test passed | 绿 2s |  |
| `web/scripts/test-reply-resize.mjs` | 对话框顶边的拖动条:往上拖变高、往下拖变矮、双击复位、上下限收住、刷新后还在。 | 绿 3s |  |
| `web/scripts/test-reviewer-profile-summary.mjs` | （文件头没有说明；跑完打印）reviewer profile summary test passed | 绿 2s |  |
| `web/scripts/test-run-activity.mjs` | （文件头没有说明；跑完打印）run activity state tests passed | 绿 1s |  |
| `web/scripts/test-run-target-picker.mjs` | 三段执行目标胶囊的连续选择回归：前一段选定后，下一段应沿横向顺序自动展开。 | 绿 2s |  |
| `web/scripts/test-scm-file-layout.mjs` | SCM 面板文件清单的平铺/目录树两种摆法：默认平铺、单链目录压行、两处切换共用一份偏好并持久化、目录行的批量操作只作用于该目录。 | 绿 4s |  |
| `web/scripts/test-scm-nested-ui.mjs` | （文件头没有说明；跑完打印）scm nested ui test passed | 绿 2s |  |
| `web/scripts/test-scm-paths.mjs` | （文件头没有说明；跑完打印）scm paths ok | 绿 1s |  |
| `web/scripts/test-scm-stale.mjs` | （文件头没有说明；跑完打印）scm stale test passed | 绿 2s |  |
| `web/scripts/test-send-after.tsx` | （文件头没有说明；跑完打印）test-send-after ok | 绿 1s |  |
| `web/scripts/test-session-merge.mjs` | （文件头没有说明；跑完打印）session 合并回归验证通过 | 绿 1s |  |
| `web/scripts/test-settle-created-task.mjs` | （文件头没有说明；跑完打印）settle-created-task: all assertions passed | 绿 1s |  |
| `web/scripts/test-slash-match.mjs` | （文件头没有说明；跑完打印）slash match tests passed | 绿 1s |  |
| `web/scripts/test-spread-filter.mjs` | （文件头没有说明；跑完打印）spread filter counting tests passed | 绿 1s |  |
| `web/scripts/test-task-mode-paging.mjs` | （文件头没有说明；跑完打印）✓ 任务模式分页：独立 20 条展开、历史深链/切模式不自动展开、年龄闸优先且自动揭示不带历史、计数口径不变、J/K/上下键按可见顺序导航 | 绿 8s |  |
| `web/scripts/test-task-review-rounds.mjs` | （文件头没有说明；跑完打印）task review rounds test passed | 绿 3s |  |
| `web/scripts/test-task-sync.mjs` | （文件头没有说明；跑完打印）test-task-sync: all assertions passed | 绿 1s |  |
| `web/scripts/test-task-tree-offline.mjs` | 任务模式空态里不许把离线提示吞掉：接力出去的行因为持有机联系不上退回冻住的状态、 又正好是唯一候选时，用户看到的必须是「联系不上 mac-mini」+「没有在跑…」两句话， 而不是只剩后一句 —— 那正是最需要解释「接力那条怎么没了」的时刻。 | 绿 2s |  |
| `web/scripts/test-task-tree-paging.mjs` | 侧栏三处「展开(20/N)」都是**分页**的：一次放 20 条，不够再点一下，不是一把梭全展开。 | 绿 3s |  |
| `web/scripts/test-task-tree-preview.mjs` | 任务树「展开(N/N) / 收起」：展开后点几条旧任务，收起必须真的收得回去。 | 绿 3s |  |
| `web/scripts/test-task-tree.mjs` | （文件头没有说明；跑完打印）task tree grouping tests passed | 绿 1s |  |
| `web/scripts/test-team-review-inspector.mjs` | （文件头没有说明；跑完打印）team review inspector test passed | 绿 2s |  |
| `web/scripts/test-tool-summary.mjs` | （文件头没有说明；跑完打印）tool-summary ok | 绿 1s |  |
| `web/scripts/test-turn-fold-dom.mjs` | 回合折叠的时机（渲染结果，切分逻辑本身由 test:turn-fold 钉住）。 | 绿 4s |  |
| `web/scripts/test-workflow-edit.mjs` | 编排时的连带修复（web/src/workflow/workflowEdit.ts）。 | 绿 1s |  |
| `web/scripts/test-workflow-rail.mjs` | 线路图的两条产品承诺（web/src/workflow/workflowModel.ts）。 | 绿 1s |  |
| `web/scripts/test-workspace-history.mjs` | （文件头没有说明；跑完打印）workspace task history tests passed | 绿 1s |  |

## 可纳入（较慢）（51）

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
| `server/scripts/test-monitor-offline.ts` | 哨兵**跨 ash 重启**那一半的回归:进程活过重启、停服期间跑完的活要补完、补读到的证据要 折进结局。 | 绿 20s |  |
| `server/scripts/test-monitor-reclaim-debt.ts` | **撤销是一段时间,而「停止函数正常返回」不等于资源已经回收。 | 绿 43s |  |
| `server/scripts/test-monitor-reclaim-unit.ts` | **记号凭证这一问:每次创建独有的那条资源记号,到底能签发什么。 | 绿 32s |  |
| `server/scripts/test-monitor-settle-handover.ts` | **收尾交接的那一族回归** —— 第 21、22、23 轮审查钉下来的那几幕,从 `test-monitor-intent-handover.ts` 拆出来(全局约定:单文件不超过 700 行)。 | 绿 33s |  |
| `server/scripts/test-monitor-unit-proof.ts` | **记号这一问答得有多实,以及最后那份身份有没有真的落盘** —— 第 14 轮审查两条拦验收项的回归。 | 绿 41s |  |
| `server/scripts/test-monitors.ts` | 哨兵（Monitor）这个功能本身的回归：起、推、合并、停、回看、闸。 | 绿 17s |  |
| `server/scripts/test-preview-process.ts` | 预览进程的两条生命线：ash 自己的 dev 脚本不能在拉起 vite 后因 TDZ 崩掉； | 绿 18s |  |
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
| `mcp/scripts/test-read-transcript.mjs` | 端到端验证 read_task_transcript：起真实的 mcp/dist/index.js，ASH_URL 指向一个**假 ash**（固定语料，不碰真库），然后按断言逐条核对它拼出来的对话。 | 绿 1s |  |
| `mcp/scripts/test-reconnect.mjs` | 端到端验证 MCP 的重启重试： 1. 起真实的 mcp/dist/index.js，ASH_URL 指向一个没人监听的端口 2. 立刻发一个 tools/call（此刻必然 ECONNREFUSED） 3. 3 秒后才把一个假 ash 拉起来 4. 断言：调用最终成功（说明它等过去了），且 s… | 绿 4s |  |
| `mobile/scripts/test-reply-command-ui.mjs` | （文件头没有说明；跑完打印）screenshots: ${shots} | 绿（已修） 17s | (b) 缺 mobile/dist 时直说先 build:mobile |
| `mobile/scripts/test-web-smoke.mjs` | SDK 升级后的渲染冒烟：把 worktree 自己的 `mobile/dist`（expo export -p web 的产物） 挂在临时端口上，用 headless Chromium 逐条路由打开，断言「React 真的挂载出了内容」且 控制台没有报错。 | 绿（已修） 17s | (b) 改用系统 Chrome + 自带假后端（原来依赖 playwright 下载的浏览器、反代 live :4317）；需先 build:mobile |
| `scripts/test-process-ownership.mjs` | （文件头没有说明；跑完打印）process ownership regressions ok | 绿（并发下闪红） 42s | 单并发绿；并行时 setsid 后代先没了 |
| `server/scripts/test-assistant-live.ts` | （文件头没有说明；跑完打印）assistant live passed: ${cases.length} 个真实 Claude 回合，无工具事件或工具重试 | 有意不跑 | 设计上就要调用真实 Claude 模型（需 ASH_ALLOW_REAL_AGENT=1） |
| `server/scripts/test-chat-cli.ts` | （文件头没有说明；跑完打印）${agentType} real CLI chat passed: ${answer.reply} | 有意不跑 | 设计上调用真实 CLI 跑模型回合（需 ASH_CHAT_SMOKE=1） |
| `server/scripts/test-claude-goal-live.ts` | （文件头没有说明；跑完打印）real Claude /goal stayed connected through ${working.length} locally mocked working turns; private context cleaned | 绿 | 真 claude + 本地假上游（禁外网档跑） |
| `server/scripts/test-claude-relay-settings-live.ts` | 用真 Claude CLI 打本地假上游，验证 ash 供应商配置不会被用户级 settings / CC Switch 覆盖。 | 绿（已修） | 真 claude + 本地假上游；假上游没放行 CLI 的 HEAD /api/hello 探测，崩了还留下真 claude 进程 |
| `server/scripts/test-claude-settings-live.ts` | 拿**真 claude** 对一遍 `claude-settings.ts` 里那套分层假设。 | 绿 | 真 claude，钩子在会话初始化就杀，不调模型（禁外网档跑） |
| `server/scripts/test-codex-archive-live.ts` | （文件头没有说明；跑完打印）✓ 终端 codex unarchive 可恢复归档，不启动模型回合 | 绿 | 真 codex + 本地假 provider；沙箱下 codex 的联网探测被挡，沙箱外绿 |
| `server/scripts/test-codex-goal-bridge.ts` | （文件头没有说明；跑完打印）Codex multi-turn goal, early completion, late verdict, startup failure, review lifecycle, fork, fast override: passed | 留给用户 1s | 红：/review 完成事件早于 review/start 应答到达时永不结算（aaa2002d 去掉了 completeTurn 对应答的等待）；import 已修 |
| `server/scripts/test-goal-native-live.ts` | （文件头没有说明；跑完打印）real ash continuation: plan scope, side-turn isolation, native multi-turn goal, durable budget pause and inspection: pas | 绿 | 同上 |
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
