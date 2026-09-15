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
import type { GitAction } from "@ash/shared/git-workbench";

const directory = realpathSync(
  mkdtempSync(join(tmpdir(), "ash-workbench-test-")),
);
process.env.ASH_DB = join(directory, "ash.db");
process.env.GIT_CONFIG_GLOBAL = join(directory, "gitconfig");
process.env.GIT_CONFIG_NOSYSTEM = "1";
writeFileSync(
  process.env.GIT_CONFIG_GLOBAL,
  "[user]\nname = Workbench Test\nemail = workbench@example.test\n[commit]\ngpgsign = false\n",
);
const rawGit = (root: string, ...args: string[]) =>
  execFileSync("git", ["-C", root, ...args], {
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
  }).trim();
const write = (root: string, content: string, file = "file.txt") =>
  writeFileSync(join(root, file), content);
const seed = (name: string) => {
  const root = join(directory, name);
  execFileSync("git", ["init", "-q", "-b", "main", root]);
  write(root, "one\ntwo\nthree\nfour\nfive\nsix\nseven\neight\nnine\nten\n");
  rawGit(root, "add", "--", "file.txt");
  rawGit(root, "commit", "-qm", "seed");
  return root;
};

try {
  const { readWorkbench, readHistory, readDetail } = await import(
    "../src/git-workbench/read.js"
  );
  const { executeWorkbench } = await import(
    "../src/git-workbench/operations.js"
  );
  const { readConflict } = await import("../src/git-workbench/conflicts.js");
  const { confirmationFor, selectRoot } = await import(
    "../src/git-workbench/core.js"
  );
  const { readScmStatus } = await import("../src/git-status.js");
  const { parseAction } = await import("../src/git-workbench/input.js");
  const { withRepoLock } = await import("../src/repo-lock.js");
  const { db, ensureSchema } = await import("../src/db/index.js");
  await ensureSchema();
  const run = async (
    root: string,
    action: GitAction,
    actor = "tester",
    repo = root,
  ) => {
    const state = await readWorkbench(repo, root, actor);
    return executeWorkbench(
      repo,
      "project-test",
      { id: actor, name: actor },
      {
        root,
        version: state.version,
        action,
        confirmation:
          confirmationFor(action, await readScmStatus(root)) || undefined,
      },
    );
  };
  let checks = 0;
  const check = (label: string) => {
    checks++;
    console.log(`ok ${checks} · ${label}`);
  };

  const root = seed("changes 中文 space");
  let state = await readWorkbench(root, root, "tester");
  assert.equal(state.status.branch.head, "main");
  assert.equal((await readHistory(root)).commits[0].subject, "seed");
  assert.ok(state.refs.some((r) => r.name === "main"));
  const oldVersion = state.version;
  write(root, "one\nTWO\nthree\nfour\nfive\nsix\nseven\neight\nNINE\nten\n");
  await assert.rejects(
    () =>
      executeWorkbench(
        root,
        "p",
        { id: "tester", name: "Test" },
        {
          root,
          version: oldVersion,
          action: { kind: "stage", paths: ["file.txt"] },
        },
      ),
    /已经变化/,
  );
  assert.equal(rawGit(root, "diff", "--cached"), "");
  check("过期页面不修改索引");

  const diff = await readDetail(root, { path: "file.txt", source: "unstaged" });
  const lines = diff.diff.split("\n");
  const chosen = lines
    .map((line, i) => (/^[-+](two|TWO)$/.test(line) ? i : -1))
    .filter((i) => i >= 0);
  await run(root, {
    kind: "patch",
    path: "file.txt",
    source: "unstaged",
    diff: diff.diff,
    lines: chosen,
  });
  const staged = rawGit(root, "show", ":file.txt");
  assert.ok(staged.includes("TWO"));
  assert.ok(!staged.includes("NINE"));
  const cached = await readDetail(root, { path: "file.txt", source: "staged" });
  await run(root, {
    kind: "patch",
    path: "file.txt",
    source: "staged",
    diff: cached.diff,
    lines: cached.diff
      .split("\n")
      .map((line, i) => (/^[-+](two|TWO)$/.test(line) ? i : -1))
      .filter((i) => i >= 0),
  });
  assert.equal(rawGit(root, "diff", "--cached"), "");
  check("只暂存选定改动行，取消暂存保留工作区");

  write(root, "new\n", "新增 [1].txt");
  await run(root, { kind: "stage", paths: ["file.txt", "新增 [1].txt"] });
  await run(root, { kind: "unstage", paths: ["新增 [1].txt"] });
  await run(root, {
    kind: "commit",
    message: "first\n\n中文提交信息",
    amend: false,
  });
  assert.equal((await readHistory(root)).commits[0].subject, "first");
  assert.ok(existsSync(join(root, "新增 [1].txt")));
  await run(root, {
    kind: "discard",
    paths: [],
    deleteUntracked: ["新增 [1].txt"],
  });
  assert.ok(!existsSync(join(root, "新增 [1].txt")));
  const amend = await run(root, {
    kind: "commit",
    message: "reworded",
    amend: true,
  });
  assert.ok(amend.entry.backup);
  await run(root, { kind: "undo", id: amend.entry.id });
  assert.equal((await readHistory(root)).commits[0].subject, "first");
  check("提交、amend、备份撤销与字面文件名丢弃");

  await run(root, {
    kind: "branch-create",
    name: "feature",
    target: "HEAD",
    checkout: false,
  });
  const feature = rawGit(root, "rev-parse", "feature");
  await assert.rejects(
    () =>
      run(root, {
        kind: "branch-delete",
        name: "feature",
        sha: "0".repeat(40),
        force: false,
      }),
    /已经改变/,
  );
  await run(root, {
    kind: "branch-rename",
    name: "feature",
    next: "topic",
    sha: feature,
  });
  await run(root, { kind: "checkout", name: "topic" });
  write(root, "topic\n", "topic.txt");
  await run(root, { kind: "stage", paths: ["topic.txt"] });
  await run(root, { kind: "commit", message: "topic change", amend: false });
  const topic = rawGit(root, "rev-parse", "HEAD");
  await run(root, { kind: "checkout", name: "main" });
  await assert.rejects(
    () =>
      run(root, {
        kind: "branch-delete",
        name: "topic",
        sha: topic,
        force: false,
      }),
    /not fully merged/,
  );
  await run(root, { kind: "merge", target: topic, strategy: "no-ff" });
  assert.equal(
    rawGit(root, "rev-list", "--parents", "-n", "1", "HEAD").split(" ").length,
    3,
  );
  await run(root, {
    kind: "branch-delete",
    name: "topic",
    sha: topic,
    force: false,
  });
  await run(root, {
    kind: "tag-create",
    name: "v1",
    target: "HEAD",
    message: "release",
  });
  state = await readWorkbench(root, root, "tester");
  const tag = state.refs.find((r) => r.kind === "tag")!;
  await run(root, { kind: "tag-delete", name: tag.name, sha: tag.sha });
  check("分支、合并、引用并发保护、附注标签");

  write(root, "stash tracked\n");
  write(root, "stash new\n", "scratch.txt");
  await run(root, { kind: "stash-save", message: "draft", untracked: true });
  state = await readWorkbench(root, root, "tester");
  const stash = state.stashes[0];
  assert.equal(stash.owned, true);
  await assert.rejects(
    () => run(root, { kind: "stash-drop", sha: stash.sha }, "other"),
    /不属于/,
  );
  await run(root, { kind: "stash-apply", sha: stash.sha }, "other");
  assert.equal(readFileSync(join(root, "scratch.txt"), "utf8"), "stash new\n");
  rawGit(root, "reset", "--hard", "HEAD");
  rawGit(root, "clean", "-fd");
  await run(root, { kind: "stash-pop", sha: stash.sha });
  assert.equal((await readWorkbench(root, root, "tester")).stashes.length, 0);
  rawGit(root, "reset", "--hard", "HEAD");
  rawGit(root, "clean", "-fd");
  check("贮藏包含未跟踪文件，别人只能 apply，pop 成功后移除");

  for (const kind of ["merge", "cherry-pick", "rebase", "revert"] as const) {
    const repo = seed(`conflict-${kind}`);
    const original = rawGit(repo, "rev-parse", "HEAD");
    rawGit(repo, "checkout", "-qb", "other");
    write(repo, "THEIRS\n");
    rawGit(repo, "commit", "-qam", "other");
    const theirs = rawGit(repo, "rev-parse", "HEAD");
    rawGit(repo, "checkout", "-q", "main");
    write(repo, "OURS\n");
    rawGit(repo, "commit", "-qam", "ours");
    const before = rawGit(repo, "rev-parse", "HEAD");
    const act: GitAction =
      kind === "merge"
        ? { kind, target: theirs, strategy: "ff" }
        : { kind, target: theirs };
    await assert.rejects(() => run(repo, act));
    const conflict = await readConflict(repo, "file.txt");
    assert.ok(conflict.ours && conflict.theirs);
    assert.equal(
      (await readWorkbench(repo, repo, "tester")).journal[0].state,
      "conflict",
    );
    await run(repo, {
      kind: "resolve",
      path: "file.txt",
      version: conflict.version,
      choice: "content",
      content: "RESOLVED\n",
    });
    await run(repo, { kind: "continue" });
    assert.equal((await readScmStatus(repo)).operation, null);
    assert.equal(readFileSync(join(repo, "file.txt"), "utf8"), "RESOLVED\n");
    rawGit(repo, "reset", "--hard", before);
    await assert.rejects(() => run(repo, act));
    await run(repo, { kind: "abort" });
    assert.equal(rawGit(repo, "rev-parse", "HEAD"), before);
    check(`${kind} 冲突保存、继续、持久日志与中止`);
  }

  const reb = seed("rebase plan 中文 space");
  const base = rawGit(reb, "rev-parse", "HEAD");
  const sequence: string[] = [];
  for (let i = 0; i < 4; i++) {
    write(reb, `new ${i}\n`, `f${i}.txt`);
    rawGit(reb, "add", ".");
    rawGit(reb, "commit", "-qm", `commit ${i}`);
    sequence.push(rawGit(reb, "rev-parse", "HEAD"));
  }
  await run(reb, {
    kind: "rebase-plan",
    target: base,
    steps: [
      {
        sha: sequence[1],
        action: "reword",
        message: "中文改名 $(not a command)",
      },
      { sha: sequence[0], action: "fixup", message: "" },
      { sha: sequence[2], action: "squash", message: "" },
      { sha: sequence[3], action: "drop", message: "" },
    ],
  });
  assert.equal(rawGit(reb, "rev-list", "--count", `${base}..HEAD`), "1");
  assert.match(
    rawGit(reb, "log", "-1", "--format=%B"),
    /中文改名 \$\(not a command\)/,
  );
  assert.ok(!existsSync(join(reb, "f3.txt")));
  check("交互式变基排序、reword、fixup、squash、drop 及命令字符消息");

  await run(root, { kind: "worktree-add", name: "manual", target: "HEAD" });
  const wt = (await readWorkbench(root, root, "tester")).worktrees.find(
    (w) => w.branch === "manual",
  )!;
  assert.equal((await selectRoot(root, wt.path)).root, realpathSync(wt.path));
  await run(root, { kind: "worktree-lock", path: wt.path });
  assert.equal(
    (await readWorkbench(root, root, "tester")).worktrees.find(
      (w) => w.path === wt.path,
    )?.locked,
    true,
  );
  await run(root, { kind: "worktree-unlock", path: wt.path });
  write(wt.path, "dirty\n", "scratch.txt");
  await assert.rejects(
    () => run(root, { kind: "worktree-remove", path: wt.path, sha: wt.head! }),
    /工作区有/,
  );
  rmSync(join(wt.path, "scratch.txt"));
  await run(root, { kind: "worktree-remove", path: wt.path, sha: wt.head! });
  assert.ok(!existsSync(wt.path));
  check("手动 worktree 创建、锁定、脏保护与安全删除");

  const remote = join(directory, "remote.git");
  execFileSync("git", ["init", "--bare", "-q", "-b", "main", remote]);
  rawGit(root, "remote", "add", "origin", remote);
  await run(root, { kind: "push", remote: "origin" });
  const published = rawGit(root, "rev-parse", "HEAD");
  const peer = join(directory, "peer");
  execFileSync("git", ["clone", "-q", remote, peer]);
  write(peer, "remote\n", "remote.txt");
  rawGit(peer, "add", ".");
  rawGit(peer, "commit", "-qm", "remote");
  rawGit(peer, "push");
  await run(root, { kind: "fetch", remote: "origin" });
  await run(root, { kind: "pull", strategy: "ff-only" });
  assert.ok(existsSync(join(root, "remote.txt")));
  const lease = rawGit(root, "rev-parse", "origin/main");
  await run(root, { kind: "reset", target: published, mode: "hard" });
  write(peer, "more\n", "more.txt");
  rawGit(peer, "add", ".");
  rawGit(peer, "commit", "-qm", "more");
  rawGit(peer, "push");
  await assert.rejects(
    () => run(root, { kind: "push", remote: "origin", lease }),
    /stale info|rejected/,
  );
  assert.equal(
    rawGit(remote, "rev-parse", "main"),
    rawGit(peer, "rev-parse", "HEAD"),
  );
  check("真实本地远端 fetch/pull/push，过期 force-with-lease 不覆盖新提交");

  let unlock!: () => void;
  const holding = withRepoLock(
    root,
    () =>
      new Promise<void>((resolve) => {
        unlock = resolve;
      }),
  );
  const queued = run(root, {
    kind: "branch-create",
    name: "queued",
    target: "HEAD",
    checkout: false,
  });
  for (let i = 0; i < 100; i++) {
    if (
      (await readWorkbench(root, root, "tester")).journal[0]?.state === "queued"
    )
      break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(
    (await readWorkbench(root, root, "tester")).journal[0].state,
    "queued",
  );
  unlock();
  await holding;
  await queued;
  check("等待仓库锁的操作持久可见并在释放后继续");

  assert.throws(
    () =>
      parseAction({
        root,
        version: "a".repeat(64),
        action: { kind: "reset", target: "HEAD", mode: "hard --quiet" },
      }),
    /不合法/,
  );
  await assert.rejects(() => selectRoot(root, reb), /不在这个项目/);
  await assert.rejects(
    () => readDetail(root, { path: "../file.txt", source: "untracked" }),
    /路径不合法/,
  );
  const { Hono } = await import("hono");
  const { mountGitWorkbenchRoutes } = await import(
    "../src/git-workbench/routes.js"
  );
  const { projects } = await import("../src/db/schema.js");
  const { setActor } = await import("../src/auth/context.js");
  await db.insert(projects).values({
    id: "project-test",
    name: "test",
    repoPath: root,
    createdAt: new Date().toISOString(),
  });
  const app = new Hono();
  mountGitWorkbenchRoutes(app);
  const read = await app.request("/projects/project-test/git/workbench");
  assert.equal(read.status, 200);
  const current = await read.json();
  const malformed = await app.request(
    "/projects/project-test/git/workbench/actions",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        root,
        version: current.version,
        action: { kind: "not-git" },
      }),
    },
  );
  assert.equal(malformed.status, 400);
  const denied = new Hono();
  denied.use("*", async (c, next) => {
    setActor(c, {
      kind: "anonymous",
      userId: null,
      role: "member",
      name: "anonymous",
    });
    await next();
  });
  mountGitWorkbenchRoutes(denied);
  const { setInstanceMode } = await import("../src/auth/mode.js");
  await setInstanceMode("multi", directory);
  assert.equal(
    (await denied.request("/projects/project-test/git/workbench")).status,
    403,
  );
  assert.equal(
    (
      await denied.request("/projects/project-test/git/workbench/actions", {
        method: "POST",
        body: "{}",
        headers: { "Content-Type": "application/json" },
      })
    ).status,
    403,
  );
  check("HTTP 路由、授权、请求校验与路径越界拒绝");
  console.log(`Git workbench: ${checks} scenarios passed`);
} finally {
  const { dbClient } = await import("../src/db/index.js");
  dbClient.close();
  rmSync(directory, { recursive: true, force: true });
}
