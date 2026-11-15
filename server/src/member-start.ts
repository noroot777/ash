import { eq } from "drizzle-orm";
import { db } from "./db/index.js";
import { queueItems, tasks } from "./db/schema.js";
import { freeSlot, takeSlot, whenSlotFrees } from "./launch-slots.js";
import { serializeQueueClaims } from "./queue-seat.js";
import { releaseTurn, type TurnIdentity } from "./runs.js";
import { reclaimStrandedSeat } from "./queue-seat-reclaim.js";
import { reserveUnqueuedMember, restoreQueuedTask, taskQueueReservation, type TaskQueueReservation } from "./task-queue-reservation.js";
import { claimOwnTurnUnlessStarted, turnStartsOf } from "./turn-lock.js";

// 先排队、后起跑的那一类入口共用的准入：分组运行拉起成员（scheduler.ts runParallel）、「接着跑」
// 兑现欠账（dispatch-hold.ts）。从决定起它到真轮到它，中间可能等了一整轮别人的任务；排队那一刻
// 成立的事实轮到时一条都不能信，全部在这里、在队列认领的同一个临界区里重读：
//   · 它此刻在哪：等的期间进了队列 → 不由这条路起，交回队列按位置起（不然和同队在跑的那条一起跑，
//     第 3 轮复审 F1）；换了分组 → 还掉旧组的名额、按新组重新排（不然吃的是旧组的配额）；
//   · 这期间有没有人替它起过（起跑票，turn-lock.ts turnStartsOf）：起过就不起第二遍（第 2 轮复审 F1）；
//   · 调用方自己的资格（状态、提问、哨兵、被按住）照样轮到才判。
// 占位与「落 queued」都在临界区里做完，跟队列推进（scheduler.ts advanceQueueAttempt）、手动启动
// （queue-seat.ts claimQueueSeat）争的是同一个原子对象；改归属的接口不进这个临界区，所以归属由占位
// 那一笔 UPDATE 自己再认一次。

type TaskRow = typeof tasks.$inferSelect;
export type MemberAdmitted = { owner: TurnIdentity; row: TaskRow };

type Verdict =
  | { kind: "skip" }
  | { kind: "queue"; queueId: string }
  | { kind: "regroup"; groupId: string | null }
  /** 占位那一笔因为归属 / 状态刚变了没写成（什么都没写）：重新准入一遍，按变化后的事实走。 */
  | { kind: "changed" }
  | ({ kind: "start"; reservation: TaskQueueReservation } & MemberAdmitted);

/** 同一个名额上为「刚变了」重来几趟：每一趟都意味着别人刚改了它，挡的只是病态来回。 */
const MAX_READMITS = 3;

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
    const slotGroup = group;
    if (slotGroup) await occupySlot(slotGroup, taskId);
    let verdict: Verdict = { kind: "changed" };
    try {
      if (opts.prepare && await opts.prepare()) return;
      for (let i = 0; i < MAX_READMITS && verdict.kind === "changed"; i += 1) {
        verdict = await admit(taskId, group, seen, opts.eligible);
      }
      if (verdict.kind === "start") {
        const { reservation, owner } = verdict;
        try {
          await opts.start(verdict);
        } finally {
          releaseTurn(taskId, owner);
          await restoreQueuedTask(reservation).catch((error) => reclaimLater(reservation, error));
        }
        return;
      }
    } finally {
      if (slotGroup) freeSlot(slotGroup, taskId);
    }
    if (verdict.kind === "queue") return opts.queued(verdict.queueId);
    if (verdict.kind !== "regroup") return;
    group = verdict.groupId;
  }
}

/**
 * 占这一组的一个名额（launch-slots.ts，分组运行、等齐就起、接着跑兑现欠账共用的那一份），满了就等有人
 * 还。占不到也可能是这一位的名额正被别的入口占着（它正由那一路起跑）：等那一路还了再进来，准入那里
 * 会认出它这期间已经起过。没有分组的不占：只有同组的并发有上限。
 */
async function occupySlot(groupId: string, taskId: string): Promise<void> {
  while (!takeSlot(groupId, taskId)) await whenSlotFrees();
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
    // 上面读到的归属只是这一刻的：入队、改组的接口不进这个临界区。占位那一笔自己再认一次
    // 「不在队列、还在这个组」（task-queue-reservation.ts reserveUnqueuedMember），读完之后才变的
    // 就写不成，回头按变化后的事实重新准入（第 4 轮复审 F1）。
    const reservation = taskQueueReservation(row);
    let written: boolean;
    try {
      written = await reserveUnqueuedMember(reservation, group);
    } catch (error) {
      releaseTurn(taskId, owner);
      reclaimLater(reservation, error);
      throw error;
    }
    if (!written) {
      releaseTurn(taskId, owner);
      return { kind: "changed" };
    }
    return { kind: "start", owner, row, reservation };
  });
}

/**
 * 占位写没写进去不知道（UPDATE 提交之后附带的读取抛了），或者用完之后还原失败：这具 queued 没人
 * 收拾就是永久「排队中」，欠账补扫也不认 queued（第 4 轮复审 F2）。交给队列占位的守卫式回收
 * （queue-seat-reclaim.ts）：带着自己那份凭证，只收「还停在我这一份 queued 上」的，失败自己退避重试。
 * 不推队列（这一位不在队列里）：回到原状态之后，欠账由 tick 的补扫接着兑现，分组运行那边照常报没起来。
 * 延一拍、不在这里等：此刻多半还在队列认领的临界区里。
 */
function reclaimLater(reservation: TaskQueueReservation, error: unknown): void {
  console.error(`[ash] 成员起跑占位没收干净 task=${reservation.taskId}，交给守卫式回收:`, error);
  const timer = setTimeout(() => void reclaimStrandedSeat(reservation.taskId, "", reservation.prevStatus,
    { repush: "never", reservation }), 1_000);
  timer.unref?.();
}
