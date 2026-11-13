// pause_task / complete_task 的返回里带着**当场交出的哨兵结果**时(服务端 monitor-turn-handoff.ts),
// 把它摊成一段 agent 直接读得懂的话:说明在前,结果原文在后。JSON 包着的多行正文对模型不友好,
// 而这几行恰恰是它要据此往下做的东西。
import { answeredMcpError } from "@ash/shared/mcp-delivery";
import { fail, ok } from "../runtime.js";

function handedText(data: unknown): string | null {
  const d = data as { note?: unknown; error?: unknown; monitorResults?: unknown } | null;
  if (!d || typeof d.monitorResults !== "string") return null;
  const head = typeof d.note === "string" ? d.note : typeof d.error === "string" ? d.error : "";
  return `${head}\n\n${d.monitorResults}`;
}

/** 成功返回:带着结果就摊开,否则照常。 */
export function okWithMonitorResults(data: unknown) {
  const text = handedText(data);
  return text === null ? ok(data) : ok(text);
}

/**
 * 拒绝返回:带着结果就摊开(仍是 isError —— 这一次没有生效),否则照常。摊开之后仍写成「ash 已应答」
 * 那个形状:结果正文里出现 `ECONNRESET` 之类,补捞那一侧也认得出这是业务返回、不是通道断了。
 */
export function failWithMonitorResults(e: unknown) {
  const { body, status, method, path } = (e ?? {}) as { body?: unknown; status?: number; method?: string; path?: string };
  let text: string | null = null;
  if (typeof body === "string" && status && method && path) {
    try { text = handedText(JSON.parse(body)); } catch { text = null; }
  }
  return text === null || !status || !method || !path
    ? fail(e)
    : { isError: true, content: [{ type: "text" as const, text: answeredMcpError(status, method, path, text) }] };
}
