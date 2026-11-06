import type { GateAction } from "@ash/shared";

// In-process HITL gate rendezvous. The duet orchestrator awaits
// a human decision; the API resolves it. Lives in the long-running server.
// (M4: in-memory only — a server restart abandons an open gate. Acceptable for now.)
//
// 每扇门带一个版本号(这场讨论第几次开门,`gate-version.ts` 发号)。为什么:一场讨论会
// 反复开门(注入/提问 → 重新合稿 → 再开一扇),而点按钮的那张卡片可能早就过时了(飞书
// 消息、另一个标签页)。只按 taskId 找门的话,第 N 扇门的卡片会把第 N+1 扇门放行掉——
// 放行的是一份用户没读过的方案。所以调用方可以带上它看到的版本,对不上就拒,**门继续等**:
// 过时的点击不该把一扇真正开着的门关掉。
type PendingGate = { version: number; resolve: (a: GateAction) => void };
const pending = new Map<string, PendingGate>();

export function waitForGate(taskId: string, version: number): Promise<GateAction> {
  return new Promise((resolve) => {
    const entry: PendingGate = {
      version,
      resolve: (a) => {
        // 只摘自己:同一个任务理论上不会叠两扇门,但按身份删不会误删后来的那一扇。
        if (pending.get(taskId) === entry) pending.delete(taskId);
        resolve(a);
      },
    };
    pending.set(taskId, entry);
  });
}

export type ResolveGateResult =
  | { ok: true; version: number }
  | { ok: false; reason: "none" }
  | { ok: false; reason: "stale"; current: number };

/**
 * 把用户的决定交给正在等的那扇门。`expectedVersion` 缺省 = 老客户端,不核版本,行为与
 * 加版本之前一致;带了却对不上就回 `stale`,门原样留着。
 */
export function resolveGate(taskId: string, action: GateAction, expectedVersion?: number): ResolveGateResult {
  const entry = pending.get(taskId);
  if (!entry) return { ok: false, reason: "none" };
  if (expectedVersion !== undefined && expectedVersion !== entry.version) {
    return { ok: false, reason: "stale", current: entry.version };
  }
  entry.resolve(action);
  return { ok: true, version: entry.version };
}

export function hasOpenGate(taskId: string): boolean {
  return pending.has(taskId);
}

/** 内存里开着的那扇门的版本;没有开着的门(或重启后丢了)返回 null。 */
export function openGateVersion(taskId: string): number | null {
  return pending.get(taskId)?.version ?? null;
}
