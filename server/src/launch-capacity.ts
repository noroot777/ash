// 同一分组「同时在跑」最多几条。名额**不记账**：此刻同组里有几条任务占着执行回合锁（turn-lock.ts），
// 就是几条在跑。没有要配平的计数，所以没有「谁忘了还」，重启接回（reattach.ts 重新占锁）的回合也自然算在里面。
//
// 只拦自动起跑（等齐就起那一个放行口，launch-request.ts）。用户点运行、发回复、队列推进不拦，但它们在跑时
// 占着锁，就算在数里。审查的旁路回合、写工作区 / 验收 / 收唤醒这些占位不是执行回合，不算。
// 不在分组里的任务共用一个公共桶。
//
// 「数」和「占」之间没有 await：数完没满当场 `claimOwnTurn`，这一下认领本身就是占名额。数之前要知道每把锁
// 的主人在哪个组（读库），读回来之后再同步看一遍此刻的锁：有新主人没读过就再读，读齐了才数、才占。
// 占着执行锁的任务不许换组（queue-membership-guard.ts），所以读到的组在它放锁之前一直作数。
import { inArray } from "drizzle-orm";
import { db } from "./db/index.js";
import { tasks } from "./db/schema.js";
import { claimOwnTurn, heldTurns, isTurnClaimed, turnRole, type TurnIdentity } from "./turn-lock.js";

export const PARALLEL_LIMIT = 4;

/** 算名额的回合：执行回合本身（续聊、研讨也是）。审查、旁路、各种占位都不算。 */
const EXECUTION_ROLES = new Set(["single", "duet"]);

const bucket = (groupId: string | null | undefined) => groupId ?? "";

function executionHolders(): string[] {
  return heldTurns().filter((turn) => EXECUTION_ROLES.has(turn.role)).map((turn) => turn.taskId);
}

/** 这条任务此刻占着执行回合（在跑，或者正由某一路起跑）。 */
export function holdsExecutionTurn(taskId: string): boolean {
  const role = turnRole(taskId);
  return role !== null && EXECUTION_ROLES.has(role);
}

/** 把这几把执行锁主人的分组读进 `known`。读不到行的（删了）记成一个谁都不等于的桶：不算，也不再读它。 */
async function readGroups(unknown: string[], known: Map<string, string | null>): Promise<void> {
  const rows = await db.select({ id: tasks.id, groupId: tasks.groupId }).from(tasks).where(inArray(tasks.id, unknown));
  const found = new Map(rows.map((row) => [row.id, row.groupId ?? null] as const));
  for (const taskId of unknown) known.set(taskId, found.has(taskId) ? found.get(taskId)! : `\0gone:${taskId}`);
}

const MAX_READ_ROUNDS = 8;

function countIn(groupId: string | null, known: ReadonlyMap<string, string | null>): number {
  return executionHolders().filter((taskId) => known.has(taskId) && bucket(known.get(taskId)) === bucket(groupId)).length;
}

/** 同组此刻在跑几条（页面上那句「在等什么」用；要占名额走 `claimLaunchTurn`，别拿它先数后占）。 */
export async function runningInGroup(groupId: string | null): Promise<number> {
  const known = new Map<string, string | null>();
  for (let round = 0; round < MAX_READ_ROUNDS; round += 1) {
    const unknown = executionHolders().filter((taskId) => !known.has(taskId));
    if (!unknown.length) break;
    await readGroups(unknown, known);
  }
  return countIn(groupId, known);
}

/**
 * `full` = 同组已满；`busy` = 这条任务此刻已经有回合（别处正在起它 / 它在跑）；`churn` = 锁的主人一直在换、
 * 读不齐（调用方过一会儿再来）。
 */
export type LaunchClaim = { ok: true; turn: TurnIdentity } | { ok: false; why: "full" | "busy" | "churn"; running?: number };

/** 按 `groupId` 那一桶占一个名额并认领这条任务的执行回合。认领到之后照常由持有者在每条出路上还锁。 */
export async function claimLaunchTurn(taskId: string, groupId: string | null): Promise<LaunchClaim> {
  const known = new Map<string, string | null>();
  for (let round = 0; round < MAX_READ_ROUNDS; round += 1) {
    const unknown = executionHolders().filter((holder) => !known.has(holder));
    if (unknown.length) {
      await readGroups(unknown, known);
      continue; // 读的这段时间里又有人占了锁：回头再看一遍此刻的锁
    }
    // ── 从上面那一看到认领，没有 await ──
    if (isTurnClaimed(taskId)) return { ok: false, why: "busy" };
    const running = countIn(groupId, known);
    if (running >= PARALLEL_LIMIT) return { ok: false, why: "full", running };
    const turn = claimOwnTurn(taskId, "single");
    return turn ? { ok: true, turn } : { ok: false, why: "busy" };
  }
  return { ok: false, why: "churn" };
}
