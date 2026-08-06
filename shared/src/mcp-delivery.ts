// 「这次 MCP 调用到底送没送达」——补捞与重试的判据都放这儿，但**两边宽严不同**，
// 这个不对称是刻意的，别顺手统一掉。
//
// 两个消费者：
// ① `mcp/src/index.ts` 的 `call()`：拿到的是 Node 抛的 error code，在**自己进程里**
//    退避重试，覆盖「server 在重启、MCP 还活着」。它对**所有工具**一视同仁（包括
//    `dispatch` 这种非幂等的），所以只敢认 `UNDELIVERED_NET_CODES` 那三个码——
//    ECONNREFUSED 意味着根本没人监听，请求一个字节都没发出去。
// ② `server/src/mcp-handoff.ts` 的补捞：拿到的是 agent 输出流里记下的**错误文本**
//    （"Transport closed"…），在回合结算时替 agent 重放，覆盖「MCP 进程被杀」——
//    ①那套救不了这种，因为重试的代码跟着一起死了。它可以宽到 `UNDELIVERED_PHRASES`
//    （连 ECONNRESET 这种「连上了又断、也许已送达」都算），**因为它另外叠了一层
//    `REPLAYABLE_MCP_TOOLS` 幂等白名单**：最坏情况是把同一个 stage 再写一遍。
//
// 所以：宽的那份（`isUndeliveredMcpFailure`）只有在幂等白名单的保护下才能用。谁要
// 是把它接到 ①，`dispatch` 就会被做两遍。
//
// 两边都绝不认业务错误。`HTTP 409 只能在任务正在运行时确认完成` 是 server 收到了并
// 明确拒绝，重放它等于把 server 的拒绝偷偷绕过去；`Transport closed` 才是请求压根没
// 出门。这条线划错一次的代价就是**把 server 拒绝过的动作偷偷做成**，所以下面用的是
// 短语白名单，不是「包含 error 就算」。

/**
 * 「确定没送达」里最硬的那一档：连接压根没建立起来。
 *
 * 两个消费者共用这一份（`mcp/src/index.ts` 的 RETRYABLE 就是它）。形状实测见那边的
 * 注释：Node 26 下 `http://localhost:<关闭端口>` 抛的是 AggregateError。
 */
export const UNDELIVERED_NET_CODES = new Set(["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN"]);

// 各家 CLI 在 MCP 通道断掉时写进事件流的说法。全部小写后做子串匹配。
// codex(rmcp) 实测：`tool call failed for \`harness/report_stage\`\n\nCaused by:\n    Transport closed`
//
// 注意这里比 UNDELIVERED_NET_CODES 宽：`econnreset` / `socket hang up` 严格说是
// 「连上了又断」，未必没送达。只有**叠着幂等白名单**的补捞侧能用这份（见文件头）。
const UNDELIVERED_PHRASES = [
  "transport closed",
  "transport channel closed",
  "connection closed",
  "mcp server is not connected",
  "server not connected",
  "not connected to mcp",
  "broken pipe",
  "epipe",
  "socket hang up",
  "econnreset",
];

/**
 * 这次失败属于「没送达」吗——**宽口径，仅供叠了幂等白名单的补捞侧使用**。
 *
 * code 与 message 给哪个都行，两个都给就任一命中即可。
 */
export function isUndeliveredMcpFailure(input: { code?: string | null; message?: string | null }): boolean {
  if (input.code && UNDELIVERED_NET_CODES.has(input.code)) return true;
  const text = (input.message ?? "").toLowerCase();
  if (!text) return false;
  if ([...UNDELIVERED_NET_CODES].some((code) => text.includes(code.toLowerCase()))) return true;
  return UNDELIVERED_PHRASES.some((phrase) => text.includes(phrase));
}

/**
 * 允许被自动重放的工具——**白名单是硬的，新增工具默认不在里面**。
 *
 * 收进来的判据是三条同时成立：
 * ① **幂等**：重复执行一次结果不变（写同一个值），所以「其实送达了、只是回执丢了」
 *    的那种情况重放也不会出事；
 * ② **只写回本任务自己的状态**：它是 agent 在回合末尾「向 harness 交卷」的动作，丢了
 *    就等于活白干（结论没写回、完成没确认）；
 * ③ **不凭空创造一个新的等待**：重放只是把 agent 已经做出的判断补录进来，不该让任务
 *    多出一个「有人在等你」的状态。
 *
 * 明确排除的两类：
 * · `dispatch` / `accept_task` / `batch_create_tasks` / `create_task_chain` / `run_task` /
 *   `stop_task` —— 违反①，每执行一次就在世界上多一个后果（多派一批执行者、**多合并一次
 *   代码**、多杀一次进程）。这类调用丢了宁可让人看见它失败，也不能替 agent 补一刀。
 * · `ask_question` —— 违反③。它跟另外三个的位置不一样：那三个是**回合终点**的交卷动作，
 *   而提问是**回合中途**的阻塞点，调用失败后 agent 通常自己绕过去继续干完了（实测的
 *   codex 就是这个行为）。事后替它把问题挂上去，等于让用户去回答一个早已被绕过的问题，
 *   答复还会 resume 一个已经收尾的会话。
 */
export const REPLAYABLE_MCP_TOOLS = new Set([
  "report_stage",
  "complete_task",
  "pause_task",
]);

export function isReplayableMcpTool(tool: string): boolean {
  return REPLAYABLE_MCP_TOOLS.has(tool);
}
