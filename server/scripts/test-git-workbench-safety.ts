import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  realpathSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { GitAction, GitWorkbenchState } from "@ash/shared/git-workbench";

const directory = realpathSync(
  mkdtempSync(join(tmpdir(), "ash-workbench-safety-")),
);
process.env.ASH_DB = join(directory, "ash.db");
process.env.GIT_CONFIG_GLOBAL = join(directory, "gitconfig");
process.env.GIT_CONFIG_NOSYSTEM = "1";
writeFileSync(
  process.env.GIT_CONFIG_GLOBAL,
  "[user]\nname = Safety Test\nemail = safety@example.test\n[commit]\ngpgsign = false\n",
);
const root = join(directory, "repo");
const git = (...args: string[]) =>
  execFileSync("git", ["-C", root, ...args], {
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
  }).trim();
execFileSync("git", ["init", "-q", "-b", "main", root]);
writeFileSync(join(root, "file.txt"), "base\n");
git("add", ".");
git("commit", "-qm", "seed");

try {
  const { Hono } = await import("hono");
  const { eq } = await import("drizzle-orm");
  const { db, ensureSchema } = await import("../src/db/index.js");
  const { projects, tasks, users, projectMembers } = await import(
    "../src/db/schema.js"
  );
  const { mountGitWorkbenchRoutes } = await import(
    "../src/git-workbench/routes.js"
  );
  const { setActor } = await import("../src/auth/context.js");
  const { claimWorkbench } = await import("../src/git-workbench/context.js");
  const { isTurnClaimed } = await import("../src/runs.js");
  await ensureSchema();
  const at = new Date().toISOString();
  await db
    .insert(projects)
    .values({ id: "p", name: "Safety", repoPath: root, createdAt: at });
  const app = new Hono();
  mountGitWorkbenchRoutes(app);
  const state = async (selected = root) => {
    const res = await app.request(
      `/projects/p/git/workbench?root=${encodeURIComponent(selected)}`,
    );
    assert.equal(res.status, 200, await res.clone().text());
    const data = (await res.json()) as GitWorkbenchState;
    assert(
      data.worktrees.some((tree) => tree.path === data.root),
      "当前工作树与选择器路径一致",
    );
    assert(
      data.worktrees.some((tree) => tree.path === data.repo),
      "主工作树使用同一规范路径",
    );
    return data;
  };
  const run = async (
    action: GitAction,
    options: { selected?: string; confirmation?: string } = {},
  ) => {
    const current = await state(options.selected);
    const res = await app.request("/projects/p/git/workbench/actions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        root: current.root,
        version: current.version,
        confirmation: options.confirmation,
        action,
      }),
    });
    return { status: res.status, body: await res.json() };
  };
  const head = git("rev-parse", "HEAD");
  assert.equal(
    (await run({ kind: "reset", mode: "hard", target: head })).status,
    400,
  );
  assert.equal(git("rev-parse", "HEAD"), head);
  const malicious = await run({
    kind: "branch-create",
    name: "--force",
    target: "HEAD",
    checkout: false,
  });
  assert.equal(malicious.status, 400);

  await db.insert(tasks).values({
    id: "live",
    projectId: "p",
    title: "正在写主仓",
    status: "running",
    createdAt: at,
    updatedAt: at,
  });
  const blocked = await run({
    kind: "branch-create",
    name: "blocked",
    target: "HEAD",
    checkout: false,
  });
  assert.equal(blocked.status, 409);
  assert.match(blocked.body.error, /正在使用/);
  await db.update(tasks).set({ status: "done" }).where(eq(tasks.id, "live"));
  const release = await claimWorkbench(root, root, "p", {
    kind: "fetch",
    remote: "",
  });
  assert.equal(isTurnClaimed("live"), true);
  release();
  assert.equal(isTurnClaimed("live"), false);
  const managed = join(root, ".worktrees", "archived-task");
  const { ensureWorktreesIgnored } = await import("../src/git.js");
  await ensureWorktreesIgnored(root);
  git("worktree", "add", "-b", "ash/archived", managed);
  await db.insert(tasks).values({
    id: "archived-task",
    projectId: "p",
    title: "归档工作树",
    useWorktree: true,
    status: "done",
    archived: true,
    createdAt: at,
    updatedAt: at,
  });
  assert.match((await state(managed)).readOnly || "", /归档/);
  assert.equal(
    (
      await run(
        { kind: "commit", message: "forbidden", amend: true },
        { selected: managed },
      )
    ).status,
    409,
  );
  assert.equal(
    (
      await run(
        { kind: "worktree-remove", path: managed, sha: head },
        { confirmation: managed },
      )
    ).status,
    409,
  );
  assert.equal(
    (
      await run({
        kind: "branch-rename",
        name: "ash/archived",
        sha: head,
        next: "lost",
      })
    ).status,
    409,
  );
  await db
    .update(tasks)
    .set({ archived: false })
    .where(eq(tasks.id, "archived-task"));
  const managedRebase = await run(
    { kind: "pull", strategy: "rebase" },
    { selected: managed },
  );
  assert.equal(managedRebase.status, 409);
  assert.match(managedRebase.body.error, /任务工作树的基线/);
  assert.equal(
    execFileSync("git", ["-C", managed, "rev-parse", "HEAD"], {
      encoding: "utf8",
    }).trim(),
    head,
  );
  await db
    .update(tasks)
    .set({ archived: true })
    .where(eq(tasks.id, "archived-task"));

  if (process.platform !== "win32") {
    const outside = join(directory, "outside-secret");
    writeFileSync(outside, "outside\n");
    symlinkSync(outside, join(root, "link.txt"));
    const preview = await app.request(
      `/projects/p/git/workbench/diff?root=${encodeURIComponent(root)}&source=untracked&path=link.txt`,
    );
    assert.equal(preview.status, 400);
    assert.equal(readFileSync(outside, "utf8"), "outside\n");
    rmSync(join(root, "link.txt"));
  }
  console.log(
    "ok · typed confirmation, task claims, archived/managed worktrees and path boundaries",
  );

  const remote = join(directory, "remote.git");
  execFileSync("git", ["init", "--bare", "-q", "-b", "main", remote]);
  assert.equal(
    (await run({ kind: "remote-add", name: "origin", url: remote })).status,
    200,
  );
  let remoteInfo = (await state()).remoteDetails[0];
  assert.equal(remoteInfo.urls[0], remote);
  assert.equal(
    (
      await run({
        kind: "remote-url",
        name: "origin",
        url: "https://user:secret@example.test/a",
        version: remoteInfo.version,
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await run({
        kind: "remote-add",
        name: "bad",
        url: "ext::sh -c touch pwned",
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await run({
        kind: "remote-url",
        name: "origin",
        url: remote,
        version: "0".repeat(64),
      })
    ).status,
    409,
  );
  assert.equal((await run({ kind: "push", remote: "origin" })).status, 200);
  git("branch", "published");
  git("push", "origin", "published");
  const deleted = await run(
    {
      kind: "remote-delete-ref",
      remote: "origin",
      name: "published",
      refKind: "branch",
      sha: head,
    },
    { confirmation: "origin/published" },
  );
  assert.equal(deleted.status, 200, deleted.body.error);
  assert.throws(() =>
    execFileSync("git", ["-C", remote, "rev-parse", "--verify", "published"], {
      stdio: "pipe",
    }),
  );
  assert.equal(
    (
      await run({
        kind: "tag-create",
        name: "v1",
        target: head,
        message: "release",
      })
    ).status,
    200,
  );
  const tag = (await state()).refs.find((r) => r.name === "v1")!;
  assert.equal(
    (
      await run({
        kind: "tag-push",
        name: "v1",
        sha: tag.sha,
        remote: "origin",
      })
    ).status,
    200,
  );
  assert.equal(
    (
      await run(
        {
          kind: "remote-delete-ref",
          remote: "origin",
          name: "v1",
          refKind: "tag",
          sha: tag.sha,
        },
        { confirmation: "origin/v1" },
      )
    ).status,
    200,
  );
  const removedTag = await run(
    { kind: "tag-delete", name: "v1", sha: tag.sha },
    { confirmation: "v1" },
  );
  assert.equal(removedTag.status, 200);
  assert.equal(git("rev-parse", removedTag.body.entry.backup), tag.sha);
  assert.equal(
    (await run({ kind: "undo", id: removedTag.body.entry.id })).status,
    409,
  );
  assert.equal(
    (
      await run({
        kind: "branch-create",
        name: "restore-tag",
        target: removedTag.body.entry.backup,
        checkout: false,
      })
    ).status,
    200,
  );
  remoteInfo = (await state()).remoteDetails[0];
  assert.equal(
    (
      await run(
        { kind: "remote-remove", name: "origin", version: remoteInfo.version },
        { confirmation: "origin" },
      )
    ).status,
    200,
  );
  assert.equal((await state()).remotes.length, 0);
  console.log(
    "ok · remote configuration, explicit remote deletes, tag backup and safe recovery",
  );

  git("checkout", "-qb", "binary-side");
  writeFileSync(join(root, "binary.dat"), Buffer.from([0, 1, 2]));
  git("add", ".");
  git("commit", "-qm", "binary side");
  git("checkout", "-q", "main");
  writeFileSync(join(root, "binary.dat"), Buffer.from([0, 3, 4]));
  git("add", ".");
  git("commit", "-qm", "binary main");
  assert.equal(
    (await run({ kind: "merge", target: "binary-side", strategy: "ff" }))
      .status,
    409,
  );
  let res = await app.request(
    `/projects/p/git/workbench/conflict?root=${encodeURIComponent(root)}&path=binary.dat`,
  );
  const conflict = await res.json();
  assert.equal(conflict.binary, true);
  assert.equal(conflict.available.ours, true);
  assert.equal(conflict.available.theirs, true);
  assert.equal(
    (
      await run({
        kind: "resolve",
        path: "binary.dat",
        version: conflict.version,
        choice: "content",
        content: "lossy",
      })
    ).status,
    409,
  );
  assert.equal(
    (
      await run({
        kind: "resolve",
        path: "binary.dat",
        version: conflict.version,
        choice: "theirs",
      })
    ).status,
    200,
  );
  assert.deepEqual(
    readFileSync(join(root, "binary.dat")),
    Buffer.from([0, 1, 2]),
  );
  assert.equal((await run({ kind: "continue" })).status, 200);
  assert.ok(!existsSync(join(root, "pwned")));
  console.log(
    "ok · binary conflict versions, lossless side selection and continuation",
  );

  const { setInstanceMode } = await import("../src/auth/mode.js");
  await setInstanceMode("multi", directory);
  await db.insert(users).values({
    id: "member",
    name: "member",
    dirName: "member",
    role: "member",
    status: "active",
    createdAt: at,
  });
  await db
    .insert(projectMembers)
    .values({ projectId: "p", userId: "member", role: "member", addedAt: at });
  const member = new Hono();
  member.use("*", async (c, next) => {
    setActor(c, {
      kind: "user",
      userId: "member",
      role: "member",
      name: "Member",
    });
    await next();
  });
  mountGitWorkbenchRoutes(member);
  res = await member.request("/projects/p/git/workbench");
  assert.equal(res.status, 200);
  assert.match((await res.json()).readOnly, /管理员/);
  assert.equal(
    (
      await member.request("/projects/p/git/workbench/actions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      })
    ).status,
    403,
  );
  console.log("ok · project members can read but cannot mutate Git");
} finally {
  const { dbClient } = await import("../src/db/index.js");
  dbClient.close();
  rmSync(directory, { recursive: true, force: true });
}
