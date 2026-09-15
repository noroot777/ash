import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { GitAction, GitWorkbenchState } from "@ash/shared/git-workbench";

const directory = realpathSync(
  mkdtempSync(join(tmpdir(), "ash-workbench-maintenance-")),
);
process.env.ASH_DB = join(directory, "ash.db");
process.env.GIT_CONFIG_GLOBAL = join(directory, "gitconfig");
process.env.GIT_CONFIG_NOSYSTEM = "1";
writeFileSync(
  process.env.GIT_CONFIG_GLOBAL,
  "[user]\nname = Maintenance Test\nemail = test@example.test\n[commit]\ngpgsign = false\n[core]\nautocrlf = false\n",
);
const root = join(directory, "repo");
const git = (tree: string, ...args: string[]) =>
  execFileSync("git", ["-C", tree, ...args], {
    encoding: "utf8",
    stdio: "pipe",
  }).trim();
execFileSync("git", ["init", "-q", "-b", "main", root]);
writeFileSync(join(root, "file.txt"), "base\n");
git(root, "add", ".");
git(root, "commit", "-qm", "base");
const base = git(root, "rev-parse", "HEAD");

try {
  const { Hono } = await import("hono");
  const { db, ensureSchema } = await import("../src/db/index.js");
  const { projects } = await import("../src/db/schema.js");
  const { mountGitWorkbenchRoutes } = await import(
    "../src/git-workbench/routes.js"
  );
  const { appendEntry, journalDirectory } = await import(
    "../src/git-workbench/journal.js"
  );
  await ensureSchema();
  await db
    .insert(projects)
    .values({
      id: "p",
      name: "Maintenance",
      repoPath: root,
      createdAt: new Date().toISOString(),
    });
  const app = new Hono();
  mountGitWorkbenchRoutes(app);
  const state = async (tree = root) => {
    const response = await app.request(
      `/projects/p/git/workbench?root=${encodeURIComponent(tree)}`,
    );
    assert.equal(response.status, 200, await response.clone().text());
    return (await response.json()) as GitWorkbenchState;
  };
  const run = async (action: GitAction, confirmation?: string, tree = root) => {
    const current = await state(tree);
    const response = await app.request("/projects/p/git/workbench/actions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        root: current.root,
        version: current.version,
        action,
        confirmation,
      }),
    });
    return { status: response.status, body: await response.json() };
  };
  const ok = async (action: GitAction, confirmation?: string, tree = root) => {
    const result = await run(action, confirmation, tree);
    assert.equal(result.status, 200, JSON.stringify(result.body));
    return result.body;
  };
  const backup = (await ok({ kind: "reset", mode: "soft", target: base })).entry
    .backup;
  for (let i = 0; i < 205; i++)
    await appendEntry(root, {
      id: randomUUID(),
      at: new Date().toISOString(),
      actor: "test",
      root,
      action: "fetch",
      state: "succeeded",
      message: "older backup pagination fixture",
    });
  const older = await state();
  assert.equal(older.journal.length, 200);
  assert(!older.journal.some((entry) => entry.backup === backup));
  assert(
    older.backups.some((item) => item.ref === backup && item.sha === base),
  );
  await ok({
    kind: "branch-create",
    name: "recovered",
    target: backup,
    checkout: false,
  });
  assert.equal(git(root, "rev-parse", "recovered"), base);
  const deleteAction: GitAction = {
    kind: "backup-delete",
    ref: backup,
    sha: base,
  };
  assert.equal((await run(deleteAction)).status, 400);
  assert.equal(
    (await run({ ...deleteAction, sha: "1".repeat(40) }, backup)).status,
    409,
  );
  const foreign = {
    kind: "backup-delete" as const,
    ref: "refs/heads/main",
    sha: base,
  };
  assert.equal((await run(foreign, foreign.ref)).status, 400);
  const indexBefore = git(root, "ls-files", "--stage");
  await ok(deleteAction, backup);
  assert.equal((await state()).backups.length, 0);
  assert.equal(git(root, "rev-parse", "HEAD"), base);
  assert.equal(git(root, "ls-files", "--stage"), indexBefore);
  assert.equal(readFileSync(join(root, "file.txt"), "utf8"), "base\n");
  assert.equal((await run(deleteAction, backup)).status, 409);
  console.log(
    "ok · old backups remain visible beyond journal limit; confirmed SHA-guarded deletion preserves HEAD/index/files",
  );

  const helpers = await journalDirectory(root);
  const helperDirs = () =>
    readdirSync(helpers).filter((name) => /^rebase-[a-f0-9-]{36}$/.test(name));
  const history = (tree = root) => {
    git(tree, "reset", "--hard", base);
    const commits: string[] = [];
    for (const word of ["one", "two"]) {
      writeFileSync(join(tree, "file.txt"), word + "\n");
      git(tree, "add", ".");
      git(tree, "commit", "-qm", word);
      commits.push(git(tree, "rev-parse", "HEAD"));
    }
    return commits;
  };
  const plan = (
    commits: string[],
    conflict: boolean,
    reword = true,
  ): GitAction => ({
    kind: "rebase-plan",
    target: base,
    steps: conflict
      ? [
          {
            sha: commits[1],
            action: reword ? "reword" : "pick",
            message: "rewritten second",
          },
          { sha: commits[0], action: "drop", message: "" },
        ]
      : commits.map((sha, i) => ({
          sha,
          action: i === 0 ? "reword" : "pick",
          message: "rewritten first",
        })),
  });
  await ok(plan(history(), false));
  assert.equal(
    git(root, "log", "-1", "--format=%s", "HEAD~"),
    "rewritten first",
  );
  assert.equal(helperDirs().length, 0);

  let commits = history();
  assert.equal((await run(plan(commits, true))).status, 409);
  assert.equal((await state()).status.operation, "rebase");
  assert.equal(helperDirs().length, 1);
  assert(existsSync(join(helpers, helperDirs()[0], "amend.cjs")));
  assert.equal((await run({ kind: "continue" })).status, 409);
  assert.equal(helperDirs().length, 1);
  const conflictResponse = await app.request(
    `/projects/p/git/workbench/conflict?root=${encodeURIComponent(root)}&path=file.txt`,
  );
  const conflict = await conflictResponse.json();
  await ok({
    kind: "resolve",
    path: "file.txt",
    version: conflict.version,
    choice: "content",
    content: "two\n",
  });
  await ok({ kind: "continue" });
  assert.equal(git(root, "log", "-1", "--format=%s"), "rewritten second");
  assert.equal(git(root, "show", "HEAD:file.txt"), "two");
  assert.equal(helperDirs().length, 0);
  console.log(
    "ok · completed plans clean helpers; conflicted plans retain pending reword scripts through continue",
  );

  commits = history();
  assert.equal((await run(plan(commits, true))).status, 409);
  await ok({ kind: "abort" });
  assert.equal(git(root, "rev-parse", "HEAD"), commits[1]);
  assert.equal(helperDirs().length, 0);
  commits = history();
  assert.equal((await run(plan(commits, true, false))).status, 409);
  await ok({ kind: "skip" });
  assert.equal((await state()).status.operation, null);
  assert.equal(helperDirs().length, 0);

  commits = history();
  const hooks = join(directory, "hooks");
  mkdirSync(hooks);
  writeFileSync(join(hooks, "pre-rebase"), "#!/bin/sh\nexit 1\n", {
    mode: 0o755,
  });
  git(root, "config", "core.hooksPath", hooks);
  try {
    assert.equal((await run(plan(commits, false))).status, 409);
    assert.equal((await state()).status.operation, null);
    assert.equal(helperDirs().length, 0);
  } finally {
    git(root, "config", "--unset", "core.hooksPath");
  }
  console.log("ok · abort, skip and terminal pre-rebase failure clean helpers");

  const legacy = join(helpers, `rebase-${randomUUID()}`);
  mkdirSync(legacy);
  writeFileSync(join(legacy, "sequence.cjs"), "legacy helper");
  mkdirSync(join(helpers, "rebase-unrelated"));
  const other = join(directory, "other tree");
  git(root, "worktree", "add", "-b", "other", other, base);
  const otherCommits = history(other);
  assert.equal(
    (await run(plan(otherCommits, true), undefined, other)).status,
    409,
  );
  assert.equal((await run({ kind: "rebase-cleanup" })).status, 409);
  assert(existsSync(legacy));
  assert.equal(helperDirs().length, 2);
  await ok({ kind: "abort" }, undefined, other);
  assert.equal(helperDirs().length, 0);
  assert(existsSync(join(helpers, "rebase-unrelated")));

  mkdirSync(legacy);
  renameSync(other, other + "-moved");
  try {
    assert.equal((await run({ kind: "rebase-cleanup" })).status, 409);
    assert(existsSync(legacy));
  } finally {
    renameSync(other + "-moved", other);
  }
  const beforeCleanup = (await state()).backups;
  await ok({ kind: "rebase-cleanup" });
  assert.equal(helperDirs().length, 0);
  assert.deepEqual((await state()).backups, beforeCleanup);
  assert(existsSync(join(helpers, "rebase-unrelated")));
  console.log(
    "ok · active or inaccessible sibling worktree prevents cleanup; explicit cleanup removes only abandoned helper dirs",
  );
} finally {
  const { dbClient } = await import("../src/db/index.js");
  dbClient.close();
  rmSync(directory, { recursive: true, force: true });
}
