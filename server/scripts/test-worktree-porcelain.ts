import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { mock } from "node:test";
import type { GitWorkbenchState } from "@ash/shared/git-workbench";
import { releaseTmpDb } from "./tmp-db.js";

const directory = realpathSync(mkdtempSync(join(tmpdir(), "ash-worktree-porcelain-")));
process.env.ASH_DB = join(directory, "ash.db");
process.env.GIT_CONFIG_GLOBAL = join(directory, "gitconfig");
process.env.GIT_CONFIG_NOSYSTEM = "1";
writeFileSync(process.env.GIT_CONFIG_GLOBAL,
  "[user]\nname = Worktree Test\nemail = worktree@example.test\n[commit]\ngpgsign = false\n[core]\nautocrlf = false\n");
const realExecFile = childProcess.execFile;
let nulReads = 0;
let legacyReads = 0;
const fault = mock.method(childProcess, "execFile", (...args: Parameters<typeof realExecFile>) => {
  const argv = args[1];
  if (args[0] === "git" && Array.isArray(argv) && argv.includes("worktree") && argv.includes("list")) {
    if (argv.includes("-z")) {
      nulReads++;
      if (process.env.ASH_TEST_NATIVE_GIT !== "1")
        args[1] = argv.map(arg => arg === "-z" ? "--ash-test-unsupported-z" : arg);
    } else legacyReads++;
  }
  return realExecFile(...args);
});
syncBuiltinESMExports();
const git = (root: string, ...args: string[]) => childProcess.execFileSync("git", ["-C", root, ...args], {
  encoding: "utf8", stdio: "pipe", windowsHide: true,
}).trim();

try {
  const { worktreePorcelain, registeredCheckout, hasWorktreeRegistration, removeMissingWorktreeRegistrations, samePath } =
    await import("../src/git-worktree-state.js");
  const { getGitOverview } = await import("../src/git-overview.js");
  const { selectRoot } = await import("../src/git-workbench/core.js");
  const { cleanupRebaseHelpers } = await import("../src/git-workbench/maintenance.js");
  const { journalDirectory } = await import("../src/git-workbench/journal.js");
  const { Hono } = await import("hono");
  const { db, ensureSchema } = await import("../src/db/index.js");
  const { projects } = await import("../src/db/schema.js");
  const { mountGitWorkbenchRoutes } = await import("../src/git-workbench/routes.js");
  await ensureSchema();

  const modern = 'worktree /repo/中文 "quoted"\nnext\0HEAD abc123\0detached\0locked line1\nline2\0\0';
  let calls = 0;
  assert.equal(await worktreePorcelain(async args => {
    calls++;
    assert.ok(args.includes("-z"));
    return modern;
  }), modern);
  assert.equal(calls, 1, "modern Git retains NUL delimiters and embedded newlines without a retry");
  const legacy = 'worktree C:/中文 repo\r\nHEAD abc123\r\nbranch refs/heads/main\r\n\r\n'
    + 'worktree C:/bare repo\r\nbare\r\n\r\n'
    + 'worktree C:/locked\r\nHEAD abc123\r\ndetached\r\nlocked "line1\\nline2"\r\nprunable missing\r\n\r\n';
  const fallback = async (output: string) => worktreePorcelain(async args => {
    if (args.includes("-z")) throw new Error("error: unknown switch `z'");
    return output;
  });
  assert.equal(await fallback(legacy), legacy.replace(/\r\n/g, "\0"));
  await assert.rejects(fallback("worktree /repo/first\nsecond\nHEAD abc123\n\n"), /升级 Git/);
  const failure = new Error("repository is unreadable");
  await assert.rejects(worktreePorcelain(async () => { throw failure; }), error => error === failure);
  console.log("ok · modern NUL output, legacy CRLF/bare/locked records, unsafe paths and read failures");

  const repo = join(directory, "repo 中文 space");
  const tree = join(directory, "tree 中文 space");
  const detached = join(directory, "detached");
  const gone = join(directory, "gone");
  childProcess.execFileSync("git", ["init", "-q", "-b", "main", repo], { windowsHide: true });
  git(repo, "commit", "--allow-empty", "-qm", "seed");
  git(repo, "worktree", "add", "-qb", "feature", tree);
  git(repo, "worktree", "lock", "--reason", "line1\nline2 中文", tree);
  git(repo, "worktree", "add", "--detach", detached);
  git(repo, "worktree", "add", "-qb", "gone", gone);
  rmSync(gone, { recursive: true });
  const overview = await getGitOverview(repo);
  assert.equal(overview.worktrees.length, 4);
  assert.ok(overview.worktrees.some(item => samePath(item.path, tree) && item.branch === "feature"));
  assert.ok(overview.worktrees.some(item => samePath(item.path, detached) && item.detached));
  assert.deepEqual(await selectRoot(repo, tree), { repo, root: tree });
  await assert.rejects(selectRoot(repo, directory), /目标不在这个项目的工作树列表中/);
  const checkout = await registeredCheckout(repo, "feature");
  assert.ok(checkout.path && samePath(checkout.path, tree));
  assert.equal(checkout.locked, true);
  assert.equal(checkout.needsRepair, false);
  assert.equal((await registeredCheckout(repo, "absent")).path, null);
  assert.equal(await hasWorktreeRegistration(repo, tree, "feature"), true);
  assert.equal((await registeredCheckout(repo, "gone")).path, null);
  await removeMissingWorktreeRegistrations(repo, { branch: "gone" });
  assert.equal((await getGitOverview(repo)).worktrees.length, 3);
  console.log("ok · overview, root whitelist, locked/detached checkouts and scoped stale registration cleanup");

  await db.insert(projects).values({ id: "compat", name: "Old Git", repoPath: repo, createdAt: new Date().toISOString() });
  const api = new Hono();
  mountGitWorkbenchRoutes(api);
  for (const root of [repo, tree, detached]) {
    const response = await api.request(`/projects/compat/git/workbench?root=${encodeURIComponent(root)}`);
    assert.equal(response.status, 200, await response.clone().text());
    const state = await response.json() as GitWorkbenchState;
    assert.equal(state.root, root);
    assert.equal(state.worktrees.length, 3);
    assert.equal(state.worktrees.find(item => samePath(item.path, tree))?.locked, true);
    assert.equal(state.status.branch.head, root === repo ? "main" : root === tree ? "feature" : null);
  }
  console.log("ok · workbench HTTP 200 for main, linked and detached worktrees with correct lock state");

  const helper = join(await journalDirectory(repo), `rebase-${randomUUID()}`);
  mkdirSync(helper, { recursive: true });
  const rebase = resolve(tree, git(tree, "rev-parse", "--git-path", "rebase-merge"));
  mkdirSync(rebase);
  const blocked = await cleanupRebaseHelpers(repo);
  assert.equal(blocked.removed, 0);
  assert.match(blocked.blocked!, /正在变基/);
  assert.ok(existsSync(helper));
  rmSync(rebase, { recursive: true });
  assert.deepEqual(await cleanupRebaseHelpers(repo), { removed: 1, blocked: null });
  assert.ok(!existsSync(helper));
  assert.ok(nulReads > 0);
  if (process.env.ASH_TEST_NATIVE_GIT !== "1") assert.ok(legacyReads > 0);
  console.log(`ok · helper cleanup protects active rebase; NUL attempts=${nulReads}, legacy reads=${legacyReads}`);
} finally {
  fault.mock.restore();
  syncBuiltinESMExports();
  await releaseTmpDb();
  rmSync(directory, { recursive: true, force: true });
}
