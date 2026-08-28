// 接力导入侧「审查历史翻译」的边界:哪些本机外键解析得到、解析不到时哪些东西可以撤、
// 哪些**绝不能**撤。
//
// 核心那条:自动复审的续轮预约(reviewRunId 指向本次载荷里的 run)不依赖审查者 profile
// —— 它在原 run 上续下一轮,执行器配置早冻结在 free_review_runs 那一行里。按「审查者
// 解析不到就撤销预约」一刀切,会让「修复完成后自动进第 N+1 轮」这条链在接力到一台没有
// 同名审查者的机器后静默断掉(第 1 轮审查实测)。
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HandoffFreeWorkflowPayload } from "../src/handoff-types.js";
import { releaseTmpDb } from "./tmp-db.js";

const root = mkdtempSync(join(tmpdir(), "ash-handoff-fw-rows-"));
process.env.ASH_DB = join(root, "ash.db");

const [{ db, ensureSchema }, { reviewerProfiles }, { buildFreeWorkflowRows }] = await Promise.all([
  import("../src/db/index.js"),
  import("../src/db/schema.js"),
  import("../src/handoff-import-free-workflow.js"),
]);

const at = "2026-08-27T00:00:00.000Z";
const run = {
  id: "run-1", reviewerName: "远端审查者", agentType: "codex", model: null, reasoningEffort: null,
  checkMode: "logic", note: null, targetKind: "workspace", targetBranch: null,
  targetBaseCommit: null, targetCommit: null, retryLimit: 1, currentRound: 1, status: "stopped",
  createdAt: at, updatedAt: at, finishedAt: null,
  rounds: [{ round: 1, status: "stopped", conclusion: "未通过", reviewedCommit: "abc", startedAt: at, endedAt: at }],
};
const payload = (state: Partial<HandoffFreeWorkflowPayload["state"]>): HandoffFreeWorkflowPayload => ({
  state: {
    selectedReviewerName: "远端审查者", reviewArmed: true, reviewCheckMode: "logic",
    reviewRetryLimit: 1, reviewNote: null, reviewAgentType: null, reviewModel: null,
    reviewReasoningEffort: null, reviewRunId: null, updatedAt: at,
    ...state,
  },
  runs: [run],
  events: [{ kind: "review_started", source: "user", detail: null, occurredAt: at }],
});

try {
  await ensureSchema();

  // ① 本机没有同名审查者 + 自动续轮预约(挂着 runId):预约必须活着。
  let notes: string[] = [];
  let rows = await buildFreeWorkflowRows("t1", payload({ reviewRunId: "run-1" }), notes);
  assert.equal(rows.state?.reviewArmed, true, "续轮预约不依赖审查者 profile，不能因为本机没有同名审查者就撤掉");
  assert.equal(rows.state?.reviewRunId, "run-1", "续轮预约必须继续指向同一条 run");
  assert.equal(rows.state?.selectedReviewerId, null, "审查者 profile 是本机主键，解析不到就置空");
  assert.equal(notes.some((n) => n.includes("取消了预约复审")), false, "没撤销就不能报「已取消预约」");

  // ② 本机没有同名审查者 + 手动预约(没有 runId):这一条确实只能撤,并如实说明。
  notes = [];
  rows = await buildFreeWorkflowRows("t2", payload({}), notes);
  assert.equal(rows.state?.reviewArmed, false, "手动预约要真去查审查者 profile，解析不到就不能 armed");
  assert.ok(notes.some((n) => n.includes("取消了预约复审")), "撤销预约必须留下注记，不能静默");

  // ③ 悬空的 runId(指向不在本次载荷里的 run)同样按手动预约处理。
  notes = [];
  rows = await buildFreeWorkflowRows("t3", payload({ reviewRunId: "run-not-in-payload" }), notes);
  assert.equal(rows.state?.reviewRunId, null, "指不到本次载荷里的 runId 是悬空指针，必须清掉");
  assert.equal(rows.state?.reviewArmed, false, "悬空 runId 撑不起续轮预约");

  // ④ 本机有同名审查者:profile 解析上，run 行上的 reviewerId 也跟着挂回去。
  await db.insert(reviewerProfiles).values({
    id: "rp-1", name: "远端审查者", agentType: "codex", executorId: null,
    model: null, reasoningEffort: null, createdAt: at, updatedAt: at,
  });
  notes = [];
  rows = await buildFreeWorkflowRows("t4", payload({}), notes);
  assert.equal(rows.state?.selectedReviewerId, "rp-1", "同名审查者应按名字解析回本机 profile");
  assert.equal(rows.state?.reviewArmed, true, "解析得到就照常 armed");
  assert.equal(rows.runs[0].reviewerId, "rp-1", "历史 run 的审查者同名时也挂回本机 profile");
  assert.equal(rows.runs[0].executorId, null, "执行器 profile 一律置空，按 agentType 走本机默认解析");
  assert.equal(rows.runs[0].repairTaskId, null, "修复任务没随本次接力迁移，幂等锁必须置空");
  assert.equal(rows.rounds.length, 1, "轮次跟着 run 一起翻译");
  assert.equal(rows.rounds[0].runId, "run-1", "run id 原样保留，证据文件才对得上号");
  assert.equal(rows.events.length, 1);

  console.log("✓ 审查历史翻译:续轮预约不受审查者缺失影响，手动预约撤销留痕，本机外键各按各的规矩重解析");
} finally {
  await releaseTmpDb();
  rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
