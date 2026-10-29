import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import {
  api, db, dbClient, failCheckpointAck, hits, pending, rowOf, scenario, scheduledMessages,
  schema, settled, taskOf, until,
} from "./checkpoint-recovery-fixture.js";
import { deliveryCrossing, ensureCrossingDir, noteDeliveryCrossing } from "../src/delivery-crossing.js";
import { RUNS_DIR } from "../src/paths.js";
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
 * 在重启那一拍不许被回填),以及送达只认记号上那一轮(④)、正在送的不许被接管(⑤)。
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

  // ④ **「送达」只认带身份的那一份证据**(第 1 轮逻辑审查 4)。早先的判据是「这个任务在租约之后
  //    开过任何一个回合」,同一个任务上别的回合(审查旁路、续聊、再点一次运行)也会命中,那段
  //    交代于是被当成已送达划掉:agent 从没收到,时间线上也不留带原文的「交付不明」。
  //    三个现场只差记号上写着的那一轮,判据必须分别给出三种结论。
  const otherTurnAfterLease = async (taskId: string, sessionId: string) => db.insert(schema.sessions).values({
    id: sessionId, taskId, role: "single", agentType: "claude",
    executor: "claude", cwd: ".", startedAt: now(), turnStartedAt: now(),
  });
  {
    // ④a 租约之后有别的回合,却没有越线记号:凭证是硬前置那一代,「没有记号」就是没送出去 → 归还。
    const test = await scenario(0);
    const generation = (await taskOf(test.taskId)).resumePromptGeneration;
    const receipt = (await claimCheckpointForRun(test.taskId, test.checkpoint, generation))!;
    await otherTurnAfterLease(test.taskId, `other-${receipt.id}`);
    forgetCheckpointDelivering(receipt.id);
    await reconcileCheckpointDeliveries(test.taskId);
    await until("没越线的交代归还任务", async () => (await taskOf(test.taskId)).resumePrompt === test.checkpoint);
    assert.equal(hits(test.checkpoint), 0, "压根没送出去,agent 不该见过它");
    console.log("PASS: an unrelated turn after the lease does not count as delivery when nothing crossed");
  }
  {
    // ④b 记号在,写着的那一轮却没开起来;同一个任务上另有一条晚于租约的回合。按时间窗会判送达
    //    并静默划掉 —— 现在必须落「交付不明」,原文留在用户看得见的地方。
    const test = await scenario(0);
    const generation = (await taskOf(test.taskId)).resumePromptGeneration;
    const receipt = (await claimCheckpointForRun(test.taskId, test.checkpoint, generation))!;
    noteDeliveryCrossing(test.taskId, [receipt.id], { sessionId: `sess-${receipt.id}`, turnStart: now() });
    await otherTurnAfterLease(test.taskId, `other-${receipt.id}`);
    forgetCheckpointDelivering(receipt.id);
    await reconcileCheckpointDeliveries(test.taskId);
    await until("交付不明就地了结", async () => (await rowOf(receipt.id)).status === "sent");
    assert.equal((await taskOf(test.taskId)).resumePrompt, null, "越过线的那段话不许被回填");
    const told = await transcript(test.taskId);
    assert.match(told, /不会自动再送一遍/, "别的回合不是这段交代的送达证据 —— 必须留下交付不明的交代");
    assert.match(told, new RegExp(test.checkpoint), "原文必须留在用户看得见的地方");
    console.log("PASS: another turn after the lease is not proof the marked turn received the handoff");
  }
  {
    // ④c 记号上那一轮确实开起来了(回合表里有那个「会话 + 起点」):这才是送达,只往前走。
    const test = await scenario(0);
    const generation = (await taskOf(test.taskId)).resumePromptGeneration;
    const receipt = (await claimCheckpointForRun(test.taskId, test.checkpoint, generation))!;
    const turn = { sessionId: `sess-${receipt.id}`, turnStart: now() };
    noteDeliveryCrossing(test.taskId, [receipt.id], turn);
    await otherTurnAfterLease(test.taskId, turn.sessionId);
    await db.insert(schema.sessionTurns).values({
      id: `turn-${receipt.id}`, sessionId: turn.sessionId, taskId: test.taskId, cwd: ".", startedAt: turn.turnStart,
    });
    forgetCheckpointDelivering(receipt.id);
    await reconcileCheckpointDeliveries(test.taskId);
    await until("已送达那一侧只往前走", async () => (await rowOf(receipt.id)).status === "sent");
    assert.equal((await taskOf(test.taskId)).resumePrompt, null, "记号上那一轮开起来过 = 已送达,不许归还");
    assert.doesNotMatch(await transcript(test.taskId), /不会自动再送一遍/, "真送达了就不是交付不明");
    console.log("PASS: the lease flips to delivered once the marked turn itself is on record");
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
    assert.equal(deliveryCrossing(test.taskId, settledRow.id), "absent", "有了定论,越线记号就该收走");
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
    assert.equal(deliveryCrossing(test.taskId, receipt.id), "absent", "有了定论,越线记号就该收走");
    console.log("PASS: a crossed-but-unrecorded handoff survives a restart as a visible uncertain record, never a replay");
  }

  // ⑧ **凭据写不下来就不许产生外部效果**(第 2 轮自由审查 F1)。
  //    早先 `noteDeliveryCrossing` 吞掉 mkdir/open/write/fsync 的失败,调用方紧接着照常 spawn:
  //    输入出去了、凭据没留下,恢复侧又把「记号不存在」读成否证 —— 审查者用「拿普通文件占住
  //    runs/<task>/crossed」造出真实 EEXIST,跨进程实测到同一段交代被执行两遍。
  //    现在目录在**认领凭证那一步**就建,建不起来当场抛:交代原样留在任务上,一个字都没送出去。
  {
    const test = await scenario(0);
    const occupied = join(RUNS_DIR, test.taskId, "crossed");
    mkdirSync(join(RUNS_DIR, test.taskId), { recursive: true });
    rmSync(occupied, { recursive: true, force: true });
    writeFileSync(occupied, "拿一个普通文件占住这个名字");
    try {
      const generation = (await taskOf(test.taskId)).resumePromptGeneration;
      await assert.rejects(() => claimCheckpointForRun(test.taskId, test.checkpoint, generation),
        /投递越线记号写不下来/, "凭据落不下来时不许认领,更不许往下走到 spawn");
      assert.equal((await taskOf(test.taskId)).resumePrompt, test.checkpoint, "交代原样留在任务上");
      assert.equal((await db.select().from(scheduledMessages)
        .where(eq(scheduledMessages.taskId, test.taskId))).length, 0, "没有凭证就没有在途投递");
      // 走真实启动路径同样如此:它不会把这段话交出去。
      const refused = await api.request(`/tasks/${test.taskId}/run`, { method: "POST" });
      assert.notEqual(refused.status, 202, `凭据坏了时 /run 不许按已启动返回（实得 ${refused.status}）`);
      assert.equal(hits(test.checkpoint), 0, "凭据写不下来时绝不许产生外部效果");
      assert.equal((await taskOf(test.taskId)).resumePrompt, test.checkpoint);
    } finally {
      rmSync(occupied, { force: true });
    }
    console.log("PASS: an unwritable crossing credential aborts before spawn instead of delivering unprovably");
  }

  // ⑧b 同一条不变量的**另一半**:目录好好的,倒在**写文件**那一步(报告点名的 EACCES /
  //    ENOSPC / EIO 一类)。⑧ 那个形状在认领凭证时就被 `ensureCrossingDir` 挡住了,这一条
  //    只有 spawn 前那张记号挡得住 —— 撤掉 `requireDeliveryCrossing` 的抛错,这段交代就会在
  //    没有凭据的情况下真的交出去。这里把目录置成只读造出真实 EACCES(root 下权限位不生效,
  //    那种环境整条跳过)。
  if (process.getuid?.() !== 0) {
    const test = await scenario(0);
    const dir = join(RUNS_DIR, test.taskId, "crossed");
    mkdirSync(dir, { recursive: true });
    chmodSync(dir, 0o555); // 目录建得起来也 fsync 得了,只是往里写文件会被拒
    try {
      ensureCrossingDir(test.taskId); // ⑧ 那道闸这次放行:目录本身是好的
      const refused = await api.request(`/tasks/${test.taskId}/run`, { method: "POST" });
      assert.notEqual(refused.status, 202, `凭据写不下来时 /run 不许按已启动返回（实得 ${refused.status}）`);
      await until("凭据写不下来 → 原地撤回,交代退回任务",
        async () => (await taskOf(test.taskId)).resumePrompt === test.checkpoint);
      assert.equal(hits(test.checkpoint), 0, "凭据写不下来时一个字都不许送出去");
      assert.ok((await db.select().from(scheduledMessages).where(eq(scheduledMessages.taskId, test.taskId)))
        .every((row) => row.status !== "sent"), "没送出去的东西不许被记成已送达");
    } finally {
      chmodSync(dir, 0o755);
    }
    console.log("PASS: a write-stage credential failure returns the checkpoint instead of delivering it unprovably");
  }

  // ⑨ 跟 ③ 同一个现场,只差「记号这一问读不出来」:上一个进程越过线之后被换掉,随后那棵树
  //    被谁清掉了。`existsSync` 的失败方向是 false,于是读不出来被当成否证、交代被归还重投 ——
  //    这正是 F1 的另一半。读不出来只能归到交付不明,由人裁定。
  {
    const test = await scenario(0);
    const generation = (await taskOf(test.taskId)).resumePromptGeneration;
    const receipt = (await claimCheckpointForRun(test.taskId, test.checkpoint, generation))!;
    noteDeliveryCrossing(test.taskId, [receipt.id], { sessionId: `sess-${receipt.id}`, turnStart: now() });
    rmSync(join(RUNS_DIR, test.taskId, "crossed"), { recursive: true, force: true });
    assert.equal(deliveryCrossing(test.taskId, receipt.id), "unreadable", "目录都不在了,这一问没答上来");
    forgetCheckpointDelivering(receipt.id);
    await pending.reclaimStaleDeliveries();
    await until("读不出来归到交付不明", async () => (await rowOf(receipt.id)).status === "sent");
    assert.equal((await taskOf(test.taskId)).resumePrompt, null,
      "记号读不出来不是否证 —— 按否证归还就是把可能已经执行过的交代再投一遍");
    assert.equal(hits(test.checkpoint), 0, "系统自己一次都没再送");
    const told = await transcript(test.taskId);
    assert.match(told, /不会自动再送一遍/);
    assert.match(told, new RegExp(test.checkpoint), "原文必须留在用户看得见的地方");
    console.log("PASS: an unreadable crossing credential settles as uncertain instead of being replayed");
  }

  // ⑩ **可见发布成功是消费凭据的前提**(第 2 轮自由审查 F4)。
  //    `appendTaskTimeline` 是尽力而为的(异常被 catch、返回 false)。早先补办那一次的返回值
  //    压根没接,于是对话文件写不下去时:带原文的裁定记录一个字都没发布,而 markSent + 删记号
  //    已经把恢复责任永久消费掉 —— 用户再也看不到原文,对账也不会再扫到它。
  {
    const test = await scenario(0);
    const generation = (await taskOf(test.taskId)).resumePromptGeneration;
    const receipt = (await claimCheckpointForRun(test.taskId, test.checkpoint, generation))!;
    noteDeliveryCrossing(test.taskId, [receipt.id], { sessionId: `sess-${receipt.id}`, turnStart: now() });
    forgetCheckpointDelivering(receipt.id);
    const taskDir = join(RUNS_DIR, test.taskId);
    // 对话文件写不下去:用一个普通文件占住这个任务的 runs 目录(mkdirSync 当场 EEXIST)。
    rmSync(taskDir, { recursive: true, force: true });
    writeFileSync(taskDir, "对话目录此刻写不下去");
    try {
      await pending.reclaimStaleDeliveries();
      // 发布没成功 ⇒ 一个字都不许消费:租约留着、记号那一侧也不动,任务照旧不许起跑。
      await until("至少试过一次发布", async () => (await rowOf(receipt.id)).status === "canceled");
      const held = await rowOf(receipt.id);
      assert.equal(held.status, "canceled", "发布失败时不许标 sent");
      assert.ok(held.deliveringSince, "租约是「这张凭证还没了结」的唯一凭据,不许提前清掉");
      assert.equal(held.checkpointTaken, test.checkpoint);
      assert.match(String(await preparePendingCheckpointStart(test.taskId)), /交付不明/,
        "没发布出去的时候,准入这一侧也得照实说还没了结");
      assert.equal((await taskOf(test.taskId)).resumePrompt, null, "交付不明照旧不许回填成待执行输入");
    } finally {
      rmSync(taskDir, { force: true });
    }
    // 目录恢复之后,退避重试自己把它办完 —— 恢复责任一直留着。
    await until("恢复之后补办成功", async () => (await rowOf(receipt.id)).status === "sent");
    assert.equal((await rowOf(receipt.id)).deliveringSince, null);
    const told = await transcript(test.taskId);
    assert.match(told, /不会自动再送一遍/, "补办之后那条带原文的记录必须真的在");
    assert.match(told, new RegExp(test.checkpoint));
    assert.equal(hits(test.checkpoint), 0, "整个过程系统一次都没再送");
    console.log("PASS: an uncertain settlement keeps the recovery credential until the visible record publishes");
  }

  // ⑪ 跟 ③ **同一个现场,只差这张凭证是哪一代开出来的**(第 2 轮自由审查 F1)。
  //    「记号不在 ⇒ 一定没送出去」这句话只在**强制前置**存在的那一代成立:凭据写不下来就
  //    当场抛、一个字都不许 spawn(⑧/⑧b),所以那一代的记号缺失是真否证。旧代开出来的凭证
  //    身上没有这层保护 —— 当时越线记号是尽力而为的,写不下来照样 spawn。拿当前代码已经变
  //    严格来追认旧凭证也受保护,就是用「现在的规矩」去给「当时的事实」作证:审查者跨进程
  //    实测到同一段交代被执行两遍(OLD_BEFORE_CRASH_INPUT_COUNT 1 → NEW_VERDICT not-started
  //    → NEW_AFTER_RETRY_INPUT_COUNT 2)。
  //
  //    所以否证的效力**跟着凭证走**:这一行的协议代次是 null(或任何不认得的代次)时,记号
  //    不在只能归到交付不明,就地结成一条带原文的可见记录,由人裁定要不要再送。
  {
    const test = await scenario(0);
    const generation = (await taskOf(test.taskId)).resumePromptGeneration;
    const receipt = (await claimCheckpointForRun(test.taskId, test.checkpoint, generation))!;
    // 把它改回旧代开出来的样子 —— 认领那一步现在会盖上 CROSSING_PROTOCOL。
    await db.update(scheduledMessages).set({ crossingProtocol: null })
      .where(eq(scheduledMessages.id, receipt.id));
    assert.equal(deliveryCrossing(test.taskId, receipt.id), "absent",
      "夹具前提:记号确实不在 —— ③ 那一档正是靠这一点归还的");
    forgetCheckpointDelivering(receipt.id);
    await pending.reclaimStaleDeliveries();
    await until("旧代凭证归到交付不明", async () => (await rowOf(receipt.id)).status === "sent");
    assert.equal((await taskOf(test.taskId)).resumePrompt, null,
      "旧代的记号缺失不构成否证 —— 按否证归还就是把可能已经执行过的交代再投一遍");
    assert.equal((await rowOf(receipt.id)).deliveringSince, null, "也不许永久挂着");
    assert.equal(await preparePendingCheckpointStart(test.taskId), null, "了结之后这个任务能再启动");
    assert.equal(hits(test.checkpoint), 0, "系统自己一次都没再送");
    const told = await transcript(test.taskId);
    assert.match(told, /不会自动再送一遍/);
    assert.match(told, new RegExp(test.checkpoint), "原文必须留在用户看得见的地方");
    console.log("PASS: a legacy receipt minted before the pre-spawn guard is settled as uncertain, never returned");
  }
}
