// 「在别的机器上跑完 + 验收完，再移回原机」这条路上的两桩回归（用户 2026-09-01 报的）：
//
//   1. 移回后**不该**自动续跑。续跑的第一件事是把验收牌子连同合并快照整套摘掉
//      （turn-baseline → reopenAcceptedStage），于是移回这个动作本身把用户刚点下的验收
//      抹掉了，还白烧一轮 agent。判据落在接收侧，源机勾没勾都拦得住。
//   2. 移回来的**不该**是个空壳 worktree。验收会把任务分支合进目标分支、再删掉 worktree
//      和分支，此后仓库里唯一的痕迹就是目标分支上那个合并提交；不带走它，原机拿到的就是
//      一个建在 base 上的空目录，代码留在对端主线上，本机既看不见也没得合。
//   3. 代码回到原机之后，「验收通过」必须真的在本机合一次 —— 验收章随任务走，合并却走
//      不了（那次 merge 发生在对端仓库里），走 already_accepted 幂等快路就是拿一句
//      「此前已验收完成」盖住「本机主线一个字节都没有」。
//
// 单进程直调，不 spawn 对端 server：两台机器用两个 git 仓库模拟，共用一个临时库，所以
// 「持有机那条任务行」在打完包之后显式删掉（真实场景里它本来就在另一台机器的库里）。
// ASH_RUNS_DIR 指到临时目录顺带打开 guardAgentSpawn：万一续跑闸失手，也不会真拉起 CLI。
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { releaseTmpDb } from "./tmp-db.js";

const root = mkdtempSync(join(tmpdir(), "ash-handoff-accepted-"));
const home = join(root, "home");
mkdirSync(home, { recursive: true });
process.env.HOME = home;
process.env.USERPROFILE = home;
process.env.ASH_DB = join(root, "ash.db");
process.env.ASH_RUNS_DIR = join(root, "runs");
process.env.ASH_UPLOADS_DIR = join(root, "uploads");
process.on("exit", () => { try { rmSync(root, { recursive: true, force: true }); } catch { /* 兜底 */ } });
assert.ok(
  process.env.ASH_ALLOW_REAL_AGENT !== "1",
  "本测试靠 guardAgentSpawn 兜底拦真 CLI;拦截器一失效就会烧用户的真额度",
);

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();

function hasBranch(repo: string, branch: string): boolean {
  try {
    git(repo, "show-ref", "--verify", "--quiet", `refs/heads/${branch}`);
    return true;
  } catch {
    return false;
  }
}

function makeRepo(path: string): string {
  execFileSync("git", ["init", "-b", "main", path]);
  git(path, "config", "user.name", "Ash Handoff Test");
  git(path, "config", "user.email", "handoff@example.test");
  writeFileSync(join(path, ".gitignore"), ".worktrees/\n");
  writeFileSync(join(path, "seed.txt"), "seed\n");
  git(path, "add", "-A");
  git(path, "commit", "-m", "seed");
  return path;
}

try {
  const { db, ensureSchema } = await import("../src/db/index.js");
  const { projects, sessions, tasks } = await import("../src/db/schema.js");
  const { prepareWorktree, worktreeBranchName } = await import("../src/git.js");
  const { cleanupAcceptedTask, cleanupPlanFor, mergeTaskBranch } = await import("../src/git-accept.js");
  const { packGitState } = await import("../src/handoff-collect.js");
  const { importHandoff } = await import("../src/handoff-import.js");
  const { acceptTask } = await import("../src/task-accept.js");
  const { now } = await import("../src/util.js");
  type HandoffManifest = Awaited<ReturnType<typeof import("../src/handoff-import-payload.js")["validate"]>>;
  await ensureSchema();

  const holderRepo = makeRepo(join(root, "holder"));
  const originRepo = join(root, "origin");
  execFileSync("git", ["clone", "--quiet", holderRepo, originRepo]);
  git(originRepo, "config", "user.name", "Ash Handoff Test");
  git(originRepo, "config", "user.email", "handoff@example.test");
  const originBase = git(originRepo, "rev-parse", "HEAD");

  const holderProject = { id: "prjholder01", name: "holder", repoPath: holderRepo, createdAt: now() };
  const originProject = { id: "prjorigin01", name: "origin", repoPath: originRepo, createdAt: now() };
  await db.insert(projects).values([holderProject, originProject]);

  const taskId = "acceptret01";
  const branch = worktreeBranchName(taskId);
  const taskBase = {
    id: taskId,
    projectId: holderProject.id,
    title: "远程验收后移回",
    body: "在持有机上干完并验收",
    mode: "single" as const,
    status: "done" as const,
    workflowMode: "free" as const,
    useWorktree: true,
    worktreeBase: "main",
    agentType: "claude" as const,
    createdAt: now(),
    updatedAt: now(),
  };
  await db.insert(tasks).values(taskBase);

  // ── 1. 持有机:干活 → 验收(合并 + 清理 worktree 和分支)→ 打包 ───────────────
  const ws = await prepareWorktree(holderRepo, taskId, "main");
  writeFileSync(join(ws.path, "feature.txt"), "远程做完的活\n");
  git(ws.path, "add", "-A");
  git(ws.path, "commit", "-m", "feat: 远程实现");
  const merged = await mergeTaskBranch(holderRepo, taskId, "main");
  assert.equal(merged.ok, true, "持有机上的验收合并应当成功");
  if (!merged.ok) throw new Error(merged.message);
  const mergeCommit = merged.afterCommit!;
  const cleaned = await cleanupAcceptedTask(holderRepo, taskId, "main", cleanupPlanFor("all"));
  assert.equal(cleaned.ok, true, "验收清理应当成功");
  assert.equal(existsSync(ws.path), false, "验收清理之后 worktree 目录不该还在");
  assert.equal(hasBranch(holderRepo, branch), false, "验收清理之后任务分支不该还在");
  await db.update(tasks).set({
    stage: "accepted",
    acceptedTargetBranch: "main",
    acceptedBaseCommit: originBase,
    acceptedMergeCommit: mergeCommit,
  }).where(eq(tasks.id, taskId));

  const holderRow = (await db.select().from(tasks).where(eq(tasks.id, taskId))).at(0)!;
  const packNotes: string[] = [];
  const packed = await packGitState(holderRow, holderRepo, [{ name: "main", commit: originBase }], packNotes);
  assert.ok(packed, "已验收任务的合并成果必须能打包带走,不能当成「还没跑过」返回 null");
  assert.equal(packed!.acceptedMerge, true, "载荷要标明这是验收合并成果,接收侧才说得清「还差最后一合」");
  assert.equal(packed!.head, mergeCommit, "带走的应当正是那次验收的合并提交");
  assert.equal(packed!.branch, branch, "落到对端时要用任务分支原来的名字,否则 worktree 接不上");
  assert.ok(packed!.bundleBase64.length > 0, "对端没有这个提交,必须真的传 bundle");
  assert.deepEqual(packed!.prereqs, [originBase], "对端已有的 base 应当协商成前置提交,别整条历史全打");
  assert.equal(
    hasBranch(holderRepo, branch), false,
    "打包借用的临时分支必须撤掉 —— 留着会让持有机以为这个任务还有活分支",
  );
  assert.ok(
    packNotes.some((note) => note.includes("验收") && note.includes(mergeCommit.slice(0, 8))),
    `打包注记要说清带走的是哪次验收的合并提交,实际:${packNotes.join(" / ")}`,
  );

  // 持有机那条任务行属于**另一台机器的库**;单进程模拟只有一个库,导入前先让位。
  await db.delete(sessions).where(eq(sessions.taskId, taskId));
  await db.delete(tasks).where(eq(tasks.id, taskId));

  // ── 2. 原机:导入 —— 代码要落地,而且绝不自动续跑 ──────────────────────────
  const manifest = {
    version: 1,
    sourceHost: "holder-machine",
    sourcePort: null,
    sourceFingerprint: null,
    originFingerprint: null,
    targetProjectId: originProject.id,
    transferId: "transferaccepted01",
    autoResume: true, // 源机明确要求续跑:接收侧仍必须拦住
    sourceWorkspace: ws.path,
    task: {
      id: taskId,
      title: taskBase.title,
      body: taskBase.body,
      status: "done",
      stage: "accepted",
      labels: "[]",
      agentType: "claude",
      model: null,
      reasoningEffort: null,
      autoTitle: false,
      useWorktree: true,
      worktreeBase: "main",
      workflow: null,
      workflowMode: "free",
      workflowAt: null,
      reviewStep: null,
      verifyRounds: 0,
      verifyStationRounds: 0,
      resumePrompt: null,
      question: null,
      questionOptions: null,
      questionItems: null,
      acceptedTargetBranch: "main",
      acceptedBaseCommit: originBase,
      acceptedMergeCommit: mergeCommit,
      pinnedAt: null,
      starredAt: null,
      createdAt: taskBase.createdAt,
      startedAt: taskBase.createdAt,
      endedAt: now(),
    },
    sessions: [],
    freeWorkflow: null,
    git: packed,
    uploads: [],
    messages: [],
    schedule: null,
    files: [],
  } as unknown as HandoffManifest;

  const imported = await importHandoff(manifest, { sourceUrl: "http://holder.test:4317" });
  assert.equal(
    imported.autoResume, false,
    "已验收的任务导入后绝不能自动续跑 —— 一续跑就把用户刚点下的验收连同合并快照整套摘掉",
  );
  assert.ok(
    imported.notes.some((note) => note.includes("已验收") && note.includes("没有自动续跑")),
    `应答要如实说明为什么没续跑,实际:${imported.notes.join(" / ")}`,
  );
  const importedRow = (await db.select().from(tasks).where(eq(tasks.id, taskId))).at(0)!;
  assert.equal(importedRow.stage, "accepted", "验收章随任务回到原机");
  assert.equal(
    (JSON.parse(importedRow.handoff!) as { autoResume?: boolean }).autoResume, false,
    "标记里存的是「到底跑没跑」的事实,幂等收口靠它如实回答源机",
  );
  assert.equal(imported.git, "bundle", "代码必须确认落到原机,否则源机不敢收尾");
  assert.equal(hasBranch(originRepo, branch), true, "验收合并成果要落成原机上的任务分支");
  assert.equal(
    git(originRepo, "rev-parse", branch), mergeCommit,
    "原机这条分支应当正指着那次验收的合并提交",
  );
  assert.equal(
    existsSync(join(imported.workspace!, "feature.txt")), true,
    "移回来的 worktree 里必须有远程做完的活,而不是一个建在 base 上的空壳",
  );
  assert.ok(
    imported.notes.some((note) => note.includes("还没有这份合并")),
    `要说清本机主线还差最后一合,实际:${imported.notes.join(" / ")}`,
  );
  assert.equal(
    git(originRepo, "rev-parse", "main"), originBase,
    "导入绝不能顺手改用户的主线 —— 合不合、什么时候合是用户按验收那一下的事",
  );

  // ── 3. 原机点「验收通过」:必须真的合一次,不能走 already_accepted 幂等快路 ──
  const relanded = await acceptTask(taskId);
  assert.equal(relanded.accepted, true, `移回后的验收应当成功:${JSON.stringify(relanded).slice(0, 300)}`);
  if (!relanded.accepted) throw new Error(relanded.error);
  assert.notEqual(
    relanded.kind, "already_accepted",
    "记录的合并提交在本机目标分支上够不着时,幂等快路就是拿一句「此前已验收完成」盖住「本机主线什么都没有」",
  );
  assert.equal(relanded.targetBranch, "main", "目标分支以随任务带回的落账为准");
  assert.equal(
    readFileSync(join(originRepo, "feature.txt"), "utf8"), "远程做完的活\n",
    "验收之后原机主线上必须真的有这份代码",
  );
  assert.equal(hasBranch(originRepo, branch), false, "本机合完照常清理任务分支");

  // ── 4. 正常的重复验收仍然走幂等快路(这道新检查不能把老行为掀了)──────────────
  const localTaskId = "acceptlocal1";
  await db.insert(tasks).values({
    ...taskBase,
    id: localTaskId,
    projectId: originProject.id,
    title: "本机跑完直接验收",
    stage: null,
    createdAt: now(),
    updatedAt: now(),
  });
  const localWs = await prepareWorktree(originRepo, localTaskId, "main");
  writeFileSync(join(localWs.path, "local.txt"), "本机做完的活\n");
  git(localWs.path, "add", "-A");
  git(localWs.path, "commit", "-m", "feat: 本机实现");
  const firstAccept = await acceptTask(localTaskId);
  assert.equal(firstAccept.accepted, true, "本机验收应当成功");
  const secondAccept = await acceptTask(localTaskId);
  assert.equal(secondAccept.accepted, true);
  assert.equal(
    secondAccept.accepted && secondAccept.kind, "already_accepted",
    "合并结果本机够得着时,重复验收必须仍是零 git 操作的幂等快路",
  );

  // ── 5. 残留的旧任务分支不能盖住验收成果(来回接力两趟就会撞上)────────────────
  // 任务在两台机器之间走过一圈之后,本机很可能同时留着「一条早已过时的 ash/<id8>」和
  // 「目标分支上那次验收的合并提交」。只按「分支在不在」二选一的话,带走的就是那条空壳,
  // 代码又一次留在原地 —— 所以两个候选尖要按祖先关系比,谁更靠后带谁。
  const staleTaskId = "acceptstale1";
  const staleBranch = worktreeBranchName(staleTaskId);
  await db.insert(tasks).values({
    ...taskBase,
    id: staleTaskId,
    projectId: holderProject.id,
    title: "接力回来又验收一次",
    createdAt: now(),
    updatedAt: now(),
  });
  const staleWs = await prepareWorktree(holderRepo, staleTaskId, "main");
  const staleBase = git(holderRepo, "rev-parse", "main");
  writeFileSync(join(staleWs.path, "second.txt"), "第二轮的活\n");
  git(staleWs.path, "add", "-A");
  git(staleWs.path, "commit", "-m", "feat: 第二轮实现");
  const merged2 = await mergeTaskBranch(holderRepo, staleTaskId, "main");
  assert.equal(merged2.ok, true, "第二轮的验收合并应当成功");
  if (!merged2.ok) throw new Error(merged2.message);
  const mergeCommit2 = merged2.afterCommit!;
  await cleanupAcceptedTask(holderRepo, staleTaskId, "main", cleanupPlanFor("all"));
  await db.update(tasks).set({
    stage: "accepted",
    acceptedTargetBranch: "main",
    acceptedMergeCommit: mergeCommit2,
  }).where(eq(tasks.id, staleTaskId));
  // 上一趟接力在本机留下的空壳分支:停在合并之前,内容为零。
  git(holderRepo, "update-ref", `refs/heads/${staleBranch}`, staleBase);

  const staleRow = (await db.select().from(tasks).where(eq(tasks.id, staleTaskId))).at(0)!;
  const stalePacked = await packGitState(staleRow, holderRepo, [], []);
  assert.equal(
    stalePacked?.head, mergeCommit2,
    "过时的任务分支尖是合并提交的祖先时,必须带走合并提交 —— 带那条空壳等于把代码又丢一次",
  );
  assert.equal(stalePacked?.acceptedMerge, true, "这一路带走的仍是验收成果,措辞要照旧说清");
  assert.equal(
    git(holderRepo, "rev-parse", staleBranch), staleBase,
    "借用分支名打包之后必须原样还回去,不能把本机这条分支悄悄挪到合并提交上",
  );

  // 反过来:分支上有合并之后的新活,那它才是最新的,不能被旧的合并快照盖住。
  writeFileSync(join(holderRepo, "third.txt"), "合并之后又干的活\n");
  git(holderRepo, "add", "-A");
  git(holderRepo, "commit", "-m", "feat: 合并之后的新提交");
  const newerTip = git(holderRepo, "rev-parse", "HEAD");
  git(holderRepo, "update-ref", `refs/heads/${staleBranch}`, newerTip);
  const newerPacked = await packGitState(staleRow, holderRepo, [], []);
  assert.equal(newerPacked?.head, newerTip, "分支上有合并之后的新提交时,带走的应当是分支尖");
  assert.ok(!newerPacked?.acceptedMerge, "这一路带的不是验收合并成果,别误报「还差最后一合」");
  assert.equal(git(holderRepo, "rev-parse", staleBranch), newerTip, "没借用就不该动这条分支");

  console.log("handoff accepted-return: 验收合并成果随任务回家 / 移回不自动续跑 / 回家后仍能本机合并 / 幂等快路不受影响 / 空壳旧分支盖不住验收成果 全部通过");
} finally {
  await releaseTmpDb();
  rmSync(root, { recursive: true, force: true });
}
