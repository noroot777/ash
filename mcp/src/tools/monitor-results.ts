// pause_task / complete_task 的返回里带着**当场交出的哨兵结果**时(服务端 monitor-turn-handoff.ts),
// 把它摊成一段 agent 直接读得懂的话:说明在前,结果原文在后。JSON 包着的多行正文对模型不友好,
// 而这几行恰恰是它要据此往下做的东西。
//
// **交给执行器之前先发回确认**(服务端 monitor-turn-ack.ts):送没送到,服务端只认这一笔。请求里带
// `monitorAck: true` 就是在声明「我会确认」—— 不带的调用方,服务端不在回合里交结果。
import { answeredMcpError } from "@ash/shared/mcp-delivery";
import { call, fail, ok } from "../runtime.js";

type Handed = { note?: unknown; error?: unknown; monitorResults?: unknown; monitorResultsReceipt?: unknown };

function handedText(data: unknown): string | null {
  const d = data as Handed | null;
  if (!d || typeof d.monitorResults !== "string") return null;
  const head = typeof d.note === "string" ? d.note : typeof d.error === "string" ? d.error : "";
  return `${head}\n\n${d.monitorResults}`;
}

/** 返回里带着交付号就确认收到。确认失败不挡这次返回:没确认的那几行服务端会退回、再送一遍。 */
async function ackHanded(taskId: string, data: unknown): Promise<void> {
  const hand = (data as Handed | null)?.monitorResultsReceipt;
  if (typeof hand !== "string") return;
  try { await call("POST", `/tasks/${taskId}/monitor-results/ack`, { hand }); }
  catch (e) { console.error(`[ash-mcp] 哨兵结果的送达确认没发出去(会再送一遍):${e instanceof Error ? e.message : String(e)}`); }
}

/** 成功返回:带着结果就先确认、再摊开,否则照常。 */
async function okWithMonitorResults(taskId: string, data: unknown) {
  const text = handedText(data);
  if (text === null) return ok(data);
  await ackHanded(taskId, data);
  return ok(text);
}

/**
 * 拒绝返回:带着结果就先确认、再摊开(仍是 isError —— 这一次没有生效),否则照常。摊开之后仍写成
 * 「ash 已应答」那个形状:结果正文里出现 `ECONNRESET` 之类,补捞那一侧也认得出这是业务返回、不是通道断了。
 */
async function failWithMonitorResults(taskId: string, e: unknown) {
  const { body, status, method, path } = (e ?? {}) as { body?: unknown; status?: number; method?: string; path?: string };
  let data: unknown = null;
  if (typeof body === "string" && status && method && path) {
    try { data = JSON.parse(body); } catch { data = null; }
  }
  const text = handedText(data);
  if (text === null || !status || !method || !path) return fail(e);
  await ackHanded(taskId, data);
  return { isError: true, content: [{ type: "text" as const, text: answeredMcpError(status, method, path, text) }] };
}

/** pause_task / complete_task 共用:声明会确认,拿到返回按上面两条摊开。 */
export async function callWithMonitorResults(taskId: string, path: string, body: Record<string, unknown>, directionToken: string) {
  try { return await okWithMonitorResults(taskId, await call("POST", path, { ...body, monitorAck: true }, directionToken)); }
  catch (e) { return failWithMonitorResults(taskId, e); }
}
