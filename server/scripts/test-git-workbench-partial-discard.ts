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
} finally {
  const { dbClient } = await import("../src/db/index.js");
  dbClient.close();
  rmSync(directory, { recursive: true, force: true });
}
