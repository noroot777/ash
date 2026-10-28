import assert from "node:assert/strict";
import { eq } from "drizzle-orm";
import {
  db, dbClient, hits, now, runs, scenario, schema, settled, taskOf, tasks, until,
} from "./checkpoint-recovery-fixture.js";
import { advanceQueue, pauseGroup, recoverQueueAdvances } from "../src/scheduler.js";
import { requestQueueAdvance } from "../src/queue-advance-retry.js";
import { occupyResumePrompt } from "../src/task-resume-prompt.js";
import { setTaskStatus } from "../src/status.js";
import { makeTask } from "./monitors-fixture.js";
import { id } from "../src/util.js";

function failRequestWrites(taskId: string, limit = 1) {
  const transaction = dbClient.transaction;
  let failures = 0;
  dbClient.transaction = async function (...args) {
    const active = await transaction.apply(dbClient, args);
    const execute = active.execute.bind(active);
    active.execute = async (statement) => {
      if (failures < limit && typeof statement !== "string" && Array.isArray(statement.args)
        && /^update "tasks" set "queue_advance_request" =/i.test(statement.sql) && statement.args.includes(taskId)) {
        failures++;
        throw new Error("INJECT_ADVANCE_REQUEST_WRITE_FAILURE");
      }
      return execute(statement);
    };
    return active;
  };
  return { count: () => failures, restore: () => { dbClient.transaction = transaction; } };
}

export async function checkpointAdvanceFailureCases(): Promise<void> {
  for (const entry of ["terminal", "direct", "read", "begin"]) {
    const test = await scenario(0);
    const queueId = id();
    await db.insert(schema.queueItems).values({ taskId: test.taskId, queueId, position: 1, createdAt: now() });
    const previous = entry === "terminal" ? await scenario(0) : null;
    if (previous) await db.insert(schema.queueItems).values({ taskId: previous.taskId, queueId, position: 0, createdAt: now() });
    const execute = dbClient.execute;
    const transaction = dbClient.transaction;
    const fault = entry === "terminal" || entry === "direct" ? failRequestWrites(test.taskId, 2) : null;
    let failures = 0;
    if (entry === "read") dbClient.execute = async function (statement) {
      if (!failures && typeof statement !== "string" && /from "queue_items"/i.test(statement.sql)
        && Array.isArray(statement.args) && statement.args.includes(queueId)) {
        failures++;
        throw new Error("INJECT_QUEUE_MEMBERS_READ_FAILURE");
      }
      return execute.call(dbClient, statement);
    };
    if (entry === "begin") dbClient.transaction = async function (...args) {
      if (!failures++) throw new Error("INJECT_ADVANCE_TRANSACTION_BEGIN_FAILURE");
      return transaction.apply(dbClient, args);
    };
    try {
      if (previous) {
        await setTaskStatus(previous.taskId, "done");
        await until("终态钩子的首次推进写失败", async () => fault!.count() > 0);
      } else await advanceQueue(queueId);
      assert.equal((await taskOf(test.taskId)).queueAdvanceRequest, null);
      assert.equal(hits(test.checkpoint), 0);
      assert.equal(runs.isTurnClaimed(test.taskId), false);
      if (fault) {
        await until("重复写失败仍保留退避", async () => fault.count() === 2);
        fault.restore();
      }
      await until("不再手动触发也能重入完整临界区", async () => hits(test.checkpoint) === 1);
      await settled(test.taskId);
      assert.equal((await taskOf(test.taskId)).queueAdvanceRequest, null);
      assert.equal((await taskOf(test.taskId)).queueSeatToken, null);
      if (!fault) assert.ok(failures > 0);
    } finally {
      dbClient.execute = execute;
      dbClient.transaction = transaction;
      await db.delete(schema.queueItems).where(eq(schema.queueItems.queueId, queueId));
    }
    console.log(`PASS: ${entry} queue critical-section failure retries before any durable request exists`);
  }

  // 落库前失败之后,**后来发生的那件事**决定重试该怎么收场。两种截然不同,不能共用一套期望:
  //  · 分组被暂停 = 真的撤销 —— 整组一个都不许启动,重试必须认这件事;
  //  · 队首的续跑交代被改写 = **换人/换交代,不是撤销** —— 这条队列照旧该推进,只是该推的
  //    是最新那段交代。早先两种都按「撤销」处理,于是写入成功那条路会带着最新代次继续
  //    (checkpoint-advance-admission-cases.ts 钉着),写入失败这条路却永久停住:同一个外部
  //    事件,两条路径相反结果,而后者是「队列永久停住 + 新交代也永不执行」
  //    (第 2 轮审查必须修 3;定点实验见审查目录的 d3-replaced-stall.mts)。
  for (const revocation of ["group-pause", "checkpoint-replaced"]) {
    const test = await scenario(0);
    const task = await taskOf(test.taskId);
    const queueId = id();
    const groupId = id();
    await db.insert(schema.groups).values({ id: groupId, projectId: task.projectId, name: revocation, mode: "serial", createdAt: now() });
    await db.update(tasks).set({ groupId }).where(eq(tasks.id, test.taskId));
    await db.insert(schema.queueItems).values({ taskId: test.taskId, queueId, position: 0, createdAt: now() });
    const fault = failRequestWrites(test.taskId);
    try {
      await advanceQueue(queueId);
      assert.equal(fault.count(), 1);
    } finally {
      fault.restore();
    }
    if (revocation === "group-pause") {
      await pauseGroup(groupId);
      await db.update(schema.groups).set({ paused: false }).where(eq(schema.groups.id, groupId));
      await new Promise((resolve) => setTimeout(resolve, 1_250));
      assert.equal((await taskOf(test.taskId)).queueAdvanceRequest, null);
      assert.equal(hits(test.checkpoint), 0);
      assert.equal(runs.isTurnClaimed(test.taskId), false);
      console.log("PASS: failed admission retry respects a later group pause instead of resurrecting canceled intent");
    } else {
      const replacement = "REPLACED_AFTER_FAILED_ADMISSION";
      await occupyResumePrompt(test.taskId, replacement, false);
      await until("落库前失败后交代被改写,重试换人接着跑", async () => hits(replacement) === 1);
      assert.equal(hits(test.checkpoint), 0, "作废的旧交代不许被执行");
      await settled(test.taskId);
      assert.equal((await taskOf(test.taskId)).queueAdvanceRequest, null);
      assert.equal((await taskOf(test.taskId)).queueSeatToken, null);
      console.log("PASS: failed admission retry re-picks the candidate when the checkpoint was replaced");
    }
    await db.delete(schema.queueItems).where(eq(schema.queueItems.queueId, queueId));
  }

  // 必须修 1 的回归:推进请求那一笔写失败时,补办责任只活在进程内存里(deferQueueAdvance 的
  // 闭包 + 一个 unref 定时器),请求此刻一个字都还没落库 —— 进程一消失这件事就没人记得,
  // 三条恢复入口没有一条看得见它。跨进程复现见审查目录的 restart-loses-retry.mts;这里钉
  // 的是补上的那条入口本身,以及**它的边界**。
  for (const shape of ["in-flight", "never-started"] as const) {
    const queueId = id();
    if (shape === "in-flight") {
      // 前一个已经跑完、队首还停着 = 丢掉那次推进之后的现场。
      const prev = await scenario(0);
      const head = await scenario(0);
      await db.update(tasks).set({ status: "done" }).where(eq(tasks.id, prev.taskId));
      await db.insert(schema.queueItems).values([
        { taskId: prev.taskId, queueId, position: 0, createdAt: now() },
        { taskId: head.taskId, queueId, position: 1, createdAt: now() },
      ]);
      await recoverQueueAdvances();
      await until("重启恢复把丢掉的那次队列推进补回来", async () => hits(head.checkpoint) === 1);
      await settled(head.taskId);
      console.log("PASS: restart recovery re-drives a queue whose advance was lost before it reached the database");
    } else {
      // 建好还没点过运行的链(batch_create_tasks 的 run:false):全员 backlog、候选就是第一位、
      // 它前面什么都没落终态 —— 一个字都不许碰,否则重启会把用户压根没点过运行的任务拉起来。
      const members = [await makeTask({ status: "backlog" }), await makeTask({ status: "backlog" })];
      await db.insert(schema.queueItems).values(members.map((taskId, position) => (
        { taskId, queueId, position, createdAt: now() })));
      await recoverQueueAdvances();
      await new Promise((resolve) => setTimeout(resolve, 300));
      for (const taskId of members) {
        assert.equal((await taskOf(taskId)).status, "backlog", "没点过运行的链不许被重启恢复拉起来");
        assert.equal(runs.isTurnClaimed(taskId), false);
      }
      console.log("PASS: restart recovery leaves a never-started queue alone");
    }
    await db.delete(schema.queueItems).where(eq(schema.queueItems.queueId, queueId));
  }

  {
    const test = await scenario(0);
    const queueId = id();
    await db.insert(schema.queueItems).values({ taskId: test.taskId, queueId, position: 0, createdAt: now() });
    const request = await requestQueueAdvance(queueId, await taskOf(test.taskId));
    assert.ok(request);
    await occupyResumePrompt(test.taskId, "KEEP_NEW_CHECKPOINT_PAUSED", false);
    const execute = dbClient.execute;
    let failed = false;
    dbClient.execute = async function (statement) {
      if (!failed && typeof statement !== "string" && /^update "tasks" set "queue_advance_request" =/i.test(statement.sql)
        && Array.isArray(statement.args) && statement.args[0] === null && statement.args.includes(test.taskId)) {
        failed = true;
        throw new Error("INJECT_STALE_ADVANCE_CLEAR_FAILURE");
      }
      return execute.call(dbClient, statement);
    };
    try {
      await advanceQueue(queueId, request);
      assert.equal(failed, true);
    } finally {
      dbClient.execute = execute;
    }
    await until("旧请求异常收口仍携带旧身份清账", async () => (await taskOf(test.taskId)).queueAdvanceRequest === null);
    assert.equal((await taskOf(test.taskId)).resumePrompt, "KEEP_NEW_CHECKPOINT_PAUSED");
    assert.equal(hits("KEEP_NEW_CHECKPOINT_PAUSED"), 0);
    await db.delete(schema.queueItems).where(eq(schema.queueItems.queueId, queueId));
    console.log("PASS: failed stale-request cleanup replays the same identity, not a fresh unscoped queue advance");
  }
}
