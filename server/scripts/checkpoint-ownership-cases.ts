import assert from "node:assert/strict";
import { eq } from "drizzle-orm";
import {
  api, db, dbClient, hits, rowOf, scenario, scheduledMessages, schema, settled, taskOf, until,
} from "./checkpoint-recovery-fixture.js";
import type { InStatement, ResultSet, Transaction, TransactionMode } from "../src/db/node-sqlite-client.js";
import { deliveryCrossing, noteDeliveryCrossing } from "../src/delivery-crossing.js";
import { claimCheckpointForRun, settleStrandedCheckpointRun } from "../src/task-checkpoint-delivery.js";
import {
  preparePendingCheckpointStart, recoverPendingCheckpoints,
} from "../src/pending-checkpoint-recovery.js";
import { now } from "../src/util.js";

const sqlOf = (statement: InStatement) => typeof statement === "string" ? statement : statement.sql;
const argsOf = (statement: InStatement) =>
  typeof statement !== "string" && Array.isArray(statement.args) ? statement.args : [];

/**
 * 把一段**并发**定点插在「续跑凭证那一行刚写进事务、这笔事务还没提交」那一瞬。
 *
 * 为什么必须钩 `transaction` 而不是 `execute`:事务里的语句走的是那笔事务自己的 `execute`
 * (db/node-sqlite-client.ts 的 `beginOwned`),根客户端那个钩子看不见它们。
 *
 * 为什么这一瞬是真的窗口:根连接上的**读不等别人的事务**(同一文件 `execute` 的注释),所以
 * 这一行此刻对并发的对账是可见的 —— 下面的用例顺手把「确实看见了」断言出来,免得哪天客户端
 * 改了读语义、这条用例就静默地什么都没测。
 */
function probeAtReceiptInsert(taskId: string, probe: () => Promise<void>) {
  const open = dbClient.transaction.bind(dbClient);
  let fired = false;
  dbClient.transaction = async (mode?: TransactionMode): Promise<Transaction> => {
    const transaction = await open(mode);
    const execute = transaction.execute.bind(transaction);
    transaction.execute = async (statement: InStatement): Promise<ResultSet> => {
      const result = await execute(statement);
      if (!fired && /^insert into "scheduled_messages"/i.test(sqlOf(statement))
        && argsOf(statement).includes(taskId)) {
        fired = true;
        await probe();
      }
      return result;
    };
    return transaction;
  };
  return { fired: () => fired, restore: () => { dbClient.transaction = open; } };
}

/** 定点让**判定自己读不出来**:三态判定问「记号上那一轮开起来过没有」的第一笔读(回合表)。 */
function failVerdictRead() {
  const execute = dbClient.execute;
  let armed = true;
  let failures = 0;
  dbClient.execute = async function (statement, ...rest) {
    if (armed && /from "session_turns"/i.test(sqlOf(statement))) {
      armed = false;
      failures++;
      throw new Error("INJECT_CHECKPOINT_VERDICT_READ_FAILURE");
    }
    return execute.call(dbClient, statement, ...rest);
  };
  return { count: () => failures, restore: () => { armed = false; dbClient.execute = execute; } };
}

/**
 * 认领、恢复与起跑资格之间那一套**互斥所有权**(第 1 轮审查 FMGMWUm5TH7E F1/F2)。
 *
 * 两条都是「同一张凭证同时有两个人认为自己该负责」的后果,只是方向相反:
 *  ① 认领与对账撞在一起 → 两个人都往前走 → 同一段交代执行两遍;
 *  ② 判定阶段读失败 → 所有权留在一个已经放手的人名下 → 谁都不敢动 → 任务永久起不来。
 */
export async function checkpointOwnershipCases(): Promise<void> {
  // ① 凭证行刚写进去、还没提交的那一瞬并发对账:它不许把这张凭证当成「有租约、没人管」
  //    回收掉。回收了就有两个人认为自己该送这段话 —— 实测后果是任务上原文还在、下一次
  //    启动把它再喂一遍(审查者的跨进程复现:CLI 收到次数从 1 变成 2)。
  {
    const test = await scenario(0);
    let concurrent: Promise<number> | null = null;
    const hook = probeAtReceiptInsert(test.taskId, () => {
      concurrent = (async () => {
        const seen = (await db.select().from(scheduledMessages)
          .where(eq(scheduledMessages.taskId, test.taskId))).length;
        await recoverPendingCheckpoints(test.taskId);
        return seen;
      })();
      // 对账那一趟的读必须落在这笔事务**提交之前**。它自己的写(旧口径的归还)会被写闸挡到
      // 提交之后才落,所以这里只等它把读做完,不在事务里等它整趟跑完 —— 那才是真实的并发形状。
      return new Promise<void>((resolve) => setTimeout(resolve, 100));
    });
    try {
      assert.equal((await api.request(`/tasks/${test.taskId}/run`, { method: "POST" })).status, 202);
      await until("原交代喂给 agent", async () => hits(test.checkpoint) === 1);
    } finally {
      hook.restore();
    }
    assert.ok(hook.fired(), "并发对账确实插在了凭证落库那一瞬");
    assert.ok(concurrent, "并发对账确实跑起来了");
    assert.equal(await concurrent, 1, "那一瞬凭证行对并发的读是可见的 —— 这正是要封住的窗口");
    const receipts = await db.select().from(scheduledMessages)
      .where(eq(scheduledMessages.taskId, test.taskId));
    assert.equal(receipts.length, 1);
    assert.equal(receipts[0]!.checkpointTaken, test.checkpoint);
    assert.equal((await taskOf(test.taskId)).resumePrompt, null, "正在送的交代不许被对账回填成待执行输入");
    await until("送达之后这一笔确认照常记上账", async () => (await rowOf(receipts[0]!.id)).status === "sent");
    assert.equal((await rowOf(receipts[0]!.id)).deliveringSince, null);
    assert.equal(hits(test.checkpoint), 1, "恰好一次:并发对账既不许少送也不许多送一遍");
    assert.equal((await taskOf(test.taskId)).resumePrompt, null);
    await settled(test.taskId);
    assert.equal(await preparePendingCheckpointStart(test.taskId), null);
    console.log("PASS: a receipt claimed mid-transaction is never reclaimed by a concurrent reconcile");
  }

  // ② 判定阶段读不出来(库锁、I/O 故障):这一档也必须有人接着办。早先这个异常直接穿出去,
  //    而「正在送」的所有权留在原地 —— 此后每一趟对账都把它当成「还有发送方」跳过,任务从此
  //    起不来,只有重启能解。所以:所有权当场交回 + 自己退避重排一趟对账。
  {
    const test = await scenario(0);
    const generation = (await taskOf(test.taskId)).resumePromptGeneration;
    const receipt = (await claimCheckpointForRun(test.taskId, test.checkpoint, generation))!;
    // 记号在、记号上那一轮也确实开起来过 ⇒ 判定一旦读得动,结论是「已送达,补记这一笔」。
    const turn = { sessionId: `sess-${receipt.id}`, turnStart: now() };
    noteDeliveryCrossing(test.taskId, [receipt.id], turn);
    await db.insert(schema.sessions).values({
      id: turn.sessionId, taskId: test.taskId, role: "single", agentType: "claude",
      executor: "claude", cwd: ".", startedAt: now(), turnStartedAt: turn.turnStart,
    });
    const fault = failVerdictRead();
    try {
      // 不许抛:抛出去就等于没人兜底(它是 task-resume.ts 的 finally 与对账的共同出路)。
      await settleStrandedCheckpointRun(receipt, "测试：判定阶段读失败");
      assert.equal(fault.count(), 1, "判定确实在读回合表那一步失败了");
      const kept = await rowOf(receipt.id);
      assert.ok(kept.deliveringSince, "一个字都不消费:租约原样留着(它是「这张凭证还没了结」的凭据)");
      assert.equal(kept.checkpointTaken, test.checkpoint);
      assert.equal(kept.status, "canceled");
      assert.equal(deliveryCrossing(test.taskId, receipt.id), "crossed", "越线记号也原样留着");
      assert.equal((await taskOf(test.taskId)).resumePrompt, null, "读不出来不是「没送出去」的证据,不许归还");
    } finally {
      fault.restore();
    }
    // 没有任何人再碰它:所有权已经交回、退避重排的那一趟对账自己接得走,所以不必非等用户
    // 再点一次运行、也不必重启。
    await until("交回所有权之后自己把账对上", async () => (await rowOf(receipt.id)).status === "sent");
    assert.equal((await rowOf(receipt.id)).deliveringSince, null);
    assert.equal(await preparePendingCheckpointStart(test.taskId), null, "任务没有被永久钉死");
    assert.equal((await taskOf(test.taskId)).resumePrompt, null, "已送达的那段话不许被回填");
    assert.equal(hits(test.checkpoint), 0, "这一轮压根没真起过 agent");
    console.log("PASS: a verdict read failure hands ownership back and reschedules instead of wedging the task");
  }
}
