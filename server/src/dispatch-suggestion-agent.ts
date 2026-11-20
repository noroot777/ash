// 智能体那一笔（MCP suggest_dispatch → POST /tasks/:id/dispatch-suggestions）怎么落：
//   · 先收回、再挂新的——所以「收回旧的、挂一件同名的新说明」一次就能换；要收回的那件已经不在了不算错；
//   · 不等的一批：跟还挂着的（或同一批里前面的）同名的不挂第二件，框顶同一件事只有一行；
//   · 要等的一批：换掉之前在等的那一批（同一回合里再摆一次就是改），同一笔写下那一问（`task.question`，一句看得懂
//     的清单）——任务结算落暂停、队列不自动续跑，跟提问同一套停法。有普通提问在等时摆不出来（同一时刻只等用户一样
//     东西，判在同一笔事务里：跟同时发出的提问只有一个写得进去）。等着的那一批被它自己收回光了，那一问一起撤掉；
//   · 挂上去超过上限：整笔不落，连收回也不落；
//   · 收回的原因跟拿掉那一件同一条更新落库（dispatch-suggestion.ts `appendWithdrawn`）。
// 写的权利（回合、方向身份）入口核过之后、真写进去之前没了（用户补了新要求、回合结束了），这一笔整个不落。
import { and, eq } from "drizzle-orm";
import {
  MAX_SUGGESTIONS_PER_TASK, hangingSuggestions,
  type DispatchSuggestionWithdrawal, type StoredSuggestion, type WithdrawnSuggestion,
} from "@navi/shared/dispatch-suggestion";
import { bus } from "./bus.js";
import { db } from "./db/index.js";
import { tasks } from "./db/schema.js";
import { appendWithdrawn, readSuggestions, serializedSuggestions, turnWriteGuard, waitingBatchOf } from "./dispatch-suggestion.js";
import type { IncomingBatch } from "./dispatch-suggestion-input.js";
import { recordReviewWait } from "./review-wait.js";
import type { TaskRow } from "./task-store.js";
import { now } from "./util.js";

export type AgentSuggestionChange = {
  /** 改完以后的那一列。 */
  after: StoredSuggestion[];
  added: StoredSuggestion[];
  /** 真收回了的那几件留下的记录（标题、原因、时刻）：跟 after 同一笔写进库。 */
  withdrawn: WithdrawnSuggestion[];
  /** 要收回、却已经不在了的（用户派掉或叉掉了）。 */
  gone: string[];
  /** 要挂、却已经有同名的挂着的：指向挂着的那一件。 */
  already: { id: string; title: string }[];
  /** 那一问怎么动：置上这一批的清单 / 撤掉（等着的那一批被收回光了）/ 不动。 */
  question: "set" | "clear" | "keep";
  room: string | null;
};

export function agentChange(
  current: StoredSuggestion[],
  withdrawals: readonly DispatchSuggestionWithdrawal[],
  incoming: IncomingBatch,
): AgentSuggestionChange {
  const reasons = new Map(withdrawals.map((item) => [item.id, item.reason]));
  const at = now();
  const live = hangingSuggestions(current);
  const withdrawn = live.filter((item) => reasons.has(item.id))
    .map((item) => ({ id: item.id, title: item.title, reason: reasons.get(item.id)!, at }));
  const gone = withdrawals.map((item) => item.id).filter((suggestion) => !live.some((item) => item.id === suggestion));
  const waitingBefore = waitingBatchOf(current).length > 0;
  let kept = current.filter((item) => !reasons.has(item.id));
  const replacing = incoming.wait !== "none";
  if (replacing) kept = kept.filter((item) => item.wait === "none");
  const added: StoredSuggestion[] = [];
  const already: { id: string; title: string }[] = [];
  for (const item of incoming.items) {
    const same = replacing ? null : [...hangingSuggestions(kept), ...added].find((hanging) => hanging.title === item.title);
    if (same) already.push({ id: same.id, title: same.title });
    else added.push(item);
  }
  const after = [...kept, ...added];
  const count = hangingSuggestions(after).length;
  if (count > MAX_SUGGESTIONS_PER_TASK) {
    const existing = hangingSuggestions(kept).length;
    return {
      after: current, added: [], withdrawn: [], gone, already, question: "keep",
      room: `这条任务上已经挂着 ${existing} 件用户还没处理，再挂 ${added.length} 件就超过 ${MAX_SUGGESTIONS_PER_TASK} 件了；只挂最该做的，已经不成立的先用 withdraw 收回`,
    };
  }
  const waitingAfter = waitingBatchOf(after).some((item) => !item.settled);
  const question = replacing ? "set" : waitingBefore && !waitingAfter ? "clear" : "keep";
  // 等着的那一批被收回光了：那一批（连同已经了结的那几件）一起拿掉，免得留一批没人等的了结记录。
  return { after: question === "clear" ? after.filter((item) => item.wait === "none") : after, added, withdrawn, gone, already, question, room: null };
}

export type AgentWriteResult =
  | { kind: "written"; change: AgentSuggestionChange }
  | { kind: "room"; change: AgentSuggestionChange }
  | { kind: "question-taken" }
  | { kind: "turn-gone" };

/**
 * 在一笔（立即加锁的）事务里读、算、写：同一时刻别处写不进来，所以读到的就是写的底。`questionText` 是要等的那一批
 * 写进那一问的清单（调用方按交给谁算好，也已经记在这一批每一件的 `question` 上）。
 */
export async function writeAgentChange(
  seen: TaskRow,
  withdrawals: readonly DispatchSuggestionWithdrawal[],
  incoming: IncomingBatch,
  questionText: string | null,
): Promise<AgentWriteResult> {
  const guard = and(eq(tasks.id, seen.id), turnWriteGuard(seen));
  const result = await db.transaction(async (transaction): Promise<AgentWriteResult> => {
    const row = (await transaction.select().from(tasks).where(guard)).at(0);
    if (!row) return { kind: "turn-gone" };
    const current = readSuggestions(row);
    if (incoming.wait !== "none" && row.question && !waitingBatchOf(current).length) return { kind: "question-taken" };
    const change = agentChange(current, withdrawals, incoming);
    if (change.room) return { kind: "room", change };
    const updatedAt = now();
    const asked = change.question === "set" ? { question: questionText, questionOptions: null, questionItems: null }
      : change.question === "clear" ? { question: null, questionOptions: null, questionItems: null } : {};
    await transaction.update(tasks).set({
      dispatchSuggestions: serializedSuggestions(change.after), dispatchPlan: null, ...asked, updatedAt,
      ...(change.withdrawn.length ? { dispatchWithdrawals: appendWithdrawn(change.withdrawn) } : {}),
    }).where(guard);
    if (change.question === "set") {
      const owner = (await transaction.select().from(tasks).where(eq(tasks.id, seen.id)))[0]!;
      await recordReviewWait(transaction, owner, "question");
    }
    return { kind: "written", change };
  }, { behavior: "immediate" });
  if (result.kind === "written" && result.change.question !== "keep") {
    bus.publish({
      type: "task.question", taskId: seen.id, updatedAt: now(),
      question: result.change.question === "set" ? questionText : null, questionOptions: null, questionItems: null,
    });
  }
  return result;
}
