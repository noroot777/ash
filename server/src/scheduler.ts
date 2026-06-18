import { eq } from "drizzle-orm";
import { canStartTask } from "@harness/shared";
import type { TaskStatus } from "@harness/shared";
import { db } from "./db/index.js";
import { tasks, groups } from "./db/schema.js";
import { setTaskStatus } from "./status.js";
import { resumeOrRunTask } from "./orchestrator.js";

const MAX_PARALLEL = 4;

type Node = { id: string; dependsOn: string[]; createdAt: string };

async function setQueued(taskId: string) {
  await setTaskStatus(taskId, "queued");
}

// Re-read the live paused flag each tick (the pause endpoint flips it mid-run).
async function isPaused(groupId: string): Promise<boolean> {
  const g = (await db.select().from(groups).where(eq(groups.id, groupId))).at(0);
  return !!g?.paused;
}

// Park tasks that were queued-but-never-started back to backlog so a paused group
// shows them as parked (not stuck "queued") and a server restart won't reap them.
// Running tasks are left alone — pause only holds what hasn't begun.
async function parkQueued(groupId: string): Promise<void> {
  const waiting = (await db.select().from(tasks).where(eq(tasks.groupId, groupId))).filter(
    (t) => t.status === "queued",
  );
  for (const t of waiting) await setTaskStatus(t.id, "backlog");
}

async function succeeded(taskId: string): Promise<boolean> {
  const r = (await db.select().from(tasks).where(eq(tasks.id, taskId))).at(0);
  return r?.status === "done";
}

// Run every task in a group honoring its mode (parallel/serial) and per-task
// dependsOn edges. The scheduler only queues + sequences; runTask does the work
// and owns running/done/failed status (DESIGN.md §1/§3/§6 — same path as manual).
// A paused group starts nothing; pausing mid-run stops launching the not-yet-
// started tasks (the in-flight one finishes) and parks them back to backlog.
export async function runGroup(groupId: string): Promise<void> {
  const group = (await db.select().from(groups).where(eq(groups.id, groupId))).at(0);
  if (!group) throw new Error("group not found");
  if (group.paused) return; // 已暂停：不启动任何任务，等再次「运行」

  // Only (re)start settled tasks — skip running/queued/awaiting_review/done so a
  // group re-run doesn't re-run already-finished or in-flight tasks.
  const rows = (await db.select().from(tasks).where(eq(tasks.groupId, groupId))).filter(
    (t) => canStartTask(t.status as TaskStatus),
  );
  if (!rows.length) return;

  const nodes: Node[] = rows.map((r) => ({
    id: r.id,
    dependsOn: JSON.parse(r.dependsOn) as string[],
    createdAt: r.createdAt,
  }));
  const ids = new Set(nodes.map((n) => n.id));

  await Promise.all(nodes.map((n) => setQueued(n.id)));

  if (group.mode === "serial") {
    const ordered = [...nodes].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    for (const n of ordered) {
      if (await isPaused(groupId)) break; // 暂停：剩下未开始的不再启动
      await resumeOrRunTask(n.id, { reason: "group" });
    }
    await parkQueued(groupId); // 暂停时把没轮到的那些归位为 backlog
    return;
  }

  // parallel: launch tasks whose in-group deps are resolved; cap concurrency.
  const resolved = new Set<string>();
  const pending = new Map(nodes.map((n) => [n.id, n]));
  const inflight = new Map<string, Promise<void>>();
  const ready = (n: Node) => n.dependsOn.every((d) => !ids.has(d) || resolved.has(d));

  const launch = (n: Node) => {
    pending.delete(n.id);
    const p = resumeOrRunTask(n.id, { reason: "group" })
      .then(async () => {
        await succeeded(n.id); // status already persisted by runTask
      })
      .finally(() => {
        resolved.add(n.id);
        inflight.delete(n.id);
      });
    inflight.set(n.id, p);
  };

  while (pending.size || inflight.size) {
    if (!(await isPaused(groupId))) {
      for (const n of [...pending.values()]) {
        if (inflight.size >= MAX_PARALLEL) break;
        if (ready(n)) launch(n);
      }
      // Deadlock guard: nothing in flight but tasks remain (unresolved/cyclic deps).
      if (inflight.size === 0 && pending.size) {
        for (const n of [...pending.values()]) {
          if (inflight.size >= MAX_PARALLEL) break;
          launch(n);
        }
      }
    }
    if (inflight.size) await Promise.race(inflight.values());
    else break; // 暂停且无在跑任务（或确实无可跑）→ 退出
  }
  await parkQueued(groupId); // 暂停时被挂起的 pending → backlog
}
