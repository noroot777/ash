export type NativeWorkStatus = "pending" | "running" | "completed" | "failed" | "stopped" | "unknown";

export function nativeWorkStatus(value: unknown): NativeWorkStatus {
  const name = typeof value === "string" ? value.replace(/[_ -]/g, "").toLowerCase() : "";
  if (["completed", "complete", "done", "success"].includes(name)) return "completed";
  if (["running", "inprogress", "working"].includes(name)) return "running";
  if (["pending", "queued", "spawned", "initializing", "pendinginit"].includes(name)) return "pending";
  if (["failed", "error", "errored", "notfound"].includes(name)) return "failed";
  if (["stopped", "closed", "shutdown", "cancelled", "canceled", "interrupted", "deleted"].includes(name)) return "stopped";
  return "unknown";
}

export type NativeAgentActivity =
  | { kind: "text" | "thinking"; text: string }
  | { kind: "tool"; name: string; detail?: string }
  | { kind: "error"; message: string }
  | { kind: "attachment"; path: string };

export type NativeWorkEvent = (
  | { type: "activity"; id: string; event: NativeAgentActivity }
  | { type: "call"; id: string; parentId?: string; name: string; input: Record<string, unknown> }
  | { type: "result"; id: string; result: string; failed: boolean }
  // model/effort 是子智能体**实跑**的档位；requested* 是派活那一刻调用方点的名（可能被执行器改掉）。
  | { type: "agent"; id: string; nativeId?: string; parentId?: string; title?: string; description?: string;
      status: NativeWorkStatus; closed?: boolean; message?: string; result?: string;
      model?: string; requestedModel?: string; effort?: string; requestedEffort?: string; agentType?: string }
) & { at?: string };

export function isVisibleExecutionEvent(event: { nativeWork?: NativeWorkEvent }): boolean {
  return !event.nativeWork || (event.nativeWork.type === "call" && !event.nativeWork.parentId);
}
