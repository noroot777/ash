// test-prerequisites*.ts 共用的台子：临时库、临时 git 仓库、装在 PATH 上的假 claude、几样小工具。
//
// **必须是测试文件的第一个 import**：环境变量要在任何 src 模块加载之前设好（db 一加载就按 ASH_DB 开库）。
// 执行器是装在 PATH 上的假 claude：收到输入就记一行，等用例放行那个任务再以成功退出（ASH_LAX_DONE 下即 done）。
// git 夹具在临时目录里，进程里所有 GIT_* 环境变量先清掉，免得漏进夹具改到别的仓库。
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { makeStep } from "@ash/shared/workflow";
import { IS_WINDOWS } from "../src/platform.js";
import { releaseTmpDb } from "./tmp-db.js";

for (const key of Object.keys(process.env)) if (key.startsWith("GIT_")) delete process.env[key];
export const root = mkdtempSync(join(tmpdir(), "ash-prerequisites-"));
const inputLog = join(root, "inputs.jsonl");
const releaseDir = join(root, "release");
mkdirSync(releaseDir, { recursive: true });
process.env.ASH_DB = join(root, "ash.db");
process.env.ASH_RUNS_DIR = join(root, "runs");
process.env.ASH_ALLOW_REAL_AGENT = "1"; // 跑的是下面这个假 claude
process.env.ASH_LAX_DONE = "1";
process.env.ASH_TEST_INPUT_LOG = inputLog;
process.env.ASH_TEST_RELEASE_DIR = releaseDir;

const bin = join(root, "bin");
mkdirSync(bin, { recursive: true });
writeFileSync(join(bin, "fake-claude.js"), `const fs = require("fs");
const path = require("path");
const task = String(process.env.ASH_TASK_ID);
const resident = process.argv.includes("--input-format");
let buf = "";
let started = false;
function start(input) {
  fs.appendFileSync(process.env.ASH_TEST_INPUT_LOG, JSON.stringify({ task, input }) + "\\n");
  if (started) return;
  started = true;
  process.stdout.write(JSON.stringify({ type: "system", session_id: "prereq-" + task }) + "\\n");
  const timer = setInterval(() => {
    if (!fs.existsSync(path.join(process.env.ASH_TEST_RELEASE_DIR, task))) return;
    clearInterval(timer);
    process.stdout.write(JSON.stringify({ type: "result", subtype: "success", session_id: "prereq-" + task }) + "\\n");
    process.exit(0);
  }, 20);
}
process.stdin.on("data", (d) => {
  buf += d;
  if (!resident) return;
  for (let i = buf.indexOf("\\n"); i >= 0; i = buf.indexOf("\\n")) {
    const line = buf.slice(0, i);
    buf = buf.slice(i + 1);
    if (line.includes('"control_request"')) continue;
    if (line.trim()) start(line);
  }
});
process.stdin.on("end", () => { if (!resident && buf) start(buf); });
`);
writeFileSync(
  join(bin, IS_WINDOWS ? "claude.cmd" : "claude"),
  IS_WINDOWS ? `@node "%~dp0fake-claude.js" %*\r\n` : `#!/bin/sh\nexec node "$(dirname "$0")/fake-claude.js" "$@"\n`,
  { mode: 0o755 },
);
process.env.PATH = `${bin}${delimiter}${process.env.PATH ?? ""}`;

export const { db, ensureSchema } = await import("../src/db/index.js");
export const schema = await import("../src/db/schema.js");
export const { agents, freeReviewRounds, freeReviewRuns, freeWorkflowStates, groups, projects, taskPrerequisites, tasks } = schema;
export const { createTasks } = await import("../src/task-store.js");
export const { taskWorkspace } = await import("../src/task-workspace.js");
export const { acceptTask } = await import("../src/task-accept.js");
export const { updateTaskBase } = await import("../src/task-base-update.js");
export const { branchDependency } = await import("../src/task-branch-plan.js");
export const { worktreePathFor } = await import("../src/git.js");
export const { setTaskStatus } = await import("../src/status.js");
export const { mountTaskRoutes } = await import("../src/task-routes.js");
export const { mountTaskRunRoutes } = await import("../src/task-run-routes.js");
export const { mountTaskDiffRoutes } = await import("../src/task-diff-routes.js");
export const { mountGroupRoutes } = await import("../src/group-routes.js");
export const { prerequisiteStanding } = await import("../src/prerequisite-standing.js");
export const { prerequisiteViews } = await import("../src/prerequisite-view.js");
export const { launchRecord } = await import("../src/prerequisite-store.js");
export const { holdForPrerequisites, notePrerequisiteProgress, startPrerequisiteLaunches, sweepPrerequisiteLaunches } = await import("../src/prerequisite-launch.js");
export const { workspaceStateOf } = await import("../src/free-workflow-state.js");
export const runs = await import("../src/runs.js");

export const api = new Hono();
mountTaskRoutes(api);
mountTaskRunRoutes(api);
mountTaskDiffRoutes(api);
mountGroupRoutes(api);
export const request = (method: string, path: string, body?: unknown) => api.request(path, {
  method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body),
});

export const at = new Date().toISOString();
export const started: string[] = [];
export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
export const until = async (what: string, cond: () => boolean | Promise<boolean>, ms = 15_000) => {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(25)) if (await cond()) return;
  assert.fail(`等不到:${what}`);
};
export const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
export const row = async (id: string) => (await db.select().from(tasks).where(eq(tasks.id, id))).at(0)!;
export const inputsOf = (taskId: string) => existsSync(inputLog)
  ? readFileSync(inputLog, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as { task: string; input: string })
    .filter((entry) => entry.task === taskId) : [];
export const hasStarted = (taskId: string) => inputsOf(taskId).length > 0;
export const release = (taskId: string) => writeFileSync(join(releaseDir, taskId), "go");
export const view = async (id: string) => (await prerequisiteViews([await row(id)])).get(id)!;
export const step = async (id: string) => (await prerequisiteStanding(await row(id))).step;
export const commit = (path: string, file: string, value: string) => {
  writeFileSync(join(path, file), value);
  git(path, "add", "--", file);
  git(path, "commit", "-m", file);
  return git(path, "rev-parse", "HEAD");
};
export const diffFiles = async (id: string) => {
  const body = await (await request("GET", `/tasks/${id}/diff`)).json() as { files: { path: string }[]; reason?: string };
  return body.files.map((file) => file.path).sort();
};

let sequence = 0;
export async function project(strategy: "safe" | "squash" = "safe") {
  const key = `p${++sequence}`;
  const repo = join(root, key);
  execFileSync("git", ["init", "-b", "main", repo], { stdio: "ignore" });
  git(repo, "config", "user.name", "Prereq Test");
  git(repo, "config", "user.email", "prereq@example.test");
  commit(repo, ".gitignore", ".worktrees/\n");
  commit(repo, "shared.txt", "seed\n");
  await db.insert(projects).values({ id: key, name: key, repoPath: repo, createdAt: at });
  await db.insert(groups).values({ id: `${key}-g`, projectId: key, name: `${key} 组`, mode: "parallel", paused: false, createdAt: at });
  const accept = makeStep("accept", "accept");
  if (accept.kind === "accept") accept.p = { strategy, clean: "all" };
  const workflow = strategy === "squash"
    ? JSON.stringify({ workspace: "isolated", steps: [makeStep("run", "run"), makeStep("human", "human"), accept] })
    : null;
  const task = async (suffix: string, opts: { status?: string; prerequisites?: string[]; mergeTargetBranch?: string; useWorktree?: boolean } = {}) => {
    const id = `${key}-${suffix}`;
    await createTasks([{
      id, projectId: key, groupId: `${key}-g`, title: `${key}-${suffix}`, body: "test", mode: "single", status: opts.status ?? "backlog",
      agentType: "claude", createdAt: at, updatedAt: at, useWorktree: opts.useWorktree ?? true, worktreeBase: null,
      mergeTargetBranch: opts.mergeTargetBranch ?? null,
      ...(workflow ? { workflow, workflowMode: "preset" as const, workflowAt: "human" } : { workflowMode: "free" as const }),
    }], undefined, undefined, [], (opts.prerequisites ?? []).map((prerequisiteId) => ({ taskId: id, prerequisiteId })));
    return id;
  };
  /** 不经执行器：直接给任务开出工作区、落一个提交、标成完成（起跑闸照样要过）。 */
  const finish = async (id: string, file = `${id}.txt`, value = `${id}\n`) => {
    assert.equal(await holdForPrerequisites(await row(id), { source: "run" }), null, `${id} 的前置都站稳了才能开工`);
    const ws = await taskWorkspace(await row(id), repo);
    const head = commit(ws.path, file, value);
    await db.update(tasks).set({ status: "done" }).where(eq(tasks.id, id));
    return { path: ws.path, branch: ws.branch!, head };
  };
  return { key, repo, group: `${key}-g`, task, finish, path: (id: string) => worktreePathFor(repo, id) };
}

/** 一条审查链（只落库，不跑审查者）。fingerprint 缺省取此刻工作区的，等于「审的就是现在这版」。 */
export async function review(taskId: string, run: "reviewing" | "passed" | "failed", round: "reviewing" | "passed" | "failed",
  extra: Partial<typeof freeReviewRounds.$inferInsert> = {}) {
  const runId = `${taskId}-run-${Math.random().toString(36).slice(2, 8)}`;
  const snapshot = await workspaceStateOf(await row(taskId));
  await db.insert(freeReviewRuns).values({ id: runId, taskId, reviewerName: "r", agentType: "claude", checkMode: "logic",
    retryLimit: 1, currentRound: 1, status: run, createdAt: new Date().toISOString(), updatedAt: at });
  await db.insert(freeReviewRounds).values({ id: `${runId}-1`, runId, round: 1, status: round, startedAt: at,
    reviewedCommit: snapshot.head, reviewedFingerprint: snapshot.fingerprint, ...extra });
  return runId;
}
export const arm = (taskId: string, armed: boolean) => db.insert(freeWorkflowStates).values({ taskId, reviewArmed: armed, updatedAt: at })
  .onConflictDoUpdate({ target: freeWorkflowStates.taskId, set: { reviewArmed: armed } });
export const clearReviews = (taskId: string) => db.delete(freeReviewRuns).where(eq(freeReviewRuns.taskId, taskId));

/** 建表、登记一个默认执行器、挂上等齐就起（开机那一套，兜底扫描间隔拉长到用例跑不到）。 */
export async function setup(): Promise<void> {
  await ensureSchema();
  await db.insert(schema.agents).values({ id: "ex", name: "test", type: "claude", model: "test", isDefault: true });
  await startPrerequisiteLaunches(3_600_000);
}

export async function teardown(): Promise<void> {
  for (const taskId of started) release(taskId);
  await until("在跑的回合都退干净", () => started.every((taskId) => !runs.turnIdentity(taskId)), 15_000).catch((error) => console.error(error));
  // 收尾的结算、等齐就起的补办扫描（放出来的那条跑完后 500ms）还要再读写几次库。
  await sleep(1_000);
  await releaseTmpDb();
}
