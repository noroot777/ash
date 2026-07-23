import { eq } from "drizzle-orm";
import type { TaskStatus } from "@harness/shared";
import { db } from "./db/index.js";
import { tasks, sessions } from "./db/schema.js";
import { bus } from "./bus.js";
import { now, runsTiming } from "./util.js";

const TERMINAL: TaskStatus[] = ["done", "failed", "canceled"];

// Single source of truth for changing a task's status. Besides persisting the
// status it maintains the run-timing columns and broadcasts them, so every
// surface (single run, debate, scheduler, manual patch) keeps `startedAt` /
// `endedAt` consistent and the web can show start/end/duration live:
//   • → running  : stamp startedAt once (first run), clear endedAt.
//   • → terminal : stamp endedAt (run finished).
//   • → paused   : 跑到检查点（非终止），startedAt/endedAt 都不动；下次 resume
//                  会走 → running 路径自动清掉 endedAt。
//   • otherwise  : leave the timestamps untouched.
export async function setTaskStatus(taskId: string, status: TaskStatus): Promise<void> {
  const cur = (await db.select().from(tasks).where(eq(tasks.id, taskId))).at(0);
  let startedAt = cur?.startedAt ?? null;
  let endedAt = cur?.endedAt ?? null;
  const patch: Record<string, unknown> = { status, updatedAt: now() };

  if (status === "running") {
    if (!startedAt) patch.startedAt = startedAt = now();
    patch.endedAt = endedAt = null;
  } else if (TERMINAL.includes(status)) {
    patch.endedAt = endedAt = now();
  }

  await db.update(tasks).set(patch).where(eq(tasks.id, taskId));
  // Carry execution-time fields so every surface updates live with the status —
  // notably the terminal transition, where every turn now has ended_at so
  // activeMs is final and liveSince clears. When no session rows exist yet (status
  // flips to running just before the row is recorded) omit them, so the client
  // keeps its last fetched value rather than seeing a transient null.
  const runs = await db
    .select({ activeMs: sessions.activeMs, turnStartedAt: sessions.turnStartedAt, endedAt: sessions.endedAt })
    .from(sessions)
    .where(eq(sessions.taskId, taskId));
  const timing = runs.length ? runsTiming(runs) : {};
  bus.publish({ type: "task.status", taskId, status, startedAt, endedAt, ...timing });

  // 队列推进钩子(DESIGN §3):任务进 done / canceled / failed / paused 时,
  // 如果它在某个 queue 里,触发那个 queue 的下一位推进。
  // - done / canceled / failed = 透明,head 让位(failed 留在原地等用户处理,
  //   但不挡后面的——一个环节挂了不拖整条流水线)
  // - paused = 让上游(若也 paused)知道"我已经到位等续跑了",但只有当我
  //   恰好是 head 的时候 advance 才会启动我;否则我继续静静等
  // awaiting_review 不触发——审查门是明确的"等人"语义。
  // 动态 import scheduler 以避免和 scheduler → status 的循环。
  if (status === "done" || status === "canceled" || status === "failed" || status === "paused") {
    void import("./scheduler.js").then(({ advanceQueueFromTask }) =>
      advanceQueueFromTask(taskId).catch((err) =>
        console.error(`[harness] advanceQueueFromTask(${taskId}) failed:`, err),
      ),
    );
  }
}
