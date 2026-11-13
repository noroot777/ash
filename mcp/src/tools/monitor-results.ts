// pause_task / complete_task 的返回里带着**当场交出的哨兵结果**时(服务端 monitor-turn-handoff.ts),
// 把它摊成一段 agent 直接读得懂的话:说明在前,结果原文在后。JSON 包着的多行正文对模型不友好,
// 而这几行恰恰是它要据此往下做的东西。
//
// 返回里还带着一个回执号(服务端 monitor-turn-ack.ts):agent 下一次调用时原样带回来才算收到,这里
// 不替它确认 —— MCP 拿到返回不等于执行器拿到。请求里带 `monitorAck: true` 是在声明「我这边的
// pause_task / complete_task 带得回回执号」;不带的调用方,服务端不在回合里交结果。
import { answeredMcpError } from "@ash/shared/mcp-delivery";
import { call, fail, ok } from "../runtime.js";

type Handed = { note?: unknown; error?: unknown; monitorResults?: unknown; monitorResultsReceipt?: unknown };

function handedText(data: unknown): string | null {
  const d = data as Handed | null;
  if (!d || typeof d.monitorResults !== "string") return null;
  const head = typeof d.note === "string" ? d.note : typeof d.error === "string" ? d.error : "";
  return `${head}\n\n${d.monitorResults}`;
}

/** 成功返回:带着结果就摊开,否则照常。 */
function okWithMonitorResults(data: unknown) {
  const text = handedText(data);
  return text === null ? ok(data) : ok(text);
}

/**
 * 拒绝返回:带着结果就摊开(仍是 isError —— 这一次没有生效),否则照常。摊开之后仍写成
 * 「ash 已应答」那个形状:结果正文里出现 `ECONNRESET` 之类,补捞那一侧也认得出这是业务返回、不是通道断了。
 */
function failWithMonitorResults(e: unknown) {
  const { body, status, method, path } = (e ?? {}) as { body?: unknown; status?: number; method?: string; path?: string };
  let data: unknown = null;
  if (typeof body === "string" && status && method && path) {
    try { data = JSON.parse(body); } catch { data = null; }
  }
  const text = handedText(data);
  if (text === null || !status || !method || !path) return fail(e);
  return { isError: true, content: [{ type: "text" as const, text: answeredMcpError(status, method, path, text) }] };
}

/** pause_task / complete_task 共用:声明带得回回执号、捎上这一次带回来的,拿到返回按上面两条摊开。 */
export async function callWithMonitorResults(path: string, body: Record<string, unknown>, directionToken: string) {
  try { return okWithMonitorResults(await call("POST", path, { ...body, monitorAck: true }, directionToken)); }
  catch (e) { return failWithMonitorResults(e); }
}
