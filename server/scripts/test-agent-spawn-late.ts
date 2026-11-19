// 「末尾还有任务排着没起跑」时收尾，不许起机器上真的 CLI —— 走真实的起跑链路钉一遍。
//
// 这类端到端脚本把假 claude 排在 PATH 最前，收尾时把 PATH 还原。起跑是异步的：还原之后才轮到的
// 那一条，解析到的就是机器上真装着的 claude（2026-11-18 test-dispatch-suggestion 这样漏出 4 个
// PPID=1 的真 `claude -p`）。这里照那个顺序做一遍：PATH 先还原、放行还开着、任务这时才起跑。
// 「机器上真的 claude」由一个只留记号的替身充当，排在假目录后面。
// 底层那道闸自己的判据在 test-agent-spawn-guard.ts。
// Run: npm -w server run test:agent-spawn-guard
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { releaseTmpDb } from "./tmp-db.js";
import { installFakeClaude, settleFakeClaudes } from "./scheduled-messages-fixture.js";

const root = mkdtempSync(join(tmpdir(), "navi-agent-spawn-late-"));
const leadLog = join(root, "lead-input.jsonl");
const IS_WINDOWS = process.platform === "win32";
process.env.NAVI_DB = join(root, "ash.db");
process.env.NAVI_RUNS_DIR = join(root, "runs");
process.env.NAVI_LAX_DONE = "1"; // 验的是起没起，不是完成协议
process.env.NAVI_TEST_LEAD_LOG = leadLog;
delete process.env.NAVI_ALLOW_REAL_AGENT;

// 机器上那份的替身：一跑就留下记号。它所在的目录算进「原来的 PATH」。
const host = join(root, "host-bin");
const hostRan = join(root, "host-claude.ran");
mkdirSync(host);
writeFileSync(
  join(host, IS_WINDOWS ? "claude.cmd" : "claude"),
  IS_WINDOWS ? `@echo ran> "${hostRan}"\r\n` : `#!/bin/sh\necho ran > "${hostRan}"\n`,
  { mode: 0o755 },
);
const originalPath = `${host}${delimiter}${process.env.PATH ?? ""}`;
const fakeBin = installFakeClaude(root);
process.env.PATH = `${fakeBin}${delimiter}${originalPath}`;
process.env.NAVI_TEST_AGENT_BIN = fakeBin;

const [{ db, ensureSchema }, schema, runs, runRoutes] = await Promise.all([
  import("../src/db/index.js"),
  import("../src/db/schema.js"),
  import("../src/runs.js"),
  import("../src/task-run-routes.js"),
]);
const { projects, tasks } = schema;
await ensureSchema();
const api = new Hono();
runRoutes.mountTaskRunRoutes(api);

const at = new Date(Date.now() - 60_000).toISOString();
const projectId = "agent-spawn-late-project";
const row = (id: string, body: string): typeof tasks.$inferInsert => ({
  id, projectId, groupId: null, parentId: null, title: `任务 ${id}`, body, mode: "single", status: "backlog",
  labels: "[]", dependsOn: "[]", resumeDependsOn: "[]", agentType: "claude", executorId: null, autoTitle: false,
  duet: null, team: null, scheduleId: null, createdAt: at, updatedAt: at, useWorktree: false, worktreeBase: null,
  originTaskId: null,
});
const waitFor = async (predicate: () => boolean | Promise<boolean>, message: string) => {
  const deadline = Date.now() + 15_000;
  while (!(await predicate())) {
    if (Date.now() >= deadline) throw new Error(message);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
};
const taskOf = async (id: string) => (await db.select().from(tasks).where(eq(tasks.id, id))).at(0)!;
const settled = async (id: string) => {
  const status = (await taskOf(id)).status;
  return status !== "backlog" && status !== "running" && status !== "queued" && !runs.isRunning(id) && !runs.isTurnClaimed(id);
};
const start = async (id: string) => {
  const response = await api.request(`/tasks/${id}/run`, { method: "POST" });
  assert.ok(response.status < 300, `${id} 起跑请求：${response.status} ${await response.text()}`);
};
const transcript = (id: string) => {
  const dir = join(root, "runs", id);
  return existsSync(dir)
    ? readdirSync(dir).filter((name) => name.endsWith(".md")).map((name) => readFileSync(join(dir, name), "utf8")).join("\n")
    : "";
};

const [EARLY, LATE] = ["spawn-early", "spawn-late"];
let failure: unknown = null;
try {
  await db.insert(projects).values({ id: projectId, name: "agent-spawn-late", repoPath: root, apiKeys: null, createdAt: at });
  await db.insert(tasks).values([row(EARLY, "先跑的那条(early-marker)"), row(LATE, "排着没起跑的那条(late-marker)")]);

  // —— 前提：假目录还在 PATH 最前时，同一条链路起的是假 claude。
  await start(EARLY);
  await waitFor(() => existsSync(leadLog) && readFileSync(leadLog, "utf8").includes("early-marker"), "假 claude 没有收到先跑那条的正文");
  await waitFor(() => settled(EARLY), "先跑的那条没有结算");
  assert.equal((await taskOf(EARLY)).status, "done");
  assert.ok(!existsSync(hostRan));
  console.log("✓ 前提：假目录在 PATH 最前，真实起跑链路起的是假 claude");

  // —— 收尾先还原了 PATH，排着的那条这时才起跑。
  process.env.PATH = originalPath;
  await start(LATE);
  await waitFor(() => settled(LATE), "晚到的那条没有结算");
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.ok(!existsSync(hostRan), "PATH 还原后晚到的起跑把机器上那份 claude 起起来了");
  assert.ok(!readFileSync(leadLog, "utf8").includes("late-marker"), "晚到的那条正文不该送进任何 CLI");
  assert.equal((await taskOf(LATE)).status, "failed");
  assert.match(transcript(LATE), /测试隔离环境禁止启动真执行器/, "那一条的会话里写明是被隔离闸拦下的");
  console.log("✓ PATH 还原之后才起跑的任务：机器上那份 claude 一次没起，任务如实记失败");
} catch (error) {
  failure = error;
  console.error(error);
} finally {
  for (const id of [EARLY, LATE]) if (runs.isRunning(id)) runs.stopTask(id);
  await settleFakeClaudes(root);
  await releaseTmpDb();
  rmSync(root, { recursive: true, force: true });
  process.exit(failure ? 1 : 0);
}
