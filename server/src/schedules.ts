import { eq } from "drizzle-orm";
import { db } from "./db/index.js";
import { isAcceptingTask } from "./acceptance-lock.js";
import { handoffBlockReason } from "./handoff-guard.js";
import { claimOwnTurn, releaseTurn } from "./runs.js";
import { seatThenStart } from "./queue-seat.js";
import { schedules, tasks } from "./db/schema.js";
import { taskHoldOf } from "./task-hold.js";
import { runTask } from "./orchestrator.js";
import { runDuet } from "./duet/index.js";
import { SCHEDULER_STARTED } from "./log-signals.js";
import { deliverPendingMessages, reclaimStaleDeliveries } from "./pending-messages.js";
import { restoreFollowUpAnswers } from "./legacy-answer-intent.js";
import { preparePendingCheckpointStart } from "./pending-checkpoint-recovery.js";
import { replayQueueAdvances } from "./queue-advance-retry.js";
import { sweepReleasedQueueMembers } from "./queue-monitor-hold.js";
import { sweepOwedStarts, sweepPendingHolds } from "./dispatch-hold.js";
import { markShiftAdmission } from "./dispatch-hold-owed.js";
import { turnFreezeReason } from "./turn-freeze.js";
import { reportStuckWindDowns, reportSuspectTurns } from "./turn-lock-reclaim.js";

// ── Minimal 5-field cron matcher (minute hour dom month dow), local time ──────
// Supports *, n, a-b, */n, and comma lists. No seconds, no names.
function fieldMatches(field: string, value: number, min: number, max: number): boolean {
  return field.split(",").some((part) => {
    let step = 1;
    let range = part;
    const slash = part.indexOf("/");
    if (slash !== -1) {
      step = Number(part.slice(slash + 1)) || 1;
      range = part.slice(0, slash);
    }
    let lo = min;
    let hi = max;
    if (range !== "*") {
      const dash = range.indexOf("-");
      if (dash !== -1) {
        lo = Number(range.slice(0, dash));
        hi = Number(range.slice(dash + 1));
      } else {
        lo = hi = Number(range);
      }
    }
    if (value < lo || value > hi) return false;
    return (value - lo) % step === 0;
  });
}

export function cronMatches(expr: string, d: Date): boolean {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) return false;
  const [mi, ho, dom, mo, dow] = parts;
  return (
    fieldMatches(mi, d.getMinutes(), 0, 59) &&
    fieldMatches(ho, d.getHours(), 0, 23) &&
    fieldMatches(dom, d.getDate(), 1, 31) &&
    fieldMatches(mo, d.getMonth() + 1, 1, 12) &&
    fieldMatches(dow, d.getDay(), 0, 6)
  );
}

const sameMinute = (a: string, b: Date) => {
  const da = new Date(a);
  return da.getFullYear() === b.getFullYear() && da.getMonth() === b.getMonth() && da.getDate() === b.getDate() && da.getHours() === b.getHours() && da.getMinutes() === b.getMinutes();
};

// Fire a scheduled task = start a FRESH run (a schedule RE-RUNS its task).
// Never resume the prior CLI session: a recurring cron must open a new run
// each tick, not 继续 yesterday's conversation — interruption-recovery (resume) is
// the manual run/retry/group path's job, and "continue at a future time" is what
// scheduledMessages (定时发消息 → continueTask) is for. (See the bug where a daily
// cron kept appending 〔系统〕继续 into the same session instead of running anew.)
// 返回**这一班有没有真的开跑**：跳过(任务在跑/归档/组暂停/验收中)一律 false——
// 调用方只在 true 时才消费班次(写 lastRunAt、once 禁用)。先记账后开火的老顺序会把
// 被跳过的班永久记作已跑:once 被消费、cron 同一分钟 sameMinute 拦住不再试(审查实测:
// 验收锁内 fire,班次静默丢失)。
async function fire(taskId: string): Promise<boolean> {
  const t = (await db.select().from(tasks).where(eq(tasks.id, taskId))).at(0);
  if (!t || t.status === "running" || t.status === "queued") return false;
  // Archived = frozen: a schedule never fires an archived task. We skip here
  // rather than disabling the schedule, so unarchiving restores it automatically.
  if (t.archived) return false;
  // 接力出去的任务同理:跳过而不消费班次,用户移除接力标记后定时自动恢复。
  if (handoffBlockReason(t.handoff)) return false;
  if (await preparePendingCheckpointStart(taskId)) return false;
  // Respect a paused group: a pause means "halt this group", so the scheduler
  // must not sneak a group member past it. The task fires on the next due tick
  // once the group is resumed.
  // 派它的那条（往上整条链）按了「全部停下」同理（task-hold.ts）。
  if (await taskHoldOf(t)) return false;
  // 原子占位后启动:只读预检查在任何 await 之后都可能过期,占到才算这一班真的开跑
  // (审查实测:验收/turn 窗口里 once 被永久消费)。占位后再查验收锁与停着(admitClaimedFire);
  // 退避不消费班次,下个 tick 再试。duet 走同一把锁:它原来在占位之前就 fire-and-forget 并返回
  // true,于是验收锁里的 duet 一步没跑、once 班次却被永久消费(审查实测)。
  const turn = claimOwnTurn(taskId, t.mode === "duet" ? "duet" : "single");
  if (!turn) return false;
  // 占到之后、交给 seatThenStart 之前这一段,锁归本函数管:不放行的每个出口 —— 退避,或者读库/
  // 写库抛错 —— 都在这里还掉。tick 会吞掉异常,漏还一次,任务就永远「回合正在进行」,自动和
  // 手动都起不来(第 3 轮审查 F1)。抛错同样不消费班次,下个 tick 重试。
  // 放行之前这一班的责任在班次上:这期间按停只撤回、不记欠账(markShiftAdmission,dispatch-hold-owed.ts)。
  const admitting = markShiftAdmission(taskId);
  let admitted = false;
  try {
    admitted = await admitClaimedFire(taskId);
  } finally {
    admitting();
    if (!admitted) releaseTurn(taskId, turn);
  }
  if (!admitted) return false;
  // 队列执行认领(queue-seat.ts):排在后面的任务到了定时启动时间,也得等前项结束 ——
  // 到点启动与手动运行/消息补投/队列推进争同一个占位,否则 fire 只占任务级回合锁、
  // 按自己的状态放行,同队前项还在跑就开了第二个(第 8 轮审查拦验收 1:once 到点
  // 双跑,且班次被消费)。被挡同样不消费班次:once 保持 enabled、不写 lastRunAt,
  // 前项结束后的下一个 tick 再试。seatThenStart 会给启动挂收尾,起跑失败按守卫回滚占位。
  const started = await seatThenStart(taskId, turn, () =>
    t.mode === "duet" ? runDuet(taskId, { turnHeld: turn }) : runTask(taskId, { origin: "auto", turnHeld: turn }));
  if (!started.ok) {
    return false;
  }
  return true;
}

/** 已占位的这一班能不能开跑。不改锁:锁由调用方按结果还。 */
async function admitClaimedFire(taskId: string): Promise<boolean> {
  // 占位后再查验收锁——与验收侧 beginAccepting→isTurnClaimed 互为镜像,任意交错至少一方退避。
  if (isAcceptingTask(taskId)) return false;
  // 占到之后按持久事实再认一次:入口那次 taskHoldOf 是一层层 await 往上读的,读到一半别处按了
  // 「全部停下」(或分组暂停),入口拿到的就是旧答案,而停的那一下清点时它还没占位、无从拦起
  // (第 2 轮审查 F1);占位之后才按的停留下的是撤回标记,这里一并消费。认出来就退避、不消费班次 ——
  // 这一班自己就是起跑的责任,放开之后下一个 tick 照常开新的一轮(停的那一下没给它记欠账)。
  // 放行之后才落下的停由 runTask 末端那道闸接住(origin auto):班次照常消费,只剩欠账这一份。
  return !(await turnFreezeReason(taskId, true));
}

export async function tick() {
  const now = new Date();
  const rows = await db.select().from(schedules).where(eq(schedules.enabled, true));
  for (const s of rows) {
    try {
      // 先问 fire 能不能跑、真跑了才记账:fire 决定与写 lastRunAt 之间没有 await 间隙,
      // 同一分钟 double-fire 的旧防线不受影响;被跳过的班次不消费,下个 tick 重试。
      if (s.kind === "once") {
        if (s.at && new Date(s.at) <= now && !s.lastRunAt && await fire(s.taskId)) {
          await db.update(schedules).set({ lastRunAt: now.toISOString(), enabled: false }).where(eq(schedules.id, s.id));
        }
      } else if (s.kind === "cron" && s.cron && cronMatches(s.cron, now)) {
        // guard against double-fire within the same minute (tick runs more often)
        if (s.lastRunAt && sameMinute(s.lastRunAt, now)) continue;
        if (await fire(s.taskId)) {
          await db.update(schedules).set({ lastRunAt: now.toISOString() }).where(eq(schedules.id, s.id));
        }
      }
    } catch {
      /* keep ticking */
    }
  }

  // ── 占着不动的回合锁:只报告 ──────────────────────────────────────────────
  // 这种锁会让队列占位的两个兜底双双让位(两边都以 isTurnClaimed 开头),任务永久停在
  // queued,于是投递判定永远是「等它空下来」—— 2026-10-26 那次卡死的下游一环。
  //
  // **这里不自动放开。** 判据证不了原持有者已经结束(duet 的人工裁决门、dispatch 的
  // 仓库锁等待都是活着的反例),拔错一把 = 同一个任务两个回合并跑。所以照 AGENTS.md
  // 对这类不可逆又外溢操作的口径办:如实上报 + 给用户一个他自己按的开关。理由、判据与
  // 那个开关都在 turn-lock-reclaim.ts。
  try {
    await reportSuspectTurns();
    // 收尾卡住的那一档:同样只报告,出路是重启(turn-wind-down.ts)。
    await reportStuckWindDowns();
  } catch (error) {
    console.error("[navi] 回合占位巡检这一趟出错:", error);
  }

  // ── 待发送消息(定时发送 + 排队追问)──────────────────────────────────────
  // 上面的 once/cron 循环是把任务**重跑一遍**(新 session);这里是把一句话送进
  // 任务原来那个会话(continueTask)。判定与投递单点在 pending-messages.ts ——
  // 排队消息的正常触发源是任务落终态时的钩子,这里是定时消息的到期路径兼兜底。
  await deliverPendingMessages();
  await replayQueueAdvances();
  // 等过哨兵、放开了却没人推的队列成员:事件那一路漏掉时由这里接住(queue-monitor-hold.ts)。
  await sweepReleasedQueueMembers().catch((error) => console.error("[navi] 欠着的队列推进巡检出错:", error));
  // 按了「全部停下」、中途出错没停完的:接着停完(dispatch-hold.ts)。排在兑现欠账之前,停完记下的账同一趟就能兑现。
  await sweepPendingHolds().catch((error) => console.error("[navi] 没停完的「全部停下」巡检出错:", error));
  await sweepOwedStarts().catch((error) => console.error("[navi] 欠着的起跑巡检出错:", error));
}

// Catch-up on startup: missed one-shots (at < now, never fired) fire once via the
// normal tick. Missed cron runs are NOT backfilled — only the next match fires
// (recurring only runs the most recent, no pile-up).
export function startScheduler(intervalMs = 30_000) {
  // 先回收上一个进程留下的投递租约,再跑第一次 tick:被重启掐在「已认领、还没送到」
  // 当口的排队/定时消息,靠这两步在开机后立刻补发出去(见 pending-messages.ts 的租约一节)。
  // 中间那一步把旧版落下的、其实是续聊的执行型答复认回来(legacy-answer-intent.ts),
  // 第一次 tick 就按续聊送出去,不再等整条队列。
  void reclaimStaleDeliveries()
    .catch((err) => console.error("[navi] reclaimStaleDeliveries failed:", err))
    .then(() => restoreFollowUpAnswers())
    .catch((err) => console.error("[navi] restoreFollowUpAnswers failed:", err))
    .then(() => tick());
  setInterval(() => void tick(), intervalMs);
  console.log(SCHEDULER_STARTED);
}
