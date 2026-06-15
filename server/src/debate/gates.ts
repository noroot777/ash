import type { GateAction } from "@harness/shared";

// In-process HITL gate rendezvous (DESIGN.md §7). The debate orchestrator awaits
// a human decision; the API resolves it. Lives in the long-running server.
// (M4: in-memory only — a server restart abandons an open gate. Acceptable for now.)
const pending = new Map<string, (a: GateAction) => void>();

export function waitForGate(taskId: string): Promise<GateAction> {
  return new Promise((resolve) => {
    pending.set(taskId, (a) => {
      pending.delete(taskId);
      resolve(a);
    });
  });
}

export function resolveGate(taskId: string, action: GateAction): boolean {
  const r = pending.get(taskId);
  if (!r) return false;
  r(action);
  return true;
}

export function hasOpenGate(taskId: string): boolean {
  return pending.has(taskId);
}
