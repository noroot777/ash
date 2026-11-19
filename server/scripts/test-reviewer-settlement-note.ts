// 审查旁路回合没办成时，不往审查者那条会话里写「续聊回合…,任务状态保持「X」不变」。
//
// 现场（2026-11-19，任务 y8S-yZjD0eaK）：审查者撞上模型上游 503、exit 1。审查那一路已经说了这一轮怎么
// 断的（「第 4 轮审查没有给出结论 · 中断 · 模型上游连不上（503）」），结算这边又往审查者会话里落了一句
// 「续聊回合异常结束(退出码 1),任务状态保持「已完成」不变」——讲的是任务状态，用的是执行者续聊的口吻，
// 页面上跟着那句原因一起落进了执行者那一回合的尾注。这份回归盯：
//   ① 续聊 / 旁路回合没办成、状态原样放回的那几支（异常退出、被停、Navi 熔断），结算交出的说明带 `restored`；
//   ② 审查回合不落这几句，普通回合照落；
//   ③ 正常收尾没有说明；不带 `restored` 的说明（真改了任务状态的那种，如改落检查点暂停）审查回合照落。
// 跑：npm -w server run test:reviewer-settlement-note
import assert from "node:assert/strict";
import { eq } from "drizzle-orm";
import { db, makeTask, sleep, tasks, teardown } from "./monitors-fixture.js";

const { settleTaskStatus } = await import("../src/settle-status.js");
const { sessionSettlementNote } = await import("../src/single-run-settle.js");

/** 一个已完成的任务正在跑旁路回合（审查 / 续聊）：库里记着进这一轮之前的原状态。 */
async function sideTurn(): Promise<string> {
  const taskId = await makeTask({ status: "running" });
  await db.update(tasks).set({ followUpFrom: "done" }).where(eq(tasks.id, taskId));
  return taskId;
}

try {
  // ① + ②：异常退出。
  const crashed = await settleTaskStatus(await sideTurn(), 1, null);
  assert.equal(crashed.status, "done", "旁路回合没办成，状态放回原来的终态");
  assert.equal(crashed.restored, true, "状态原样放回的那一支要带 restored");
  assert.match(crashed.note ?? "", /^续聊回合异常结束\(退出码 1\),任务状态保持「已完成」不变/);
  assert.equal(sessionSettlementNote("reviewer", crashed), null, "审查回合不落「状态保持不变」那一句");
  assert.equal(sessionSettlementNote("single", crashed), crashed.note, "普通续聊照落");

  // 被停。
  const stopped = await settleTaskStatus(await sideTurn(), 1, "canceled");
  assert.equal(stopped.restored, true);
  assert.match(stopped.note ?? "", /^续聊回合被手动停止/);
  assert.equal(sessionSettlementNote("reviewer", stopped), null);

  // Navi 熔断（退出码是合成的，说明换成熔断那一句，同样只是交代状态没变）。
  const tripped = await settleTaskStatus(await sideTurn(), 1, null, undefined, { kind: "tripped", detail: "上游一直不回话" });
  assert.equal(tripped.restored, true);
  assert.ok(tripped.note, "熔断那一支有说明");
  assert.equal(sessionSettlementNote("reviewer", tripped), null);

  // ③ 正常收尾：没有说明，两种角色都不落。
  const clean = await settleTaskStatus(await sideTurn(), 0, null);
  assert.equal(clean.note, undefined);
  assert.equal(clean.restored, undefined);
  assert.equal(sessionSettlementNote("reviewer", clean), null);
  assert.equal(sessionSettlementNote("single", clean), null);
  // 不带 restored 的说明（改了任务状态的那种）审查回合照落。
  assert.equal(sessionSettlementNote("reviewer", { note: "改为检查点暂停" }), "改为检查点暂停");

  console.log("✓ reviewer settlement note");
} finally {
  // 落状态之后有一步不等的重发（status.ts 的 republishWaitsAround）：等它跑完再关库，免得收台时报错。
  await sleep(500);
  await teardown();
}
