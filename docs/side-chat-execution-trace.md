# 侧聊放出执行过程

2026-09-16。侧聊的回复此前只在跑完那一刻整段出现，中途只有一句「正在思考…」；它其实就跑在主任务的工作目录里，会读文件、跑命令，这些步骤一步都看不到。现在跟主会话对齐。

## 行为

侧聊的每条回复上方多一个「执行过程」折叠块，跟主会话、团队、duet 是同一个组件、同一套词（`执行过程 · N 分析 · N 工具`）：

- **跑的中途就有**：条上带运行小点，并轮播最新一步；展开能看见工具名和当场执行的命令 / 文件。有过程可看时不再显示「正在思考…」。
- **跑完仍在**：折叠块留在回复正文上方，点开是这一轮的全部步骤。
- **停止、失败、刷新、服务重启之后也在**：记录落在 `chat_messages.trace` 列，不是内存。用户刷新页面仍看得出它停之前做了什么。

记的是工具调用、思考、以及真正的执行异常（`level: "notice"` 的旁注仍不算异常）；子智能体的内部事件按主会话同一把尺子（`isVisibleExecutionEvent`）过滤掉。

## 实现

- `invokeChat` 多一个 `onTrace` 接收器（`ChatInvokeOptions`），按事件发生顺序逐步回调。记录点在各道闸**之前**，被闸拦下的那一步也留在记录里。
- `server/src/chat/trace.ts` 的 `ChatTraceLog` 负责落库：400ms 节流的整份覆盖写，回合收尾（含停止/失败）再 flush 一次。
- 上限 `CHAT_TRACE_LIMITS`（120 步 / 每步 800 字 / 总计 24 000 字）。房间快照是整份走 SSE 的，不封顶时一次跑飞的咨询能把快照撑成几 MB。撞上限不静默——记录末尾补一行「执行过程已达记录上限」。
- 群聊与 ash 助手未接入：助手一侧工具是关掉的，群聊仍受只读闸门约束，本轮只按需求做侧聊。

## 验证

- `tsx server/scripts/test-side-chat.ts`：新增「回复带上本轮执行过程」「落库」「跑的中途就能读到」「停止后仍在」「上限截断有说明」五处断言；`test-side-chat-deletion`、`test-side-authorization` 一并通过。
- `npm -w @ash/server run test:chat` 全绿（execution / boundary / recovery / watch-load / large-workspace / git-metadata / ash-data 等），确认 `invokeChat` 的 `purpose` 改写没有动群聊、助手、摘要、授权核验的行为。
- `node web/scripts/test-side-chat-browser.mjs`：真实侧聊 HTTP/SSE + headless Chrome（独立临时 profile），覆盖跑的中途展开看见命令、说完后折叠条报数、停止并刷新后仍可展开；截图 `side-chat-execution-live.png`。另两组侧聊浏览器回归（选文、直接提问）同样通过。
- `npm -w web run build`、`npm run test:web` 通过。
- 已知与本轮无关的既有失败：`npm -w web run test:chat`（该用例不在 `npm run test:web` 链里）断言新建任务的模式页签为 4 颗，而「助手」页签加入后实际为 5 颗。

浏览器通道：本轮未使用 Chrome 扩展具名后台会话——验证由仓库自带的 Playwright 回归脚本完成，它们用独立临时 profile 的 headless Chrome，没有接管或激活用户的普通标签。
