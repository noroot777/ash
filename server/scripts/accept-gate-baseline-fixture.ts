// test-accept-gate-baseline*.ts 共用的样本仓库与驱动：临时库、真实的 PATCH 入口、真实的 acceptTask。
//
// 环境变量必须在载入任何 src 模块**之前**设好（db / runs 目录在模块初始化时就定了），所以
// 一切 src 模块都在 `baselineHarness` 里动态载入。
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { Hono } from "hono";

export async function baselineHarness(prefix: string) {
  const root = mkdtempSync(join(tmpdir(), prefix));
  process.env.ASH_DB = join(root, "ash.db");
  process.env.ASH_RUNS_DIR = join(root, "runs");
  assert.notEqual(process.env.ASH_ALLOW_REAL_AGENT, "1");
  const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
  const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
  // 门禁命令：载入每个 use-*.js，有一个抛错就红。`delay` 让它跑得够久，好在跑的期间动一下 main。
  const checkScript = (delay = 0) => `setTimeout(()=>{const fs=require("node:fs");`
    + `for(const f of fs.readdirSync(".").filter(f=>f.startsWith("use-")).sort())require("./"+f);`
    + `console.log("checked",fs.readdirSync(".").filter(f=>f.startsWith("use-")).join(","))},${delay})`;
  const gateCommand = (delay = 0) => `"${process.execPath}" -e ${JSON.stringify(checkScript(delay))}`;
  const passesOn = (cwd: string) => spawnSync(process.execPath, ["-e", checkScript()], { cwd }).status === 0;

  const { db, ensureSchema } = await import("../src/db/index.js");
  const { acceptGateRuns, projects, tasks } = await import("../src/db/schema.js");
  const { prepareWorktree } = await import("../src/git.js");
  const { acceptTask } = await import("../src/task-accept.js");
  const { acceptGateWouldRun, whenAcceptGateSettled } = await import("../src/accept-gate.js");
  const { acceptGateState } = await import("../src/accept-gate-state.js");
  const { mountProjectRoutes } = await import("../src/project-routes.js");
  const { bus } = await import("../src/bus.js");
  const { previewMerge } = await import("../src/accept-gate-preview.js");
  const { mergeTaskBranch } = await import("../src/git-accept.js");
  const { decodePhysical, snapshotPhysical } = await import("../src/accept-gate-physical.js");
  await ensureSchema();
  const api = new Hono();
  mountProjectRoutes(api);
  const stamp = new Date().toISOString();
  const runs = async (taskId: string) => (await db.select().from(acceptGateRuns).where(eq(acceptGateRuns.taskId, taskId)))
    .sort((a, b) => a.startedAt.localeCompare(b.startedAt));
  const taskRow = async (taskId: string) => (await db.select().from(tasks).where(eq(tasks.id, taskId)))[0]!;
  const projectRow = async (projectId: string) => (await db.select().from(projects).where(eq(projects.id, projectId)))[0]!;
  const wouldRun = async (sample: { taskId: string; projectId: string }) =>
    acceptGateWouldRun(await taskRow(sample.taskId), await projectRow(sample.projectId));
  const commitOnMain = (repo: string, file: string, text: string, message: string) => {
    writeFileSync(join(repo, file), text);
    git(repo, "add", "--", file);
    git(repo, "commit", "-m", message);
  };

  /**
   * B 开工在旧 main 上；`collide` = 之后 main 进了改名（A），否则只进一个无关文件。
   * baseline 走真实的 PATCH /projects/:id（界面上两处入口都落在这一条上）。
   */
  async function fixture(name: string, opts: { baseline?: string; collide?: boolean; delay?: number }) {
    const repo = join(root, name);
    execFileSync("git", ["init", "-b", "main", repo]);
    git(repo, "config", "user.name", "Gate Baseline Test");
    git(repo, "config", "user.email", "baseline@example.test");
    writeFileSync(join(repo, ".gitignore"), ".worktrees/\n");
    writeFileSync(join(repo, "api.js"), "exports.onDelivered = () => 'ok';\n");
    writeFileSync(join(repo, "use-seed.js"), "require('./api.js');\n");
    git(repo, "add", "-A");
    git(repo, "commit", "-m", "seed");
    const taskId = `baseline-${name}`;
    const projectId = `project-${name}`;
    await db.insert(projects).values({ id: projectId, name, repoPath: repo, acceptGateCommand: gateCommand(opts.delay), createdAt: stamp });
    if (opts.baseline) {
      const response = await api.request(`/projects/${projectId}`, { method: "PATCH",
        headers: { "content-type": "application/json" }, body: JSON.stringify({ acceptGateBaseline: opts.baseline }) });
      const body = await response.json() as { acceptGateBaseline?: string };
      assert.equal(response.status, 200, JSON.stringify(body));
      assert.equal(body.acceptGateBaseline, opts.baseline);
    }
    const cwd = (await prepareWorktree(repo, taskId, "main")).path;
    writeFileSync(join(cwd, "use-b.js"),
      "if (typeof require('./api.js').onDelivered !== 'function') throw new Error('onDelivered is gone');\n");
    git(cwd, "add", "-A");
    git(cwd, "commit", "-m", "task B uses onDelivered");
    if (opts.collide) commitOnMain(repo, "api.js", "exports.onInputSettled = () => 'ok';\n", "task A renames onDelivered");
    else commitOnMain(repo, "unrelated.txt", "unrelated\n", "unrelated main commit");
    await db.insert(tasks).values({ id: taskId, projectId, title: name, body: "", mode: "single", status: "done",
      stage: "verified", workflowMode: "free", useWorktree: true, worktreeBase: "main", mergeTargetBranch: "main",
      createdAt: stamp, updatedAt: stamp });
    return { repo, cwd, taskId, projectId };
  }
  /** 像门禁那样把测过的树在一份新目录里检出、记下物理凭据（直接调 mergeTaskBranch 的用例用）。 */
  async function testedPhysical(repo: string, base: string, tree: string) {
    const commit = git(repo, "commit-tree", tree, "-m", "tested");
    const dir = join(root, `tested-${commit.slice(0, 12)}`);
    git(repo, "worktree", "add", "-q", "--detach", dir, commit);
    try { return await snapshotPhysical(repo, "main", base, tree, dir, []); }
    finally { git(repo, "worktree", "remove", "--force", dir); }
  }
  async function settled(taskId: string, count = 1) {
    for (let attempt = 0; attempt < 800; attempt++) {
      const rows = await runs(taskId);
      if (rows.length >= count && rows.every(row => row.status !== "running")) {
        await Promise.all(rows.map(row => whenAcceptGateSettled(row.id)));
        if ((await runs(taskId)).every(row => row.status !== "running")) return;
      }
      await sleep(25);
    }
    throw new Error(`gate timed out: ${taskId}`);
  }
  return { root, git, sleep, gateCommand, passesOn, db, acceptGateRuns, projects, tasks, acceptTask, acceptGateState,
    mountProjectRoutes, bus, previewMerge, mergeTaskBranch, api, stamp, runs, taskRow, projectRow, wouldRun, commitOnMain,
    fixture, settled, testedPhysical, decodePhysical };
}
