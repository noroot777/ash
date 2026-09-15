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
  git("init", "-b", "main");
  const lines = Array.from({ length: 22 }, (_, index) => `line ${index + 1}`);
  const path = "file[1].txt";
  const write = () => writeFileSync(join(root, path), lines.join("\n") + "\n");
  write();
  const noEolPath = "noeol.txt";
  const noEolBase = "a\nb\nc\nlast-no-eol";
  const noEolModified = "a\nB\nc\nlast-no-eol";
  writeFileSync(join(root, noEolPath), noEolBase);
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
} finally {
  const { dbClient } = await import("../src/db/index.js");
  dbClient.close();
  rmSync(directory, { recursive: true, force: true });
}
