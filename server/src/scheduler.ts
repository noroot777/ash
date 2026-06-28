import { eq, asc, inArray } from "drizzle-orm";
import type { TaskStatus } from "@harness/shared";
import { db } from "./db/index.js";
import { tasks, groups, queueItems } from "./db/schema.js";
import { setTaskStatus } from "./status.js";
import { resumeOrRunTask } from "./orchestrator.js";

const MAX_PARALLEL = 4;

async function setQueued(taskId: string) {
  await setTaskStatus(taskId, "queued");
}

// Re-read the live paused flag each tick (the pause endpoint flips it mid-run).
async function isPaused(groupId: string): Promise<boolean> {
  const g = (await db.select().from(groups).where(eq(groups.id, groupId))).at(0);
  return !!g?.paused;
}

// Park tasks that were queued-but-never-started back to backlog so a paused
// group shows them parked (not stuck "queued") and a restart won't reap them.
async function parkQueued(groupId: string): Promise<void> {
  const waiting = (await db.select().from(tasks).where(eq(tasks.groupId, groupId))).filter(
    (t) => t.status === "queued",
  );
  for (const t of waiting) await setTaskStatus(t.id, "backlog");
}

// 终态钩子：任务进 done / canceled 时,如果它在某个 queue 里,推进那个 queue。
// failed / awaiting_review 不触发——链停在这里等用户处理(DESIGN §3)。
// status.ts 在写完终态后会动态 import 调过来;保持纯函数,不依赖 status.ts。
export async function advanceQueueFromTask(taskId: string): Promise<void> {
  const item = (
    await db.select().from(queueItems).where(eq(queueItems.taskId, taskId))
  ).at(0);
  if (!item) return; // 不在任何 queue 里(独立任务 / parallel group)
  // 队列绑定到 group:如果 group 被 paused 就不推进
  const t = (await db.select().from(tasks).where(eq(tasks.id, taskId))).at(0);
  if (t?.groupId) {
    const g = (await db.select().from(groups).where(eq(groups.id, t.groupId))).at(0);
    if (g?.paused) return;
  }
  await advanceQueue(item.queueId);
}

// 队列推进的唯一规则(DESIGN §3)。
// 沿 position 升序找 head:
//   - done / canceled → 透明跳过,继续找
//   - failed / awaiting_review → 停,链停在这里等用户
//   - running / queued → 等已在跑的那个跑完
//   - backlog → 拉起新 agent
//   - paused → 用 resumePrompt 续跑(resumeOrRunTask 内部按 status 分流)
// 每次推进只启动 head 一项;它跑完触发 advanceQueueFromTask 再推下一个。
export async function advanceQueue(queueId: string): Promise<void> {
  const next = await pickNextLaunchable(queueId);
  if (!next) return;
  await setQueued(next.id);
  void resumeOrRunTask(next.id, { reason: "queue" });
}

// 给定 queue,挑出"现在应该被拉起来的下一个 task"(或 null = 没有)。
// 纯函数(只读 DB,不变状态),便于测试 + 给 UI 用来高亮"下一个会跑的"。
export async function pickNextLaunchable(queueId: string): Promise<typeof tasks.$inferSelect | null> {
  const items = await db
    .select()
    .from(queueItems)
    .where(eq(queueItems.queueId, queueId))
    .orderBy(asc(queueItems.position));

  for (const item of items) {
    const t = (await db.select().from(tasks).where(eq(tasks.id, item.taskId))).at(0);
    if (!t) continue;
    if (t.archived) continue;
    const s = t.status as TaskStatus;
    if (s === "done" || s === "canceled") continue;
    if (s === "failed" || s === "awaiting_review") return null; // 链停
    if (s === "running" || s === "queued") return null; // 已在跑
    return t; // backlog / paused
  }
  return null;
}

// Run an entire group. parallel mode:扫所有 backlog/paused,限流并行启动。
// serial mode:找该 group 关联的 queue,调用 advanceQueue 推进一次
// (后续推进靠 advanceQueueFromTask 终态钩子自动链式触发,不再 while-loop)。
// A paused group starts nothing;pausing mid-run 不会取消已在跑的,但不会启动新的。
export async function runGroup(groupId: string): Promise<void> {
  const group = (await db.select().from(groups).where(eq(groups.id, groupId))).at(0);
  if (!group) throw new Error("group not found");
  if (group.paused) return;

  if (group.mode === "serial") {
    // 找该 group 关联的 queue(通过任一 task 反查 queue_items)
    const groupTasks = await db.select().from(tasks).where(eq(tasks.groupId, groupId));
    if (!groupTasks.length) return;
    const items = await db
      .select()
      .from(queueItems)
      .where(inArray(queueItems.taskId, groupTasks.map((t) => t.id)));
    const queueIds = [...new Set(items.map((i) => i.queueId))];
    if (queueIds.length === 0) {
      // 异常:serial group 却没 queue。可能是 group 后来才被设成 serial、
      // 或者迁移漏了。退化按 parallel 跑(用户至少能看见任务在动)。
      console.warn(`[scheduler] serial group ${groupId} 没有 queue,退化按 parallel 启动`);
      return runParallel(groupId);
    }
    if (queueIds.length > 1) {
      // 违反不变量:同 group 多 queue。打 warn,仍尝试推进每个 queue。
      console.error(`[scheduler] group ${groupId} 关联到多个 queue: ${queueIds.join(",")}`);
    }
    for (const qid of queueIds) await advanceQueue(qid);
    return;
  }

  // parallel
  await runParallel(groupId);
}

// parallel mode 的执行:扫所有 backlog/paused 任务并行启动,限流 MAX_PARALLEL。
// canceled / failed 不在这里被批量唤起 —— 那是 P0d-fY_Zi4RC 那个事故的根因
// (DESIGN §0 #3)。用户想重跑某条 canceled / failed task 应在单条上点 Run。
async function runParallel(groupId: string): Promise<void> {
  const groupRows = await db.select().from(tasks).where(eq(tasks.groupId, groupId));
  const launchable = groupRows.filter(
    (t) => !t.archived && (t.status === "backlog" || t.status === "paused"),
  );
  if (!launchable.length) return;

  const pending = [...launchable];
  const inflight = new Map<string, Promise<void>>();

  const launch = async (taskId: string): Promise<void> => {
    await setQueued(taskId);
    await resumeOrRunTask(taskId, { reason: "group" });
  };

  while (pending.length || inflight.size) {
    if (!(await isPaused(groupId))) {
      while (pending.length && inflight.size < MAX_PARALLEL) {
        const t = pending.shift()!;
        const p = launch(t.id).finally(() => inflight.delete(t.id));
        inflight.set(t.id, p);
      }
    }
    if (inflight.size) await Promise.race(inflight.values());
    else break;
  }
  await parkQueued(groupId);
}
