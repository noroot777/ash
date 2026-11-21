// 智能体那一笔（MCP suggest_dispatch → POST /tasks/:id/dispatch-suggestions）怎么落：
//   · 先收回、再挂新的——所以「收回旧的、挂一件同名的新说明」一次就能换；要收回的那件已经不在了不算错（只收得回
//     还挂着的：已经派出去、点叉了的那几件的记录原样留着，等交到智能体手上）；
//   · 不等的一批：跟还挂着的（或同一批里前面的）同名的不挂第二件，框顶同一件事只有一行——同一批里有别的要挂的
//     那件等着它时照挂（前置不能指向一件没挂上的东西）；收回的那件被同一批里还挂着的等着时，那条前置跟着划掉；
//   · 要等的一批：换掉之前在等的那一批（同一回合里再摆一次就是改），同一笔写下那一问（`task.question`，一句看得懂
//     的清单）——任务结算落暂停、队列不自动续跑，跟提问同一套停法。有普通提问在等时摆不出来（同一时刻只等用户一样
//     东西，判在同一笔事务里：跟同时发出的提问只有一个写得进去）。等着的那一批被它自己收回光了，那一问一起撤掉；
//   · 挂上去超过上限、或者会把用户已经从等着的那一批里派出去的几件的记录一起拿掉（换掉那一批、收回光剩下的）：
//     整笔不落，连收回也不落；
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
import {
  appendWithdrawn, readSuggestions, rewritePrerequisites, scopedKey, serializedSuggestions, turnWriteGuard, waitingBatchOf,
} from "./dispatch-suggestion.js";
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
  /** 这一笔不落的原因（挂满了、会抹掉用户已经派出去的那几件的记录）；null = 照写。 */
  refused: string | null;
};

/**
 * 不等的一批里哪几件因为同名不挂第二件。同一批里还有要挂的那件等着它（前置指着它的 key）就照挂：不挂的话那件的前置
 * 指向一件不存在的东西，派的时候只会报「前置任务不存在」；它也不能指到别的那一件上去（不同批的 key 互不相通）。
 */
function duplicatesOf(items: readonly StoredSuggestion[], hanging: readonly StoredSuggestion[]): Map<string, StoredSuggestion> {
  const skipped = new Map<string, StoredSuggestion>();
  const seen = [...hanging];
  for (const item of items) {
    const same = seen.find((other) => other.title === item.title);
    if (same) skipped.set(item.id, same);
    else seen.push(item);
  }
  for (let changed = true; changed;) {
    changed = false;
    const needed = new Set(items.filter((item) => !skipped.has(item.id)).flatMap((item) => item.prerequisites ?? []));
    for (const item of items) {
      if (skipped.has(item.id) && item.key && needed.has(item.key)) { skipped.delete(item.id); changed = true; }
    }
  }
  return skipped;
}

export function agentChange(
  current: StoredSuggestion[],
  withdrawals: readonly DispatchSuggestionWithdrawal[],
  incoming: IncomingBatch,
): AgentSuggestionChange {
  const reasons = new Map(withdrawals.map((item) => [item.id, item.reason]));
  const at = now();
  const live = hangingSuggestions(current);
  const pulled = live.filter((item) => reasons.has(item.id));
  const withdrawn = pulled.map((item) => ({ id: item.id, title: item.title, reason: reasons.get(item.id)!, at }));
  const gone = withdrawals.map((item) => item.id).filter((suggestion) => !live.some((item) => item.id === suggestion));
  const refuse = (refused: string): AgentSuggestionChange =>
    ({ after: current, added: [], withdrawn: [], gone, already: [], question: "keep", refused });
  const waitingBefore = waitingBatchOf(current);
  // 收回的那几件：同一批里还挂着、等着它们的那几件划掉这条前置（同用户点叉）。
  const rewrite = new Map(pulled.flatMap((item) => (item.key ? [[scopedKey(item, item.key), null] as const] : [])));
  // 只收得回还挂着的：已经了结的（派出去、点叉）那几件的记录要交到你手上，不因为一次收回就没了。
  let kept = rewritePrerequisites(current.filter((item) => item.settled || !reasons.has(item.id)), rewrite);
  const replacing = incoming.wait !== "none";
  if (replacing) kept = kept.filter((item) => item.wait === "none");
  const skipped = replacing ? new Map<string, StoredSuggestion>() : duplicatesOf(incoming.items, hangingSuggestions(kept));
  const added = incoming.items.filter((item) => !skipped.has(item.id));
  const already = [...skipped.values()].map((item) => ({ id: item.id, title: item.title }));
  const after = [...kept, ...added];
  const count = hangingSuggestions(after).length;
  if (count > MAX_SUGGESTIONS_PER_TASK) {
    return refuse(`这条任务上已经挂着 ${hangingSuggestions(kept).length} 件用户还没处理，再挂 ${added.length} 件就超过 ${MAX_SUGGESTIONS_PER_TASK} 件了；只挂最该做的，已经不成立的先用 withdraw 收回`);
  }
  const waitingAfter = waitingBatchOf(after).some((item) => !item.settled);
  const question = replacing ? "set" : waitingBefore.length && !waitingAfter ? "clear" : "keep";
  // 等着的那一批要被换掉或收回光了，而用户已经从里面派出去了几件：那几件建好的任务只记在这一批上，拿掉就没人知道
  // 它们建过了（清单交不到你手上）。这种时候不落，等用户把剩下的处理完。
  const created = waitingBefore.filter((item) => item.settled?.task);
  if (question !== "keep" && created.length) {
    return refuse(`用户已经从等着的那一批里派出了${created.map((item) => `「${item.title}」`).join("")}，这一批不能再换掉或整批收回；`
      + "等用户把剩下的处理完，建好的清单会交给你");
  }
  // 等着的那一批被收回光了：那一批（连同点叉了的了结记录）一起拿掉，免得留一批没人等的了结记录。
  return { after: question === "clear" ? after.filter((item) => item.wait === "none") : after, added, withdrawn, gone, already, question, refused: null };
}

export type AgentWriteResult =
  | { kind: "written"; change: AgentSuggestionChange }
  | { kind: "refused"; change: AgentSuggestionChange }
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
    if (change.refused) return { kind: "refused", change };
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
