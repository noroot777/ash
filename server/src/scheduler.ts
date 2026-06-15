import { eq } from "drizzle-orm";
import { db } from "./db/index.js";
import { tasks, groups } from "./db/schema.js";
import { bus } from "./bus.js";
import { now } from "./util.js";
import { runTask } from "./orchestrator.js";

const MAX_PARALLEL = 4;

type Node = { id: string; dependsOn: string[]; createdAt: string };

async function setQueued(taskId: string) {
  await db.update(tasks).set({ status: "queued", updatedAt: now() }).where(eq(tasks.id, taskId));
  bus.publish({ type: "task.status", taskId, status: "queued" });
}

async function succeeded(taskId: string): Promise<boolean> {
  const r = (await db.select().from(tasks).where(eq(tasks.id, taskId))).at(0);
  return r?.status === "done";
}

// Run every task in a group honoring its mode (parallel/serial) and per-task
// dependsOn edges. The scheduler only queues + sequences; runTask does the work
// and owns running/done/failed status (DESIGN.md §1/§3/§6 — same path as manual).
export async function runGroup(groupId: string): Promise<void> {
  const group = (await db.select().from(groups).where(eq(groups.id, groupId))).at(0);
  if (!group) throw new Error("group not found");

  const rows = (await db.select().from(tasks).where(eq(tasks.groupId, groupId))).filter(
    (t) => t.status !== "running",
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
    for (const n of ordered) await runTask(n.id);
    return;
  }

  // parallel: launch tasks whose in-group deps are resolved; cap concurrency.
  const resolved = new Set<string>();
  const pending = new Map(nodes.map((n) => [n.id, n]));
  const inflight = new Map<string, Promise<void>>();
  const ready = (n: Node) => n.dependsOn.every((d) => !ids.has(d) || resolved.has(d));

  const launch = (n: Node) => {
    pending.delete(n.id);
    const p = runTask(n.id)
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
    if (inflight.size) await Promise.race(inflight.values());
  }
}
