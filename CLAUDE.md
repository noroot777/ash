# CLAUDE.md

## 工作约定

- 随时留意需求是否已经变动到「现有代码结构不再合适」的程度。一旦判断需求变动足够大、值得重构，就大胆重构，不要为了迁就旧结构而打补丁。
- 前端禁用浏览器原生弹窗：确认对话框用 `ConfirmModal`、其它弹层用 `Modal`（均在 `web/src/Modal.tsx`），报错/提示用 `toast`（`web/src/toast.tsx`）。不要用 `window.confirm / prompt / alert`——它们样式不一致、阻塞且无法做成应用风格。
- 做出关键性决定或确立新约定时（技术选型、目录/数据结构、跨模块的统一规则、刻意的取舍等），自行判断是否值得写进本文件；值得就主动补一条。理由：本文件在仓库根目录，会被自己、后来的人、以及在本仓库 cwd 下运行的 CLI 派生 agent 自动读到——写进来约定才真正生效，只存在于代码习惯里就会被漏掉。
- 事项（Issue）正文恒为用户原文：hero 里填的内容，AI 只用来「分析意图」产出派生元信息（归类 `projectId` / 简短标题 `title` / `priority` / `labels`），**绝不改写正文**——`parseIssue`（`server/src/agentOnce.ts`）的 `body` 始终取原文，`parsePrompt` 也不再向模型要 body。理由：用户第一手输入是最准的意图，AI 重写会失真、丢细节；要结构化就让用户在详情页自己改，或 @CLI 智能体执行。`sourceText` 是不可变的原始快照，`body` 初始等于它、但允许用户手动编辑。
- 任务完成走严格协议：**exit 0 ≠ done**。agent 必须在回合内调 harness MCP 的 `complete_task`（POST `/tasks/:id/complete`）确认目标达成，结算才落 done；未确认的正常退出记 failed（时间线附一行说明）。结算规则单点在 `settleTaskStatus`（`server/src/orchestrator.ts`），优先级：手停 canceled > 检查点 paused（resumePrompt）> exit≠0 failed > 已确认 done > 未确认 failed。协议通过 prompt 前言（fresh run）/ 消息尾部提醒（reply/resume 回合）注入，taskId 一并告知。逃生口：`HARNESS_LAX_DONE=1` 退回「exit 0 即 done」（接没配 harness MCP 的 agent 时用）。理由：CLI 正常退出不代表目标达成（agent 报错后退出照样 exit 0），假 done 会误推进队列、错误唤醒下游任务。
- Codex 单任务每一轮必须保留失败证据链：`data/runs/<taskId>/` 下按 session+turn 写原始 `codex exec --json` 事件、stderr 和结构化 diagnostics；`turn.failed`、signal、静默非零退出等诊断同时写进会话 Markdown，保证实时页面与刷新后都能看到。诊断写入是 best-effort，不得反过来改变 agent 原本的退出结果。
