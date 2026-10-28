import assert from "node:assert/strict";
import { eq } from "drizzle-orm";
import {
  api, db, failCheckpointAck, hits, pending, rowOf, scenario, scheduledMessages,
  schema, settled, taskOf, until,
} from "./checkpoint-recovery-fixture.js";
import { claimCheckpointForRun, returnCheckpointRun } from "../src/task-checkpoint-delivery.js";
import {
  forgetCheckpointDelivering, preparePendingCheckpointStart, reconcileCheckpointDeliveries,
} from "../src/pending-checkpoint-recovery.js";
import { now } from "../src/util.js";

/** 这个任务名下唯一那张续跑凭证(scenario(0) 不排哨兵结果,所以只有它一行)。 */
const receiptOf = async (taskId: string) => (await db.select().from(scheduledMessages)
  .where(eq(scheduledMessages.taskId, taskId)))[0]!;

/**
 * 「原文已经喂给 agent 了、确认那一笔没写成」那一段缝(第 1 轮审查必须修 3)。
 *
 * 四条合起来钉的是一个取舍:**送达一旦成为事实,这张凭证只能往前走(标 sent),永不归还** ——
 * 所以这里既要证明它不再永久阻塞(①②),也要证明它没有被改成「超时就归还」(③:已送达的那张
 * 在重启那一拍不许被回填),以及归还那一侧仍然work(④)、正在送的不许被接管(⑤)。
 */
export async function checkpointAckFailureCases(): Promise<void> {
  // ① 确认写不成 → 原地退避补办,库一恢复就自己走到 sent;期间启动被拒,但拒绝理由说的是
  //    「正在补记」而不是一句没有出路的「仍由消息账本保管」。
  {
    const test = await scenario(0);
    const fault = failCheckpointAck();
    try {
      assert.equal((await api.request(`/tasks/${test.taskId}/run`, { method: "POST" })).status, 202);
      await until("原交代已经喂给 agent", async () => hits(test.checkpoint) === 1);
      await until("确认写入至少失败过一次", async () => fault.count() > 0);
      const stranded = await receiptOf(test.taskId);
      assert.equal(stranded.status, "canceled");
      assert.ok(stranded.deliveringSince, "租约要留着:它是「有一次投递在途」的唯一凭据");
      assert.equal(stranded.checkpointTaken, test.checkpoint);
      assert.equal((await taskOf(test.taskId)).resumePrompt, null, "已经在执行的输入不许被回填");
      const blocked = await preparePendingCheckpointStart(test.taskId);
      assert.match(String(blocked), /已经送到 agent 手里/);
      assert.match(String(blocked), /正在自动补记/);
    } finally {
      fault.restore();
    }
    await until("确认被补记上账", async () => (await receiptOf(test.taskId)).status === "sent");
    assert.equal((await receiptOf(test.taskId)).deliveringSince, null);
    assert.equal(await preparePendingCheckpointStart(test.taskId), null, "补记成功之后这个任务就能再启动");
    assert.equal(hits(test.checkpoint), 1, "补记不许让同一段交代再送一遍");
    assert.equal((await taskOf(test.taskId)).resumePrompt, null);
    await settled(test.taskId);
    console.log("PASS: a failed delivery receipt is repaired in place instead of stranding the task forever");
  }

  // ② 补办期间进程被换掉:开机那一拍按同一判据接管下去。**方向是往前**,因为租约之后有回合
  //    开起来过 —— 这正是「已送达」的那条可证伪因果。
  {
    const test = await scenario(0);
    const fault = failCheckpointAck();
    try {
      assert.equal((await api.request(`/tasks/${test.taskId}/run`, { method: "POST" })).status, 202);
      await until("原交代已经喂给 agent", async () => hits(test.checkpoint) === 1);
      await until("确认写入至少失败过一次", async () => fault.count() > 0);
      const receipt = await receiptOf(test.taskId);
      // 进程换过一次:在途登记按定义是空的(同 reclaimStaleDeliveries 的理由)。
      forgetCheckpointDelivering(receipt.id);
      await pending.reclaimStaleDeliveries();
      const after = await rowOf(receipt.id);
      assert.ok(after.deliveringSince, "开机那一把全清不许碰已送达的续跑凭证,否则紧接着的恢复扫描会把它回填");
      assert.equal(after.checkpointTaken, test.checkpoint);
      assert.equal(after.status, "canceled");
      assert.equal((await taskOf(test.taskId)).resumePrompt, null, "重启不许把已经喂给 agent 的交代变回待执行输入");
      assert.equal(hits(test.checkpoint), 1);
    } finally {
      fault.restore();
    }
    await pending.reclaimStaleDeliveries();
    await until("接管之后补记到位", async () => (await receiptOf(test.taskId)).status === "sent");
    assert.equal(hits(test.checkpoint), 1, "接管一次不许多送一遍");
    await settled(test.taskId);
    console.log("PASS: a restart takes the stranded receipt forward to sent without replaying the handoff");
  }

  // ③ 反方向:租约之后一个回合都没开过 ⇒ 一定没送出去 ⇒ 归还安全。
  {
    const test = await scenario(0);
    const generation = (await taskOf(test.taskId)).resumePromptGeneration;
    const receipt = (await claimCheckpointForRun(test.taskId, test.checkpoint, generation))!;
    assert.ok(receipt);
    assert.equal((await taskOf(test.taskId)).resumePrompt, null);
    forgetCheckpointDelivering(receipt.id);
    await pending.reclaimStaleDeliveries();
    await until("没送出去的交代归还任务", async () => (await taskOf(test.taskId)).resumePrompt === test.checkpoint);
    const returned = await rowOf(receipt.id);
    assert.equal(returned.checkpointTaken, null);
    assert.equal(returned.deliveringSince, null);
    assert.equal(hits(test.checkpoint), 0, "压根没送出去,agent 不该见过它");
    console.log("PASS: a lease with no turn after it is proven undelivered and returned to the task");
  }

  // ④ 同一张凭证,只是这一次库里有一个租约之后开起来的回合 —— 判据必须翻面:不许归还。
  {
    const test = await scenario(0);
    const generation = (await taskOf(test.taskId)).resumePromptGeneration;
    const receipt = (await claimCheckpointForRun(test.taskId, test.checkpoint, generation))!;
    await db.insert(schema.sessions).values({
      id: `sess-${receipt.id}`, taskId: test.taskId, role: "single", agentType: "claude",
      executor: "claude", cwd: ".", startedAt: now(), turnStartedAt: now(),
    });
    forgetCheckpointDelivering(receipt.id);
    await reconcileCheckpointDeliveries(test.taskId);
    await until("已送达那一侧只往前走", async () => (await rowOf(receipt.id)).status === "sent");
    assert.equal((await taskOf(test.taskId)).resumePrompt, null, "有回合在租约之后开过时一律按已送达处理");
    console.log("PASS: the same lease flips to delivered once a turn opened after it");
  }

  // ⑤ 本进程还有一条路正在送它时,别人不许接管 —— 否则一条正在送的交代会被归还、送完再送一遍。
  {
    const test = await scenario(0);
    const generation = (await taskOf(test.taskId)).resumePromptGeneration;
    const receipt = (await claimCheckpointForRun(test.taskId, test.checkpoint, generation))!;
    await reconcileCheckpointDeliveries(test.taskId);
    const untouched = await rowOf(receipt.id);
    assert.equal(untouched.checkpointTaken, test.checkpoint);
    assert.ok(untouched.deliveringSince);
    assert.equal(untouched.status, "canceled");
    assert.equal((await taskOf(test.taskId)).resumePrompt, null);
    // 送它的那条路自己收尾,这一刻才轮到归还。
    await returnCheckpointRun(receipt);
    await until("送它那条路自己归还", async () => (await taskOf(test.taskId)).resumePrompt === test.checkpoint);
    assert.equal((await rowOf(receipt.id)).checkpointTaken, null);
    console.log("PASS: an in-flight lease is left to whoever is delivering it");
  }
}
