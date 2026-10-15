// 「这个 tool_use 块是一次内置 Monitor 调用吗、它在盯什么」—— 入参解析只此一份。
//
// 两边都要用同一份判据：实时投影（`claude-monitors.ts`，从事件流里现读）和历史扫描
// （`claude-monitor-scan.ts`，从 run 文件里重读）。两份实现漂移的后果是同一条调用在两条路
// 上一边认得出、一边认不出，于是卡片时有时无。

/** 一个内置 Monitor 的入参，从它的 tool_use 块上摘下来。 */
export type MonitorCall = { command: string; description: string };

export const monitorStr = (value: unknown): string => (typeof value === "string" ? value.trim() : "");
const str = monitorStr;

/**
 * 从 `Monitor` 工具的入参里取命令与说明。
 *
 * `ws` 那种（WebSocket 源）没有 `command`，用 url 顶上去——否则面板上会出现一张命令为空
 * 的卡，而「它在盯什么」正是这张卡唯一要回答的问题。
 */
export function parseMonitorInput(input: unknown): MonitorCall | null {
  let parsed: unknown = input;
  if (typeof parsed === "string") {
    try { parsed = JSON.parse(parsed); } catch { return null; }
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const fields = parsed as Record<string, unknown>;
  const ws = fields.ws && typeof fields.ws === "object" ? fields.ws as Record<string, unknown> : null;
  const command = str(fields.command) || (ws ? `ws: ${str(ws.url)}` : "");
  if (!command) return null;
  const description = str(fields.description) || command;
  // **入参里的 `timeout_ms` 一律不取**。那是「我们请求了多久」，不是「来源给了多久」：
  // claude 自己会钳（实测本机 2.1.283 的归一化函数有 30 分钟和 10 分钟两个分支），还有
  // 不设会话内超时的 persistent 模式。生效期限只认起手回执里那句 `expires in …`，它在
  // `task_started` **之后**才到，所以投影先落 `unknown`，拿到回执再升级（见 toolResult）。
  return { command, description };
}
