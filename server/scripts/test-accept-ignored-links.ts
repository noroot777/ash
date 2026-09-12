import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, symlinkSync, writeFileSync } from "node:fs";
import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { mock } from "node:test";
import { dirname, join, relative } from "node:path";
import { eq } from "drizzle-orm";
import { db } from "../src/db/index.js";
import { tasks } from "../src/db/schema.js";
import { acceptTask } from "../src/task-accept.js";

type Fixture = { repo: string; path: string; branch: string | null; task: { id: string; projectId: string } };
const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const snapshot = (repo: string) => ({ head: git(repo, "rev-parse", "HEAD"), status: git(repo, "--no-optional-locks", "status", "--porcelain"), index: readFileSync(join(repo, ".git", "index")) });
const contents = (path: string) => existsSync(path) ? readFileSync(path, "utf8") : null;

function nativeIgnoredTargetContents(root: string): string | null {
  const repo = join(root, "native-ignored-link"), worktree = join(root, "native-ignored-worktree");
  mkdirSync(repo);
  git(repo, "init", "-b", "main");
  git(repo, "config", "user.name", "Native Cleanup Test");
  git(repo, "config", "user.email", "cleanup@example.test");
  writeFileSync(join(repo, ".gitignore"), "node_modules\n");
  git(repo, "add", "."); git(repo, "commit", "-m", "native ignored link control");
  git(repo, "worktree", "add", "--detach", worktree);
  const external = join(repo, "node_modules");
  mkdirSync(external); writeFileSync(join(external, "external.txt"), "external dependency survives");
  symlinkSync(external, join(worktree, "node_modules"), process.platform === "win32" ? "junction" : "dir");
  git(repo, "worktree", "remove", worktree);
  return contents(join(external, "external.txt"));
}

export async function testIgnoredDependencyLinks(root: string, setup: () => Promise<Fixture>): Promise<void> {
  // Windows Git 原生删除 junction 会遍历目标；故障回退的对照是原生行为，正常撤链仍保护目标。
  const nativeTarget = nativeIgnoredTargetContents(root);
  console.log(`Native ignored dependency fallback retains target: ${nativeTarget !== null}`);
  const modes = ["internal", "hoisted", "tracked-hoisted", "tracked-inner-link", "hoisted-dirty", "hoisted-untracked", "ignored-lstat-fails", "ignored-readlink-fails", "ignored-unlink-fails", "untracked-readlink-fails", "untracked-unlink-fails"] as const;
  for (const mode of modes) {
    const s = await setup();
    const externalCase = mode.endsWith("fails");
    const ignored = !mode.startsWith("untracked-");
    writeFileSync(join(s.path, ".gitignore"), ignored ? "node_modules\n" : "");
    const external = ignored ? join(s.repo, "node_modules") : join(root, `${s.task.id}-external`);
    mkdirSync(external);
    writeFileSync(join(external, "external.txt"), "external dependency survives");
    let link: string;
    let target: string;
    if (externalCase) {
      link = join(s.path, "node_modules"); target = external;
    } else if (mode === "internal") {
      target = join(s.path, "shared-deps"); link = join(s.path, "node_modules");
      mkdirSync(target); writeFileSync(join(target, "source.txt"), "tracked internal dependency");
    } else {
      target = join(s.path, "node_modules");
      mkdirSync(target); writeFileSync(join(target, "cache.txt"), "local cached dependency");
      link = mode === "tracked-inner-link" ? join(target, "inner-link") : join(s.path, "packages", "app one", "node_modules");
      mkdirSync(dirname(link), { recursive: true });
      mkdirSync(join(s.path, "packages", "app one"), { recursive: true });
      writeFileSync(join(s.path, "packages", "app one", "source.txt"), "tracked package");
      if (mode === "tracked-hoisted" || mode === "tracked-inner-link") {
        writeFileSync(join(target, "tracked.txt"), "tracked dependency fixture");
        git(s.path, "add", "-f", "node_modules/tracked.txt");
      }
    }
    git(s.path, "add", "-A");
    git(s.path, "commit", "-m", "ignored link fixture");
    git(s.repo, "merge", "--no-ff", "--no-edit", s.branch!);
    const before = snapshot(s.repo);
    assert.equal(before.status, "", `${mode}: main checkout is clean`);
    symlinkSync(process.platform === "win32" ? target : relative(dirname(link), target), link, process.platform === "win32" ? "junction" : "dir");
    const linkValue = readlinkSync(link);
    const status = git(s.path, "status", "--porcelain", "--ignored=matching", "--untracked-files=all");
    if (ignored) { assert.ok(status.includes("!!"), status); assert.ok(!status.includes("??"), status); }
    else assert.ok(status.includes("??"), status);
    if (mode === "tracked-inner-link") assert.match(status, /!! node_modules\/inner-link/, "Git 枚举出 ignored 目录里的内部链接");
    if (mode === "hoisted-dirty") writeFileSync(join(s.path, "feature.txt"), "uncommitted source");
    if (mode === "hoisted-untracked") writeFileSync(join(s.path, "WIP.txt"), "untracked source");
    const operation = mode.includes("lstat") ? "lstat" : mode.includes("readlink") ? "readlink" : "unlink";
    const original = fs[operation];
    let faults = 0;
    const fault = externalCase ? mock.method(fs, operation, async (...args: any[]) => {
      if (String(args[0]) === link) { faults++; throw Object.assign(new Error("fixture dependency link unavailable"), { code: "EACCES" }); }
      return (original as (...args: any[]) => any)(...args);
    }) : null;
    syncBuiltinESMExports();
    const blocked = mode === "hoisted-dirty" || mode === "hoisted-untracked" || !ignored;
    try {
      for (let attempt = 0; attempt < 2; attempt++) {
        const result = await acceptTask(s.task.id, "human", { confirmUnverified: true });
        assert.equal(result.accepted, !blocked, `${mode}: ${JSON.stringify(result)}`);
        if (!ignored && !result.accepted) assert.match(result.error, /fixture dependency link unavailable/);
        assert.deepEqual(snapshot(s.repo), before);
        assert.equal(contents(join(external, "external.txt")), externalCase && ignored ? nativeTarget : "external dependency survives");
        if (blocked) {
          assert.equal(lstatSync(link).isSymbolicLink(), true);
          assert.equal(readlinkSync(link), linkValue);
          if (mode === "hoisted-dirty") assert.equal(readFileSync(join(s.path, "feature.txt"), "utf8"), "uncommitted source");
          if (mode === "hoisted-untracked") assert.equal(readFileSync(join(s.path, "WIP.txt"), "utf8"), "untracked source");
        } else {
          assert.equal(existsSync(s.path), false);
          assert.equal((await db.select().from(tasks).where(eq(tasks.id, s.task.id)))[0].stage, "accepted");
          const log = readFileSync(join(root, "runs", s.task.id, `${s.task.projectId}.md`), "utf8");
          if (mode === "ignored-lstat-fails") assert.doesNotMatch(log, /随 worktree 一并删除了 Git 忽略的本地文件或目录/);
          else assert.match(log, /随 worktree 一并删除了 Git 忽略的本地文件或目录/);
          assert.doesNotMatch(log, /依赖链接.*指向工作区内部或涉及已跟踪文件/);
          if (attempt) assert.equal(result.accepted && result.kind, "already_accepted");
        }
      }
      if (externalCase) assert.ok(faults > 0, `${mode}: fault injected`);
    } finally { fault?.mock.restore(); syncBuiltinESMExports(); }
    console.log(`✓ ignored dependency link ${mode}: native cleanup semantics, retry and source protection`);
  }
}
