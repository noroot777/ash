// 定时班次「这一班到了、还没跑」的判据，单点。两边问它：
//   · 调度 tick（schedules.ts）：到了、没跑才去 fire，真跑了才记账；
//   · 兑现「接着跑」欠账（dispatch-hold.ts honorOwedStart）：停的那一下可能正赶上到点启动已占位，
//     那一班退避、班次没消费，同时任务身上又记着一笔欠账 —— 正常情况下退避时会把欠账撤掉，可撤账
//     那一下写失败的话，两份持久责任都在，放开后各起一次（第 4 轮审查 F1：只跑一次的任务跑了两遍）。
//     所以兑现之前先对账：班次还欠着，就让给班次（它要的是新一轮），欠账撤掉。
import { and, eq } from "drizzle-orm";
import { db } from "./db/index.js";
import { schedules } from "./db/schema.js";

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

type ShiftRow = Pick<typeof schedules.$inferSelect, "kind" | "at" | "cron" | "lastRunAt">;

/** 这一班到了、还没跑。once：到点且从没跑过；cron：这一分钟匹配且这一分钟还没跑过（tick 比一分钟勤）。 */
export function shiftDue(s: ShiftRow, now: Date): boolean {
  if (s.kind === "once") return !!s.at && new Date(s.at) <= now && !s.lastRunAt;
  if (s.kind === "cron") return !!s.cron && cronMatches(s.cron, now) && !(s.lastRunAt && sameMinute(s.lastRunAt, now));
  return false;
}

/** 这条任务有没有一班到了还没跑的定时（启用着的）。 */
export async function scheduleOwesStart(taskId: string, now = new Date()): Promise<boolean> {
  const rows = await db.select().from(schedules).where(and(eq(schedules.taskId, taskId), eq(schedules.enabled, true)));
  return rows.some((s) => shiftDue(s, now));
}
