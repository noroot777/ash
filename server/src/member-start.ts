import { eq } from "drizzle-orm";
import { db } from "./db/index.js";
import { queueItems, tasks } from "./db/schema.js";
import { acquireGroupSlot, releaseGroupSlot } from "./group-slots.js";
import { serializeQueueClaims } from "./queue-seat.js";
import { releaseTurn, type TurnIdentity } from "./runs.js";
import { reserveQueuedTask, restoreQueuedTask, taskQueueReservation } from "./task-queue-reservation.js";
import { claimOwnTurnUnlessStarted, turnStartsOf } from "./turn-lock.js";

// 先排队、后起跑的那一类入口共用的准入：分组运行拉起成员（scheduler.ts runParallel）、「接着跑」
// 兑现欠账（dispatch-hold.ts）。从决定起它到真轮到它，中间可能等了一整轮别人的任务；排队那一刻
// 成立的事实轮到时一条都不能信，全部在这里、在队列认领的同一个临界区里重读：
//   · 它此刻在哪：等的期间进了队列 → 不由这条路起，交回队列按位置起（不然和同队在跑的那条一起跑，
//     第 3 轮复审 F1）；换了分组 → 还掉旧组的名额、按新组重新排（不然吃的是旧组的配额）；
//   · 这期间有没有人替它起过（起跑票，turn-lock.ts turnStartsOf）：起过就不起第二遍（第 2 轮复审 F1）；
//   · 调用方自己的资格（状态、提问、哨兵、被按住）照样轮到才判。
// 占位与「落 queued」都在临界区里做完，跟队列推进（scheduler.ts advanceQueueAttempt）、手动启动
// （queue-seat.ts claimQueueSeat）争的是同一个原子对象。

type TaskRow = typeof tasks.$inferSelect;
export type MemberAdmitted = { owner: TurnIdentity; row: TaskRow };

type Verdict =
  | { kind: "skip" }
  | { kind: "queue"; queueId: string }
  | { kind: "regroup"; groupId: string | null }
  | ({ kind: "start"; reservation: ReturnType<typeof taskQueueReservation> } & MemberAdmitted);

export async function startMember(groupId: string | null, taskId: string, opts: {
  /** 轮到之后、进临界区之前（会自己读写别处的，比如续跑交代的交接）；返回真 = 这次不起。 */
  prepare?: () => Promise<unknown>;
  /** 轮到时重读到的这一行还该由这条路起吗。在临界区里跑：只许读库、记账，别去推队列。 */
  eligible: (row: TaskRow) => Promise<boolean>;
  /** 等的期间它进了队列：交回队列。 */
  queued: (queueId: string) => Promise<void>;
  /** 占好位、落好 queued 之后真去起它；返回之后由这里还锁、回收没用上的占位。 */
  start: (admitted: MemberAdmitted) => Promise<void>;
}): Promise<void> {
  const seen = turnStartsOf(taskId);
  let group = groupId;
  for (;;) {
    const slot = group;
    if (slot) await acquireGroupSlot(slot, taskId);
    let verdict: Verdict;
    try {
      if (opts.prepare && await opts.prepare()) return;
      verdict = await admit(taskId, group, seen, opts.eligible);
      if (verdict.kind === "start") {
        const { reservation, owner } = verdict;
        try {
          await opts.start(verdict);
        } finally {
          releaseTurn(taskId, owner);
          await restoreQueuedTask(reservation);
        }
        return;
      }
    } finally {
      if (slot) releaseGroupSlot(slot, taskId);
    }
    if (verdict.kind === "queue") return opts.queued(verdict.queueId);
    if (verdict.kind === "skip") return;
    group = verdict.groupId;
  }
}

function admit(taskId: string, group: string | null, seen: number, eligible: (row: TaskRow) => Promise<boolean>): Promise<Verdict> {
  return serializeQueueClaims(async (): Promise<Verdict> => {
    const row = (await db.select().from(tasks).where(eq(tasks.id, taskId))).at(0);
    if (!row) return { kind: "skip" };
    const item = (await db.select({ queueId: queueItems.queueId }).from(queueItems).where(eq(queueItems.taskId, taskId))).at(0);
    if (item) return { kind: "queue", queueId: item.queueId };
    if ((row.groupId ?? null) !== group) return { kind: "regroup", groupId: row.groupId ?? null };
    if (!(await eligible(row))) return { kind: "skip" };
    const owner = claimOwnTurnUnlessStarted(taskId, seen);
    if (!owner) return { kind: "skip" };
    const reservation = taskQueueReservation(row);
    try {
      await reserveQueuedTask(reservation);
    } catch (error) {
      releaseTurn(taskId, owner);
      throw error;
    }
    return { kind: "start", owner, row, reservation };
  });
}
