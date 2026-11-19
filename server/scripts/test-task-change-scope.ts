// 「这条任务自己改了什么」的口径（server/src/task-change-scope.ts）：任务分支把目标分支合进来之后，
// 目标分支上本来就有的、开工点里已经有的，都不能算成这条任务的改动。
//
// 每一档都从同一个入口核对一遍「同一口径」：整份 diff、逐个单文件 diff、动过哪些路径、提交清单、
// 交给审查者的对比基准（连同它给的那条 git log 命令）说的必须是同一段改动。
//
// git 夹具全在临时目录里；进程里的 GIT_* 先清掉，免得漏进夹具改到别的仓库。
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { releaseTmpDb } from "./tmp-db.js";

for (const key of Object.keys(process.env)) if (key.startsWith("GIT_")) delete process.env[key];
const root = mkdtempSync(join(tmpdir(), "navi-change-scope-"));
process.env.NAVI_DB = join(root, "ash.db");
process.env.NAVI_RUNS_DIR = join(root, "runs");
const { db, ensureSchema } = await import("../src/db/index.js");
const { projects, taskBranchReceipts, taskPrerequisites, tasks } = await import("../src/db/schema.js");
const { mountTaskDiffRoutes } = await import("../src/task-diff-routes.js");
const { mountTaskScheduleRoutes } = await import("../src/task-schedule-routes.js");
const { taskBranchChangedPaths } = await import("../src/git-diff.js");
const { TASK_COMMIT_LIST_LIMIT } = await import("../src/task-change-scope.js");
const { verifyProtocolFor } = await import("../src/review-prompts.js");
const { prerequisiteStart } = await import("../src/prerequisite-start-point.js");
const { worktreeBranchName } = await import("../src/git.js");
await ensureSchema();
const api = new Hono();
mountTaskDiffRoutes(api);
mountTaskScheduleRoutes(api);

const at = new Date().toISOString();
const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const row = async (id: string) => (await db.select().from(tasks).where(eq(tasks.id, id)))[0]!;
const read = async (path: string) => {
  const response = await api.request(path);
  assert.equal(response.status, 200, `${path} → ${response.status}`);
  return response.json();
};
/** 在仓库当前检出的分支上写一个文件并提交。 */
const commit = (repo: string, file: string, content: string, message = file) => {
  writeFileSync(join(repo, file), content);
  git(repo, "add", "--", file);
  git(repo, "commit", "-m", message);
  return git(repo, "rev-parse", "HEAD");
};
const lines = (...values: string[]) => `${values.join("\n")}\n`;
/** 同一秒内的提交先后不稳：清单里有别的分支带进来的提交时只比有哪些。 */
const sorted = (values: string[]) => [...values].sort();

let sequence = 0;
/** 一个临时仓库：main 上有 shared.txt（三行）和 old.txt。 */
async function repository() {
  const id = `r${++sequence}`;
  const repo = join(root, id);
  execFileSync("git", ["init", "-b", "main", repo], { stdio: "ignore" });
  git(repo, "config", "user.name", "Scope Test");
  git(repo, "config", "user.email", "scope@example.test");
  commit(repo, "shared.txt", lines("one", "two", "three"));
  commit(repo, "old.txt", lines("old"));
  await db.insert(projects).values({ id, name: id, repoPath: repo, createdAt: at });
  let count = 0;
  /** 建一条任务和它的分支（从 `start` 开叉）。任务号前八位各不相同，分支名由它派生。 */
  const task = async (name: string, start: string, extra: Partial<typeof tasks.$inferInsert> = {}) => {
    const taskId = `${id}t${++count}`.padEnd(8, "x") + `-${name}`;
    git(repo, "branch", worktreeBranchName(taskId), start);
    await db.insert(tasks).values({ id: taskId, projectId: id, title: name, body: "test", status: "done", createdAt: at, updatedAt: at,
      useWorktree: true, workflowMode: "free", worktreeStartCommit: start, mergeTargetBranch: "main", ...extra });
    return { id: taskId, branch: worktreeBranchName(taskId) };
  };
  /** 切到某条分支上做事，做完回 main。 */
  const on = <T>(branch: string, work: () => T): T => {
    git(repo, "checkout", "-q", branch);
    try { return work(); } finally { git(repo, "checkout", "-q", "main"); }
  };
  /** 任务分支把 main 合进来；有冲突时按 `resolve` 给的内容解掉再提交。 */
  const mergeMain = (branch: string, message: string, resolve?: Record<string, string>) => on(branch, () => {
    try {
      git(repo, "merge", "--no-ff", "-m", message, "main");
      assert.ok(!resolve, "这一步本该有冲突");
    } catch (error) {
      if (!resolve) throw error;
      for (const [file, content] of Object.entries(resolve)) { writeFileSync(join(repo, file), content); git(repo, "add", "--", file); }
      git(repo, "commit", "-m", message);
    }
    return git(repo, "rev-parse", "HEAD");
  });
  return { id, repo, task, on, mergeMain, head: (ref = "main") => git(repo, "rev-parse", ref) };
}
type Repo = Awaited<ReturnType<typeof repository>>;

/**
 * 从各个入口读一遍，确认它们说的是同一段改动，再把这段改动交回去断言。
 * `files` 是「路径 → [增, 删]」，`subjects` 是提交清单（新的在前）。
 */
async function scope(r: Repo, taskId: string) {
  const diff = await read(`/tasks/${taskId}/diff`);
  assert.equal(diff.available, true, `diff 读不出来：${diff.reason}`);
  const commits = await read(`/tasks/${taskId}/commits`);
  assert.equal(commits.reason, undefined, "数得出来的清单不带原因");
  const task = await row(taskId);
  const paths = await taskBranchChangedPaths(r.repo, task);
  assert.equal(paths.available, true);
  const listed = (diff.files as { path: string; additions: number; deletions: number }[]);
  assert.deepEqual([...paths.paths].sort(), listed.map((file) => file.path).sort(), "产物面板「已提交」那一档和 diff 文件清单是同一批路径");
  for (const file of listed) {
    const single = await read(`/tasks/${taskId}/diff/file?path=${encodeURIComponent(file.path)}`);
    assert.equal(single.available, true);
    assert.ok(single.diff.length > 0, `清单上有 ${file.path}，单文件 diff 不能是空的`);
    // 同一个文件的那一段，整份里和单独读出来的一样。
    assert.ok(diff.diff.includes(single.diff.trimEnd()), `${file.path} 的单文件 diff 和整份 diff 对不上`);
  }
  const prompt = await verifyProtocolFor(task, 1, r.repo);
  assert.ok(prompt.includes(`比较基线 ${diff.mergeBase}`), "交给审查者的对比基准就是 diff 的基准");
  // 审查者照提示里那条命令列出来的提交，和提交清单是同一批。
  const command = /本任务自己的提交：git log (\S+) --not ([0-9a-f ]+)）/.exec(prompt);
  assert.ok(command, "提示里要给出列提交的命令");
  const logged = git(r.repo, "log", "--format=%H", command![1]!, "--not", ...command![2]!.trim().split(" ")).split("\n").filter(Boolean);
  assert.deepEqual(logged.slice(0, commits.commits.length), commits.commits.map((entry: { sha: string }) => entry.sha));
  assert.equal(logged.length, commits.total, "真实条数和审查者列出来的一致");
  return {
    base: diff.mergeBase as string,
    files: Object.fromEntries(listed.map((file) => [file.path, [file.additions, file.deletions]])) as Record<string, [number, number]>,
    subjects: (commits.commits as { subject: string }[]).map((entry) => entry.subject),
    total: commits.total as number,
    diff: diff.diff as string,
  };
}

/** 算不出来时：各个入口给出同一个原因，没有哪个悄悄给出数字。 */
async function unavailable(r: Repo, taskId: string, reason: string, said: RegExp) {
  const diff = await read(`/tasks/${taskId}/diff`);
  assert.equal(diff.available, false);
  assert.equal(diff.reason, reason);
  assert.deepEqual(diff.files, []);
  const single = await read(`/tasks/${taskId}/diff/file?path=shared.txt`);
  assert.equal(single.available, false);
  assert.equal(single.reason, reason);
  const commits = await read(`/tasks/${taskId}/commits`);
  assert.deepEqual(commits.commits, []);
  // 数不出来不是「没有提交」：条数是 null，原因和 diff 那边是同一个。
  assert.equal(commits.total, null);
  assert.equal(commits.reason, reason);
  const task = await row(taskId);
  const paths = await taskBranchChangedPaths(r.repo, task);
  assert.equal(paths.available, false);
  assert.equal(paths.reason, reason);
  assert.match(await verifyProtocolFor(task, 1, r.repo), said);
}

/** 一条前置：从此刻的 main 开叉，改 shared.txt 第一行并新增 `<name>.txt`。 */
async function prerequisite(r: Repo, name: string) {
  const task = await r.task(name, r.head());
  const head = r.on(task.branch, () => {
    commit(r.repo, "shared.txt", lines(`${name}-one`, "two", "three"), `${name}: shared`);
    return commit(r.repo, `${name}.txt`, lines(name));
  });
  return { ...task, head };
}

/** 按前置开工的下游：起点由真正的开工判定合出来（目标分支 + 各条前置交出的那一版）。 */
async function downstream(r: Repo, name: string, givers: { id: string; head: string }[]) {
  const placeholder = { ...(await row(givers[0]!.id)), id: "downstream", mergeTargetBranch: "main" };
  const start = await prerequisiteStart(r.repo, placeholder,
    await Promise.all(givers.map(async (giver) => ({ task: await row(giver.id), commit: giver.head }))));
  assert.ok(start.ok, JSON.stringify(start));
  if (!start.ok) throw new Error("unreachable");
  const task = await r.task(name, start.commit);
  for (const giver of givers) {
    await db.insert(taskPrerequisites).values({ taskId: task.id, prerequisiteId: giver.id, inheritedCommit: start.inherited.get(giver.id)!, createdAt: at });
  }
  return { ...task, start: start.commit };
}

/** 把一条任务分支压缩合入 main，并按验收那样在任务上记下这次合入。 */
async function squashAccept(r: Repo, giver: { id: string; branch: string; head: string }, evidence: "accepted" | "receipt") {
  const before = r.head();
  git(r.repo, "merge", "--squash", giver.branch);
  git(r.repo, "commit", "-m", `squash ${giver.branch}`);
  const merged = r.head();
  if (evidence === "accepted") {
    await db.update(tasks).set({ stage: "accepted", acceptedSourceCommit: giver.head, acceptedTargetBranch: "main",
      acceptedBaseCommit: before, acceptedMergeCommit: merged }).where(eq(tasks.id, giver.id));
  } else {
    await db.insert(taskBranchReceipts).values({ id: `${giver.id}:receipt`, taskId: giver.id, sourceCommit: giver.head, mergeCommit: merged, targetBranch: "main" });
  }
  return merged;
}

try {
  {
    // 验收标准第一条：从 main 开分支提交一条，main 前进几条（还删了东西），分支合并 main。
    const r = await repository();
    const start = r.head();
    const task = await r.task("plain", start);
    r.on(task.branch, () => commit(r.repo, "own.txt", lines("own")));
    let seen = await scope(r, task.id);
    assert.equal(seen.base, start, "没合过目标分支：起点就是开工点");
    assert.deepEqual(seen.files, { "own.txt": [1, 0] });
    assert.deepEqual(seen.subjects, ["own.txt"]);

    commit(r.repo, "m1.txt", lines("m1"));
    commit(r.repo, "m2.txt", lines("a", "b", "c"));
    git(r.repo, "rm", "-q", "old.txt"); git(r.repo, "commit", "-q", "-m", "cleanup");
    const mergedIn = r.head();
    r.mergeMain(task.branch, "merge main");
    commit(r.repo, "m3.txt", lines("m3"));
    seen = await scope(r, task.id);
    assert.equal(seen.base, mergedIn, "开工点在目标分支上、之后合过：起点是分支和目标分支的共同祖先");
    assert.deepEqual(seen.files, { "own.txt": [1, 0] }, "main 的进展（新增、清理）不算，没合进来的 m3 也不出现");
    assert.deepEqual(seen.subjects, ["merge main", "own.txt"], "它自己的那一条，加它自己做的合并提交");
    assert.equal(seen.total, 2);
    console.log("✓ 合过目标分支：提交清单是自己的一条加一条合并提交，文件和增删行只算自己的；目标分支后来的进展不出现");

    // 解冲突时动的内容算任务自己的改动。
    r.on(task.branch, () => commit(r.repo, "shared.txt", lines("one", "task two", "three"), "task edits shared"));
    commit(r.repo, "shared.txt", lines("one", "main two", "three"), "main edits shared");
    r.mergeMain(task.branch, "merge main, resolved", { "shared.txt": lines("one", "resolved two", "three") });
    seen = await scope(r, task.id);
    assert.deepEqual(seen.files, { "own.txt": [1, 0], "shared.txt": [1, 1] });
    assert.match(seen.diff, /-main two\n\+resolved two/, "解冲突写下的那一行，是相对合进来的目标分支算的");
    assert.deepEqual(seen.subjects, ["merge main, resolved", "task edits shared", "merge main", "own.txt"]);
    console.log("✓ 解冲突时动的内容算任务自己的改动");
  }
  {
    // 用户撞到的那一条：分支上有自己的提交，合并 main 之后文件和 main 完全一致。
    const r = await repository();
    const task = await r.task("net-zero", r.head());
    r.on(task.branch, () => commit(r.repo, "doc.txt", lines("draft")));
    for (let index = 0; index < 4; index += 1) commit(r.repo, `main-${index}.txt`, lines(String(index)));
    commit(r.repo, "doc.txt", lines("final"));
    r.mergeMain(task.branch, "merge main", { "doc.txt": lines("final") });
    assert.equal(git(r.repo, "rev-parse", `${task.branch}^{tree}`), git(r.repo, "rev-parse", "main^{tree}"));
    const seen = await scope(r, task.id);
    assert.deepEqual(seen.files, {}, "净改动为零就是零个文件");
    assert.deepEqual(seen.subjects, ["merge main", "doc.txt"]);
    console.log("✓ 合并后与目标分支完全一致：零文件，提交清单只有它自己的两条");
  }
  {
    // 前置还没合入：开工点是「目标分支 + 前置」合成的提交，不在目标分支上。
    const r = await repository();
    const giver = await prerequisite(r, "pre");
    commit(r.repo, "m1.txt", lines("m1"));
    const task = await downstream(r, "after-pre", [giver]);
    assert.notEqual(task.start, giver.head, "前提：起点是合成的");
    r.on(task.branch, () => commit(r.repo, "down.txt", lines("down")));
    let seen = await scope(r, task.id);
    assert.equal(seen.base, task.start);
    assert.deepEqual(seen.files, { "down.txt": [1, 0] });
    assert.deepEqual(seen.subjects, ["down.txt"], "合成起点、前置的提交都不在清单里");

    commit(r.repo, "m2.txt", lines("m2"));
    r.mergeMain(task.branch, "merge main");
    seen = await scope(r, task.id);
    assert.deepEqual(seen.files, { "down.txt": [1, 0] }, "前置带来的、目标分支带来的都不算");
    assert.deepEqual(seen.subjects, ["merge main", "down.txt"]);
    assert.ok(seen.base !== task.start && seen.base !== r.head(), "基准是两边合出来的一个提交");
    assert.equal((await scope(r, task.id)).base, seen.base, "同样的两边永远合出同一个提交，反复读不会越攒越多");
    // 合成的基准没有引用指着：仓库整理把它收走之后照样读得出来。
    git(r.repo, "reflog", "expire", "--expire=now", "--all"); git(r.repo, "gc", "-q", "--prune=now");
    assert.throws(() => git(r.repo, "cat-file", "-e", seen.base), "前提：合成的提交已经被收走");
    assert.deepEqual((await scope(r, task.id)).files, { "down.txt": [1, 0] });
    console.log("✓ 前置没合入、下游合过目标分支：改动里既没有前置的也没有目标分支的；合成的基准可重算");

    // 前置直接合入了目标分支。下游没把这一段合进来之前，口径不变；合进来之后前置的内容不算回下游头上。
    git(r.repo, "merge", "-q", "--no-ff", "-m", "accept pre", giver.branch);
    assert.deepEqual((await scope(r, task.id)).files, { "down.txt": [1, 0] });
    const mergedIn = r.head();
    r.mergeMain(task.branch, "merge main again");
    seen = await scope(r, task.id);
    assert.equal(seen.base, mergedIn, "前置已经在合进来的那段目标分支里：基准就是那一段");
    assert.deepEqual(seen.files, { "down.txt": [1, 0] });
    assert.deepEqual(seen.subjects, ["merge main again", "merge main", "down.txt"]);
    console.log("✓ 前置后来直接合入目标分支、下游又合了目标分支：前置的改动不算回下游");
  }
  for (const evidence of ["accepted", "receipt"] as const) {
    // 前置压缩合入（或调整历史后合入，凭回执认），目标分支随后又改了前置动过的同一处。
    const r = await repository();
    const giver = await prerequisite(r, "pre");
    commit(r.repo, "m1.txt", lines("m1"));
    const task = await downstream(r, "after-squash", [giver]);
    r.on(task.branch, () => commit(r.repo, "down.txt", lines("down")));
    await squashAccept(r, giver, evidence);
    commit(r.repo, "shared.txt", lines("pre-one, revised on main", "two", "three"), "main revises what pre changed");
    commit(r.repo, "pre.txt", lines("pre", "more"), "main extends pre.txt");
    assert.deepEqual((await scope(r, task.id)).files, { "down.txt": [1, 0] }, "下游还没把这一段合进来：前置的代码仍只来自开工点");
    const mergedIn = r.head();
    // 开工点里是前置原来那一版，目标分支上是改过的：下游这次合并有冲突，照目标分支的解。
    r.mergeMain(task.branch, "merge main", { "shared.txt": lines("pre-one, revised on main", "two", "three"), "pre.txt": lines("pre", "more") });
    const seen = await scope(r, task.id);
    assert.equal(seen.base, mergedIn);
    assert.deepEqual(seen.files, { "down.txt": [1, 0] }, "前置的改动既不算回下游头上，也不算成被删掉；目标分支后来的修改也不算");
    assert.deepEqual(seen.subjects, ["merge main", "down.txt"]);
    console.log(`✓ 前置${evidence === "accepted" ? "压缩合入" : "调整历史后合入（凭回执）"}、目标分支又改了同一处：下游的改动只有它自己的`);
  }
  {
    // 两条前置，一条压缩合入了、一条还没进：只补没进的那一条。
    const r = await repository();
    const merged = await prerequisite(r, "pre");
    const waiting = await r.task("other", r.head());
    const waitingHead = r.on(waiting.branch, () => commit(r.repo, "other.txt", lines("other")));
    commit(r.repo, "m1.txt", lines("m1"));
    const task = await downstream(r, "after-two", [merged, { ...waiting, head: waitingHead }]);
    r.on(task.branch, () => commit(r.repo, "down.txt", lines("down")));
    await squashAccept(r, merged, "accepted");
    commit(r.repo, "shared.txt", lines("pre-one, revised on main", "two", "three"), "main revises what pre changed");
    r.mergeMain(task.branch, "merge main", { "shared.txt": lines("pre-one, revised on main", "two", "three") });
    const seen = await scope(r, task.id);
    assert.deepEqual(seen.files, { "down.txt": [1, 0] }, "进了的那条不重复算，没进的那条照旧从开工点这一侧扣掉");
    assert.deepEqual(seen.subjects, ["merge main", "down.txt"]);
    console.log("✓ 两条前置一进一没进：两边的改动都不算到下游头上");
  }
  {
    // 单父继承（从父任务分支开叉）：开工点就是父任务那一版，父的改动在合入前后都不算子任务的。
    const r = await repository();
    const parent = await prerequisite(r, "parent");
    const child = await r.task("child", parent.head, { baseTaskId: parent.id, worktreeBase: parent.branch });
    r.on(child.branch, () => commit(r.repo, "child.txt", lines("child")));
    commit(r.repo, "m1.txt", lines("m1"));
    r.mergeMain(child.branch, "merge main");
    let seen = await scope(r, child.id);
    assert.deepEqual(seen.files, { "child.txt": [1, 0] });
    assert.deepEqual(seen.subjects, ["merge main", "child.txt"], "开工点里的父提交不在子任务的清单里");
    await squashAccept(r, parent, "accepted");
    commit(r.repo, "parent.txt", lines("parent", "more"), "main extends parent.txt");
    r.mergeMain(child.branch, "merge main again", { "parent.txt": lines("parent", "more") });
    seen = await scope(r, child.id);
    assert.deepEqual(seen.files, { "child.txt": [1, 0] }, "父任务压缩合入后不算回子任务头上，目标分支后来对它的修改也不算");
    assert.deepEqual(seen.subjects, ["merge main again", "merge main", "child.txt"]);
    console.log("✓ 从父任务分支开叉的子任务：开工点里父的改动和提交在父合入前后都不算子任务的");
  }
  for (const evidence of ["accepted", "receipt"] as const) for (const cleaned of [true, false]) {
    // 定下来的行为（用户 2026-11-16）：只认「在哪」，不认「谁做的」。下游开工之后又手动合进来的上游提交，
    // 在上游合入目标分支、下游把那一段合进来之前，算在下游的改动里 —— 文件和提交清单都有它；
    // 合进来之后两边一起消失，凭的是上游验收时记下的那一版，上游的分支在不在都一样。
    // 要拿上游后来的成果又不想算在自己头上，正路是「更新基线」（挪开工点），不是手动合。
    const r = await repository();
    const parent = await prerequisite(r, "parent");
    const child = await r.task("child", parent.head, { baseTaskId: parent.id, worktreeBase: parent.branch });
    r.on(child.branch, () => commit(r.repo, "child.txt", lines("child")));
    parent.head = r.on(parent.branch, () => commit(r.repo, "parent-more.txt", lines("more")));
    r.on(child.branch, () => git(r.repo, "merge", "-q", "--no-ff", "-m", "merge parent", parent.branch));
    commit(r.repo, "m1.txt", lines("m1"));
    r.mergeMain(child.branch, "merge main");
    let seen = await scope(r, child.id);
    assert.deepEqual(seen.files, { "child.txt": [1, 0], "parent-more.txt": [1, 0] }, "父任务没合入：子任务手动合进来的那条父改动算在子任务的改动里");
    assert.deepEqual(sorted(seen.subjects), sorted(["merge main", "merge parent", "parent-more.txt", "child.txt"]), "提交清单同样有它：和文件说的是同一件事");

    const landedAt = await squashAccept(r, parent, evidence);
    if (cleaned) git(r.repo, "branch", "-D", parent.branch);
    seen = await scope(r, child.id);
    assert.deepEqual(seen.files, { "child.txt": [1, 0], "parent-more.txt": [1, 0] }, "父任务合入了，子任务还没把那一段合进来：照旧");
    assert.equal(seen.total, 4);
    r.mergeMain(child.branch, "merge main again");
    seen = await scope(r, child.id);
    assert.equal(seen.base, landedAt, "父任务的验收版本已经在合进来的目标分支里：基准就是那一段");
    assert.deepEqual(seen.files, { "child.txt": [1, 0] }, "父的改动已经在目标分支上：不算子任务的");
    assert.deepEqual(sorted(seen.subjects), sorted(["merge main again", "merge main", "merge parent", "child.txt"]), "父的提交也一起从清单里消失");

    // 按前置开工的下游同理。
    const giver = await prerequisite(r, "pre");
    const task = await downstream(r, "after-pre", [giver]);
    r.on(task.branch, () => commit(r.repo, "down.txt", lines("down")));
    giver.head = r.on(giver.branch, () => commit(r.repo, "pre-more.txt", lines("more")));
    r.on(task.branch, () => git(r.repo, "merge", "-q", "--no-ff", "-m", "merge pre", giver.branch));
    commit(r.repo, "m9.txt", lines("m9"));
    r.mergeMain(task.branch, "merge main");
    let later = await scope(r, task.id);
    assert.deepEqual(later.files, { "down.txt": [1, 0], "pre-more.txt": [1, 0] });
    assert.deepEqual(sorted(later.subjects), sorted(["merge main", "merge pre", "pre-more.txt", "down.txt"]));
    await squashAccept(r, giver, evidence);
    if (cleaned) git(r.repo, "branch", "-D", giver.branch);
    r.mergeMain(task.branch, "merge main again");
    later = await scope(r, task.id);
    assert.deepEqual(later.files, { "down.txt": [1, 0] });
    assert.deepEqual(sorted(later.subjects), sorted(["merge main again", "merge main", "merge pre", "down.txt"]));
    console.log(`✓ 开工后手动合进来的上游提交（上游${evidence === "accepted" ? "压缩合入" : "凭回执合入"}、分支${cleaned ? "已清理" : "还在"}）：上游合入并被下游合进来之前算下游的，之后文件和提交一起不算`);
  }
  {
    // 上游收过下游的一部分再回流：父任务先合了子任务当时的成果、自己再往前走，子任务又把父分支合回来。
    // 子任务自己前后两次的文件和提交都在 —— 不从共同祖先去猜哪一段是「父交来的」。
    const r = await repository();
    const parent = await prerequisite(r, "parent");
    const child = await r.task("child", parent.head, { baseTaskId: parent.id, worktreeBase: parent.branch });
    r.on(child.branch, () => commit(r.repo, "child-first.txt", lines("first")));
    parent.head = r.on(parent.branch, () => {
      git(r.repo, "merge", "-q", "--no-ff", "-m", "parent receives child", child.branch);
      return commit(r.repo, "parent-more.txt", lines("more"));
    });
    r.on(child.branch, () => {
      commit(r.repo, "child-second.txt", lines("second"));
      git(r.repo, "merge", "-q", "--no-ff", "-m", "merge parent", parent.branch);
    });
    commit(r.repo, "foreign.txt", lines("foreign"));
    r.mergeMain(child.branch, "merge main");
    let seen = await scope(r, child.id);
    assert.deepEqual(seen.files, { "child-first.txt": [1, 0], "child-second.txt": [1, 0], "parent-more.txt": [1, 0] },
      "子任务两次自己的文件都在；父任务没合入的那条照上一档的规矩也在");
    assert.deepEqual(sorted(seen.subjects),
      sorted(["merge main", "merge parent", "child-second.txt", "parent-more.txt", "parent receives child", "child-first.txt"]),
      "子任务两次自己的提交和它做的两次合并都在清单里");

    // 父任务随后压缩合入，合入的那一版里就有 child-first：它从此是「目标分支上已经有的」，
    // 子任务把那一段合进来之后，文件和提交一起不再算（验收子任务也不会再带进去这一份）。
    await squashAccept(r, parent, "accepted");
    r.mergeMain(child.branch, "merge main again");
    seen = await scope(r, child.id);
    assert.deepEqual(seen.files, { "child-second.txt": [1, 0] });
    assert.deepEqual(sorted(seen.subjects), sorted(["merge main again", "merge main", "merge parent", "child-second.txt"]));
    console.log("✓ 上游收过下游的一部分再回流：下游自己的文件和提交不被扣掉；随上游合入目标分支的那部分之后才不算");
  }
  {
    // 提交清单截断：列出来的是最近一批，条数照实给。
    const r = await repository();
    const task = await r.task("many", r.head());
    const own = TASK_COMMIT_LIST_LIMIT + 10;
    r.on(task.branch, () => { for (let index = 0; index < own; index += 1) git(r.repo, "commit", "-q", "--allow-empty", "-m", `own ${index}`); });
    for (let index = 0; index < 5; index += 1) commit(r.repo, `main-${index}.txt`, lines(String(index)));
    r.mergeMain(task.branch, "merge main");
    const commits = await read(`/tasks/${task.id}/commits`);
    assert.equal(commits.commits.length, TASK_COMMIT_LIST_LIMIT, "清单只列最近一批");
    assert.equal(commits.total, own + 1, "总数是真实条数：自己的提交加一条合并，不含 main 的那 5 条");
    assert.equal(commits.commits[0].subject, "merge main");
    assert.equal((await scope(r, task.id)).total, own + 1);
    console.log(`✓ 提交多到截断：列 ${TASK_COMMIT_LIST_LIMIT} 条，总数照实是 ${own + 1}`);
  }
  {
    // 已经合入目标分支的任务：目标分支里有它自己，按合入之前那一版扣。
    const r = await repository();
    const task = await r.task("merged", r.head());
    r.on(task.branch, () => commit(r.repo, "own.txt", lines("own")));
    commit(r.repo, "m1.txt", lines("m1"));
    r.mergeMain(task.branch, "merge main");
    const before = r.head();
    git(r.repo, "merge", "-q", "--no-ff", "-m", "accept", task.branch);
    commit(r.repo, "later.txt", lines("later"));
    const live = await scope(r, task.id);
    assert.deepEqual(live.files, {}, "没有验收记录时照实算：分支整条已经在目标分支里，没有目标分支之外的改动");
    assert.deepEqual(live.subjects, []);
    assert.equal(live.total, 0, "真的一条都没有时是 0，和数不出来的 null 分得开");
    await db.update(tasks).set({ stage: "merged", acceptedTargetBranch: "main", acceptedBaseCommit: before, acceptedMergeCommit: git(r.repo, "rev-parse", "main~1") })
      .where(eq(tasks.id, task.id));
    const seen = await scope(r, task.id);
    assert.deepEqual(seen.files, { "own.txt": [1, 0] });
    assert.deepEqual(seen.subjects, ["merge main", "own.txt"]);
    console.log("✓ 已合入、分支还在：按验收时冻结的合入前那一版算，仍是它自己的改动");
  }
  {
    // 算不出来就说出来。
    const r = await repository();
    const lost = await r.task("lost-start", r.head());
    r.on(lost.branch, () => commit(r.repo, "own.txt", lines("own")));
    await db.update(tasks).set({ worktreeStartCommit: "0".repeat(40) }).where(eq(tasks.id, lost.id));
    await unavailable(r, lost.id, "start_commit_unreadable", /比较基线 未能确定（无法读取任务的开工提交）/);

    // 前置没合入，目标分支却改了前置动过的同一处：开工点和合进来的目标分支合不拢。
    const giver = await prerequisite(r, "pre");
    commit(r.repo, "m1.txt", lines("m1"));
    const task = await downstream(r, "conflicted", [giver]);
    r.on(task.branch, () => commit(r.repo, "down.txt", lines("down")));
    commit(r.repo, "shared.txt", lines("main-one", "two", "three"), "main changes the same line");
    r.mergeMain(task.branch, "merge main", { "shared.txt": lines("merged-one", "two", "three") });
    await unavailable(r, task.id, "base_conflict", /比较基线 未能确定（开工点带来的代码和任务分支里已合入的目标分支合不到一起/);
    console.log("✓ 开工点读不出来、合成基准时两边合不拢：各个入口给出同一个原因，不给数字");
  }
  {
    // 目标那一版读不到：开工点还在也不退回按开工点算 —— 合进来的目标分支会整段算成任务自己的。
    const r = await repository();
    const task = await r.task("target-gone", r.head());
    r.on(task.branch, () => commit(r.repo, "own.txt", lines("own")));
    commit(r.repo, "foreign.txt", lines("foreign"));
    const before = r.head();
    r.mergeMain(task.branch, "merge main");
    assert.deepEqual((await scope(r, task.id)).files, { "own.txt": [1, 0] });
    // 已合入的任务认验收时冻结的那一版；那一版读不到，不拿此刻的目标分支顶替。
    await db.update(tasks).set({ stage: "merged", acceptedBaseCommit: "0".repeat(40) }).where(eq(tasks.id, task.id));
    await unavailable(r, task.id, "accepted_snapshot_unreadable", /比较基线 未能确定（无法读取验收时保存的提交）/);
    await db.update(tasks).set({ stage: null, acceptedBaseCommit: null }).where(eq(tasks.id, task.id));

    git(r.repo, "branch", "-m", "main", "trunk");
    await unavailable(r, task.id, "target_branch_missing", /比较基线 未能确定（合入目标分支不在本地）/);
    // 冻结的那一版还读得到时，目标分支后来改名、删除都不影响已合入的任务。
    await db.update(tasks).set({ stage: "merged", acceptedBaseCommit: before }).where(eq(tasks.id, task.id));
    assert.deepEqual((await scope(r, task.id)).subjects, ["merge main", "own.txt"]);
    await db.update(tasks).set({ stage: null, acceptedBaseCommit: null }).where(eq(tasks.id, task.id));
    // 把合入目标改到还在的那条分支上，数字就回来了。
    await db.update(tasks).set({ mergeTargetBranch: "trunk" }).where(eq(tasks.id, task.id));
    const seen = await scope(r, task.id);
    assert.deepEqual(seen.files, { "own.txt": [1, 0] });
    assert.deepEqual(seen.subjects, ["merge main", "own.txt"]);
    git(r.repo, "checkout", "-q", "--detach");
    git(r.repo, "branch", "-D", "trunk");
    await unavailable(r, task.id, "target_branch_missing", /比较基线 未能确定（合入目标分支不在本地）/);
    await db.update(tasks).set({ mergeTargetBranch: null }).where(eq(tasks.id, task.id));
    await unavailable(r, task.id, "target_unresolved", /比较基线 未能确定（无法确定目标分支）/);
    console.log("✓ 目标分支被删、被改名，或冻结的合入前那一版读不到：各个入口都说算不出来，不退回按开工点算");
  }
  {
    // 只有提交清单读不出来（一条说明长到撑破读取上限）、diff 是好的：清单那边给出自己的原因，不给 0，diff 照常。
    const r = await repository();
    const task = await r.task("long-subject", r.head());
    r.on(task.branch, () => {
      commit(r.repo, "own.txt", lines("own"));
      execFileSync("git", ["-C", r.repo, "commit", "-q", "--allow-empty", "-F", "-"], { input: "x".repeat(1_100_000), stdio: ["pipe", "ignore", "pipe"] });
    });
    const commits = await read(`/tasks/${task.id}/commits`);
    assert.deepEqual([commits.commits, commits.total, commits.reason], [[], null, "commit_list_unreadable"]);
    const diff = await read(`/tasks/${task.id}/diff`);
    assert.equal(diff.available, true);
    assert.deepEqual(diff.files.map((file: { path: string }) => file.path), ["own.txt"]);
    console.log("✓ 只有提交清单读不出来：清单给出原因和 null，diff 不受牵连");
  }
  console.log("PASS: 任务改动的口径");
} finally {
  await releaseTmpDb(); rmSync(root, { recursive: true, force: true });
}
