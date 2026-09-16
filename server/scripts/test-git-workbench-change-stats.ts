import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile, rename } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);
const directory = await mkdtemp(join(tmpdir(), "ash-git-stats-"));
const root = join(directory, "repo");
process.env.ASH_DB = join(directory, "test.db");
process.env.GIT_CONFIG_GLOBAL = join(directory, "gitconfig");
process.env.GIT_CONFIG_NOSYSTEM = "1";
await writeFile(process.env.GIT_CONFIG_GLOBAL, "[commit]\ngpgsign = false\n");
await mkdir(root);
const git = async (...args: string[]) =>
  (await exec("git", ["-C", root, ...args])).stdout;
try {
  const { readChangeStats } = await import("../src/git-workbench/change-stats.js");
  await git("init", "-b", "main");
  await git("config", "user.name", "Stats Test");
  await git("config", "user.email", "stats@example.test");
  await git("config", "core.autocrlf", "false");
  assert.equal((await readChangeStats(root, true)).size, 0);
  const odd = "中文\tfile.txt";
  await writeFile(join(root, odd), "old\nkept\n");
  await writeFile(join(root, "rename.txt"), "a\nb\nc\nd\ne\n");
  await writeFile(join(root, "binary.bin"), Buffer.from([0, 1, 2]));
  await git("add", ".");
  await git("commit", "-m", "base");
  await writeFile(join(root, odd), "new\nkept\nadded\n");
  await rename(join(root, "rename.txt"), join(root, "renamed.txt"));
  await writeFile(join(root, "binary.bin"), Buffer.from([0, 4, 5]));
  await git("add", ".");
  await writeFile(join(root, odd), "newer\nkept\nadded\nlast\n");
  const before = await git("status", "--porcelain=v2", "-z");
  const head = await git("rev-parse", "HEAD");
  const staged = await readChangeStats(root, true);
  const unstaged = await readChangeStats(root, false);
  assert.deepEqual(staged.get(odd), { additions: 2, deletions: 1 });
  assert.deepEqual(unstaged.get(odd), { additions: 2, deletions: 1 });
  assert.deepEqual(staged.get("renamed.txt"), { additions: 0, deletions: 0 });
  assert.equal(staged.has("rename.txt"), false);
  assert.equal(staged.has("binary.bin"), false);
  assert.equal(await git("status", "--porcelain=v2", "-z"), before);
  assert.equal(await git("rev-parse", "HEAD"), head);
  console.log(
    "ok · real staged/unstaged statistics preserve tabbed paths, renames, binary files and repository state",
  );
} finally {
  const { dbClient } = await import("../src/db/index.js");
  dbClient.close();
  await rm(directory, { recursive: true, force: true });
}
