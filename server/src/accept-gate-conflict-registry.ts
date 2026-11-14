// 「这一份合并预览冲突交给任务之后怎么样了」的记忆。验收台据它把那一行从「与 X 冲突」换成
// 排队中 / 任务正在解决 / 没交出去 / 那一轮结束了冲突还在 —— 不记的话，交出去之后任务在跑、冲突
// 还在，那一行照旧摆着「让任务解决」，像没按过。
//
// **登记只是意图，不是投递**：handOffConflict 那一刻只是把输入排进了等待队列，真正送进会话要等
// flushConflictHandoff 那条异步交接走完。所以状态按交接层报回来的结局推进（accept-conflict.ts
// 里的 flushConflictHandoff 是唯一的推进方）：
//   queued    —— 排着，还没送进去；
//   delivered —— agent 收下了。此后「正在解决」只在任务这一轮真在跑时成立，跑完了冲突还在
//                （同一个分支头）就是 ended：那一轮没解掉，出路回到「再交一次」；
//   failed    —— 撤回、抢占、启动失败、协议层拒收或说不清，一个字都没送到（或者说不上来送到没有）。
//
// 认的是**同一份冲突**：任务分支头和目标分支头都没动。任务把目标分支合进来并提交之后分支头就变了，
// 这份记忆自然作废（那时冲突多半已经没了，状态接口会重判）。只放内存：ash 重启后只是那一行回到
// 「与 X 冲突」，再按一次照样交得出去，不需要落库。
import type { AcceptGateState } from "@ash/shared/accept-gate";

type Handoff = NonNullable<NonNullable<AcceptGateState["baselineIssue"]>["handoff"]>;

// 每一份登记有自己的编号（ticket）：两份验收台先后交接同一个任务时，后一份会盖掉前一份的登记，前一份
// 那条交接晚到的回执只认它自己的编号，结算不到后一份头上。
type Handed = { ticket: number; at: string; head: string | null; targetCommit: string; phase: "queued" | "delivered" | "failed"; note: string | null };
const handed = new Map<string, Handed>();
let tickets = 0;

export function noteConflictHandoff(taskId: string, head: string | null, targetCommit: string): void {
  handed.set(taskId, { ticket: ++tickets, at: new Date().toISOString(), head, targetCommit, phase: "queued", note: null });
}

/** 此刻这个任务上那一份登记的编号：投递发出去的那一刻取，回执带着它回来结算。 */
export function conflictHandoffTicket(taskId: string): number | null {
  return handed.get(taskId)?.ticket ?? null;
}

/** 交接层报回来的结局。没登记过（真合并撞冲突那条路，不走预演）、或者编号对不上就什么都不做。 */
export function settleConflictHandoff(taskId: string, ticket: number | null, outcome: { delivered: true } | { delivered: false; why: string }): boolean {
  const row = handed.get(taskId);
  if (!row || row.ticket !== ticket || row.phase !== "queued") return false;
  if (outcome.delivered) handed.set(taskId, { ...row, phase: "delivered" });
  else handed.set(taskId, { ...row, phase: "failed", note: outcome.why });
  return true;
}

/** `live` = 任务此刻有一轮在跑或排着（running / queued）。 */
export function conflictHandoffOf(taskId: string, head: string | null, targetCommit: string, live: boolean): Handoff | null {
  const row = handed.get(taskId);
  if (!row) return null;
  if (row.head !== head || row.targetCommit !== targetCommit) {
    handed.delete(taskId);
    return null;
  }
  if (row.phase === "queued") return { at: row.at, state: "queued", note: null };
  if (row.phase === "failed") return { at: row.at, state: "failed", note: row.note };
  return { at: row.at, state: live ? "working" : "ended", note: null };
}
