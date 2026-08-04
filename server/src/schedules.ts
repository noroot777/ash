import { eq } from "drizzle-orm";
import type { AgentType } from "@harness/shared";
import { db } from "./db/index.js";
import { schedules, scheduledMessages, tasks, groups } from "./db/schema.js";
import { runTask, continueTask } from "./orchestrator.js";
import { runDebate } from "./debate/index.js";
import { appendTaskTimeline } from "./task-timeline.js";

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
  if (t.mode === "debate") void runDebate(taskId);
  else void runTask(taskId); // 全新一轮(新 session),不接续上次会话
}

type ScheduledMessageRow = typeof scheduledMessages.$inferSelect;

async function cancelScheduledMessage(message: ScheduledMessageRow, reason: string): Promise<void> {
  await db
    .update(scheduledMessages)
    .set({ status: "canceled", sentAt: null })
    .where(eq(scheduledMessages.id, message.id));
  const note = `〔系统〕定时消息未发送，已取消（原定 ${message.sendAt}）：${reason}`;
  if (!await appendTaskTimeline(message.taskId, note)) {
    console.warn(`[harness] ${note} task=${message.taskId} message=${message.id}`);
  }
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

  // ── Due scheduled messages (定时发消息；独立于 schedules 表) ─────────────────
  // The once/cron loop above re-RUNS a task FRESH (new session); these DELIVER a
  // queued reply via continueTask (resume the existing session). Single tasks wait
  // until idle; resident team leads accept the message whether idle or running.
  // Mark sent before firing so an overlapping tick won't re-pick it.
  const due = (await db.select().from(scheduledMessages).where(eq(scheduledMessages.status, "pending")))
    .filter((m) => new Date(m.sendAt) <= now);
  const firedTasks = new Set<string>(); // at most one delivery per task per tick
  for (const m of due) {
    try {
      if (firedTasks.has(m.taskId)) continue;
      const t = (await db.select().from(tasks).where(eq(tasks.id, m.taskId))).at(0);
      if (!t) {
        await cancelScheduledMessage(m, "任务不存在");
        continue;
      }
      if (t.archived) {
        await cancelScheduledMessage(m, "任务已归档");
        continue;
      }
      if (t.mode !== "single" && t.mode !== "team") {
        await cancelScheduledMessage(m, `任务类型 ${t.mode} 不支持回复`);
        continue;
      }
      if (t.mode === "single" && (t.status === "running" || t.status === "queued")) continue;
      firedTasks.add(m.taskId);
      await db.update(scheduledMessages).set({ status: "sent", sentAt: now.toISOString() }).where(eq(scheduledMessages.id, m.id));
      const options = {
        attachments: JSON.parse(m.attachments) as string[],
        agent: (m.agent as AgentType) ?? undefined,
        // 定时发送要跑的还是用户排程时选的那一套执行器/模型/思考强度（没选就是 null=按默认解析）。
        executorId: m.executorId ?? null,
        model: m.model ?? null,
        reasoningEffort: m.reasoningEffort ?? null,
      };
      if (t.mode === "team") {
        try {
          await continueTask(m.taskId, m.text, { ...options, throwOnTeamUnavailable: true });
        } catch (reason) {
          const detail = reason instanceof Error ? reason.message : String(reason);
          await cancelScheduledMessage(m, `调度台不可用：${detail}`);
        }
      } else {
        void continueTask(m.taskId, m.text, options);
      }
    } catch {
      /* keep ticking */
    }
  }
}

// Catch-up on startup: missed one-shots (at < now, never fired) fire once via the
// normal tick. Missed cron runs are NOT backfilled — only the next match fires
// (DESIGN.md §9: recurring only runs the most recent, no pile-up).
export function startScheduler(intervalMs = 30_000) {
  void tick();
  setInterval(() => void tick(), intervalMs);
  console.log("[harness] scheduler started");
}
