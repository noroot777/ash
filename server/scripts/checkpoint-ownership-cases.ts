import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { eq } from "drizzle-orm";
import {
  api, db, dbClient, hits, rowOf, scenario, scheduledMessages, schema, settled, taskOf, until,
} from "./checkpoint-recovery-fixture.js";
import type { InStatement, ResultSet, Transaction, TransactionMode } from "../src/db/node-sqlite-client.js";
import { deliveryCrossing, noteDeliveryCrossing } from "../src/delivery-crossing.js";
import {
  claimCheckpointForRun, holdCheckpointOwnership, settleStrandedCheckpointRun,
} from "../src/task-checkpoint-delivery.js";
import {
  forgetCheckpointDelivering, preparePendingCheckpointStart,
  reconcileCheckpointDeliveries, recoverPendingCheckpoints,
} from "../src/pending-checkpoint-recovery.js";
import { processGenerationSync } from "../src/process-generation.js";
import { id, now } from "../src/util.js";

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
function failVerdictRead(times = 1) {
  const execute = dbClient.execute;
  let failures = 0;
  dbClient.execute = async function (statement, ...rest) {
    if (failures < times && /from "session_turns"/i.test(sqlOf(statement))) {
      failures++;
      throw new Error("INJECT_CHECKPOINT_VERDICT_READ_FAILURE");
    }
    return execute.call(dbClient, statement, ...rest);
  };
  return { count: () => failures, restore: () => { failures = times; dbClient.execute = execute; } };
}

/** 定点让**起跑资格那一笔条件写**写不下去(续租约那一句)。 */
function failOwnershipWrite() {
  const execute = dbClient.execute;
  let failures = 0;
  dbClient.execute = async function (statement, ...rest) {
    const sql = sqlOf(statement);
    if (!failures && /^update "scheduled_messages" set "delivering_since"/i.test(sql)) {
      failures++;
      throw new Error("INJECT_CHECKPOINT_OWNERSHIP_WRITE_FAILURE");
    }
    return execute.call(dbClient, statement, ...rest);
  };
  return { count: () => failures, restore: () => { dbClient.execute = execute; } };
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

  // ③ **另一份 ash 正在送它时不许接管**(第 2 轮自由审查 F1,两个独立进程实测)。
  //    墙钟租约在接管方眼里跟「有租约、没人管」一模一样,所以旧口径会按「没送出去」把交代
  //    还给任务,而那边照旧把原文送了出去 —— 同一段话执行两遍。放行只认证据,所以这里分两
  //    段判:持有它的那个进程还活着 ⇒ 不接管;它退出了 ⇒ 照常接管下去。
  {
    const test = await scenario(0);
    const generation = (await taskOf(test.taskId)).resumePromptGeneration;
    const receipt = (await claimCheckpointForRun(test.taskId, test.checkpoint, generation))!;
    // 伪装成「另一个进程开的票」:真起一个子进程,按它**当下那一代**拼出所有权身份。
    const other = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
    try {
      await until("旁证进程起来了", async () => other.pid !== undefined && processGenerationSync(other.pid) !== null);
      const foreign = [other.pid!, processGenerationSync(other.pid!)!, `boot-${id()}`, id()].join("|");
      await db.update(scheduledMessages).set({ deliveringOwner: foreign })
        .where(eq(scheduledMessages.id, receipt.id));
      forgetCheckpointDelivering(receipt.id);   // 本进程这边没人在送它(跨实例时按定义如此)
      await reconcileCheckpointDeliveries(test.taskId);
      const kept = await rowOf(receipt.id);
      assert.equal(kept.deliveringOwner, foreign, "持有者还活着 ⇒ 这张票不许被接管");
      assert.ok(kept.deliveringSince);
      assert.equal(kept.checkpointTaken, test.checkpoint);
      assert.equal((await taskOf(test.taskId)).resumePrompt, null, "更不许把交代还给任务 —— 那边可能正在送");
      const blocked = await preparePendingCheckpointStart(test.taskId);
      assert.match(String(blocked), /另一个进程/, "拒绝启动的理由要如实说它挂在谁名下");
      assert.match(String(blocked), /证不出/);
    } finally {
      other.kill("SIGKILL");
    }
    await until("旁证进程确实没了", async () => {
      try { process.kill(other.pid!, 0); return false; } catch { return true; }
    });
    // 持有者退出之后,「证明得了它已经不在」成立 ⇒ 照常接管:没有越线记号 = 没送出去 ⇒ 归还。
    await reconcileCheckpointDeliveries(test.taskId);
    await until("持有者退出后接管下去", async () => (await taskOf(test.taskId)).resumePrompt === test.checkpoint);
    assert.equal((await rowOf(receipt.id)).checkpointTaken, null);
    assert.equal(hits(test.checkpoint), 0, "压根没送出去,agent 不该见过它");
    console.log("PASS: a lease held by a live foreign process is left alone and only taken over once it is gone");
  }

  // ④ 起跑资格是一次**条件写**,而且两种答不出都按失权算:被接管走(身份变了)、以及这一问
  //    自己写不下去。早先它是一次读 + 读失败放行 —— 用过期观察授权一次不可逆的投递。
  {
    const test = await scenario(0);
    const generation = (await taskOf(test.taskId)).resumePromptGeneration;
    const receipt = (await claimCheckpointForRun(test.taskId, test.checkpoint, generation))!;
    assert.equal(await holdCheckpointOwnership(receipt), true, "正常情况下这一问放行");
    const fault = failOwnershipWrite();
    try {
      assert.equal(await holdCheckpointOwnership(receipt), false, "问不出来 ⇒ 按失权算,这一趟不起跑");
      assert.equal(fault.count(), 1);
    } finally {
      fault.restore();
    }
    // 被别人接管走:身份换了,原发送方的资格一问当场为假。
    const taken = [process.pid, "?", `boot-${id()}`, id()].join("|");
    await db.update(scheduledMessages).set({ deliveringOwner: taken })
      .where(eq(scheduledMessages.id, receipt.id));
    assert.equal(await holdCheckpointOwnership(receipt), false, "身份已经不是我那一个 ⇒ 失权");
    // **失权方不许再写账**:这个出口会归还/补记/就地了结,三种都在改那张票和任务上的交代。
    await settleStrandedCheckpointRun(receipt, "测试：失权之后不许再写账");
    const untouched = await rowOf(receipt.id);
    assert.equal(untouched.deliveringOwner, taken, "失权方不许动这张票");
    assert.equal(untouched.checkpointTaken, test.checkpoint);
    assert.equal((await taskOf(test.taskId)).resumePrompt, null, "更不许把交代归还 —— 新持有者可能已经按别的结论处置过了");
    // 收尾:把身份放回来再正常了结。上面那个伪身份故意拼成「代次不详 + 号还活着」(谁都证不出
    // 它已经不在),所以不收尾的话这张票会一直带着租约 —— 套件末尾那条「没有凭证还带着租约」
    // 的总账会红(本轮回归 5W9-jnXiPaLY 的现场)。
    await db.update(scheduledMessages).set({ deliveringOwner: receipt.deliveringOwner })
      .where(eq(scheduledMessages.id, receipt.id));
    await settleStrandedCheckpointRun(receipt, "测试：收尾把这张票归还");
    await until("收尾归还", async () => (await taskOf(test.taskId)).resumePrompt === test.checkpoint);
    assert.equal((await rowOf(receipt.id)).deliveringSince, null);
    console.log("PASS: start eligibility is a conditional write that fails closed, and a displaced sender writes nothing");
  }

  // ⑤ 证据持续读不出来时**退避真的在涨**(第 2 轮自由审查 N6)。计时器回调要绕一趟对账才回到
  //    出口,`attempts` 在那一跳上丢掉,于是每轮又从 0 起、恒为 200ms:既没有退避,还会把读取
  //    压力和日志按故障时长线性放大。
  {
    const test = await scenario(0);
    const generation = (await taskOf(test.taskId)).resumePromptGeneration;
    const receipt = (await claimCheckpointForRun(test.taskId, test.checkpoint, generation))!;
    noteDeliveryCrossing(test.taskId, [receipt.id], { sessionId: `sess-${receipt.id}`, turnStart: now() });
    const said: string[] = [];
    const warn = console.warn;
    console.warn = (...args: unknown[]) => { said.push(args.map(String).join(" ")); warn(...args); };
    const fault = failVerdictRead(Infinity);
    try {
      await settleStrandedCheckpointRun(receipt, "测试：判定持续读不出来");
      await until("第二次重排的间隔翻上去了", async () => said.some((line) => /400ms 后第 3 次对账/.test(line)));
      assert.ok(said.some((line) => /200ms 后第 2 次对账/.test(line)), "第一次仍从 200ms 起");
    } finally {
      fault.restore();
      console.warn = warn;
    }
    // 库恢复之后照旧自己把账对上(退避只改间隔,不改出路)。
    await until("读得动之后自己了结", async () => (await rowOf(receipt.id)).status === "sent");
    assert.equal(await preparePendingCheckpointStart(test.taskId), null);
    console.log("PASS: repeated verdict read failures actually back off instead of retrying every 200ms");
  }
}
