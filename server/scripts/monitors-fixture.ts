// 哨兵回归的共用台子：一份临时库、真模块、几个小工具。
//
// 为什么单独一份：哨兵的回归已经分成两份——「这个功能本身对不对」(test-monitors.ts)
// 和「终态与投递抢同一条命的那几个窗口」(test-monitor-races.ts)。台子只能有一份，
// 两边各抄一遍迟早漂移（漂的那一刻两份测试对「任务一开始是什么状态」的理解就分家了）。
//
// **导入它就等于把台子搭起来**：`ASH_DB` / `ASH_RUNS_DIR` 在模块顶层就落定，所以它必须
// 排在任何 `src/` 模块之前被导入——下面那串动态 import 就是为此。
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { and, eq } from "drizzle-orm";
import { requireTmpDb, releaseTmpDb } from "./tmp-db.js";

export const HERE = dirname(fileURLToPath(import.meta.url));
export const root = mkdtempSync(join(tmpdir(), "ash-monitors-"));
process.env.ASH_DB = join(root, "ash.db");
process.env.ASH_RUNS_DIR = join(root, "runs");
requireTmpDb("monitors");

export const [
  { db, ensureSchema }, schema, monitorsModule, status, { isPidAlive }, pending, { continueTask }, runs, taskRoutes,
] = await Promise.all([
  import("../src/db/index.js"),
  import("../src/db/schema.js"),
  import("../src/monitors.js"),
  import("../src/status.js"),
  import("../src/platform.js"),
  import("../src/pending-messages.js"),
  import("../src/orchestrator.js"),
  import("../src/runs.js"),
  import("../src/task-routes.js"),
]);
export const { mountTaskRoutes } = taskRoutes;
export const { startMonitor, stopMonitor, listMonitors, getMonitor, readMonitorTail, reattachMonitors, detachAllMonitors } =
  monitorsModule;
export const { monitors, projects, scheduledMessages, tasks } = schema;

await ensureSchema();

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
export async function until(label: string, probe: () => Promise<boolean>, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await probe()) return;
    await sleep(100);
  }
  throw new Error(`等不到：${label}`);
}

export const now = () => new Date().toISOString();
let seq = 0;
/** 给同一个任务里要手写 id 的那几行用（真人排的那条消息），保证不撞。 */
export const uniq = (prefix: string) => `${prefix}-${seq}-${Date.now()}`;

export async function makeTask(): Promise<string> {
  const projectId = `proj-${++seq}`;
  const taskId = `task-${seq}`;
  await db.insert(projects).values({ id: projectId, name: "monitors", repoPath: root, createdAt: now() });
  await db.insert(tasks).values({
    // 刻意落 running：投递链路对「单飞任务正在跑」的判定是**等**，于是事件只排队、
    // 不会真去 spawn 一个 agent。这正是这两份测试都要观察的那个现场（忙的时候攒事件）。
    id: taskId, projectId, title: `t${seq}`, body: "", status: "running",
    agentType: "claude", mode: "single", createdAt: now(), updatedAt: now(),
  });
  return taskId;
}

export const pendingOf = (taskId: string) =>
  db.select().from(scheduledMessages).where(and(eq(scheduledMessages.taskId, taskId), eq(scheduledMessages.status, "pending")));

/** 收尾：哨兵全撒手（不杀——它们本来就该活过 ash）、放锁、删临时目录。 */
export async function teardown(): Promise<void> {
  detachAllMonitors();
  await releaseTmpDb();
  rmSync(root, { recursive: true, force: true });
}
