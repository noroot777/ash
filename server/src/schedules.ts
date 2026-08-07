import { eq } from "drizzle-orm";
import { db } from "./db/index.js";
import { schedules, tasks, groups } from "./db/schema.js";
import { runTask } from "./orchestrator.js";
import { runDuet } from "./duet/index.js";
import { deliverPendingMessages, reclaimStaleDeliveries } from "./pending-messages.js";

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

// Fire a scheduled task = start a FRESH run (DESIGN.md §9: a schedule RE-RUNS its
// task). Never resume the prior CLI session: a recurring cron must open a new run
// each tick, not 继续 yesterday's conversation — interruption-recovery (resume) is
// the manual run/retry/group path's job, and "continue at a future time" is what
// scheduledMessages (定时发消息 → continueTask) is for. (See the bug where a daily
// cron kept appending 〔系统〕继续 into the same session instead of running anew.)
async function fire(taskId: string) {
  const t = (await db.select().from(tasks).where(eq(tasks.id, taskId))).at(0);
  if (!t || t.status === "running" || t.status === "queued") return;
  // Archived = frozen: a schedule never fires an archived task. We skip here
  // rather than disabling the schedule, so unarchiving restores it automatically.
  if (t.archived) return;
  // Respect a paused group: a pause means "halt this group", so the scheduler
  // must not sneak a group member past it. The task fires on the next due tick
  // once the group is resumed.
  if (t.groupId) {
    const g = (await db.select().from(groups).where(eq(groups.id, t.groupId))).at(0);
    if (g?.paused) return;
  }
  if (t.mode === "duet") void runDuet(taskId);
  else void runTask(taskId); // 全新一轮(新 session),不接续上次会话
}

export async function tick() {
  const now = new Date();
  const rows = await db.select().from(schedules).where(eq(schedules.enabled, true));
  for (const s of rows) {
    try {
      if (s.kind === "once") {
        if (s.at && new Date(s.at) <= now && !s.lastRunAt) {
          await db.update(schedules).set({ lastRunAt: now.toISOString(), enabled: false }).where(eq(schedules.id, s.id));
          await fire(s.taskId);
        }
      } else if (s.kind === "cron" && s.cron && cronMatches(s.cron, now)) {
        // guard against double-fire within the same minute (tick runs more often)
        if (s.lastRunAt && sameMinute(s.lastRunAt, now)) continue;
        await db.update(schedules).set({ lastRunAt: now.toISOString() }).where(eq(schedules.id, s.id));
        await fire(s.taskId);
      }
    } catch {
      /* keep ticking */
    }
  }

  // ── 待发送消息(定时发送 + 排队追问)──────────────────────────────────────
  // 上面的 once/cron 循环是把任务**重跑一遍**(新 session);这里是把一句话送进
  // 任务原来那个会话(continueTask)。判定与投递单点在 pending-messages.ts ——
  // 排队消息的正常触发源是任务落终态时的钩子,这里是定时消息的到期路径兼兜底。
  await deliverPendingMessages();
}

// Catch-up on startup: missed one-shots (at < now, never fired) fire once via the
// normal tick. Missed cron runs are NOT backfilled — only the next match fires
// (DESIGN.md §9: recurring only runs the most recent, no pile-up).
export function startScheduler(intervalMs = 30_000) {
  // 先回收上一个进程留下的投递租约,再跑第一次 tick:被重启掐在「已认领、还没送到」
  // 当口的排队/定时消息,靠这两步在开机后立刻补发出去(见 pending-messages.ts 的租约一节)。
  void reclaimStaleDeliveries()
    .catch((err) => console.error("[harness] reclaimStaleDeliveries failed:", err))
    .then(() => tick());
  setInterval(() => void tick(), intervalMs);
  console.log("[harness] scheduler started");
}
