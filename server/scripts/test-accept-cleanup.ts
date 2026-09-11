import assert from "node:assert/strict";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { releaseTmpDb } from "./tmp-db.js";

const root = mkdtempSync(join(tmpdir(), "ash-accept-cleanup-"));
process.env.ASH_DB = join(root, "ash.db");
process.env.ASH_RUNS_DIR = join(root, "runs");
const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const { db, ensureSchema } = await import("../src/db/index.js");
const { projects } = await import("../src/db/schema.js");
const { createTasks } = await import("../src/task-store.js");
const { taskWorkspace } = await import("../src/task-workspace.js");
const { acceptTask } = await import("../src/task-accept.js");
const { cleanupAcceptedTask } = await import("../src/git-accept.js");
const { writeRecord, readAnyPreview, recordPath } = await import("../src/preview-store.js");
const { beginPreviewStart, endPreviewStart, previewStartCanceled } = await import("../src/preview.js");
const { beginAccepting, endAccepting } = await import("../src/acceptance-lock.js");
const { restartTaskPreview } = await import("../src/workflow-steps.js");
const { killByPid } = await import("../src/executors/spawn.js");
await ensureSchema();
const children: ChildProcess[] = [];
let sequence = 0;

async function setup() {
  const id = `cleanup-${++sequence}`;
  const repo = join(root, id);
  git(root, "init", "-b", "main", repo);
  git(repo, "config", "user.name", "Cleanup Test");
  git(repo, "config", "user.email", "cleanup@example.test");
  writeFileSync(join(repo, ".gitignore"), "node_modules/\n");
  writeFileSync(join(repo, "seed.txt"), "seed\n");
  git(repo, "add", ".");
  git(repo, "commit", "-m", "seed");
  const at = new Date().toISOString();
  await db.insert(projects).values({ id, name: id, repoPath: repo, createdAt: at });
  const [task] = await createTasks([{
    id: `task-${id}`, projectId: id, title: id, body: "test", status: "done", mode: "single",
    useWorktree: true, worktreeBase: "main", workflowMode: "free", createdAt: at, updatedAt: at,
  }]);
  const workspace = await taskWorkspace(task, repo);
  writeFileSync(join(workspace.path, "feature.txt"), "committed feature\n");
  git(workspace.path, "add", ".");
  git(workspace.path, "commit", "-m", "feature");
  return { repo, task, ...workspace };
}

const accept = (id: string) => acceptTask(id, "human", { confirmUnverified: true });
const waitFor = async (check: () => boolean) => {
  const deadline = Date.now() + 5000;
  while (!check() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 25));
  assert.ok(check(), "fixture did not become ready");
};

try {
  // 持续写入 ignored 缓存，并故意延迟退出；停止发生时工作区必须还在。
  for (const life of ["task", "manual"] as const) {
    const s = await setup();
    const stopped = join(root, `${s.task.id}-stopped`);
    const ready = join(root, `${s.task.id}-ready`);
    const source = `
      const fs = require('fs'), path = require('path');
      const cwd = process.cwd();
      fs.mkdirSync('node_modules/.vite', { recursive: true });
      const timer = setInterval(() => fs.writeFileSync('node_modules/.vite/cache.json', '{}'), 5);
      process.on('SIGTERM', () => {
        fs.writeFileSync(${JSON.stringify(stopped)}, String(fs.existsSync(path.join(cwd, '.git'))));
        setTimeout(() => { clearInterval(timer); process.exit(0); }, 250);
      });
      fs.writeFileSync(${JSON.stringify(ready)}, 'ready');
    `;
    const child = spawn(process.execPath, ["-e", source], { cwd: s.path, detached: process.platform !== "win32", stdio: "ignore" });
    children.push(child);
    await waitFor(() => existsSync(ready));
    mkdirSync(join(root, "runs", s.task.id), { recursive: true });
    writeRecord({ taskId: s.task.id, pid: child.pid!, cmd: "fixture writer", life, log: "", startedAt: new Date().toISOString(), port: null, url: null, state: "ready" });
    const result = await accept(s.task.id);
    assert.equal(result.accepted, true, JSON.stringify(result));
    assert.ok(child.exitCode !== null || child.signalCode !== null, "验收返回前进程应确实退出");
    if (process.platform !== "win32") assert.equal(readFileSync(stopped, "utf8"), "true", "停止信号必须先于工作区删除");
    assert.equal(existsSync(s.path), false);
    assert.equal(readAnyPreview(s.task.id), null);
    assert.equal(git(s.repo, "show", "main:feature.txt"), "committed feature");
    console.log(`✓ ${life} preview stops before workspace deletion; late cache writes cannot recreate the directory`);
  }

  if (process.platform !== "win32") {
    const s = await setup();
    const ready = join(root, "orphan-ready");
    const childCode = `process.on('SIGTERM',()=>{}); require('fs').writeFileSync(${JSON.stringify(ready)}, String(process.pid)); setInterval(()=>{},100);`;
    const parent = spawn(process.execPath, ["-e", `require('child_process').spawn(process.execPath,['-e',${JSON.stringify(childCode)}],{stdio:'ignore'}).unref()`], { cwd: s.path, detached: true, stdio: "ignore" });
    children.push(parent);
    const exited = once(parent, "exit");
    await waitFor(() => existsSync(ready));
    await exited;
    mkdirSync(join(root, "runs", s.task.id), { recursive: true });
    writeRecord({ taskId: s.task.id, pid: parent.pid!, cmd: "orphan fixture", life: "task", log: "", startedAt: new Date().toISOString(), port: null, url: null });
    try {
      const result = await accept(s.task.id);
      assert.equal(result.accepted, true, JSON.stringify(result));
      assert.throws(() => process.kill(-parent.pid!, 0), "忽略 TERM 的孤儿进程组必须退出后才能删目录");
      assert.equal(existsSync(s.path), false);
    } finally { killByPid(parent.pid!); }
    console.log("✓ dead preview leader does not bypass waiting for its TERM-resistant process group");
  }

  // 未落盘的启动正在等仓库锁时，取消后先让它退出，不能在锁内把目录删了。
  {
    const s = await setup();
    const gen = beginPreviewStart(s.task.id);
    const blocked = await accept(s.task.id);
    assert.equal(blocked.accepted, false);
    if (blocked.accepted) throw new Error("pending start unexpectedly accepted");
    assert.equal(blocked.reason, "preview_cleanup_pending");
    assert.ok(blocked.completedMerge);
    assert.equal(previewStartCanceled(gen), true);
    assert.ok(existsSync(join(s.path, ".git")));
    endPreviewStart(s.task.id, gen);
    assert.equal((await accept(s.task.id)).accepted, true);
    assert.equal(existsSync(s.path), false);
    assert.equal(beginAccepting(s.task.id), true);
    try { assert.deepEqual(await restartTaskPreview(s.task.id), { ok: false, code: "busy", reason: "任务正在验收，暂时不能重开预览" }); }
    finally { endAccepting(s.task.id); }
    console.log("✓ canceled starts retain the workspace until unwound; cleanup retries and concurrent preview gating work");
  }

  for (const mode of ["clean", "modified", "untracked", "foreign", "registered"] as const) {
    const s = await setup();
    git(s.repo, "merge", "--no-ff", "--no-edit", s.branch!);
    const main = git(s.repo, "rev-parse", "main");
    const index = readFileSync(join(s.repo, ".git", "index"));
    const pointer = readFileSync(join(s.path, ".git"), "utf8");
    const admin = pointer.trim().slice("gitdir: ".length);
    if (mode !== "registered") rmSync(admin, { recursive: true });
    rmSync(join(s.path, "seed.txt"));
    mkdirSync(join(s.path, "node_modules", ".vite"), { recursive: true });
    writeFileSync(join(s.path, "node_modules", ".vite", "cache.json"), "preserved cache");
    if (mode === "modified") writeFileSync(join(s.path, "feature.txt"), "uncommitted work");
    if (mode === "untracked") writeFileSync(join(s.path, "WIP.txt"), "untracked work");
    if (mode === "foreign") {
      rmSync(join(s.path, ".git"));
      writeFileSync(join(s.path, ".git"), `gitdir: ${join(root, "other-repo", "worktrees", "entry")}\n`);
    }
    const result = await cleanupAcceptedTask(s.repo, s.task.id, "main");
    if (mode === "clean") {
      assert.equal(result.ok, true, JSON.stringify(result));
      assert.ok(result.worktreeBackupPath);
      assert.equal(existsSync(s.path), false);
      assert.equal(readFileSync(join(result.worktreeBackupPath, "feature.txt"), "utf8"), "committed feature\n");
      assert.equal(readFileSync(join(result.worktreeBackupPath, "node_modules", ".vite", "cache.json"), "utf8"), "preserved cache");
      assert.equal(readFileSync(`${result.worktreeBackupPath}.git-pointer`, "utf8"), pointer);
      assert.equal(existsSync(join(result.worktreeBackupPath, ".git")), false);
      assert.equal((await cleanupAcceptedTask(s.repo, s.task.id, "main")).ok, true);
    } else {
      assert.equal(result.ok, false, `${mode} must be retained`);
      assert.ok(existsSync(s.path));
      assert.equal(result.worktreeBackupPath, undefined);
      if (mode === "modified") assert.equal(readFileSync(join(s.path, "feature.txt"), "utf8"), "uncommitted work");
      if (mode === "untracked") assert.equal(readFileSync(join(s.path, "WIP.txt"), "utf8"), "untracked work");
    }
    assert.equal(git(s.repo, "rev-parse", "main"), main);
    assert.deepEqual(readFileSync(join(s.repo, ".git", "index")), index, "恢复检查不能改主仓 index");
    console.log(`✓ dangling registration ${mode}: safe recovery and main checkout protection`);
  }
  assert.equal(existsSync(recordPath("not-a-task")), false);
  console.log("accept cleanup regression passed");
} finally {
  for (const child of children) {
    if (child.exitCode !== null || child.signalCode !== null) continue;
    killByPid(child.pid!);
    await Promise.race([once(child, "exit"), new Promise(resolve => setTimeout(resolve, 4000))]);
  }
  await releaseTmpDb();
  rmSync(root, { recursive: true, force: true });
}
