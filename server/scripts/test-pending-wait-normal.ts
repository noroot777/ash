// 排队消息等的是看得见的事就不算滞留（pending-messages 的 waitReason）：任务正在跑一轮长的，
// 排队消息等它跑完是排队本身。每条都报一句「还没发出去：任务正在运行」是把正常排队说成了故障
// （用户 2026-11-16 指出）。真卡住的那几种（任务停在排队中却没人在跑、任务不在了）仍要出声，
// 见 test-turn-reclaim.ts 的 ⑦。
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";

const root = mkdtempSync(join(tmpdir(), "navi-pending-wait-"));
process.env.NAVI_DB = join(root, "ash.db");
process.env.NAVI_RUNS_DIR = join(root, "runs");

const { ensureSchema, db, dbClient } = await import("../src/db/index.js");
const { projects, scheduledMessages } = await import("../src/db/schema.js");
const { createTasks } = await import("../src/task-store.js");
const { recentRejectionNotices } = await import("../src/user-action-rejection.js");
const { deliverPendingMessages } = await import("../src/pending-messages.js");

await ensureSchema();
const stamp = new Date().toISOString();
await db.insert(projects).values({
  id: "p1", name: "pending wait", repoPath: join(root, "repo"), apiKeys: null, workflowId: null, createdAt: stamp,
});
await createTasks([{
  id: "t-stall-running", title: "long turn", status: "running",
  projectId: "p1", groupId: null, parentId: null, body: "test", mode: "single",
  labels: "[]", dependsOn: "[]", resumeDependsOn: "[]", agentType: "codex",
  executorId: null, model: null, reasoningEffort: null, autoTitle: false,
  duet: null, team: null, reportBack: false, scheduleId: null,
  createdAt: stamp, updatedAt: stamp,
  useWorktree: false, worktreeBase: null, originTaskId: null, workflowMode: "free",
}] as never);
const longAgo = new Date(Date.now() - 45 * 60_000).toISOString();
await db.insert(scheduledMessages).values({
  id: "m-stall-running", taskId: "t-stall-running", text: "继续", mode: "queued", status: "pending",
  sendAt: longAgo, createdAt: longAgo, sentAt: null, deliveringSince: null,
  attachments: "[]", agent: null, executorId: null, model: null, reasoningEffort: null,
  origin: null, execution: false, sessionRole: null,
} as never);

await deliverPendingMessages("t-stall-running");
// 扫描以前不等诊断写完就返回（发出去不管）：留一段让那种写法也落得了盘，免得这里读早了把它当成没写。
await new Promise((resolve) => setTimeout(resolve, 500));
assert.deepEqual(await recentRejectionNotices("t-stall-running"), [],
  "任务在跑时排队消息等它这一轮结束是正常排队，不该写滞留诊断");
const [still] = await db.select().from(scheduledMessages).where(eq(scheduledMessages.id, "m-stall-running"));
assert.equal(still?.status, "pending", "消息仍在托盘里等着");

console.log("pending wait-normal regressions ok");
dbClient.close();
process.exit(0);
