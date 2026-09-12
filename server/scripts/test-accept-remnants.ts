import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { eq } from "drizzle-orm";
import { db } from "../src/db/index.js";
import { tasks } from "../src/db/schema.js";
import { cleanupAcceptedTask } from "../src/git-accept.js";
import { acceptTask } from "../src/task-accept.js";

type Fixture = { repo: string; path: string; branch: string | null; task: { id: string; projectId: string } };
const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const mainState = (repo: string) => ({
  head: git(repo, "rev-parse", "HEAD"), main: git(repo, "rev-parse", "main"),
  status: git(repo, "--no-optional-locks", "status", "--short"), index: readFileSync(join(repo, ".git", "index")),
});

function leaveRemnants(s: Fixture, keepPointer = false, keepAdmin = false): string {
  const pointer = readFileSync(join(s.path, ".git"), "utf8");
  if (!keepAdmin) rmSync(resolve(s.path, pointer.trim().slice("gitdir: ".length)), { recursive: true });
  if (!keepPointer) rmSync(join(s.path, ".git"));
  rmSync(join(s.path, "seed.txt"));
  mkdirSync(join(s.path, "node_modules", ".vite"), { recursive: true });
  writeFileSync(join(s.path, "node_modules", ".vite", "cache.json"), "preserved cache");
  return pointer;
}

function checkBackup(s: Fixture, backup: string | undefined, pointer?: string): void {
  assert.ok(backup);
  assert.equal(existsSync(s.path), false);
  assert.equal(readFileSync(join(backup, "feature.txt"), "utf8"), "committed feature\n");
  assert.equal(readFileSync(join(backup, "node_modules", ".vite", "cache.json"), "utf8"), "preserved cache");
  assert.equal(existsSync(join(backup, ".git")), false);
  if (pointer) assert.equal(readFileSync(`${backup}.git-pointer`, "utf8"), pointer);
  else assert.equal(existsSync(`${backup}.git-pointer`), false);
}

export async function testRemovedWorktrees(root: string, setup: () => Promise<Fixture>): Promise<void> {
  for (const mode of ["clean", "modified", "untracked", "registered", "other-checkout", "git-directory"] as const) {
    const s = await setup();
    git(s.repo, "merge", "--no-ff", "--no-edit", s.branch!);
    leaveRemnants(s, false, mode === "registered");
    if (mode === "other-checkout") git(s.repo, "worktree", "add", join(root, "remnant-other-checkout"), s.branch!);
    if (mode === "git-directory") mkdirSync(join(s.path, ".git"));
    if (mode === "modified") writeFileSync(join(s.path, "feature.txt"), "uncommitted work");
    if (mode === "untracked") writeFileSync(join(s.path, "WIP.txt"), "untracked work");
    const before = mainState(s.repo);
    for (let attempt = 0; attempt < 2; attempt++) {
      const result = await cleanupAcceptedTask(s.repo, s.task.id, "main");
      if (mode === "clean") {
        assert.equal(result.ok, true, JSON.stringify(result));
        if (attempt === 0) checkBackup(s, result.worktreeBackupPath);
        else assert.equal(result.worktreeBackupPath, undefined, "重复清理不再创建备份");
      } else {
        assert.equal(result.ok, false, `${mode} must be retained`);
        if (result.ok) throw new Error("unsafe remnants cleaned");
        assert.equal(result.reason, "worktree_remove_failed");
        assert.equal(result.worktreeBackupPath, undefined);
        assert.equal(readFileSync(join(s.path, "feature.txt"), "utf8"), mode === "modified" ? "uncommitted work" : "committed feature\n");
        assert.equal(readFileSync(join(s.path, "node_modules", ".vite", "cache.json"), "utf8"), "preserved cache");
        if (mode === "untracked") assert.equal(readFileSync(join(s.path, "WIP.txt"), "utf8"), "untracked work");
        if (mode === "registered") assert.match(result.message, /新建文件.*\.git/);
      }
      assert.deepEqual(mainState(s.repo), before, "恢复检查不能改主仓 HEAD、源码或 index");
    }
    console.log(`✓ pointer-less remnants ${mode}: safe recovery, repeatability and main checkout protection`);
  }

  for (const keepPointer of [true, false]) {
    const s = await setup();
    const source = git(s.path, "rev-parse", "HEAD");
    git(s.repo, "merge", "--no-ff", "--no-edit", s.branch!);
    const pointer = leaveRemnants(s, keepPointer);
    git(s.repo, "branch", "-d", s.branch!);
    const before = mainState(s.repo);
    for (let attempt = 0; attempt < 2; attempt++) {
      const result = await cleanupAcceptedTask(s.repo, s.task.id, "main");
      assert.equal(result.ok, false);
      if (result.ok) throw new Error("unverifiable remnants cleaned");
      assert.equal(result.reason, "worktree_remove_failed");
      assert.match(result.message, /任务分支.*不存在或无法解析.*无法核对残留源码.*目录及文件已保留.*已核实的提交.*恢复.*重试/);
      assert.ok(result.message.includes(s.branch!));
      assert.doesNotMatch(result.message, /fatal:|权限|占用进程|文件系统状态/);
      assert.equal(result.worktreeBackupPath, undefined);
      assert.equal(readFileSync(join(s.path, "feature.txt"), "utf8"), "committed feature\n");
      assert.equal(readFileSync(join(s.path, "node_modules", ".vite", "cache.json"), "utf8"), "preserved cache");
      if (keepPointer) assert.equal(readFileSync(join(s.path, ".git"), "utf8"), pointer);
      assert.deepEqual(mainState(s.repo), before);
    }
    git(s.repo, "branch", s.branch!, source);
    const resumed = await cleanupAcceptedTask(s.repo, s.task.id, "main");
    assert.equal(resumed.ok, true, JSON.stringify(resumed));
    checkBackup(s, resumed.worktreeBackupPath, keepPointer ? pointer : undefined);
    assert.deepEqual(mainState(s.repo), before);
    console.log(`✓ missing branch (${keepPointer ? "dangling" : "absent"} pointer): actionable error, files retained, restored branch allows retry`);
  }

  {
    const s = await setup();
    git(s.repo, "merge", "--no-ff", "--no-edit", s.branch!);
    leaveRemnants(s);
    const before = mainState(s.repo);
    const result = await acceptTask(s.task.id, "human", { confirmUnverified: true });
    assert.equal(result.accepted, true, JSON.stringify(result));
    assert.equal((await db.select().from(tasks).where(eq(tasks.id, s.task.id)))[0].stage, "accepted");
    const log = readFileSync(join(root, "runs", s.task.id, `${s.task.projectId}.md`), "utf8");
    const backup = /全部残留文件已备份到 (.+?)。/.exec(log)?.[1];
    checkBackup(s, backup);
    assert.match(log, /备份包含依赖缓存.*不会自动清理.*确认无误后可直接删除/);
    assert.deepEqual(mainState(s.repo), before);
    const repeated = await acceptTask(s.task.id, "human", { confirmUnverified: true });
    assert.equal(repeated.accepted && repeated.kind, "already_accepted");
    checkBackup(s, backup);
    console.log("✓ pointer-less remnants reach accepted with a persistent backup location and safe repeated acceptance");
  }
}
