// 同一分组「同时在跑」最多几条。名额**不记账**：此刻同组里有几条任务占着执行回合锁（turn-lock.ts），
// 就是几条在跑。没有要配平的计数，所以没有「谁忘了还」，重启接回（reattach.ts 重新占锁）的回合也自然算在里面。
//
// 只拦自动起跑（等齐就起那一个放行口，launch-request.ts）。用户点运行、发回复、队列推进不拦，但它们在跑时
// 占着锁，就算在数里。审查的旁路回合、写工作区 / 验收 / 收唤醒这些占位不是执行回合，不算。
// 不在分组里的任务共用一个公共桶。
//
// 「数」和「占」之间没有 await：数完没满当场 `claimOwnTurn`，这一下认领本身就是占名额。数之前要知道每把锁
// 的主人在哪个组（读库），读回来之后再同步看一遍此刻的锁：有新主人没读过就再读，读齐了才数、才占。
//
// 读回来的分组只在「这期间没有人改过任何任务的分组」时作数。锁的主人名单没变，不等于主人的分组没变：单条
// 换组拦着占着执行锁的任务（queue-membership-guard.ts），删分组却会把整组成员一起摘成不在分组里。所以改已有
// 任务分组的那几处写方都包在 `writingGroupMembership` 里：写之前、写完各推一次代号，写着的时候不许认领。
// 认领那一刻代号还是读之前那个、也没有写在途，读回来的分组就是此刻库里的。
import { inArray } from "drizzle-orm";
import { db } from "./db/index.js";
import { tasks } from "./db/schema.js";
import { claimOwnTurn, heldTurns, isTurnClaimed, turnRole, type TurnIdentity } from "./turn-lock.js";
import { afterRuntimeHandover, runtimeHandoverActive } from "./runtime-handover-state.js";

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

// ── 分组归属的写方 ───────────────────────────────────────────────────────────
let membershipEpoch = 0;
let membershipWrites = 0;
let membershipIdle: { promise: Promise<void>; resolve: () => void } | null = null;

/**
 * 改**已有**任务分组的写入都从这里过（单条换组、删分组把成员摘出来）。建任务时写的分组不用：新任务手里
 * 不可能已经占着执行锁。
 */
export async function writingGroupMembership<T>(write: () => Promise<T>): Promise<T> {
  membershipWrites += 1;
  membershipEpoch += 1;
  try {
    return await write();
  } finally {
    membershipWrites -= 1;
    membershipEpoch += 1;
    if (!membershipWrites && membershipIdle) {
      membershipIdle.resolve();
      membershipIdle = null;
    }
  }
}

function membershipSettled(): Promise<void> {
  if (!membershipWrites) return Promise.resolve();
  if (!membershipIdle) {
    let resolve!: () => void;
    const promise = new Promise<void>((done) => { resolve = done; });
    membershipIdle = { promise, resolve };
  }
  return membershipIdle.promise;
}

/**
 * 把此刻每把执行锁主人的分组读齐。`fresh(known)` 为真 = 读到的这份此刻还作数（同步判断，紧接着就可以数、占）。
 * 读到一半有人改了分组，就从头再读。
 */
async function readHolders(): Promise<{ known: Map<string, string | null>; fresh: () => boolean } | null> {
  let known = new Map<string, string | null>();
  let epoch = membershipEpoch;
  for (let round = 0; round < MAX_READ_ROUNDS; round += 1) {
    if (membershipWrites) {
      await membershipSettled();
      continue;
    }
    if (epoch !== membershipEpoch) {
      known = new Map();
      epoch = membershipEpoch;
    }
    const unknown = executionHolders().filter((holder) => !known.has(holder));
    if (unknown.length) {
      await readGroups(unknown, known);
      continue; // 读的这段时间里又有人占了锁、或者改了分组：回头再看一遍
    }
    const seen = epoch;
    return { known, fresh: () => !membershipWrites && membershipEpoch === seen && executionHolders().every((holder) => known.has(holder)) };
  }
  return null;
}

function countIn(groupId: string | null, known: ReadonlyMap<string, string | null>): number {
  return executionHolders().filter((taskId) => known.has(taskId) && bucket(known.get(taskId)) === bucket(groupId)).length;
}

/** 同组此刻在跑几条（页面上那句「在等什么」用；要占名额走 `claimLaunchTurn`，别拿它先数后占）。 */
export async function runningInGroup(groupId: string | null): Promise<number> {
  const read = await readHolders();
  if (read) return countIn(groupId, read.known);
  // 一直读不齐（分组在不停地改）：按最后一次读回来的算，只是页面上的一句话。
  const known = new Map<string, string | null>();
  await readGroups(executionHolders(), known);
  return countIn(groupId, known);
}

/**
 * `full` = 同组已满；`busy` = 这条任务此刻已经有回合（别处正在起它 / 它在跑）；`churn` = 锁的主人一直在换、
 * 读不齐（调用方过一会儿再来）。
 */
export type LaunchClaim = { ok: true; turn: TurnIdentity } | { ok: false; why: "full" | "busy" | "churn"; running?: number };

/** 按 `groupId` 那一桶占一个名额并认领这条任务的执行回合。认领到之后照常由持有者在每条出路上还锁。 */
export async function claimLaunchTurn(taskId: string, groupId: string | null): Promise<LaunchClaim> {
  for (let round = 0; round < MAX_READ_ROUNDS; round += 1) {
    while (runtimeHandoverActive()) await new Promise<void>((resolve) => afterRuntimeHandover(resolve));
    const read = await readHolders();
    if (runtimeHandoverActive()) { round -= 1; continue; }
    if (!read) break;
    // ── 从这里到认领，没有 await ──
    if (!read.fresh()) continue;
    if (isTurnClaimed(taskId)) return { ok: false, why: "busy" };
    const running = countIn(groupId, read.known);
    if (running >= PARALLEL_LIMIT) return { ok: false, why: "full", running };
    const turn = claimOwnTurn(taskId, "single");
    return turn ? { ok: true, turn } : { ok: false, why: "busy" };
  }
  return { ok: false, why: "churn" };
}
