import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFileGitStatus } from "../src/file-git-status.js";
import { fileGitDecorations } from "../../web/src/files/fileGitDecorations.ts";

const stage = mkdtempSync(join(tmpdir(), "ash-file-git-"));
const repo = join(stage, "repo");
const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" });
const write = (path: string, content = path) => writeFileSync(join(repo, path), content);
const read = async (root = repo) => {
  const result = await readFileGitStatus(root);
  assert.equal(result.error, null);
  assert.equal(result.truncated, false);
  return result;
};

try {
  mkdirSync(join(repo, "src", "深层 目录"), { recursive: true });
  mkdirSync(join(repo, "old"));
  mkdirSync(join(repo, "dest"));
  mkdirSync(join(repo, "clean"));
  mkdirSync(join(stage, "hooks"));
  git("init", "-q");
  git("config", "user.name", "File tree test");
  git("config", "user.email", "file-tree@example.test");
  git("config", "commit.gpgSign", "false");
  git("config", "core.hooksPath", join(stage, "hooks"));
  write(".gitignore", "*.log\n");
  write("src/深层 目录/改动.ts", "initial\n");
  write("src/delete.ts", "delete\n");
  write("old/move.ts", "rename this unique source\n");
  write("dest/keep.ts");
  write("clean/keep.ts");
  write("src/conflict.ts", "initial\n");
  git("add", ".");
  git("commit", "-qm", "initial");
  const initialBranch = git("branch", "--show-current").trim();
  assert.deepEqual((await read()).changes, []);

  write("src/深层 目录/改动.ts", "staged\n");
  git("add", "src/深层 目录/改动.ts");
  write("src/深层 目录/改动.ts", "staged and unstaged\n");
  write("src/深层 目录/new.ts");
  write("src/深层 目录/ignore.log");
  rmSync(join(repo, "src/delete.ts"));
  git("mv", "old/move.ts", "dest/moved.ts");
  const status = await read();
  assert.equal(status.changes.filter((c) => c.path === "src/深层 目录/改动.ts").length, 2);
  assert.deepEqual(
    status.changes.filter((c) => c.path === "src/深层 目录/改动.ts").map((c) => c.source).sort(),
    ["staged", "unstaged"],
    "同一个文件两侧都改了时，两条记录各自带上自己那一侧",
  );
  assert.equal(status.changes.find((c) => c.path === "src/深层 目录/new.ts")?.source, "untracked");
  assert(!status.changes.some((c) => c.path.endsWith(".log")));
  const marks = fileGitDecorations(status);
  assert.equal(marks.get("src/深层 目录/改动.ts")?.kind, "modified");
  // 文件树里点开一个有颜色的文件就摊 diff，所以每个文件都得知道自己该比哪一段。
  assert.equal(marks.get("src/深层 目录/改动.ts")?.diff?.source, "unstaged", "两侧都有改动时先给工作树那份");
  assert.equal(marks.get("src/深层 目录/改动.ts")?.diff?.path, "src/深层 目录/改动.ts");
  assert.equal(marks.get("src/深层 目录/new.ts")?.kind, "untracked");
  assert.equal(marks.get("src/深层 目录/new.ts")?.diff?.source, "untracked");
  assert.equal(marks.get("src/深层 目录")?.kind, "modified");
  assert.equal(marks.get("src/深层 目录")?.diff, null, "目录没有可摊的 diff");
  assert.equal(marks.get("src")?.descendant, true);
  assert.equal(marks.get("")?.descendant, true);
  assert.equal(marks.get("old")?.kind, "deleted");
  assert.equal(marks.get("dest")?.kind, "renamed");
  assert.equal(marks.get("dest/moved.ts")?.diff?.source, "staged");
  assert.equal(marks.get("dest/moved.ts")?.diff?.origPath, "old/move.ts", "暂存侧的重命名要把来源路径一起交给 git");
  assert.equal(marks.get("old/move.ts")?.diff, null, "重命名的来源路径在树里已经没有了，不给对比入口");
  assert(!marks.has("clean"));
  assert(!marks.has("dest/keep.ts"));

  const scoped = fileGitDecorations(await read(join(repo, "src")));
  assert(scoped.has("深层 目录/改动.ts"));
  assert(scoped.has("深层 目录"));
  assert(!scoped.has("src"));
  assert(!scoped.has("dest"));
  assert(fileGitDecorations(await read(join(repo, "src", "深层 目录"))).has("改动.ts"));
  const movedOut = fileGitDecorations(await read(join(repo, "old")));
  assert.equal(movedOut.get("move.ts")?.kind, "deleted");
  assert.equal(fileGitDecorations(await read(join(repo, "dest"))).get("moved.ts")?.kind, "added");

  git("add", ".");
  assert.equal(fileGitDecorations(await read()).get("src/深层 目录/new.ts")?.kind, "added");
  git("commit", "-qm", "changes");
  assert.equal(fileGitDecorations(await read()).size, 0, "提交后所有文件和父目录标识消失");

  git("checkout", "-qb", "other");
  write("src/conflict.ts", "other branch\n");
  git("commit", "-qam", "other change");
  git("checkout", "-q", initialBranch);
  write("src/conflict.ts", "current branch\n");
  git("commit", "-qam", "current change");
  assert.throws(() => git("merge", "other"));
  const conflicts = fileGitDecorations(await read());
  assert.equal(conflicts.get("src/conflict.ts")?.kind, "unmerged");
  assert.equal(conflicts.get("src/conflict.ts")?.diff?.source, "unstaged", "冲突文件比的是工作树那一侧");
  assert.equal(conflicts.get("src")?.kind, "unmerged");
  assert.equal(conflicts.get("src")?.descendant, true);
  assert(!conflicts.has("clean"));

  const copy = fileGitDecorations({
    changes: [{ path: "dest/copy.ts", origPath: "clean/keep.ts", kind: "copied", source: "staged" }],
    truncated: false,
    error: null,
  });
  assert(copy.has("dest"));
  assert(!copy.has("clean"), "复制不会标记未改动的来源文件或目录");
  assert((await readFileGitStatus(stage)).error, "无法读取 Git 时返回可显示的错误");
  console.log("✓ file git status: staged/unstaged, ancestors, rename/copy, scoped paths, ignore, commit, conflict");
} finally {
  rmSync(stage, { recursive: true, force: true });
}
