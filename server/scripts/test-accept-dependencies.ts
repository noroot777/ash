import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { eq } from "drizzle-orm";
import { db } from "../src/db/index.js";
import { tasks } from "../src/db/schema.js";
import { acceptTask } from "../src/task-accept.js";
import { cleanupAcceptedTask } from "../src/git-accept.js";

type Fixture = { repo: string; path: string; branch: string | null; task: { id: string; projectId: string } };
const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const snapshot = (repo: string) => ({ head: git(repo, "rev-parse", "HEAD"), status: git(repo, "--no-optional-locks", "status", "--porcelain"), index: readFileSync(join(repo, ".git", "index")) });
const linkExists = (path: string) => { try { return lstatSync(path).isSymbolicLink(); } catch { return false; } };

export async function testAcceptanceDependencies(root: string, setup: () => Promise<Fixture>): Promise<void> {
  for (const mode of ["root", "nested", "relative", "dangling", "ignored", "untracked-parent", "modified", "untracked", "internal", "tracked", "real-untracked"] as const) {
    const s = await setup();
    const nested = mode === "nested" || mode === "untracked-parent";
    const link = join(s.path, ...(nested ? ["packages", "app one"] : []), "node_modules");
    const external = ["tracked", "real-untracked"].includes(mode) ? join(root, `${s.task.id}-dependencies`) : join(s.repo, "node_modules");
    mkdirSync(external);
    writeFileSync(join(external, "fixture.txt"), "original dependency data");
    if (nested) mkdirSync(dirname(link), { recursive: true });
    if (mode === "nested") writeFileSync(join(dirname(link), "app.txt"), "tracked package");
    if (mode === "internal") {
      mkdirSync(join(s.path, "local-deps"));
      writeFileSync(join(s.path, "local-deps", "fixture.txt"), "local source");
    }
    if (mode === "ignored") writeFileSync(join(s.path, ".gitignore"), "node_modules\n");
    if (mode === "real-untracked") writeFileSync(join(s.path, ".gitignore"), "");
    if (mode === "tracked") writeFileSync(link, "tracked file");
    git(s.path, "add", "-A");
    if (mode === "tracked") git(s.path, "add", "-f", "node_modules");
    if (git(s.path, "status", "--porcelain")) git(s.path, "commit", "-m", "dependency fixture");
    git(s.repo, "merge", "--no-ff", "--no-edit", s.branch!);
    const before = snapshot(s.repo);
    const target = mode === "internal" ? join(s.path, "local-deps") : mode === "dangling" ? join(external, "missing") : external;
    if (mode === "tracked") rmSync(link);
    if (mode === "real-untracked") {
      mkdirSync(link);
      writeFileSync(join(link, "WIP.txt"), "untracked dependency source");
    } else {
      symlinkSync(mode === "relative" ? relative(dirname(link), target) : target, link,
        process.platform === "win32" && mode !== "relative" ? "junction" : "dir");
    }
    if (mode === "modified") writeFileSync(join(s.path, "feature.txt"), "uncommitted source");
    if (mode === "untracked") writeFileSync(join(s.path, "WIP.txt"), "untracked source");
    const blocked = ["modified", "untracked", "internal", "tracked", "real-untracked"].includes(mode);
    const pointer = mode === "real-untracked" ? null : readlinkSync(link);
    for (let attempt = 0; attempt < 2; attempt++) {
      const result = await acceptTask(s.task.id, "human", { confirmUnverified: true });
      assert.equal(result.accepted, !blocked, `${mode}: ${JSON.stringify(result)}`);
      assert.equal(readFileSync(join(external, "fixture.txt"), "utf8"), "original dependency data");
      assert.deepEqual(snapshot(s.repo), before, "依赖清理不修改主仓 HEAD、文件或索引");
      if (blocked) {
        assert.ok(existsSync(s.path));
        if (pointer !== null) { assert.equal(linkExists(link), true); assert.equal(readlinkSync(link), pointer); }
        if (mode === "modified") assert.equal(readFileSync(join(s.path, "feature.txt"), "utf8"), "uncommitted source");
        if (mode === "untracked") assert.equal(readFileSync(join(s.path, "WIP.txt"), "utf8"), "untracked source");
        if (mode === "real-untracked") assert.equal(readFileSync(join(link, "WIP.txt"), "utf8"), "untracked dependency source");
      } else {
        assert.equal(existsSync(s.path), false);
        assert.equal((await db.select().from(tasks).where(eq(tasks.id, s.task.id)))[0].stage, "accepted");
        const log = readFileSync(join(root, "runs", s.task.id, `${s.task.projectId}.md`), "utf8");
        assert.match(log, /已撤下借用的依赖符号链接.*node_modules.*链接目标未删除/);
        if (attempt) assert.equal(result.accepted && result.kind, "already_accepted");
      }
    }
    console.log(`✓ borrowed dependency ${mode}: acceptance, target preservation and uncommitted source protection`);
  }

  {
    const s = await setup();
    mkdirSync(join(s.path, "node_modules"));
    writeFileSync(join(s.path, "node_modules", "local-cache.txt"), "local install");
    const result = await acceptTask(s.task.id, "human", { confirmUnverified: true });
    assert.equal(result.accepted, true, JSON.stringify(result));
    const log = readFileSync(join(root, "runs", s.task.id, `${s.task.projectId}.md`), "utf8");
    assert.match(log, /随 worktree 一并删除了 Git 忽略的本地文件或目录：node_modules.*未另行备份/);
    assert.equal(existsSync(s.path), false);
    console.log("✓ real ignored dependency directories are explicitly accounted for in the persistent acceptance timeline");
  }

  for (const keepPointer of [false, true]) {
    const s = await setup();
    git(s.repo, "config", "core.symlinks", "false");
    writeFileSync(join(s.path, "ignore-rules.txt"), "node_modules/\n.env\n");
    writeFileSync(join(s.path, ".gitignore"), "ignore-rules.txt");
    git(s.path, "add", "-f", "ignore-rules.txt");
    const blob = execFileSync("git", ["-C", s.repo, "hash-object", "-w", "--stdin"], { input: "ignore-rules.txt", encoding: "utf8" }).trim();
    git(s.path, "update-index", "--cacheinfo", `120000,${blob},.gitignore`);
    git(s.path, "commit", "-m", "symlink ignore fixture");
    const files = git(s.path, "ls-files", "-z").split("\0").filter(Boolean);
    git(s.repo, "merge", "--no-ff", "--no-edit", s.branch!);
    const admin = readFileSync(join(s.path, ".git"), "utf8").trim().slice("gitdir: ".length);
    rmSync(admin, { recursive: true });
    if (!keepPointer) rmSync(join(s.path, ".git"));
    for (const file of files) rmSync(join(s.path, file));
    mkdirSync(join(s.path, "node_modules"));
    writeFileSync(join(s.path, "node_modules", "cache.txt"), "preserved cache");
    writeFileSync(join(s.path, ".env"), "preserved local configuration");
    const before = snapshot(s.repo);
    for (let attempt = 0; attempt < 2; attempt++) {
      const result = await cleanupAcceptedTask(s.repo, s.task.id, "main");
      assert.equal(result.ok, false);
      if (result.ok) throw new Error("symlink ignore rules unexpectedly accepted");
      assert.match(result.message, /\.gitignore 是符号链接.*Git 不读取.*忽略规则.*目录及文件已保留.*移出.*重试/);
      assert.doesNotMatch(result.message, /请先保存这些改动|fatal:/);
      assert.equal(readFileSync(join(s.path, ".env"), "utf8"), "preserved local configuration");
      assert.equal(readFileSync(join(s.path, "node_modules", "cache.txt"), "utf8"), "preserved cache");
      assert.deepEqual(snapshot(s.repo), before);
    }
    rmSync(join(s.path, ".env"));
    rmSync(join(s.path, "node_modules"), { recursive: true });
    assert.equal((await cleanupAcceptedTask(s.repo, s.task.id, "main")).ok, true, "处理残留文件后可以按提示重试");
    console.log(`✓ symlink .gitignore (${keepPointer ? "dangling" : "absent"} pointer): accurate explanation, preserved files and actionable retry`);
  }
}
