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

export type NativeWorkEvent =
  | { type: "call"; id: string; parentId?: string; name: string; input: Record<string, unknown> }
  | { type: "result"; id: string; result: string; failed: boolean }
  | { type: "agent"; id: string; nativeId?: string; parentId?: string; title?: string; description?: string;
      status: NativeWorkStatus; closed?: boolean; message?: string; result?: string; model?: string; agentType?: string };
