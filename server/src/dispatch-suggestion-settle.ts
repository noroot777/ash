// 等着的那一批说定「派完就算完成」（wait = done）时，处理完那一下欠下的那件事怎么还：问答记录上的
// `settleOwed`（shared/questions.ts `LaunchSettleDebt`），跟建任务、认领那一问同一笔落库
// （dispatch-suggestion-resolve.ts）。
//
// 为什么不跟建任务同一笔落 done：落 done 要带队列推进、停哨兵、结算后续（status.ts），只有 setTaskStatus
// 这一个入口做得全，它又自开事务。所以那一笔只记下「欠着」，这里还。还的时机有三个：处理完之后当场、开机、
// 每分钟一扫——中间抛错、进程恰好没了、回合锁正被占着，下一次都会接着还；每一次都按库里此刻的样子重判。
//
// 欠的是两段，各自落库：
//   · complete —— 结成完成。跟 complete_task 过同一道终态闸（`beginTerminalLanding`）：名下还有没收下的哨兵
//     结果就落那段可恢复等待、交回智能体——「摆单时说了 done」不等于「此刻什么都收齐了」，不能替它把没收下的
//     结果一并收走。落 done 那一笔里欠账同时改成 followUp（`alsoInTx`），两者同生共死；
//   · followUp —— 完成之后该接的结算后续（预约的审查就等清掉提问的这一刻、推进线）。本来就是已完成（完成之后
//     的续聊里摆的单）的直接从这一段起，不再记一次完成。`settlementHooks` 不吞错，做成了才销账；没做成留着
//     下一次再做（审查预约按 CAS 消费，重做不会双开）。
//
// 这份授权只在派出那一刻的局面里有效（`epoch` / `from`）：之后起过新回合（智能体被叫起来了，它自己会结算，
// 清单随那一回合开头补交）、被引导过、状态被改过（用户手动改、别的结算）、归档了、接力出去了，就作废——旧的
// 授权不能越过后来的决定。用户手动改状态那一下当场显式作废（task-routes.ts），之后状态再被改回原样也不复活。
import { and, eq, like } from "drizzle-orm";
import type { TaskStatus } from "@navi/shared";
import type { LaunchSettleDebt, QuestionRecord } from "@navi/shared/questions";
import { db, dbClient } from "./db/index.js";
import { tasks } from "./db/schema.js";
import { claimOwnTurnWhenReady as claimOwnTurn, releaseTurn } from "./runs.js";
import { setTaskStatus, type StatusTxWriter } from "./status.js";
import { settlementHooks } from "./settle-status.js";
import { beginTerminalLanding, releaseTerminalLanding } from "./task-complete.js";
import { appendTaskTimeline, alertLine } from "./task-timeline.js";
import { handoffBlockReason } from "./handoff-guard.js";
import type { TaskRow } from "./task-store.js";

/** 停在这几种上的由这里落 done；在跑、在排、在等审查的归那一边。 */
const SETTLEABLE = ["paused", "failed", "canceled", "backlog"] as const satisfies readonly TaskStatus[];

const historyOf = (raw: string | null | undefined): QuestionRecord[] => {
  if (!raw) return [];
  try {
    const value = JSON.parse(raw) as unknown;
    return Array.isArray(value) ? value as QuestionRecord[] : [];
  } catch {
    return [];
  }
};

/** 处理完那一下记在问答记录上的欠账：派出那一刻的方向世代与状态；本来已完成的直接欠结算后续。 */
export function launchDebtFor(row: Pick<TaskRow, "status" | "directionEpoch">): LaunchSettleDebt {
  return { stage: row.status === "done" ? "followUp" : "complete", epoch: row.directionEpoch, from: row.status };
}

const owedOf = (records: readonly QuestionRecord[]) => records.find((record) => record.settleOwed)?.settleOwed ?? null;

/** 摘掉（或换成下一段）问答记录上的欠账。 */
function withDebt(records: readonly QuestionRecord[], next: LaunchSettleDebt | null): QuestionRecord[] {
  return records.map((record) => {
    if (!record.settleOwed) return record;
    const { settleOwed: _owed, ...rest } = record;
    return next ? { ...rest, settleOwed: next } : rest;
  });
}

/** 接力过来的问答记录不带欠账：那份授权属于源机上派出那一刻的局面（handoff-import.ts）。 */
export function questionHistoryWithoutDebt(raw: string | null): string | null {
  const history = historyOf(raw);
  return raw && owedOf(history) ? JSON.stringify(withDebt(history, null)) : raw;
}

/**
 * 整列条件写改欠账：读到之后这一列被别处改过（新的答复、删除消息）就重读一遍。`expect` 给了就只在欠账
 * 还是那一份时改（换段、销账都只认自己读到的那一份）。
 */
async function rewriteDebt(taskId: string, expect: LaunchSettleDebt | null, next: LaunchSettleDebt | null, query: StatusTxWriter = db): Promise<boolean> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const row = (await query.select({ history: tasks.questionHistory }).from(tasks).where(eq(tasks.id, taskId))).at(0);
    const history = historyOf(row?.history);
    const owed = owedOf(history);
    if (!row?.history || !owed) return false;
    if (expect && JSON.stringify(owed) !== JSON.stringify(expect)) return false;
    const written = await query.update(tasks).set({ questionHistory: JSON.stringify(withDebt(history, next)) })
      .where(and(eq(tasks.id, taskId), eq(tasks.questionHistory, row.history))).returning({ id: tasks.id });
    if (written.length) return true;
  }
  return false;
}

/** 作废这条任务上的欠账（用户手动改了状态）。没有就什么都不做。 */
export async function voidLaunchDebt(taskId: string): Promise<void> {
  await rewriteDebt(taskId, null, null);
}

/** 这份授权还算不算数：还停在派出那一刻的局面里（同一个方向世代、该段该有的状态、没归档、没接力出去）。 */
function stillOwed(task: TaskRow, debt: LaunchSettleDebt): boolean {
  if (task.archived || handoffBlockReason(task.handoff)) return false;
  if (task.directionEpoch !== debt.epoch) return false;
  return debt.stage === "complete" ? task.status === debt.from : task.status === "done";
}

class DebtMoved extends Error {}

/** 同一个进程里每条任务只报一次「没还上」：每分钟都重试，时间线不该每分钟多一行。 */
const alerted = new Set<string>();

/** 还一次。回合锁被占着就留给下一次（那一回合若是智能体的，起跑时世代已经前进，这份欠账随之作废）。 */
export async function settleLaunchDebt(taskId: string): Promise<void> {
  const turn = await claimOwnTurn(taskId, "status");
  if (!turn) return;
  let latched = false;
  try {
    const task = (await db.select().from(tasks).where(eq(tasks.id, taskId))).at(0);
    const debt = task ? owedOf(historyOf(task.questionHistory)) : null;
    if (!task || !debt) return;
    if (!stillOwed(task, debt)) {
      await rewriteDebt(taskId, debt, null);
      return;
    }
    if (debt.stage === "complete") {
      const from = SETTLEABLE.find((status) => status === task.status);
      if (!from) {
        await rewriteDebt(taskId, debt, null);
        return;
      }
      // 被闸拦下：可恢复等待已经落下，结果送到时叫醒智能体，清单随那一回合开头补交，由它看过再确认。
      if (await beginTerminalLanding(taskId)) {
        await rewriteDebt(taskId, debt, null);
        return;
      }
      latched = true;
      const followUp: LaunchSettleDebt = { ...debt, stage: "followUp" };
      const landed = await setTaskStatus(taskId, "done", {
        completion: true, expectStatus: from,
        alsoInTx: async (tx) => {
          const current = (await tx.select({ epoch: tasks.directionEpoch }).from(tasks).where(eq(tasks.id, taskId))).at(0);
          if (current?.epoch !== debt.epoch || !await rewriteDebt(taskId, debt, followUp, tx)) throw new DebtMoved();
        },
      }).catch((error: unknown) => {
        if (error instanceof DebtMoved) return false;
        throw error;
      });
      // 没落上：状态或欠账在读到之后被别处改了，下一次按新的样子再判。
      if (!landed) return;
      await settlementHooks(taskId, "done", true);
      await rewriteDebt(taskId, followUp, null);
    } else {
      await settlementHooks(taskId, "done", true);
      await rewriteDebt(taskId, debt, null);
    }
    alerted.delete(taskId);
  } catch (error) {
    console.error(`[navi] 派出去之后没能按约定收尾 ${taskId}:`, error);
    if (!alerted.has(taskId)) {
      alerted.add(taskId);
      await appendTaskTimeline(taskId, alertLine(
        `派出去的任务都建好了，但这条任务还没能按约定收尾（结成完成、开预约的审查）：${error instanceof Error ? error.message : String(error)}。`
        + "每分钟会自动再试；也可以核对后手动改状态。",
      )).catch(() => undefined);
    }
  } finally {
    if (latched) releaseTerminalLanding(taskId);
    releaseTurn(taskId, turn);
  }
}

/** 把还欠着的都还一遍（开机、每分钟）。 */
export async function sweepLaunchDebts(): Promise<void> {
  if (dbClient.closed) return; // 进程收尾（测试关库、server 退出）时迟到的那一扫
  const owing = await db.select({ id: tasks.id }).from(tasks).where(like(tasks.questionHistory, '%"settleOwed":%'));
  for (const { id } of owing) await settleLaunchDebt(id);
}

let timer: ReturnType<typeof setInterval> | null = null;
/**
 * 开机调一次：先装上每分钟的兜底，再补办一遍——首扫抛了（库一时读不了）也只是这一遍没做，一分钟后接着扫，
 * 不会让整个进程从此没人还。
 */
export async function startLaunchDebtSweeps(intervalMs = 60_000): Promise<void> {
  if (!timer) {
    timer = setInterval(() => void sweepLaunchDebts().catch((error) => console.error("[navi] 派出去之后的收尾补办失败:", error)), intervalMs);
    timer.unref();
  }
  await sweepLaunchDebts();
}
