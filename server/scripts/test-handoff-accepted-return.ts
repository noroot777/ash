// 「在别的机器上跑完 + 验收完，再移回原机」这条路上的回归（用户 2026-09-01 报的）：
// 移回后**不该**自动续跑。续跑的第一件事是把验收牌子连同合并快照整套摘掉
// （turn-baseline → reopenAcceptedStage），于是「移回」这个动作本身把用户刚点下的验收
// 抹掉了，还白烧一轮 agent。
//
// 判据落在**接收侧**：源机可能是旧版、可能走的是代理移回（那条路的 autoResume 由服务端
// 算，不经人手）、也可能是批量接力的一个全局勾——接收侧看着自己刚落库的这条任务判一次，
// 三条路一起管住。accepted 和 merged 两半都要拦住，而没翻篇的任务照常续跑。
//
// 单进程直调，不 spawn 对端 server：两台机器用两个 git 仓库模拟，共用一个临时库，所以
// 「持有机那条任务行」在打完包之后显式删掉（真实场景里它本来就在另一台机器的库里）。
// ASH_RUNS_DIR 指到临时目录顺带打开 guardAgentSpawn：万一续跑闸失手，也不会真拉起 CLI。
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
  const { prepareWorktree } = await import("../src/git.js");
  const { packGitState } = await import("../src/handoff-collect.js");
  const { importHandoff } = await import("../src/handoff-import.js");
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

  const taskBaseFor = (id: string, title: string) => ({
    id,
    projectId: holderProject.id,
    title,
    body: "在持有机上干完并验收",
    mode: "single" as const,
    status: "done" as const,
    workflowMode: "free" as const,
    useWorktree: true,
    worktreeBase: "main",
    agentType: "claude" as const,
    createdAt: now(),
    updatedAt: now(),
  });

  /** 在持有机上干一轮活并打包,然后把这条任务行让给「原机」(单进程模拟共用一个库)。 */
  async function packOnHolder(taskId: string, title: string): Promise<HandoffManifest["git"]> {
    await db.insert(tasks).values(taskBaseFor(taskId, title));
    const ws = await prepareWorktree(holderRepo, taskId, "main");
    writeFileSync(join(ws.path, `${taskId}.txt`), "远程做完的活\n");
    git(ws.path, "add", "-A");
    git(ws.path, "commit", "-m", "feat: 远程实现");
    const row = (await db.select().from(tasks).where(eq(tasks.id, taskId))).at(0)!;
    const packed = await packGitState(row, holderRepo, [{ name: "main", commit: originBase }], []);
    await db.delete(sessions).where(eq(sessions.taskId, taskId));
    await db.delete(tasks).where(eq(tasks.id, taskId));
    return packed;
  }

  const manifestFor = (
    taskId: string,
    stage: string | null,
    packed: HandoffManifest["git"],
  ) => ({
    version: 1,
    sourceHost: "holder-machine",
    sourcePort: null,
    sourceFingerprint: null,
    originFingerprint: null,
    targetProjectId: originProject.id,
    transferId: `transfer-${taskId}`,
    autoResume: true, // 源机明确要求续跑:已翻篇的任务在接收侧仍必须拦住
    sourceWorkspace: join(holderRepo, ".worktrees", taskId),
    task: {
      id: taskId,
      title: "远程验收后移回",
      body: "在持有机上干完并验收",
      status: "done",
      stage,
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
      acceptedTargetBranch: stage ? "main" : null,
      acceptedBaseCommit: stage ? originBase : null,
      pinnedAt: null,
      starredAt: null,
      createdAt: now(),
      startedAt: now(),
      endedAt: now(),
    },
    sessions: [{
      // 带一条会话:没有会话就没有时间线可写(appendTaskTimeline 直接返回 false),
      // 而真实的移回一定带着对端跑过的那几条。cliSessionId 留空 = 会话文件没随包过来,
      // 恢复不了上下文,但落库的这条行足够承载「为什么没续跑」这句交代。
      id: `sess-${taskId}`,
      role: "main",
      agentType: "claude",
      executor: "claude",
      turnModel: null,
      turnReasoningEffort: null,
      branch: null,
      cliSessionId: null,
      commandLine: null,
      startedAt: now(),
      endedAt: now(),
      exitStatus: null,
      stoppedAs: null,
      sideTurn: false,
      activeMs: 0,
    }],
    freeWorkflow: null,
    git: packed,
    uploads: [],
    messages: [],
    schedule: null,
    files: [],
  }) as unknown as HandoffManifest;

  // ── 1. 已验收(accepted):源机勾了续跑,接收侧照样不跑 ──────────────────────
  const acceptedId = "ret01accept";
  const acceptedGit = await packOnHolder(acceptedId, "远程验收后移回");
  const imported = await importHandoff(manifestFor(acceptedId, "accepted", acceptedGit), {
    sourceUrl: "http://holder.test:4317",
  });
  assert.equal(
    imported.autoResume, false,
    "已验收的任务导入后绝不能自动续跑 —— 一续跑就把用户刚点下的验收连同合并快照整套摘掉",
  );
  assert.ok(
    imported.notes.some((note) => note.includes("已验收") && note.includes("没有自动续跑")),
    `应答要如实说明为什么没续跑,实际:${imported.notes.join(" / ")}`,
  );
  const importedRow = (await db.select().from(tasks).where(eq(tasks.id, acceptedId))).at(0)!;
  assert.equal(importedRow.stage, "accepted", "验收章随任务回到原机,不该被导入动作摘掉");
  assert.equal(
    (JSON.parse(importedRow.handoff!) as { autoResume?: boolean }).autoResume, false,
    "标记里存的是「到底跑没跑」的事实,幂等收口靠它如实回答源机",
  );

  // 时间线上要留下痕迹:代理移回那条路(/tasks/:id/remote-return)把应答里的 notes 丢了,
  // 只有落在会话时间线上的这一句刷新页面后还看得见。
  const { sessionTranscriptPath } = await import("../src/transcript.js");
  const transcript = readFileSync(sessionTranscriptPath(acceptedId, `sess-${acceptedId}`), "utf8");
  assert.ok(
    transcript.includes("没有自动续跑"),
    `没续跑这件事要持久可见(会话时间线),实际:${transcript.slice(0, 400)}`,
  );

  // ── 2. 已合并(merged)是同一块牌子的另一半,一并拦住 ────────────────────────
  const mergedId = "ret02merged";
  const mergedGit = await packOnHolder(mergedId, "远程合并后移回");
  const mergedImport = await importHandoff(manifestFor(mergedId, "merged", mergedGit), {
    sourceUrl: "http://holder.test:4317",
  });
  assert.equal(
    mergedImport.autoResume, false,
    "merged 和 accepted 是同一块「已翻篇」的牌子,只拦 accepted 会漏得悄无声息",
  );

  // ── 3. 没翻篇的任务照常续跑(这道闸不能变成一刀切)──────────────────────────
  const liveId = "ret03liveok";
  const liveGit = await packOnHolder(liveId, "还没验收就移回");
  const liveImport = await importHandoff(manifestFor(liveId, null, liveGit), {
    sourceUrl: "http://holder.test:4317",
  });
  assert.equal(
    liveImport.autoResume, true,
    "没盖验收章的任务必须照旧自动续跑 —— 拦成一刀切等于把接力的正常用法一起废了",
  );
  // 这一档真的会去拉起 agent(火后不管)。等它撞上 guardAgentSpawn 并结算完再拆库,
  // 否则收尾时会甩一串「database is not open」,看着像测试失败。
  await new Promise((resolve) => setTimeout(resolve, 1_000));

  console.log("handoff accepted-return: 已验收/已合并移回不自动续跑 / 原因持久可见 / 未翻篇的照常续跑 全部通过");
} finally {
  await releaseTmpDb();
  rmSync(root, { recursive: true, force: true });
}
