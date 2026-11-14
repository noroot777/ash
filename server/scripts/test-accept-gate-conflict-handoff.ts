// 「让任务解决」：合并预览撞冲突时验收台那一行的直达出路（src/accept-gate-conflict.ts）。
//
// 钉四件事：
// ① 门禁状态把冲突**结构化**带出来（baselineIssue：哪条目标分支、哪些文件、交接到哪一步了），验收台
//    不用去解析 baselineBlock 那句话；
// ② 点下去走的是验收被基准拦下时**同一份**交接，一次门禁都不跑、目标分支不动；
// ③ **登记意图不算送到**：排着的时候报 queued；交接在起跑前被撤回（这里是排队期间任务被归档）就报
//    failed 并带原因，出路回到「再交一次」；送到了，那一轮在跑报 working、跑完冲突还在报 ended；
// ④ 任务一提交（分支头变了）那份登记就不再对得上：重新判一次，仍冲突就回到「还没交」。
// 没有冲突、已验收、没设命令时一律拒绝，并说清为什么。
import assert from "node:assert/strict";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { releaseTmpDb } from "./tmp-db.js";

const { baselineHarness } = await import("./accept-gate-baseline-fixture.js");
const h = await baselineHarness("ash-gate-conflict-handoff-");
const { root, git, db, tasks, acceptGateState, runs, commitOnMain, fixture } = h;
const { handOffPreviewConflict } = await import("../src/accept-gate-conflict.js");
const { settleConflictHandoff } = await import("../src/accept-gate-conflict-registry.js");
const { claimOwnTurn, isTurnClaimed, releaseTurn } = await import("../src/turn-lock.js");
// 占住回合让交接一直排着（真实投递要等它退出才走），放开之后等那条排队的交接把锁用完还回来。
const drained = async (taskId: string) => {
  const until = Date.now() + 5000;
  while (isTurnClaimed(taskId) && Date.now() < until) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(isTurnClaimed(taskId), false, "排着的那条交接该收场了");
};
const { mountAcceptGateRoutes } = await import("../src/accept-gate-routes.js");
const api = new Hono();
mountAcceptGateRoutes(api);
const post = async (taskId: string) => {
  const response = await api.request(`/tasks/${taskId}/accept-gate/conflict-handoff`, { method: "POST" });
  return { status: response.status, body: await response.json() as { ok?: boolean; error?: string; message?: string } };
};

try {
  // ① + ②：预演冲突 → 结构化带出 → 交给任务，门禁没跑、main 没动。
  const sample = await fixture("handoff-conflict", { baseline: "merge_preview" });
  writeFileSync(join(sample.cwd, "api.js"), "exports.onDelivered = () => 'task';\n");
  git(sample.cwd, "commit", "-am", "task edits api");
  commitOnMain(sample.repo, "api.js", "exports.onDelivered = () => 'main';\n", "main edits api");
  const mainBefore = git(sample.repo, "rev-parse", "main");
  const before = await acceptGateState(sample.taskId);
  assert.deepEqual(before.baselineIssue, { reason: "merge_conflict", targetBranch: "main", conflictFiles: ["api.js"], handoff: null });

  const held = claimOwnTurn(sample.taskId);
  assert.ok(held, "测试要先占住回合");
  const handed = await post(sample.taskId);
  assert.equal(handed.status, 200, JSON.stringify(handed.body));
  assert.equal(handed.body.ok, true);
  assert.match(handed.body.message ?? "", /解冲突/);
  // ③ 排着：只是意图，不是「正在解决」。
  const queued = await acceptGateState(sample.taskId);
  assert.equal(queued.baselineIssue?.reason, "merge_conflict");
  assert.equal(queued.baselineIssue?.handoff?.state, "queued", "排进队列不等于送到");
  assert.equal((await runs(sample.taskId)).length, 0, "交接不跑门禁");
  assert.equal(git(sample.repo, "rev-parse", "main"), mainBefore, "目标分支一动不动");

  // ③ 排队期间被撤回（任务归档了）：一个字没送到，报 failed 并带原因。
  await db.update(tasks).set({ archived: true }).where(eq(tasks.id, sample.taskId));
  releaseTurn(sample.taskId, held!);
  await drained(sample.taskId);
  await db.update(tasks).set({ archived: false }).where(eq(tasks.id, sample.taskId));
  const withdrawn = await acceptGateState(sample.taskId);
  assert.equal(withdrawn.baselineIssue?.handoff?.state, "failed", JSON.stringify(withdrawn.baselineIssue));
  assert.match(withdrawn.baselineIssue?.handoff?.note ?? "", /撤回/);

  // ③ 再交一次，这回送到了（直接报交接层的「agent 收下了」）：那一轮在跑 = working，跑完冲突还在 = ended。
  const again = claimOwnTurn(sample.taskId);
  assert.ok(again);
  assert.equal((await post(sample.taskId)).status, 200, "没送到的那份可以再交一次");
  assert.equal((await acceptGateState(sample.taskId)).baselineIssue?.handoff?.state, "queued");
  assert.equal(settleConflictHandoff(sample.taskId, { delivered: true }), true);
  await db.update(tasks).set({ status: "running" }).where(eq(tasks.id, sample.taskId));
  assert.equal((await acceptGateState(sample.taskId)).baselineIssue?.handoff?.state, "working");
  await db.update(tasks).set({ status: "done" }).where(eq(tasks.id, sample.taskId));
  assert.equal((await acceptGateState(sample.taskId)).baselineIssue?.handoff?.state, "ended", "那一轮跑完冲突还在，不能还说「正在解决」");
  assert.equal(settleConflictHandoff(sample.taskId, { delivered: false, why: "迟到的失败" }), false, "定论之后不翻盘");
  // 收掉排着的那条：归档撤回它，它的失败不再改已经落定的登记。
  await db.update(tasks).set({ archived: true }).where(eq(tasks.id, sample.taskId));
  releaseTurn(sample.taskId, again!);
  await drained(sample.taskId);
  await db.update(tasks).set({ archived: false }).where(eq(tasks.id, sample.taskId));
  assert.equal((await acceptGateState(sample.taskId)).baselineIssue?.handoff?.state, "ended");

  // ④ 任务提交了（这里只是又落了一个与冲突无关的提交）：分支头变了，登记对不上 → 重新判，仍冲突就回到没交。
  writeFileSync(join(sample.cwd, "note.txt"), "still conflicting\n");
  git(sample.cwd, "add", "-A");
  git(sample.cwd, "commit", "-m", "task commits again");
  const rejudged = await acceptGateState(sample.taskId);
  assert.equal(rejudged.baselineIssue?.reason, "merge_conflict");
  assert.equal(rejudged.baselineIssue?.handoff, null);

  // 把冲突解掉之后就没有这一行了，再按也会被拒。
  git(sample.cwd, "merge", "-X", "theirs", "--no-edit", "main");
  assert.equal((await acceptGateState(sample.taskId)).baselineIssue ?? null, null);
  const none = await post(sample.taskId);
  assert.equal(none.status, 409);
  assert.match(none.body.error ?? "", /没有合并预览冲突/);

  // 已验收的不再交。
  await db.update(tasks).set({ stage: "accepted" }).where(eq(tasks.id, sample.taskId));
  const settledRefusal = await handOffPreviewConflict(sample.taskId);
  assert.equal(settledRefusal.ok, false);
  if (!settledRefusal.ok) assert.match(settledRefusal.error, /已经验收过了/);

  // 没设命令：没有合并预览可判。
  const bare = await fixture("handoff-no-command", { baseline: "merge_preview" });
  await db.update(h.projects).set({ acceptGateCommand: null }).where(eq(h.projects.id, bare.projectId));
  const refused = await handOffPreviewConflict(bare.taskId);
  assert.equal(refused.ok, false);
  if (!refused.ok) assert.match(refused.error, /没设验收前置命令/);

  console.log(JSON.stringify({ structured: true, queued: true, withdrawnFails: true, deliveredWorking: true, endedRetry: true, rejudged: true, resolved: true, accepted: true, noCommand: true }));
} finally {
  await releaseTmpDb();
  rmSync(root, { recursive: true, force: true });
}
