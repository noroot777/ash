import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { GitAction } from "@ash/shared/git-workbench";

const directory = realpathSync(
  mkdtempSync(join(tmpdir(), "ash-partial-discard-")),
);
const root = join(directory, "repo");
process.env.ASH_DB = join(directory, "test.db");
process.env.GIT_CONFIG_GLOBAL = join(directory, "gitconfig");
process.env.GIT_CONFIG_NOSYSTEM = "1";
writeFileSync(
  process.env.GIT_CONFIG_GLOBAL,
  "[user]\nname = Test\nemail = test@example.test\n[commit]\ngpgsign = false\n",
);
mkdirSync(root);
const git = (...args: string[]) =>
  execFileSync("git", ["-C", root, ...args], { encoding: "utf8" });
try {
  const { readWorkbench, readDetail } = await import(
    "../src/git-workbench/read.js"
  );
  const { executeWorkbench } = await import(
    "../src/git-workbench/operations.js"
  );
  const { parseAction } = await import("../src/git-workbench/input.js");
  const { selectedPatch } = await import("../src/git-workbench/patch.js");
  git("init", "-b", "main");
  const lines = Array.from({ length: 22 }, (_, index) => `line ${index + 1}`);
  const path = "file[1].txt";
  const write = () => writeFileSync(join(root, path), lines.join("\n") + "\n");
  write();
  const noEolPath = "noeol.txt";
  const noEolBase = "a\nb\nc\nlast-no-eol";
  const noEolModified = "a\nB\nc\nlast-no-eol";
  writeFileSync(join(root, noEolPath), noEolBase);
  const prefixCases = [
    { path: "separator.md", before: "---", after: [], rows: ["----"] },
    { path: "comment.sql", before: "-- SQL comment", after: [], rows: ["--- SQL comment"] },
    { path: "increment.js", before: "counter();", after: ["++counter;", "counter();"], rows: ["+++counter;"] },
    { path: "headers.txt", before: "-- a/example.txt", after: ["++ b/example.txt"], rows: ["--- a/example.txt", "+++ b/example.txt"] },
  ].map((entry) => {
    const base = Array.from({ length: 24 }, (_, i) => `prefix line ${i + 1}`);
    base[9] = entry.before;
    const modified = [...base];
    modified.splice(9, 1, ...entry.after);
    modified[modified.indexOf("prefix line 12")] = "prefix line 12 EDITED";
    const original = base.join("\n") + "\n";
    writeFileSync(join(root, entry.path), original);
    return { ...entry, original, modified: modified.join("\n") + "\n" };
  });
  git("add", ".");
  git("commit", "-m", "base");
  lines[10] = "staged change";
  write();
  git("add", ".");
  lines[1] = "discard this";
  lines[20] = "preserve this";
  write();
  writeFileSync(join(root, "untracked.txt"), "preserve untracked\n");
  const original = readFileSync(join(root, path), "utf8");
  const index = git("show", `:${path}`),
    head = git("rev-parse", "HEAD");
  const diff = (await readDetail(root, { path, source: "unstaged" })).diff;
  const selected = diff
    .split("\n")
    .flatMap((line, index) =>
      line === "-line 2" || line === "+discard this" ? [index] : [],
    );
  assert.equal(selected.length, 2);
  const action: GitAction = {
    kind: "discard-patch",
    path,
    diff,
    lines: selected,
  };
  const request = {
    root,
    version: (await readWorkbench(root, root, "test")).version,
    action,
  };
  assert.equal(parseAction(request).action.kind, "discard-patch");
  await assert.rejects(
    executeWorkbench(
      root,
      "test-project",
      { id: "test", name: "Test" },
      request,
    ),
    /输入「丢弃」/,
  );
  await assert.rejects(
    executeWorkbench(
      root,
      "test-project",
      { id: "test", name: "Test" },
      {
        ...request,
        confirmation: "丢弃",
        action: { ...action, diff: diff + "stale" },
      },
    ),
    /差异已变化/,
  );
  assert.equal(readFileSync(join(root, path), "utf8"), original);
  const result = await executeWorkbench(
    root,
    "test-project",
    { id: "test", name: "Test" },
    { ...request, confirmation: "丢弃" },
  );
  assert.equal(result.entry.state, "succeeded");
  lines[1] = "line 2";
  assert.equal(readFileSync(join(root, path), "utf8"), lines.join("\n") + "\n");
  assert.equal(git("show", `:${path}`), index);
  assert.equal(git("rev-parse", "HEAD"), head);
  assert.equal(
    readFileSync(join(root, "untracked.txt"), "utf8"),
    "preserve untracked\n",
  );
  await assert.rejects(
    executeWorkbench(
      root,
      "test-project",
      { id: "test", name: "Test" },
      { ...request, confirmation: "丢弃" },
    ),
    /工作区已经变化/,
  );
  const journal = (await readWorkbench(root, root, "test")).journal;
  assert.ok(
    journal.some(
      (entry) =>
        entry.action === "discard-patch" && entry.state === "succeeded",
    ),
  );
  console.log(
    "ok · partial discard requires confirmation and fresh content; only selected lines change, index/HEAD/other edits/untracked files survive",
  );

  writeFileSync(join(root, noEolPath), noEolModified);
  const stagedBefore = git("diff", "--cached");
  const actor = { id: "test", name: "Test" };
  const run = async (action: GitAction, confirmation?: string) =>
    executeWorkbench(root, "test-project", actor, {
      root,
      version: (await readWorkbench(root, root, actor.id)).version,
      action,
      confirmation,
    });
  const rejectNoEol = async (
    source: "unstaged" | "staged",
    kind: "discard-patch" | "patch",
    label: string,
  ) => {
    const diff = (await readDetail(root, { path: noEolPath, source })).diff;
    assert.match(diff, /^\\ No newline at end of file/m);
    const selected = diff.split("\n").flatMap((line, index) =>
      /^[+-]/.test(line) && !/^(---|\+\+\+)/.test(line) ? [index] : [],
    );
    const before = {
      head: git("rev-parse", "HEAD"),
      index: git("ls-files", "-s", "-z"),
      file: readFileSync(join(root, noEolPath), "utf8"),
      status: git("status", "--porcelain=v2", "-z"),
    };
    const action: GitAction = kind === "discard-patch"
      ? { kind, path: noEolPath, diff, lines: selected }
      : { kind, path: noEolPath, source, diff, lines: selected };
    const expected = `无末尾换行的改动请按整个文件${label}`;
    await assert.rejects(run(action, kind === "discard-patch" ? "丢弃" : undefined),
      (error: Error) => error.message === expected);
    const entry = (await readWorkbench(root, root, actor.id)).journal[0];
    assert.equal(entry.state, "failed");
    assert.equal(entry.message, expected);
    assert.equal(git("rev-parse", "HEAD"), before.head);
    assert.equal(git("ls-files", "-s", "-z"), before.index);
    assert.equal(readFileSync(join(root, noEolPath), "utf8"), before.file);
    assert.equal(git("status", "--porcelain=v2", "-z"), before.status);
  };
  await rejectNoEol("unstaged", "discard-patch", "丢弃");
  await rejectNoEol("unstaged", "patch", "暂存");
  await run({ kind: "stage", paths: [noEolPath] });
  assert.equal(git("show", `:${noEolPath}`), noEolModified);
  await rejectNoEol("staged", "patch", "取消暂存");
  await run({ kind: "unstage", paths: [noEolPath] });
  assert.equal(git("show", `:${noEolPath}`), noEolBase);
  await run({ kind: "discard", paths: [noEolPath], deleteUntracked: [] }, "丢弃");
  assert.equal(readFileSync(join(root, noEolPath), "utf8"), noEolBase);
  assert.equal(readFileSync(join(root, path), "utf8"), lines.join("\n") + "\n");
  assert.equal(git("diff", "--cached"), stagedBefore);
  assert.equal(git("rev-parse", "HEAD"), head);
  console.log("ok · no-final-newline rejections use the requested action, preserve state and journal the reason; whole-file stage/unstage/discard remain valid");

  const allChangeLines = (diff: string) => {
    const rows = diff.split("\n");
    const firstHunk = rows.findIndex((row) => row.startsWith("@@ "));
    assert(firstHunk >= 0);
    return rows.flatMap((row, i) => i > firstHunk && /^[+-]/.test(row) ? [i] : []);
  };
  for (const entry of prefixCases) {
    writeFileSync(join(root, entry.path), entry.modified);
    const diff = (await readDetail(root, { path: entry.path, source: "unstaged" })).diff;
    const rows = diff.split("\n");
    const selected = allChangeLines(diff);
    for (const row of entry.rows) {
      assert(selected.includes(rows.indexOf(row)), `${entry.path}: ${row} must be selected`);
    }
    const fileHeaders = rows.flatMap((row, i) =>
      i < rows.findIndex((line) => line.startsWith("@@ ")) && /^[+-]/.test(row) ? [i] : [],
    );
    assert.equal(fileHeaders.length, 2);
    for (const operation of ["stage", "unstage", "discard"] as const) {
      for (const fileHeader of fileHeaders) {
        assert.throws(() => selectedPatch(diff, [fileHeader], operation), /请选择改动行/);
      }
    }

    await run({ kind: "patch", path: entry.path, source: "unstaged", diff, lines: selected });
    assert.equal(git("show", `:${entry.path}`), entry.modified);
    assert.equal(git("diff", "--", entry.path), "", "the entire hunk must be staged");
    assert.equal(readFileSync(join(root, entry.path), "utf8"), entry.modified);
    assert.equal(git("show", `:${path}`), index, "other staged content must survive");

    const stagedDiff = (await readDetail(root, { path: entry.path, source: "staged" })).diff;
    await run({ kind: "patch", path: entry.path, source: "staged", diff: stagedDiff, lines: allChangeLines(stagedDiff) });
    assert.equal(git("show", `:${entry.path}`), entry.original);
    assert.equal(git("diff", "--cached"), stagedBefore, "unstaging must preserve the original index");
    assert.equal(readFileSync(join(root, entry.path), "utf8"), entry.modified);

    const discardDiff = (await readDetail(root, { path: entry.path, source: "unstaged" })).diff;
    await run({ kind: "discard-patch", path: entry.path, diff: discardDiff, lines: allChangeLines(discardDiff) }, "丢弃");
    assert.equal(readFileSync(join(root, entry.path), "utf8"), entry.original);
    assert.equal(git("diff", "--", entry.path), "", "hunk discard must leave no hidden prefix edit");
    assert.equal(git("diff", "--cached"), stagedBefore);
    assert.equal(git("rev-parse", "HEAD"), head);
    assert.equal(readFileSync(join(root, path), "utf8"), lines.join("\n") + "\n");
    assert.equal(readFileSync(join(root, "untracked.txt"), "utf8"), "preserve untracked\n");
  }
  console.log("ok · hunk stage/unstage/discard include separator, comment, increment and header-like content; actual file headers remain unselectable");
} finally {
  const { dbClient } = await import("../src/db/index.js");
  dbClient.close();
  rmSync(directory, { recursive: true, force: true });
}
