// 「对哪一条驳回动手」的身份回归：一次裁定 / 辩论 / 修复，从头到尾只作用于用户点的那一条。
//
// 未裁定驳回是任务级的（同一个任务可以同时挂着好几条，升级前的老数据就有），所以「当前
// 那条」只是排序的结果。第 2 轮审查实测：对旧第 1 轮点「让它接着改」，修复却按更新的第 2 轮
// 报告发出，另一条旧驳回也被顺手记成维持；最新一条审查通过时，旧轮的修复直接起不来。
// 这里钉住：
// ① 裁定带目标 → 只裁那一条；修复的报告路径、轮次、裁定要点都取那一条（旧链、历史轮都算）；
// ② 好几条待裁定时不带目标一律拒，目标已经不在待裁定之列也拒，不替用户挑；
// ③ 老的「按意见修复」按钮只维持它修的那一轮自己的驳回；
// ④ 辩论开场认目标，续段认开场记下的那一轮；转独立任务的时间线写对轮次；
// ⑤ 驳回时间为空的老数据，服务端排序与界面上那张卡同一个兜底。
//
// 修复要真走到投递那一步（它就是被测对象），所以起跑链会跑到执行器边界：ASH_RUNS_DIR 指向
// 临时目录时 spawn 一律被拦（executors/spawn.ts `guardAgentSpawn`），PATH 上再垫一个只会
// 报错退出的 codex 替身、CODEX_HOME 指到临时目录，确保碰不到真 CLI 与真配置。
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { eq } from "drizzle-orm";
import { releaseTmpDb } from "./tmp-db.js";

const root = mkdtempSync(join(tmpdir(), "ash-free-review-dispute-target-"));
process.env.ASH_DB = join(root, "ash.db");
process.env.ASH_RUNS_DIR = join(root, "runs");
process.env.CODEX_HOME = join(root, "codex-home");
// 辩论开场会核两边够不够得着 ash MCP（ash-mcp-launch-gate.ts），给一份接好了的最小配置。
mkdirSync(process.env.CODEX_HOME);
writeFileSync(join(process.env.CODEX_HOME, "config.toml"), '[mcp_servers.ash]\ncommand = "node"\n');
const bin = join(root, "bin");
mkdirSync(bin);
writeFileSync(join(bin, "codex"), "#!/bin/sh\necho 'codex fixture'\nexit 89\n", { mode: 0o755 });
process.env.PATH = `${bin}:${process.env.PATH}`;

let failure: unknown = null;
try {
  const { ensureSchema, db } = await import("../src/db/index.js");
  const {
    agents, freeReviewDebates, freeReviewRounds, freeReviewRuns, projects, reviewerProfiles, sessions, tasks,
  } = await import("../src/db/schema.js");
  const { createTasks } = await import("../src/task-store.js");
  const { claimTurn } = await import("../src/runs.js");
  const { openDisputeOf, resolveFreeReviewDispute } = await import("../src/free-review-dispute.js");
  const { startFreeReviewDebate } = await import("../src/free-review-debate.js");
  const { startManualFreeReviewRepair } = await import("../src/free-review-manual-repair.js");
  const { freeReviewReportPath } = await import("../src/free-review-files.js");
  const { sessionTranscriptPath } = await import("../src/transcript.js");

  const repo = join(root, "repo");
  mkdirSync(repo);
  const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" }).trim();
  git("init", "-q");
  git("-c", "user.name=t", "-c", "user.email=t@invalid", "-c", "core.hooksPath=/dev/null",
    "commit", "-q", "--allow-empty", "-m", "fixture");
  const head = git("rev-parse", "HEAD");

  await ensureSchema();
  const at = new Date().toISOString();
  await db.insert(projects).values({ id: "p", name: "target", repoPath: repo, createdAt: at });
  await db.insert(agents).values({ id: "ex", name: "codex@test", type: "codex", model: "gpt-test", isDefault: true });
  await db.insert(reviewerProfiles).values({
    id: "reviewer", name: "逻辑审查者", agentType: "codex", executorId: "ex", createdAt: at, updatedAt: at,
  });

  type RoundSeed = {
    run: string; round: number; runRound?: number; passed?: boolean;
    dispute?: boolean; deferReason?: string; disputeAt?: string | null; endedAt?: string;
  };
  /** 一个停着的自由任务，按给定顺序造审查链和轮次（同一个 run 出现多次 = 同链的几轮）。 */
  async function seed(id: string, rounds: RoundSeed[]): Promise<void> {
    await createTasks([{
      id, projectId: "p", title: id, body: "test", mode: "single", status: "done",
      agentType: "codex", executorId: "ex", autoTitle: false, workflowMode: "free",
      useWorktree: false, createdAt: at, updatedAt: at,
    }]);
    await db.insert(sessions).values({
      id: `${id}-session`, taskId: id, role: "single", agentType: "codex", executor: "codex@test", startedAt: at,
    });
    for (const [index, r] of rounds.entries()) {
      const runId = `${id}-${r.run}`;
      const stamp = r.endedAt ?? `2026-11-01T0${index}:00:00.000Z`;
      const current = Math.max(...rounds.filter((x) => x.run === r.run).map((x) => x.round));
      await db.insert(freeReviewRuns).values({
        id: runId, taskId: id, reviewerId: "reviewer", reviewerName: "逻辑审查者", agentType: "codex",
        executorId: "ex", checkMode: "logic", retryLimit: 1, currentRound: current,
        status: r.passed ? "passed" : "stopped", createdAt: stamp, updatedAt: stamp, finishedAt: stamp,
      }).onConflictDoNothing();
      await db.insert(freeReviewRounds).values({
        id: `${runId}-r${r.round}`, runId, round: r.round,
        status: r.passed ? "passed" : "failed", conclusion: r.passed ? "verified" : "verify_failed",
        reviewedCommit: head, startedAt: stamp, endedAt: stamp,
        disputeSummary: r.dispute ? `${r.run} 第 ${r.round} 轮我不认` : null,
        disputeReason: r.dispute && !r.deferReason ? `${r.run} 第 ${r.round} 轮读错了代码` : null,
        disputeDeferReason: r.dispute ? r.deferReason ?? null : null,
        disputeAt: r.dispute ? (r.disputeAt === undefined ? stamp : r.disputeAt) : null,
      });
      const report = freeReviewReportPath(id, runId, r.round);
      mkdirSync(dirname(report), { recursive: true });
      writeFileSync(report, `# ${r.run} 第 ${r.round} 轮报告\n`);
    }
  }
  const roundOf = async (id: string) => (await db.select().from(freeReviewRounds)
    .where(eq(freeReviewRounds.id, id))).at(0)!;
  const timeline = (id: string) => readFileSync(sessionTranscriptPath(id, `${id}-session`), "utf8");
  /** 修复真正投递出去的那段提示（落在起跑新开的会话记录里）。 */
  async function deliveredRepair(id: string): Promise<string> {
    const dir = join(root, "runs", id);
    for (let i = 0; i < 100; i++) {
      for (const name of readdirSync(dir).filter((n) => n.endsWith(".md") && n !== `${id}-session.md`)) {
        const text = readFileSync(join(dir, name), "utf8");
        if (text.includes("请先完整读取")) {
          // 让这一趟起跑失败的结算走完，免得和下一个场景交错。
          for (let j = 0; j < 100; j++) {
            const status = (await db.select({ s: tasks.status }).from(tasks).where(eq(tasks.id, id))).at(0)?.s;
            if (status !== "running" && status !== "queued") break;
            await new Promise((resolve) => setTimeout(resolve, 50));
          }
          return text;
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error(`${id}：等不到修复投递`);
  }
  const reportOf = (id: string, run: string, round: number) => freeReviewReportPath(id, `${id}-${run}`, round);

  // ── ① 旧链待裁定 + 更新的未通过链：裁定旧的那条，修复就按旧的那份报告 ──
  await seed("t-wrong", [{ run: "old", round: 1, dispute: true }, { run: "latest", round: 2 }]);
  const wrong = await resolveFreeReviewDispute("t-wrong", "upheld", "只修旧第 1 轮那条",
    { runId: "t-wrong-old", round: 1 });
  assert.equal(wrong.repairError, null, "旧轮的报告仍对应当前代码，修复照常起");
  const wrongPrompt = await deliveredRepair("t-wrong");
  assert.ok(wrongPrompt.includes(reportOf("t-wrong", "old", 1)), "修复提示指向用户裁定的那份旧报告");
  assert.ok(!wrongPrompt.includes(reportOf("t-wrong", "latest", 2)), "不许换成更新的那份报告");
  assert.match(wrongPrompt, /只修旧第 1 轮那条/, "裁定要点跟着那一轮进修复提示");
  assert.match(wrongPrompt, /不采纳这条驳回/, "按「已裁定接着改」的口径发，不再给驳回的路");
  assert.match(timeline("t-wrong"), /已按自由工作流第 1 轮审查意见发起修复/);

  // ── ② 两条旧驳回待裁定：不带目标拒；带目标只裁那一条，另一条原样等着 ──
  await seed("t-cascade", [
    { run: "older", round: 1, dispute: true }, { run: "old", round: 1, dispute: true }, { run: "latest", round: 2 },
  ]);
  await assert.rejects(() => resolveFreeReviewDispute("t-cascade", "upheld"), /2 条驳回在等裁定/,
    "好几条待裁定时不替用户挑");
  await resolveFreeReviewDispute("t-cascade", "upheld", null, { runId: "t-cascade-old", round: 1 });
  const cascadePrompt = await deliveredRepair("t-cascade");
  assert.ok(cascadePrompt.includes(reportOf("t-cascade", "old", 1)));
  assert.equal((await roundOf("t-cascade-older-r1")).disputeResolution, null, "另一条驳回不许被顺手记成维持");
  assert.equal((await openDisputeOf("t-cascade"))?.round.id, "t-cascade-older-r1", "它还在等裁定");
  await assert.rejects(
    () => resolveFreeReviewDispute("t-cascade", "withdrawn", null, { runId: "t-cascade-old", round: 1 }),
    /已经不在等裁定/, "目标已经裁过就如实拒，不换一条顶上");

  // ── ③ 旧驳回待裁定 + 更新的审查已通过：旧轮仍对应当前代码，就按它修，不报「最近一轮没停在未通过」──
  await seed("t-blocked", [{ run: "old", round: 1, dispute: true }, { run: "latest", round: 2, passed: true }]);
  const blocked = await resolveFreeReviewDispute("t-blocked", "upheld", null, { runId: "t-blocked-old", round: 1 });
  assert.equal(blocked.repairError, null);
  assert.ok((await deliveredRepair("t-blocked")).includes(reportOf("t-blocked", "old", 1)));

  // ── ①' 同一条链的历史轮：报告、轮次取那一轮，不取链的当前轮 ──
  await seed("t-history", [{ run: "chain", round: 1, dispute: true }, { run: "chain", round: 2 }]);
  await resolveFreeReviewDispute("t-history", "upheld", null, { runId: "t-history-chain", round: 1 });
  const historyPrompt = await deliveredRepair("t-history");
  assert.ok(historyPrompt.includes(reportOf("t-history", "chain", 1)));
  assert.match(historyPrompt, /再按第 1 轮意见修复/);

  // ── ④ 转独立任务的时间线写那一轮，不写链的当前轮 ──
  await seed("t-defer", [{ run: "chain", round: 1, dispute: true, deferReason: "越界：另一个模块" }, { run: "chain", round: 2 }]);
  await resolveFreeReviewDispute("t-defer", "deferred", null, { runId: "t-defer-chain", round: 1 });
  assert.match(timeline("t-defer"), /你裁定把第 1 轮里超出本任务边界/);

  // ── ③ 老按钮只维持它修的那一轮自己的驳回 ──
  await seed("t-button", [{ run: "old", round: 1, dispute: true }, { run: "latest", round: 2, dispute: true }]);
  assert.equal(claimTurn("t-button", "single"), true, "占着回合：修复只排队，不投递");
  await startManualFreeReviewRepair("t-button");
  assert.equal((await roundOf("t-button-latest-r2")).disputeResolution, "upheld", "修哪一轮就维持哪一轮");
  assert.equal((await roundOf("t-button-old-r1")).disputeResolution, null, "别的轮次上的驳回不碰");

  // ── ④ 辩论开场认目标 ──
  await seed("t-debate", [{ run: "old", round: 1, dispute: true }, { run: "latest", round: 2, dispute: true }]);
  assert.equal(claimTurn("t-debate", "reviewer"), true, "占着回合：辩论段只排队，不起跑");
  await assert.rejects(() => startFreeReviewDebate("t-debate", { exchanges: 1 }), /2 条驳回在等裁定/);
  const debate = await startFreeReviewDebate("t-debate", { exchanges: 1, target: { runId: "t-debate-old", round: 1 } });
  const debateRow = (await db.select().from(freeReviewDebates).where(eq(freeReviewDebates.id, debate.debateId))).at(0);
  assert.equal(debateRow?.roundId, "t-debate-old-r1", "辩的是用户点的那一条，不是排第一的那条");

  // ── ⑤ 驳回时间为空的老数据：排序与界面同一个兜底（disputeAt ?? endedAt ?? startedAt）──
  await seed("t-order", [
    { run: "a", round: 1, dispute: true, disputeAt: "2026-11-01T05:00:00.000Z", endedAt: "2026-11-01T04:00:00.000Z" },
    { run: "b", round: 1, dispute: true, disputeAt: null, endedAt: "2026-11-01T06:00:00.000Z" },
  ]);
  assert.equal((await openDisputeOf("t-order"))?.round.id, "t-order-b-r1", "时间为空的那条按结束时间排");

  console.log("✓ 裁定带目标：只裁那一条，修复按那一轮的报告与要点投递（旧链、历史轮、最新已通过都对）");
  console.log("✓ 好几条待裁定时不替用户挑；老按钮只维持它修的那一轮；辩论认目标；转出时间线写对轮次");
} catch (error) {
  failure = error;
} finally {
  await releaseTmpDb();
  rmSync(root, { recursive: true, force: true });
}
if (failure) {
  console.error(failure);
  process.exit(1);
}
