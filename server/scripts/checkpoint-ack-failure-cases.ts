import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { eq } from "drizzle-orm";
import {
  api, db, dbClient, failCheckpointAck, hits, pending, rowOf, scenario, scheduledMessages,
  schema, settled, taskOf, until,
} from "./checkpoint-recovery-fixture.js";
import { deliveryCrossed, noteDeliveryCrossing } from "../src/delivery-crossing.js";
import { sessionTranscriptPath } from "../src/transcript.js";
import { claimCheckpointForRun, returnCheckpointRun } from "../src/task-checkpoint-delivery.js";
import {
  forgetCheckpointDelivering, preparePendingCheckpointStart, reconcileCheckpointDeliveries,
} from "../src/pending-checkpoint-recovery.js";
import { now } from "../src/util.js";

async function transcript(taskId: string): Promise<string> {
  const rows = await db.select().from(schema.sessions).where(eq(schema.sessions.taskId, taskId));
  return rows.map((row) => {
    const path = sessionTranscriptPath(taskId, row.id);
    return existsSync(path) ? readFileSync(path, "utf8") : "";
  }).join("\n");
}

/**
 * 定点让**这一轮的会话行**落不下来(persistRunner 的 `insert into "sessions"`),spawn 照旧
 * 发生 —— 这就是 F1 那条缝:输入已经交出去了,事后记账没做完。只打第一笔,后面补交代用的
 * 那行诊断会话照常写得下。
 */
function failSessionPersist(taskId: string) {
  const execute = dbClient.execute;
  let failures = 0;
  dbClient.execute = async function (statement, ...rest) {
    if (!failures && typeof statement !== "string" && /^insert into "sessions"/i.test(statement.sql)
      && Array.isArray(statement.args) && statement.args.includes(taskId)) {
      failures++;
      throw new Error("INJECT_SESSION_PERSIST_FAILURE");
    }
    return execute.call(dbClient, statement, ...rest);
  };
  return { count: () => failures, restore: () => { dbClient.execute = execute; } };
}

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

  // ⑥ **F1 那条缝,走真实启动路径**:spawn 已经把这段话交出去了,这一轮的会话行却没落下来。
  //    「租约之后有没有回合开起来过」这个判据于此失效 —— 它问的是事后记账,而不可逆的那一步
  //    是 spawn 本身。
  //
  //    这里钉的是**判定**:越线记号确实在 spawn 之前落了盘,于是收场按第三态走(就地结成一条
  //    带原文的可见记录),而不是按「一定没送出去」归还。同一个进程里 agent 进程会被失败出口
  //    收掉(continueTask 的 discardStartingRun),所以「被收到两遍」那个后果只在 ash 自己被
  //    SIGKILL 时才看得到(审查者的跨进程复现);下面 ⑦ 按那个现场判。
  {
    const test = await scenario(0);
    const fault = failSessionPersist(test.taskId);
    try {
      // 409 正是这条缝对用户的样子:会话行没落下 ⇒ 启动回执永远不来 ⇒ /run 回「尚未启动,
      // 请稍后重试」。而那段话此刻**可能已经在 agent 手里了** —— 他照着这句话再点一次,
      // 旧口径就会把它重投一遍。
      assert.equal((await api.request(`/tasks/${test.taskId}/run`, { method: "POST" })).status, 409);
      await until("这一轮的会话行确实没落下", async () => fault.count() === 1);
      await until("交付不明就地了结", async () => (await receiptOf(test.taskId)).status === "sent");
    } finally {
      fault.restore();
    }
    const settledRow = await receiptOf(test.taskId);
    assert.equal(settledRow.deliveringSince, null, "不许永久挂着:租约留着就等于这个任务此后一律起不来");
    assert.equal((await taskOf(test.taskId)).resumePrompt, null, "交付不明不许被回填成待执行输入");
    assert.equal(await preparePendingCheckpointStart(test.taskId), null, "了结之后这个任务能再启动");
    assert.equal(deliveryCrossed(test.taskId, settledRow.id), false, "有了定论,越线记号就该收走");
    const told = await transcript(test.taskId);
    assert.match(told, /不会自动再送一遍/, "交付不明必须留下可见交代");
    assert.match(told, new RegExp(test.checkpoint), "原文必须留在用户看得见的地方 —— 要不要再送由他判断");
    await settled(test.taskId);
    console.log("PASS: an input that crossed spawn without a session row is settled as uncertain, not returned");
  }

  // ⑦ 跟 ③ **同一个现场,只差一张越线记号**:上一个进程把输入交出去了(记号在磁盘上),随后
  //    被 SIGKILL,会话行没来得及写。开机那一拍按旧判据会读成「一定没送出去」并回填,下一次
  //    启动就把同一段交代再送一遍 —— 审查者用假 CLI 实测过那个 2
  //    (BEFORE_CRASH_AGENT_INPUT_COUNT 1 → AFTER_RETRY_AGENT_INPUT_COUNT 2)。
  {
    const test = await scenario(0);
    const generation = (await taskOf(test.taskId)).resumePromptGeneration;
    const receipt = (await claimCheckpointForRun(test.taskId, test.checkpoint, generation))!;
    // 上一个进程走到 spawn 那一行:记号落盘,然后它死了(在途登记按定义是空的)。
    noteDeliveryCrossing(test.taskId, [receipt.id], { sessionId: `sess-${receipt.id}`, turnStart: now() });
    forgetCheckpointDelivering(receipt.id);
    await pending.reclaimStaleDeliveries();
    await until("交付不明就地了结", async () => (await rowOf(receipt.id)).status === "sent");
    assert.equal((await taskOf(test.taskId)).resumePrompt, null,
      "越过 spawn 的那段话不许被回填成待执行输入 —— 这正是被实测到的重放");
    assert.equal((await rowOf(receipt.id)).deliveringSince, null, "也不许永久挂着");
    assert.equal(await preparePendingCheckpointStart(test.taskId), null);
    const told = await transcript(test.taskId);
    assert.match(told, /不会自动再送一遍/);
    assert.match(told, new RegExp(test.checkpoint), "原文必须留在用户看得见的地方");
    assert.equal(hits(test.checkpoint), 0, "系统自己一次都没再送");
    assert.equal(deliveryCrossed(test.taskId, receipt.id), false, "有了定论,越线记号就该收走");
    console.log("PASS: a crossed-but-unrecorded handoff survives a restart as a visible uncertain record, never a replay");
  }
}
