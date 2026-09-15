import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { GitAction } from "@ash/shared/git-workbench";

const directory = realpathSync(
  mkdtempSync(join(tmpdir(), "ash-workbench-outcomes-")),
);
process.env.ASH_DB = join(directory, "ash.db");
process.env.GIT_CONFIG_GLOBAL = join(directory, "gitconfig");
process.env.GIT_CONFIG_NOSYSTEM = "1";
writeFileSync(
  process.env.GIT_CONFIG_GLOBAL,
  "[user]\nname = Outcomes Test\nemail = test@example.test\n[commit]\ngpgsign = false\n[core]\nautocrlf = false\n",
);
const git = (root: string, ...args: string[]) =>
  execFileSync("git", ["-C", root, ...args], {
    encoding: "utf8",
    stdio: "pipe",
  }).trim();
const write = (root: string, content: string) =>
  writeFileSync(join(root, "file.txt"), content + "\n");
const commit = (root: string, content: string) => {
  write(root, content);
  git(root, "add", "file.txt");
  git(root, "commit", "-qm", content);
  return git(root, "rev-parse", "HEAD");
};
const seed = (name: string) => {
  const root = join(directory, name);
  execFileSync("git", ["init", "-q", "-b", "main", root]);
  commit(root, "base");
  return root;
};

try {
  const { ensureSchema } = await import("../src/db/index.js");
  const { readWorkbench } = await import("../src/git-workbench/read.js");
  const { executeWorkbench } = await import(
    "../src/git-workbench/operations.js"
  );
  const { readConflict } = await import("../src/git-workbench/conflicts.js");
  const { confirmationFor } = await import("../src/git-workbench/core.js");
  await ensureSchema();
  const state = (root: string) => readWorkbench(root, root, "tester");
  const run = async (root: string, action: GitAction) => {
    const current = await state(root);
    return executeWorkbench(
      root,
      "outcomes-test",
      { id: "tester", name: "Tester" },
      {
        root,
        version: current.version,
        action,
        confirmation: confirmationFor(action, current.status) || undefined,
      },
    );
  };
  const rejected = async (
    root: string,
    action: GitAction,
    outcome: "failed" | "conflict",
    status = 409,
  ) => {
    await assert.rejects(
      () => run(root, action),
      (error: unknown) => {
        assert.equal((error as { status: number }).status, status);
        return true;
      },
    );
    const current = await state(root);
    const entry = current.journal[0];
    assert.equal(entry.action, action.kind);
    assert.equal(entry.state, outcome);
    assert.equal(
      entry.message.includes("Git 操作尚未完成"),
      outcome === "conflict",
    );
    return current;
  };
  const resolve = async (root: string, content: string) =>
    run(root, {
      kind: "resolve",
      path: "file.txt",
      version: (await readConflict(root, "file.txt")).version,
      choice: "content",
      content: content + "\n",
    });
  const snapshot = async (root: string) => {
    const current = await state(root);
    return {
      status: current.status,
      backups: current.backups,
      head: git(root, "rev-parse", "HEAD"),
      refs: git(root, "show-ref"),
      index: git(root, "ls-files", "--stage"),
      content: readFileSync(join(root, "file.txt"), "utf8"),
    };
  };

  const root = seed("allow-list-errors");
  git(root, "checkout", "-qb", "other");
  commit(root, "other");
  git(root, "checkout", "-q", "main");
  commit(root, "main");
  await rejected(
    root,
    { kind: "merge", target: "other", strategy: "ff" },
    "conflict",
  );
  const original = await snapshot(root);
  const version = (await readConflict(root, "file.txt")).version;
  const invalid: [GitAction, number][] = [
    [{ kind: "stage", paths: ["missing.txt"] }, 409],
    [
      {
        kind: "resolve",
        path: "file.txt",
        version: "0".repeat(64),
        choice: "content",
        content: "stale\n",
      },
      409,
    ],
    [
      {
        kind: "resolve",
        path: "file.txt",
        version,
        choice: "content",
        content: "<<<<<<< unresolved\n",
      },
      409,
    ],
    [{ kind: "continue" }, 409],
    [{ kind: "skip" }, 400],
  ];
  for (const [action, status] of invalid) {
    const current = await rejected(root, action, "failed", status);
    assert.equal(current.journal[0].before, original.head);
    assert.equal(current.journal[0].after, original.head);
    assert.deepEqual(
      await snapshot(root),
      original,
      `${action.kind} rejection must preserve existing conflict`,
    );
  }
  await run(root, { kind: "abort" });
  await rejected(root, { kind: "stage", paths: ["missing.txt"] }, "failed");
  console.log(
    "ok · allow-list validation failures preserve existing conflict and log failed in both conflicted and clean repositories",
  );

  const replay = seed("continuation");
  git(replay, "checkout", "-qb", "source");
  const commits = ["one", "two", "three"].map((text) => commit(replay, text));
  git(replay, "checkout", "-q", "main");
  commit(replay, "main");
  assert.throws(() => git(replay, "cherry-pick", ...commits));
  await resolve(replay, "custom resolution");
  const continued = await rejected(replay, { kind: "continue" }, "conflict");
  assert.equal(continued.status.operation, "cherry-pick");
  assert.match((await readConflict(replay, "file.txt")).theirs!, /two/);
  const skipped = await rejected(replay, { kind: "skip" }, "conflict");
  assert.equal(skipped.status.operation, "cherry-pick");
  assert.match((await readConflict(replay, "file.txt")).theirs!, /three/);
  await run(replay, { kind: "abort" });

  const planned = seed("planned-rebase");
  const base = git(planned, "rev-parse", "HEAD");
  const first = commit(planned, "one");
  const second = commit(planned, "two");
  await rejected(
    planned,
    {
      kind: "rebase-plan",
      target: base,
      steps: [
        { sha: second, action: "pick", message: "" },
        { sha: first, action: "drop", message: "" },
      ],
    },
    "conflict",
  );
  await run(planned, { kind: "abort" });
  console.log(
    "ok · real continue/skip attempts reaching another conflict and interactive rebase keep conflict outcomes",
  );

  for (const kind of ["stash-apply", "stash-pop"] as const) {
    const repo = seed(kind);
    write(repo, "stashed");
    await run(repo, {
      kind: "stash-save",
      message: "outcomes",
      untracked: false,
    });
    const stash = (await state(repo)).stashes[0];
    commit(repo, "main");
    const conflicted = await rejected(
      repo,
      { kind, sha: stash.sha },
      "conflict",
    );
    assert.equal(conflicted.status.operation, null);
    assert.equal(conflicted.status.merge.length, 1);
    assert.equal(conflicted.stashes[0].sha, stash.sha);
    git(repo, "reset", "--hard", "HEAD");
  }
  console.log(
    "ok · stash apply/pop conflicts without an active sequencer keep conflict outcomes and retain the stash",
  );

  for (const strategy of ["merge", "rebase"] as const) {
    const repo = seed(`pull-${strategy}`);
    const remote = join(directory, `remote-${strategy}.git`);
    execFileSync("git", ["init", "--bare", "-q", "-b", "main", remote]);
    git(repo, "remote", "add", "origin", remote);
    git(repo, "push", "-qu", "origin", "main");
    const author = join(directory, `author-${strategy}`);
    execFileSync("git", ["clone", "-q", remote, author]);
    commit(author, "remote");
    git(author, "push", "-q");
    commit(repo, "local");
    const pulled = await rejected(repo, { kind: "pull", strategy }, "conflict");
    assert.equal(pulled.status.merge.length, 1);
    await run(repo, { kind: "abort" });
    const refused = await rejected(
      repo,
      { kind: "pull", strategy: "ff-only" },
      "failed",
    );
    assert.equal(refused.status.operation, null);
    assert.equal(refused.status.merge.length, 0);
  }
  console.log(
    "ok · pull merge/rebase conflicts stay actionable; ff-only refusal without a conflict logs failed",
  );
} finally {
  const { dbClient } = await import("../src/db/index.js");
  dbClient.close();
  rmSync(directory, { recursive: true, force: true });
}
