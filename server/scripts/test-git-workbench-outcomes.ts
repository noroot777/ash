import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { GitAction, GitActionRequest } from "@ash/shared/git-workbench";
import {
  gitActionBlockReason,
  emptyCommitGuidance,
} from "@ash/shared/git-workbench";

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
  const { readConflict, continueOperation } = await import(
    "../src/git-workbench/conflicts.js"
  );
  const { confirmationFor } = await import("../src/git-workbench/core.js");
  await ensureSchema();
  const state = (root: string) => readWorkbench(root, root, "tester");
  type RequestOverrides = Partial<
    Pick<GitActionRequest, "version" | "confirmation">
  >;
  const run = async (
    root: string,
    action: GitAction,
    overrides: RequestOverrides = {},
  ) => {
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
        ...overrides,
      },
    );
  };
  const rejected = async (
    root: string,
    action: GitAction,
    outcome: "failed" | "conflict",
    status = 409,
    overrides: RequestOverrides = {},
  ) => {
    let message = "";
    await assert.rejects(
      () => run(root, action, overrides),
      (error: unknown) => {
        assert.equal((error as { status: number }).status, status);
        message = (error as Error).message;
        return true;
      },
    );
    const current = await state(root);
    const entry = current.journal[0];
    assert.equal(entry.action, action.kind);
    assert.equal(entry.state, outcome);
    assert.equal(entry.message, message);
    if (outcome === "conflict") {
      if (current.status.merge.length) {
        assert.match(message, /CONFLICT[^\n]*file\.txt/);
      } else {
        assert(
          emptyCommitGuidance(current.status),
          "expected an empty replay pause",
        );
        assert(message.includes(emptyCommitGuidance(current.status)!));
        assert.doesNotMatch(message, /CONFLICT/);
      }
      assert.doesNotMatch(message, /Command failed: git -C/);
      assert.doesNotMatch(message, /(?:^|\n)hint:/);
      assert.doesNotMatch(message, /\((?:use|all conflicts fixed:)[^\n]*git /);
      assert.doesNotMatch(
        message,
        /git (?:restore|add|commit)\b|--allow-empty/,
      );
      assert.doesNotMatch(
        message,
        /git (?:rebase|cherry-pick|revert) --(?:continue|skip|abort)/,
      );
    }
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
      files: Object.fromEntries(
        [
          ...new Set(
            git(
              root,
              "ls-files",
              "--cached",
              "--others",
              "--exclude-standard",
              "-z",
            )
              .split("\0")
              .filter(Boolean),
          ),
        ].map((path) => [
          path,
          existsSync(join(root, path))
            ? readFileSync(join(root, path), "utf8")
            : null,
        ]),
      ),
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
    [{ kind: "discard-conflicts" }, 409],
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
  const cleanSnapshot = await snapshot(root);
  await rejected(root, { kind: "discard-conflicts" }, "failed");
  assert.deepEqual(await snapshot(root), cleanSnapshot);
  console.log(
    "ok · allow-list validation failures preserve existing conflict and log failed in both conflicted and clean repositories",
  );

  const squash = seed("squash-discard");
  for (const file of ["staged.txt", "unstaged.txt"])
    writeFileSync(join(squash, file), "base\n");
  git(squash, "add", ".");
  git(squash, "commit", "-qm", "unrelated files");
  git(squash, "checkout", "-qb", "other");
  writeFileSync(join(squash, "incoming.txt"), "incoming\n");
  git(squash, "add", "incoming.txt");
  commit(squash, "other");
  git(squash, "checkout", "-q", "main");
  const squashHead = commit(squash, "main");
  const squashed = await rejected(
    squash,
    { kind: "merge", target: "other", strategy: "squash" },
    "conflict",
  );
  assert.equal(squashed.status.operation, null);
  assert.equal(squashed.status.merge.length, 1);
  assert.equal(squashed.backups.length, 1);
  write(squash, "unfinished conflict draft");
  writeFileSync(join(squash, "staged.txt"), "staged edits\n");
  git(squash, "add", "staged.txt");
  writeFileSync(join(squash, "unstaged.txt"), "keep unstaged\n");
  writeFileSync(join(squash, "untracked.txt"), "keep untracked\n");
  const pending = await snapshot(squash);
  for (const confirmation of [undefined, "wrong text"]) {
    await rejected(squash, { kind: "discard-conflicts" }, "failed", 400, {
      confirmation,
    });
    assert.deepEqual(await snapshot(squash), pending);
  }
  await rejected(squash, { kind: "discard-conflicts" }, "failed", 409, {
    version: squashed.version,
  });
  assert.deepEqual(await snapshot(squash), pending);
  await rejected(
    squash,
    { kind: "reset", target: "HEAD", mode: "hard" },
    "failed",
  );
  assert.deepEqual(await snapshot(squash), pending);
  // An unstaged edit to an incoming indexed file prevents a safe reset.
  writeFileSync(join(squash, "incoming.txt"), "keep incoming draft\n");
  const unsafe = await snapshot(squash);
  const refusedDiscard = await rejected(
    squash,
    { kind: "discard-conflicts" },
    "failed",
  );
  assert.match(refusedDiscard.journal[0].message, /incoming\.txt/);
  assert.match(refusedDiscard.journal[0].message, /安全回退未完成/);
  assert.match(
    refusedDiscard.journal[0].message,
    /变更视图暂存该文件.*重试「放弃冲突改动」.*会被丢弃/,
  );
  assert.match(
    refusedDiscard.journal[0].message,
    /解决并暂存所有冲突.*变更视图提交/,
  );
  assert.deepEqual(await snapshot(squash), unsafe);
  await run(squash, { kind: "stage", paths: ["incoming.txt"] });
  const discarded = await run(squash, { kind: "discard-conflicts" });
  assert.equal(discarded.entry.state, "succeeded");
  assert.equal(discarded.entry.command, "git reset --merge HEAD");
  assert.equal(discarded.entry.before, squashHead);
  assert.equal(discarded.entry.after, squashHead);
  const reset = await state(squash);
  assert.equal(reset.status.operation, null);
  assert.equal(reset.status.merge.length, 0);
  assert.equal(reset.status.staged.length, 0);
  assert.equal(git(squash, "ls-files", "--unmerged"), "");
  assert.equal(readFileSync(join(squash, "file.txt"), "utf8"), "main\n");
  assert.equal(readFileSync(join(squash, "staged.txt"), "utf8"), "base\n");
  assert.equal(
    readFileSync(join(squash, "unstaged.txt"), "utf8"),
    "keep unstaged\n",
  );
  assert.equal(
    readFileSync(join(squash, "untracked.txt"), "utf8"),
    "keep untracked\n",
  );
  assert.equal(existsSync(join(squash, "incoming.txt")), false);
  assert.deepEqual(reset.backups, squashed.backups);
  await run(squash, {
    kind: "stage",
    paths: ["unstaged.txt", "untracked.txt"],
  });
  await run(squash, {
    kind: "commit",
    message: "preserved work",
    amend: false,
  });
  console.log(
    "ok · squash conflict discard requires fresh typed confirmation, preserves HEAD and unrelated work, and safely refuses overlapping unstaged edits",
  );

  for (const kind of ["rebase", "cherry-pick", "revert"] as const) {
    const repo = seed(`diagnostic-${kind}`);
    if (kind !== "revert") git(repo, "checkout", "-qb", "other");
    const target = commit(repo, "applied");
    if (kind !== "revert") git(repo, "checkout", "-q", "main");
    commit(repo, "main");
    const config = git(repo, "config", "--local", "--list");
    const conflicted = await rejected(repo, { kind, target }, "conflict");
    assert.equal(conflicted.status.operation, kind);
    assert.match(
      conflicted.journal[0].message,
      /error: could not (?:apply|revert)/,
    );
    assert.equal(git(repo, "config", "--local", "--list"), config);
    await run(repo, { kind: "abort" });
  }
  console.log(
    "ok · rebase/cherry-pick/revert retain both conflict stdout and failure stderr without command-line hints or persistent config changes",
  );

  for (const source of [
    "already-applied",
    "originally-empty",
    "resolved-empty",
  ] as const) {
    const repo = seed(source);
    let target: string;
    if (source === "resolved-empty") {
      git(repo, "checkout", "-qb", "other");
      target = commit(repo, "other");
      git(repo, "checkout", "-q", "main");
      commit(repo, "main");
    } else {
      if (source === "originally-empty")
        git(repo, "commit", "--allow-empty", "-qm", "empty source");
      else commit(repo, "already applied");
      target = git(repo, "rev-parse", "HEAD");
    }
    const head = git(repo, "rev-parse", "HEAD");
    await rejected(repo, { kind: "cherry-pick", target }, "conflict");
    if (source === "resolved-empty") await resolve(repo, "main");
    const paused = await state(repo);
    const guidance =
      "当前拣选没有可提交的改动。请选择「跳过」处理后续提交，或「中止操作」恢复操作前状态。";
    assert(emptyCommitGuidance(paused.status));
    assert.equal(gitActionBlockReason(paused.status, "continue"), guidance);
    assert.equal(gitActionBlockReason(paused.status, "skip"), null);
    const pausedSnapshot = await snapshot(repo);
    const refused = await rejected(repo, { kind: "continue" }, "failed");
    assert.equal(refused.journal[0].message, guidance);
    await assert.rejects(() => continueOperation(repo, "continue"), {
      message: guidance,
    });
    assert.deepEqual(await snapshot(repo), pausedSnapshot);
    await run(repo, { kind: source === "resolved-empty" ? "abort" : "skip" });
    assert.equal((await state(repo)).status.operation, null);
    assert.equal(git(repo, "status", "--porcelain"), "");
    assert.equal(git(repo, "rev-parse", "HEAD"), head);
  }
  const stagedPick = seed("empty-then-staged");
  await rejected(
    stagedPick,
    { kind: "cherry-pick", target: "HEAD" },
    "conflict",
  );
  writeFileSync(join(stagedPick, "note.txt"), "untracked note\n");
  assert(emptyCommitGuidance((await state(stagedPick)).status));
  write(stagedPick, "manual resolution");
  assert.equal(emptyCommitGuidance((await state(stagedPick)).status), null);
  await run(stagedPick, { kind: "stage", paths: ["file.txt"] });
  assert.equal(
    gitActionBlockReason((await state(stagedPick)).status, "continue"),
    null,
  );
  await run(stagedPick, { kind: "continue" });
  assert.equal((await state(stagedPick)).status.operation, null);
  assert.equal(git(stagedPick, "show", "HEAD:file.txt"), "manual resolution");
  assert.equal(
    readFileSync(join(stagedPick, "note.txt"), "utf8"),
    "untracked note\n",
  );
  console.log(
    "ok · already-applied, originally empty and resolved-empty cherry-picks guide skip/abort; real staged changes still continue",
  );

  for (const finish of ["skip", "abort", "continue"] as const) {
    const repo = seed(`empty-revert-${finish}`);
    const target = commit(repo, "applied");
    const head = commit(repo, "main");
    await rejected(repo, { kind: "revert", target }, "conflict");
    await resolve(repo, "main");
    const paused = await state(repo);
    const guidance =
      "当前反做没有可提交的改动。请选择「跳过」处理后续提交，或「中止操作」恢复操作前状态。";
    assert.equal(paused.status.operation, "revert");
    assert.equal(emptyCommitGuidance(paused.status), guidance);
    assert.equal(gitActionBlockReason(paused.status, "continue"), guidance);
    assert.equal(gitActionBlockReason(paused.status, "skip"), null);
    const original = await snapshot(repo);
    const refused = await rejected(repo, { kind: "continue" }, "failed");
    assert.equal(refused.journal[0].message, guidance);
    await assert.rejects(() => continueOperation(repo, "continue"), {
      message: guidance,
    });
    assert.deepEqual(await snapshot(repo), original);
    if (finish === "continue") {
      write(repo, "manual revert resolution");
      await run(repo, { kind: "stage", paths: ["file.txt"] });
      assert.equal(emptyCommitGuidance((await state(repo)).status), null);
      assert.equal(
        gitActionBlockReason((await state(repo)).status, "continue"),
        null,
      );
    }
    await run(repo, { kind: finish });
    assert.equal((await state(repo)).status.operation, null);
    assert.equal(git(repo, "status", "--porcelain"), "");
    if (finish === "continue") {
      assert.notEqual(git(repo, "rev-parse", "HEAD"), head);
      assert.equal(
        git(repo, "show", "HEAD:file.txt"),
        "manual revert resolution",
      );
    } else assert.equal(git(repo, "rev-parse", "HEAD"), head);
  }
  const undone = seed("already-undone-revert");
  const undoTarget = commit(undone, "applied");
  commit(undone, "base");
  const beforeNoop = await snapshot(undone);
  const noChange = await rejected(
    undone,
    { kind: "revert", target: undoTarget },
    "failed",
  );
  assert.match(
    noChange.journal[0].message,
    /^本次反做未完成：没有产生可提交的改动，未创建新提交/,
  );
  assert.match(noChange.journal[0].message, /目标改动可能已经撤销/);
  assert.doesNotMatch(noChange.journal[0].message, /「跳过」|「中止操作」/);
  assert.equal(noChange.status.operation, null);
  assert.equal(emptyCommitGuidance(noChange.status), null);
  const afterNoop = await snapshot(undone);
  for (const field of ["head", "status", "index", "files"] as const)
    assert.deepEqual(afterNoop[field], beforeNoop[field]);
  const otherFailure = await rejected(
    undone,
    { kind: "revert", target: undoTarget, mainline: 2 },
    "failed",
  );
  assert.doesNotMatch(otherFailure.journal[0].message, /没有产生可提交的改动/);
  console.log(
    "ok · empty revert pauses guide skip/abort and allow real staged continuation; already-undone reverts fail clearly without a pending operation",
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
  const rebaseSnapshot = await snapshot(planned);
  await rejected(planned, { kind: "discard-conflicts" }, "failed");
  assert.deepEqual(await snapshot(planned), rebaseSnapshot);
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
    await run(repo, { kind: "discard-conflicts" });
    const discarded = await state(repo);
    assert.equal(discarded.status.merge.length, 0);
    assert.equal(discarded.status.branch.oid, conflicted.status.branch.oid);
    assert.equal(discarded.stashes[0].sha, stash.sha);
    assert.equal(readFileSync(join(repo, "file.txt"), "utf8"), "main\n");
  }
  console.log(
    "ok · stash apply/pop diagnostics survive and conflict discard restores HEAD contents while retaining the stash",
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
