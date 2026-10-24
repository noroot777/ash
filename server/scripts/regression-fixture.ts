import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { db, inTurnCaller, makeTask, monitors, projects, root, runs, startMonitor, tasks, until } from "./monitors-fixture.js";
import type { RegressionRecord } from "../src/regression-checks.js";

export type EvidenceManifest = {
  protocol: number;
  generatedAt: string;
  records: Array<RegressionRecord & { reusable: boolean; passed: boolean | null; latest: boolean; supersededBy: string | null; reason: string }>;
};

export async function setupRegression() {
  const repo = join(root, "repo");
  mkdirSync(repo);
  const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();
  git("init", "-b", "main");
  git("config", "user.name", "Regression Test");
  git("config", "user.email", "regression@example.test");
  writeFileSync(join(repo, "code.txt"), "bad");
  writeFileSync(join(repo, ".gitignore"), "*.local\nnode_modules/\ndist/\n");
  git("add", ".");
  git("commit", "-m", "base");
  const taskId = await makeTask();
  await db.update(tasks).set({ useWorktree: false, workflowMode: "free" }).where(eq(tasks.id, taskId));
  const task = (await db.select().from(tasks).where(eq(tasks.id, taskId)))[0]!;
  await db.update(projects).set({ repoPath: repo }).where(eq(projects.id, task.projectId));
  assert.equal(runs.claimTurn(taskId, "single"), true);
  const caller = await inTurnCaller(taskId);
  const evidenceDir = join(root, "runs", taskId, "review", "round-1");
  const manifest = (directory = evidenceDir) => JSON.parse(readFileSync(join(directory, "regression-evidence.json"), "utf8")) as EvidenceManifest;
  const start = async (command: string) => {
    const result = await startMonitor({ taskId, command, cwd: repo, regression: true, caller, timeoutMs: 30_000 });
    assert.equal(result.ok, true, JSON.stringify(result));
    if (!result.ok) throw new Error(result.error);
    return result.monitor.id;
  };
  const wait = async (monitorId: string) => until("回归完成", async () =>
    (await db.select().from(monitors).where(eq(monitors.id, monitorId)))[0]?.status === "exited");
  const run = async (command: string) => {
    const monitorId = await start(command);
    await wait(monitorId);
    return monitorId;
  };
  return { taskId, task, repo, git, evidenceDir, manifest, start, wait, run };
}
