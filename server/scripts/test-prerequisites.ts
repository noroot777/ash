// 前置（shared/src/prerequisites.ts）：一条任务建在几条任务上面。
//
//  P1 站稳判定：未开工 / 在跑 / 失败 / 取消 / 完成 / 有没提交的改动 / 预约审查 / 在审 / 打回在修 / 没过 /
//     驳回等裁定 / 通过 / 通过后又改过 / 裁定收场 / 已验收，一条一条对着 prerequisiteStanding 判；
//  P2 主场景（照验收剧本）：批量建 B、C 都建在 A 上、D 建在 B、C 上并要求起跑 —— A 在跑、在审时都等着；
//     A 审过的那一刻 B、C 同时起，起点就是 A 的代码、diff 里没有 A 的；D 要等 B、C 都完成，起点是两条合在
//     一起；前置开工后又有新提交时下游页面看得出；验收先 B 被挡（点名 A），D 被挡，按 A→B→C→D 依次能过；
//  P3 起点：已合入的前置取目标分支最新；一条包含另一条时不重复合；两条改动合不拢时不开工、点名两条；
//  P4 三层链 X→Y→Z 都按 squash 验收：每一层更新基线之后都能依次合入；
//  P5 前置失败、取消：下游一直等，不跳过；去掉卡住的那条就起；前置被删：关系解除、下游照样能起；
//  P6 分组暂停着的不起，恢复后补办；起跑请求落在库里，开机那一趟扫描（重启后）照样起跑；
//  P7 成环、跨合入分支（前置还没合入）、开工后改前置都被拒；同批 key 重复被拒；stack 一行串起来；
//  P8 在队列里又有前置的：队列轮到了、前置没齐就停着，前置站稳后经队列推进起跑。
//
// 执行器是装在 PATH 上的假 claude：收到输入就记一行，等用例放行那个任务再以成功退出（ASH_LAX_DONE 下即 done）。
// git 夹具在临时目录里，进程里所有 GIT_* 环境变量先清掉，免得漏进夹具改到别的仓库。
// 跑：npm -w server run test:prerequisites
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
const root = mkdtempSync(join(tmpdir(), "ash-prerequisites-"));
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

const { db, ensureSchema } = await import("../src/db/index.js");
const schema = await import("../src/db/schema.js");
const { agents, freeReviewRounds, freeReviewRuns, freeWorkflowStates, groups, projects, taskPrerequisites, tasks } = schema;
const { createTasks } = await import("../src/task-store.js");
const { taskWorkspace } = await import("../src/task-workspace.js");
const { acceptTask } = await import("../src/task-accept.js");
const { updateTaskBase } = await import("../src/task-base-update.js");
const { branchDependency } = await import("../src/task-branch-plan.js");
const { worktreePathFor } = await import("../src/git.js");
const { setTaskStatus } = await import("../src/status.js");
const { mountTaskRoutes } = await import("../src/task-routes.js");
const { mountTaskRunRoutes } = await import("../src/task-run-routes.js");
const { mountTaskDiffRoutes } = await import("../src/task-diff-routes.js");
const { mountGroupRoutes } = await import("../src/group-routes.js");
const { prerequisiteStanding } = await import("../src/prerequisite-standing.js");
const { prerequisiteViews } = await import("../src/prerequisite-view.js");
const { launchRecord } = await import("../src/prerequisite-store.js");
const { holdForPrerequisites, notePrerequisiteProgress, startPrerequisiteLaunches, sweepPrerequisiteLaunches } =
  await import("../src/prerequisite-launch.js");
const { workspaceStateOf } = await import("../src/free-workflow-state.js");
const runs = await import("../src/runs.js");

const api = new Hono();
mountTaskRoutes(api);
mountTaskRunRoutes(api);
mountTaskDiffRoutes(api);
mountGroupRoutes(api);
const request = (method: string, path: string, body?: unknown) => api.request(path, {
  method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body),
});

const at = new Date().toISOString();
const started: string[] = [];
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const until = async (what: string, cond: () => boolean | Promise<boolean>, ms = 15_000) => {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(25)) if (await cond()) return;
  assert.fail(`等不到:${what}`);
};
const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const row = async (id: string) => (await db.select().from(tasks).where(eq(tasks.id, id))).at(0)!;
const inputsOf = (taskId: string) => existsSync(inputLog)
  ? readFileSync(inputLog, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as { task: string })
    .filter((entry) => entry.task === taskId) : [];
const hasStarted = (taskId: string) => inputsOf(taskId).length > 0;
const release = (taskId: string) => writeFileSync(join(releaseDir, taskId), "go");
const view = async (id: string) => (await prerequisiteViews([await row(id)])).get(id)!;
const step = async (id: string) => (await prerequisiteStanding(await row(id))).step;
const commit = (path: string, file: string, value: string) => {
  writeFileSync(join(path, file), value);
  git(path, "add", "--", file);
  git(path, "commit", "-m", file);
  return git(path, "rev-parse", "HEAD");
};
const diffFiles = async (id: string) => {
  const body = await (await request("GET", `/tasks/${id}/diff`)).json() as { files: { path: string }[]; reason?: string };
  return body.files.map((file) => file.path).sort();
};

let sequence = 0;
async function project(strategy: "safe" | "squash" = "safe") {
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
async function review(taskId: string, run: "reviewing" | "passed" | "failed", round: "reviewing" | "passed" | "failed",
  extra: Partial<typeof freeReviewRounds.$inferInsert> = {}) {
  const runId = `${taskId}-run-${Math.random().toString(36).slice(2, 8)}`;
  const snapshot = await workspaceStateOf(await row(taskId));
  await db.insert(freeReviewRuns).values({ id: runId, taskId, reviewerName: "r", agentType: "claude", checkMode: "logic",
    retryLimit: 1, currentRound: 1, status: run, createdAt: new Date().toISOString(), updatedAt: at });
  await db.insert(freeReviewRounds).values({ id: `${runId}-1`, runId, round: 1, status: round, startedAt: at,
    reviewedCommit: snapshot.head, reviewedFingerprint: snapshot.fingerprint, ...extra });
  return runId;
}
const arm = (taskId: string, armed: boolean) => db.insert(freeWorkflowStates).values({ taskId, reviewArmed: armed, updatedAt: at })
  .onConflictDoUpdate({ target: freeWorkflowStates.taskId, set: { reviewArmed: armed } });
const clearReviews = (taskId: string) => db.delete(freeReviewRuns).where(eq(freeReviewRuns.taskId, taskId));

try {
  await ensureSchema();
  await db.insert(agents).values({ id: "ex", name: "test", type: "claude", model: "test", isDefault: true });
  await startPrerequisiteLaunches(3_600_000);

  // ── P1 站稳判定 ─────────────────────────────────────────────────────────────
  {
    const p = await project();
    const a = await p.task("a");
    assert.equal(await step(a), "not_started");
    for (const status of ["running", "failed", "canceled"] as const) {
      await db.update(tasks).set({ status }).where(eq(tasks.id, a));
      assert.equal(await step(a), status === "running" ? "running" : status);
    }
    const ws = await p.finish(a);
    assert.equal(await step(a), "settled", "没预约过审查：完成即站稳");
    writeFileSync(join(ws.path, "loose.txt"), "没提交\n");
    assert.equal(await step(a), "dirty", "有没提交的改动：带不过去，不算");
    git(ws.path, "add", "loose.txt");
    git(ws.path, "commit", "-m", "loose");
    await arm(a, true);
    assert.equal(await step(a), "review_reserved", "预约了还没开审：不算");
    await arm(a, false);
    const reviewing = await review(a, "reviewing", "reviewing");
    assert.equal(await step(a), "reviewing");
    assert.equal((await prerequisiteStanding(await row(a))).round, 1);
    await clearReviews(a);
    await review(a, "failed", "failed");
    assert.equal(await step(a), "review_failed", "没过、停在等用户决定：不算");
    await arm(a, true);
    await db.update(tasks).set({ status: "running" }).where(eq(tasks.id, a));
    assert.equal(await step(a), "repairing", "没过、按意见修着：不算");
    await db.update(tasks).set({ status: "done" }).where(eq(tasks.id, a));
    await arm(a, false);
    await clearReviews(a);
    await review(a, "failed", "failed", { disputeReason: "这条读错了", disputeAt: at });
    assert.equal(await step(a), "review_disputed", "驳回了、等裁定：不算");
    await clearReviews(a);
    await review(a, "failed", "failed", { disputeReason: "这条读错了", disputeAt: at, disputeResolution: "withdrawn", disputeResolvedAt: at });
    assert.equal(await step(a), "settled", "用户裁定「这一轮不用改了」：收场");
    await clearReviews(a);
    await review(a, "failed", "failed", { disputeDeferReason: "不属于本任务", disputeAt: at, disputeResolution: "deferred", disputeResolvedAt: at });
    assert.equal(await step(a), "settled", "用户裁定「转为独立任务」：收场");
    await clearReviews(a);
    await review(a, "passed", "passed");
    assert.equal(await step(a), "settled", "审过、审的就是现在这版");
    commit(ws.path, "after.txt", "审完又改\n");
    assert.equal(await step(a), "review_stale", "审过之后又改过：不算");
    await db.update(tasks).set({ stage: "accepted" }).where(eq(tasks.id, a));
    assert.equal(await step(a), "settled", "已验收：算");
    void reviewing;
    console.log("✓ P1 站稳判定逐档成立");
  }

  // ── P2 主场景 ───────────────────────────────────────────────────────────────
  {
    const p = await project();
    const a = await p.task("a");
    let res = await request("POST", `/tasks/${a}/run`);
    assert.equal(res.status, 202);
    started.push(a);
    await until("A 起跑", () => hasStarted(a));
    const aHead = commit(p.path(a), "a.txt", "A 的代码\n");

    res = await request("POST", `/groups/${p.group}/tasks/batch`, {
      run: true, defaults: { useWorktree: true },
      tasks: [
        { key: "b", title: "B", body: "B", prerequisites: [a] },
        { key: "c", title: "C", body: "C", prerequisites: [a] },
        { key: "d", title: "D", body: "D", prerequisites: ["b", "c"] },
      ],
    });
    assert.equal(res.status, 201, await res.clone().text());
    const created = (await res.json() as { tasks: { id: string; title: string }[] }).tasks;
    const [b, c, d] = ["B", "C", "D"].map((title) => created.find((task) => task.title === title)!.id) as [string, string, string];
    assert.deepEqual((await db.select().from(taskPrerequisites).where(eq(taskPrerequisites.taskId, d))).map((edge) => edge.prerequisiteId).sort(), [b, c].sort());
    await until("分组运行把 B、C、D 的起跑请求记下", async () => !!(await launchRecord(b))?.requestedAt
      && !!(await launchRecord(c))?.requestedAt && !!(await launchRecord(d))?.requestedAt);
    let bView = await view(b);
    assert.equal(bView.waiting, true);
    assert.equal(bView.prerequisites[0]!.taskId, a);
    assert.equal(bView.prerequisites[0]!.step, "running");
    assert.deepEqual((await view(a)).dependents.map((x) => x.taskId).sort(), [b, c].sort());
    res = await request("POST", `/tasks/${b}/run`);
    assert.equal(res.status, 202);
    assert.equal((await res.json() as { waiting?: boolean }).waiting, true, "手动运行：前置没站稳就只记下来");

    // A 一完成就进审查：审查链在它结算之前挂好（真实链路里是预约的那一轮当场开审），B、C 不能抢在审查前面起。
    await review(a, "reviewing", "reviewing");
    release(a);
    await until("A 完成", async () => (await row(a)).status === "done" && !runs.turnIdentity(a));
    await sleep(600);
    assert.equal(hasStarted(b) || hasStarted(c), false, "A 在审：B、C 都等着");
    bView = await view(b);
    assert.equal(bView.prerequisites[0]!.step, "reviewing");
    assert.equal(bView.prerequisites[0]!.round, 1);

    const runId = (await db.select().from(freeReviewRuns).where(eq(freeReviewRuns.taskId, a))).at(0)!.id;
    await db.update(freeReviewRuns).set({ status: "passed" }).where(eq(freeReviewRuns.id, runId));
    await db.update(freeReviewRounds).set({ status: "passed" }).where(eq(freeReviewRounds.runId, runId));
    notePrerequisiteProgress(a); // 审查结算那个出口
    started.push(b, c);
    await until("A 审过：B、C 同时起", () => hasStarted(b) && hasStarted(c));
    assert.equal(hasStarted(d), false, "D 还在等 B、C");
    for (const id of [b, c]) {
      const task = await row(id);
      assert.equal(task.worktreeStartCommit, aHead, `${id} 从 A 的代码开工`);
      assert.equal(readFileSync(join(p.path(id), "a.txt"), "utf8"), "A 的代码\n");
      assert.equal((await launchRecord(id))?.requestedAt, null, "起跑请求了结");
    }
    const bHead = commit(p.path(b), "b.txt", "B\n");
    commit(p.path(c), "c.txt", "C\n");
    assert.deepEqual(await diffFiles(b), ["b.txt"], "B 的 diff 里没有 A 的改动");

    release(b);
    await until("B 完成", async () => (await row(b)).status === "done" && !runs.turnIdentity(b));
    await sleep(400);
    assert.equal(hasStarted(d), false, "C 还在跑，D 不起");
    assert.equal((await view(d)).prerequisites.find((x) => x.taskId === c)!.step, "running");
    release(c);
    started.push(d);
    await until("B、C 都完成：D 起", () => hasStarted(d));
    const dTask = await row(d);
    assert.equal(git(p.repo, "rev-list", "--parents", "-n", "1", dTask.worktreeStartCommit!).split(" ").length, 3, "D 的起点是 B、C 合在一起");
    for (const file of ["a.txt", "b.txt", "c.txt"]) assert.ok(existsSync(join(p.path(d), file)), `D 拿到了 ${file}`);
    commit(p.path(d), "d.txt", "D\n");
    assert.deepEqual(await diffFiles(d), ["d.txt"], "D 的 diff 只有它自己的");
    commit(p.path(c), "c2.txt", "C 后来又改\n");
    const dView = await view(d);
    assert.equal(dView.prerequisites.find((x) => x.taskId === c)!.movedOn, true, "前置开工后又有新提交");
    assert.equal(dView.prerequisites.find((x) => x.taskId === b)!.movedOn, false);
    release(d);
    await until("D 完成", async () => (await row(d)).status === "done" && !runs.turnIdentity(d));

    const early = await acceptTask(b);
    assert.equal(early.accepted, false, "A 还没合入，B 不能先合");
    assert.match(JSON.stringify(early), /p\d+-a|等待「/);
    assert.equal((await branchDependency(await row(d), p.repo))?.state, "waiting");
    assert.equal((await acceptTask(d)).accepted, false, "B、C 都没合入，D 被挡");
    for (const id of [a, b, c, d]) assert.equal((await acceptTask(id)).accepted, true, `${id} 按顺序验收`);
    for (const file of ["a.txt", "b.txt", "c.txt", "c2.txt", "d.txt"]) assert.ok(git(p.repo, "show", `main:${file}`));
    void bHead;
    console.log("✓ P2 A 在跑在审时 B、C 等着，审过同时起；D 等 B、C 都完成；起点含前置、diff 不含；按序验收，先合下游被挡");
  }

  // ── P3 起点的三种情形 ───────────────────────────────────────────────────────
  {
    const p = await project();
    const a = await p.task("a");
    await p.finish(a);
    assert.equal((await acceptTask(a)).accepted, true);
    commit(p.repo, "later.txt", "别人后来合进来的\n");
    const f = await p.task("f", { prerequisites: [a] });
    await p.finish(f);
    assert.equal((await row(f)).worktreeStartCommit, git(p.repo, "rev-parse", "main"), "已合入的前置：取目标分支最新");
    assert.ok(existsSync(join(p.path(f), "later.txt")));

    const x = await p.task("x");
    const xWs = await p.finish(x);
    const y = await p.task("y", { prerequisites: [x] });
    const yWs = await p.finish(y);
    const e = await p.task("e", { prerequisites: [x, y] });
    await p.finish(e);
    assert.equal((await row(e)).worktreeStartCommit, yWs.head, "Y 已包含 X：不重复合，直接从 Y 开工");
    void xWs;

    const g1 = await p.task("g1");
    await p.finish(g1, "same.txt", "一种写法\n");
    const g2 = await p.task("g2");
    await p.finish(g2, "same.txt", "另一种写法\n");
    const h = await p.task("h", { prerequisites: [g1, g2] });
    const hold = await holdForPrerequisites(await row(h), { source: "run" });
    assert.ok(hold, "合不拢：不开工");
    assert.match(hold!.reason, /「p\d+-g1」和「p\d+-g2」的改动合不到一起/);
    assert.match((await view(h)).blocked ?? "", /合不到一起/);
    assert.equal(existsSync(p.path(h)), false, "没开出工作区");
    console.log("✓ P3 已合入的取目标分支最新、被包含的不重复合、合不拢的不开工并点名两条");
  }

  // ── P4 三层 squash 链 ───────────────────────────────────────────────────────
  {
    const p = await project("squash");
    const x = await p.task("x");
    await p.finish(x);
    const y = await p.task("y", { prerequisites: [x] });
    await p.finish(y);
    const z = await p.task("z", { prerequisites: [y] });
    await p.finish(z);
    assert.equal((await acceptTask(y)).accepted, false, "X 没合入：Y 被挡");
    assert.equal((await acceptTask(x)).accepted, true);
    assert.equal((await branchDependency(await row(y), p.repo))?.state, "needs_update");
    assert.equal((await updateTaskBase(y, git(p.path(y), "rev-parse", "HEAD"))).ok, true);
    assert.equal((await acceptTask(y)).accepted, true);
    assert.equal((await branchDependency(await row(z), p.repo))?.state, "needs_update");
    assert.equal((await updateTaskBase(z, git(p.path(z), "rev-parse", "HEAD"))).ok, true);
    assert.equal((await branchDependency(await row(z), p.repo))?.state, "ready");
    assert.equal((await acceptTask(z)).accepted, true);
    for (const id of [x, y, z]) assert.equal(git(p.repo, "show", `main:${id}.txt`), id);
    console.log("✓ P4 三层链按 squash 依次验收，每层更新基线后能合");
  }

  // ── P5 失败 / 取消 / 去掉 / 删除 ───────────────────────────────────────────
  {
    const p = await project();
    for (const status of ["failed", "canceled"] as const) {
      const bad = await p.task(`bad-${status}`, { status });
      const q = await p.task(`q-${status}`, { prerequisites: [bad] });
      const res = await request("POST", `/tasks/${q}/run`);
      assert.equal(res.status, 202);
      assert.equal((await res.json() as { waiting?: boolean }).waiting, true, `前置${status}：等着，不跳过`);
      assert.equal((await view(q)).prerequisites[0]!.step, status);
      await sweepPrerequisiteLaunches();
      await sleep(200);
      assert.equal(hasStarted(q), false);
      assert.equal((await request("DELETE", `/tasks/${q}/prerequisites/${bad}`)).status, 200);
      started.push(q);
      await until(`去掉${status}的前置后 ${q} 起跑`, () => hasStarted(q));
      release(q);
    }
    const s = await p.task("s", { status: "failed" });
    const r = await p.task("r", { prerequisites: [s] });
    assert.equal((await request("POST", `/tasks/${r}/run`)).status, 202);
    assert.equal((await request("DELETE", `/tasks/${s}`)).status, 200);
    started.push(r);
    await until("前置被删：关系解除，下游照样起", () => hasStarted(r));
    assert.equal((await db.select().from(taskPrerequisites).where(eq(taskPrerequisites.taskId, r))).length, 0);
    release(r);
    console.log("✓ P5 前置失败、取消时下游一直等；去掉或删掉卡住的那条，下游当场起");
  }

  // ── P6 暂停的分组、重启后补办 ──────────────────────────────────────────────
  {
    const p = await project();
    const a = await p.task("a");
    await p.finish(a);
    await db.update(tasks).set({ status: "running" }).where(eq(tasks.id, a));
    const b = await p.task("b", { prerequisites: [a] });
    assert.equal((await request("POST", `/tasks/${b}/run`)).status, 202);
    await db.update(groups).set({ paused: true }).where(eq(groups.id, p.group));
    // 「重启期间」站稳：直接改库，任何出口都没被调用。
    await db.update(tasks).set({ status: "done" }).where(eq(tasks.id, a));
    await sweepPrerequisiteLaunches();
    await sleep(300);
    assert.equal(hasStarted(b), false, "分组暂停着：不起");
    assert.ok((await launchRecord(b))?.requestedAt, "请求还挂着");
    await db.update(groups).set({ paused: false }).where(eq(groups.id, p.group));
    started.push(b);
    await sweepPrerequisiteLaunches(); // 开机那一趟扫描
    await until("恢复后补办起跑", () => hasStarted(b));
    release(b);
    console.log("✓ P6 暂停的分组不起；起跑请求在库里，开机扫描照样起");
  }

  // ── P7 校验 ─────────────────────────────────────────────────────────────────
  {
    const p = await project();
    const a = await p.task("a");
    const b = await p.task("b", { prerequisites: [a] });
    const c = await p.task("c", { prerequisites: [b] });
    let res = await request("POST", `/tasks/${a}/prerequisites`, { prerequisiteId: c });
    assert.equal(res.status, 400);
    assert.match((await res.json() as { error: string }).error, /成环/);
    res = await request("POST", `/tasks/${a}/prerequisites`, { prerequisiteId: a });
    assert.equal(res.status, 400);
    git(p.repo, "branch", "other");
    const elsewhere = await p.task("elsewhere", { mergeTargetBranch: "other" });
    res = await request("POST", `/tasks/${a}/prerequisites`, { prerequisiteId: elsewhere });
    assert.equal(res.status, 400);
    assert.match((await res.json() as { error: string }).error, /最终合入 other/);
    const plain = await p.task("plain", { useWorktree: false });
    res = await request("POST", `/tasks/${c}/prerequisites`, { prerequisiteId: plain });
    assert.equal(res.status, 200, "加前置：开工前随时能加");
    assert.equal((await request("DELETE", `/tasks/${c}/prerequisites/${plain}`)).status, 200, "也随时能去");
    await p.finish(a);
    res = await request("POST", `/tasks/${a}/prerequisites`, { prerequisiteId: plain });
    assert.equal(res.status, 409, "开工之后不能再改前置");
    res = await request("POST", `/groups/${p.group}/tasks/batch`, {
      tasks: [{ key: "k", body: "1" }, { key: "k", body: "2" }],
    });
    assert.equal(res.status, 400);
    res = await request("POST", `/groups/${p.group}/tasks/batch`, {
      stack: true, defaults: { useWorktree: true }, tasks: [{ title: "s1", body: "1" }, { title: "s2", body: "2" }, { title: "s3", body: "3" }],
    });
    assert.equal(res.status, 201);
    const stacked = (await res.json() as { tasks: { id: string; title: string }[] }).tasks;
    const idOf = (title: string) => stacked.find((task) => task.title === title)!.id;
    const edgesOf = async (id: string) => (await db.select().from(taskPrerequisites).where(eq(taskPrerequisites.taskId, id))).map((edge) => edge.prerequisiteId);
    assert.deepEqual(await edgesOf(idOf("s1")), []);
    assert.deepEqual(await edgesOf(idOf("s2")), [idOf("s1")], "stack：每一条建在上一条上");
    assert.deepEqual(await edgesOf(idOf("s3")), [idOf("s2")]);
    console.log("✓ P7 成环、自己、跨合入分支、开工后改前置、同批 key 重复都被拒；stack 一行串起来");
  }

  // ── P8 队列与前置都放行才起 ─────────────────────────────────────────────────
  {
    const p = await project();
    await db.insert(groups).values({ id: `${p.key}-serial`, projectId: p.key, name: "串行", mode: "serial", paused: false, createdAt: at });
    const x = await p.task("x");
    await p.finish(x);
    await db.update(tasks).set({ status: "running" }).where(eq(tasks.id, x));
    const res = await request("POST", `/groups/${p.key}-serial/tasks/batch`, {
      chain: true, run: true, defaults: { useWorktree: true },
      tasks: [{ key: "q1", title: "Q1", body: "1" }, { key: "q2", title: "Q2", body: "2", prerequisites: [x] }],
    });
    assert.equal(res.status, 201, await res.clone().text());
    const created = (await res.json() as { tasks: { id: string; title: string }[] }).tasks;
    const [q1, q2] = ["Q1", "Q2"].map((title) => created.find((task) => task.title === title)!.id) as [string, string];
    started.push(q1);
    await until("队首 Q1 起跑", () => hasStarted(q1));
    release(q1);
    await until("Q1 完成，队列推到 Q2 并记下请求", async () => (await row(q1)).status === "done"
      && !!(await launchRecord(q2))?.requestedAt);
    await sleep(300);
    assert.equal(hasStarted(q2), false, "队列放行了、前置没站稳：不起");
    assert.equal((await row(q2)).status, "backlog");
    started.push(q2);
    await setTaskStatus(x, "done");
    await until("前置站稳：由队列推进起 Q2", () => hasStarted(q2));
    release(q2);
    console.log("✓ P8 队列轮到了、前置没齐时停着；前置站稳后经队列推进起跑");
  }
} finally {
  for (const taskId of started) release(taskId);
  await until("在跑的回合都退干净", () => started.every((taskId) => !runs.turnIdentity(taskId)), 15_000).catch((error) => console.error(error));
  // 收尾的结算、等齐就起的补办扫描（放出来的那条跑完后 500ms）还要再读写几次库。
  await sleep(1_000);
  await releaseTmpDb();
}
