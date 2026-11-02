// **一次投递的在途生命周期** —— 回执三档各自怎么处置那张租约,以及「协议层收下了」之后谁都
// 不许把它退回重投。
// 跑:npm -w server run test:undriven-turn(与 test-undriven-turn.ts 同一条命令,这一份排第三)
//
// 起因与另两道闸见 test-undriven-turn.ts 的文件头(同一次事故:2026-11-02 任务 WfLfTjaGzcA8
// 零输出 1.5 小时)。**从那份里拆出来的理由只有一个:它顶到了单文件上限**(根 CLAUDE.md 的
// 700 行)。这一份只管投递记账那一条链:租约本体、真实投递入口、以及消费水位与进展事实的
// 一致性。接管判定、协议应答那两道闸留在那边。
//
// 这一份里每一段红了都指向同一个问题:**本地记账的成败被当成了对方的事实**。两个方向各有
// 实测,而且第二个比第一个更坏:
//   · 本地记账成了就当对方收下 → 一条压根没送出去的消息被标成 `sent`,永久消失(第 2 轮 F2);
//   · 本地记账失败就当对方没收下 → **同一条消息被执行两遍**(第 2 轮 F1,审查端到端实测)。
if (process.platform === "win32") {
  console.log("test:delivery-receipt 跳过：夹具是 #!/bin/sh 的假 codex，Windows 覆盖要上真机（根 AGENTS.md）");
  process.exit(0);
}

import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "ash-delivery-receipt-"));
process.env.ASH_DB = join(root, "ash.db");
process.env.ASH_RUNS_DIR = join(root, "runs");
// 设了 ASH_RUNS_DIR 会触发 guardAgentSpawn 的测试隔离闸;本文件跑的是自己装在 PATH 上的
// 假 codex,显式放行(executors/spawn.ts)。
process.env.ASH_ALLOW_REAL_AGENT = "1";
process.env.ASH_LAX_DONE = "1";
process.env.ASH_TURN_INPUT_ACK_MS = "5000";
process.env.ASH_CODEX_TURN_START_ACK_MS = "5000";
// **补偿退避压到毫秒级**(delivery-lease.ts 的 ASH_DELIVERY_RETRY_MS,只给回归脚本)。
// §② 要的是「补偿失败很多次之后 accepted 仍然不许退回重投」,按真实节奏钉这一条要一分多钟
// (审查那次端到端复现用了 63.7 秒)。压的是节奏,判据一个字没动。
// 节奏不能压得比回合本身还快:②要钉的是「回合已经跑完、记账还欠着」那一刻调用点怎么办 ——
// 补偿要是在回合结束前就补完了,那一刻压根不会被问到(上一版的缺陷也就钉不住)。
process.env.ASH_DELIVERY_RETRY_MS = "100,100,100";
const originalPath = process.env.PATH;

const { installFakeCodexAppServer, codexMode, resetTurnStarts, turnStarts } =
  await import("./undriven-turn-fixture.js");
const fakeBin = installFakeCodexAppServer(root);
process.env.PATH = `${fakeBin}${delimiter}${originalPath ?? ""}`;

const { db, dbClient, ensureSchema } = await import("../src/db/index.js");
const { projects, scheduledMessages, sessions, tasks } = await import("../src/db/schema.js");
const { createDeliveryLease } = await import("../src/delivery-lease.js");
const { deliverPendingMessages, pendingMessageRow } = await import("../src/pending-messages.js");
const { dispatchPendingMessage } = await import("../src/pending-dispatch.js");
const { sleep } = await import("./stall-fixtures.js");
const { eq } = await import("drizzle-orm");
await ensureSchema();

let failures = 0;
const ok = (line: string) => console.log(`   ✓ ${line}`);
const fail = (line: string) => { failures += 1; console.error(`   ✗ ${line}`); };
const check = (cond: boolean, line: string) => (cond ? ok(line) : fail(line));

const stamp = new Date().toISOString();
await db.insert(projects).values({
  id: "p-receipt", name: "receipt", repoPath: root, createdAt: stamp,
} as never);
const seedTask = async (id: string, body: string): Promise<void> => {
  mkdirSync(join(root, "runs", id), { recursive: true });
  await db.insert(tasks).values({
    id, projectId: "p-receipt", title: id, body, mode: "single", status: "paused",
    agentType: "codex", createdAt: stamp, updatedAt: stamp, useWorktree: false,
  } as never);
};

console.log("① 在途租约本体:三档处置、终局不翻盘、欠账只补不退(第 2 轮自由审查 F1)");
{
  const unit = (fails = 0, retryMs?: number[]) => {
    const log: string[] = [];
    let left = fails;
    return {
      log,
      lease: createDeliveryLease({
        // 标清楚:①c/①d 那两段故意永不落盘,它们的补偿日志会一直刷到本文件跑完(计时器
        // 都是 unref 的,不会拖住进程)。不标的话后面几段的日志看起来像在报错。
        label: fails > 1 ? "单元·本段刻意让记账永不落盘" : "单元",
        ...(retryMs ? { retryMs } : {}),
        onAccepted: () => {
          if (left-- > 0) { log.push("sent-fail"); throw new Error("database is locked"); }
          log.push("sent");
        },
        onReturn: () => {
          if (left-- > 0) { log.push("return-fail"); throw new Error("database is locked"); }
          log.push("return");
        },
      }),
    };
  };

  // ①a 三档各自的处置。`callerMustReturn()` 答的是「这张租约该不该由我归还并重投」。
  const inflight = unit();
  await inflight.lease.settle("unknown");
  check(!inflight.lease.callerMustReturn() && inflight.log.length === 0,
    `unknown → 留在在途:既不落 sent 也不归还,调用点也不许碰它(动作:${inflight.log.join(",") || "无"})`);
  await inflight.lease.settle("refused");
  check(inflight.log.join(",") === "return" && !inflight.lease.callerMustReturn(),
    `迟到的拒收把租约还回去,还成了调用点就不必再动(动作:${inflight.log.join(",") || "无"})`);
  await inflight.lease.settle("refused");
  check(inflight.log.join(",") === "return", `重复的拒收只归还一次(动作:${inflight.log.join(",")})`);

  const done = unit();
  await done.lease.settle("accepted");
  await done.lease.settle("refused");
  check(done.log.join(",") === "sent" && !done.lease.callerMustReturn(),
    `accepted 是终局:迟到的拒收不许把已送达的行退回重投(动作:${done.log.join(",")})`);

  // ①b 协议定论 ≠ 副作用完成:记账那一笔失败就退避补上(第 3 轮自由审查 F4)。
  const once = unit(1);
  await once.lease.settle("accepted");
  for (let i = 0; i < 200 && once.lease.owes(); i += 1) await sleep(10);
  check(once.log.join(",") === "sent-fail,sent" && !once.lease.owes(),
    `送达确认第一次没落盘 → 退避补上(动作:${once.log.join(",")});上一版:这一条永久 sent 不了`);

  const backOnce = unit(1);
  await backOnce.lease.settle("refused");
  for (let i = 0; i < 200 && backOnce.lease.owes(); i += 1) await sleep(10);
  check(backOnce.log.join(",") === "return-fail,return" && !backOnce.lease.owes(),
    `归还第一次没落盘 → 退避补上(动作:${backOnce.log.join(",")});上一版:租约永远留着,补发扫描领不走`);

  // ①c **accepted 的欠账永远不许冒充「没人管」**(第 2 轮自由审查 F1 的根因)。
  // 上一版补到第十次就置 `gaveUp`,而 `handled()` 读了它、没读协议定论 —— 于是协议层明明收下、
  // 消息也真执行完了的那一条被暴露成「没送达」,三个调用点照它的口径归还并重投。
  const stuck = unit(99, [5, 5]);
  await stuck.lease.settle("accepted");
  for (let i = 0; i < 200 && stuck.log.filter((x) => x === "sent-fail").length < 12; i += 1) await sleep(10);
  const tries = stuck.log.filter((x) => x === "sent-fail").length;
  check(tries >= 12, `补偿不设上限:失败 ${tries} 次了还在补(上一版第十次就放弃)`);
  check(!stuck.lease.callerMustReturn(),
    "accepted 一次都不授权归还 —— 记账是本地账,只能补,不能靠把消息退回重投来结");
  check(stuck.lease.acceptance() === "accepted" && stuck.lease.owes(),
    "定论与欠账分开报:协议事实 accepted 不翻盘,欠账如实说还欠着");

  // ①d 确证拒收这一档,归还没落盘就该交给调用点一起办(两边都幂等)。
  const owing = unit(99, [5, 5]);
  await owing.lease.settle("refused");
  await sleep(40);
  check(owing.lease.callerMustReturn() && owing.lease.acceptance() === "refused",
    "拒收且还没归还成 → 调用点那段善后正是此刻该走的路(归还幂等,撞上也只是空转)");
}

console.log("② 真实投递入口:记账失败很多次,也绝不能把同一条消息执行第二遍(F1 端到端)");
{
  // 审查的端到端复现:假 CLI 收下输入、把回合跑完(协议层确证 accepted),而 `markSent` 那笔
  // UPDATE 连续失败。上一版第十次失败后把租约暴露成「没人管」,`dispatchPendingMessage` 的
  // 三支善后照口径归还 + 重投 —— 同一条 `perform-operation-once` 进了两个回合。
  const taskId = "t-double-exec";
  await seedTask(taskId, "验证记账失败不会导致重复执行");
  codexMode(fakeBin, "accept");
  resetTurnStarts(fakeBin);
  const row = pendingMessageRow({ taskId, text: "perform-operation-once", mode: "queued" });
  await db.insert(scheduledMessages).values(row as never);

  const execute = dbClient.execute.bind(dbClient);
  let injected = 0;
  let faulting = true;
  (dbClient as { execute: typeof execute }).execute = async (statement) => {
    if (faulting && typeof statement !== "string"
      && /^update "scheduled_messages"/i.test(statement.sql)
      && (statement.args as unknown[] | undefined)?.includes("sent")
      && (statement.args as unknown[] | undefined)?.includes(row.id)) {
      injected += 1;
      // 连续失败约 3 秒(100ms 一拍)—— 比这一轮跑完还久,所以调用点被问到时欠账还在。
      if (injected >= 30) faulting = false; // 存储恢复:补偿下一拍就该把它补上
      throw new Error("ASH_TEST_INJECT_TRANSIENT_MARK_SENT_IO_FAILURE");
    }
    return execute(statement);
  };
  try {
    await dispatchPendingMessage(row as never, {
      spans: { dueAt: Date.now(), busyMs: 0, queuedAt: Date.now() }, onClaim: () => {},
    });
    const owedAtReturn = faulting; // 投递入口返回时注入还没撤 = 那一刻欠账还在
    const current = async () => (await db.select().from(scheduledMessages)
      .where(eq(scheduledMessages.id, row.id))).at(0)!;
    for (let i = 0; i < 300 && (await current()).status !== "sent"; i += 1) await sleep(20);
    const after = await current();
    check(injected >= 10, `前提:记账真的连续失败了 ${injected} 次(没到十次就钉不到上一版那个出口)`);
    check(owedAtReturn, "前提:回合跑完的那一刻记账确实还欠着(否则下面那条是假绿)");
    check(turnStarts(fakeBin) === 1,
      `同一条消息只被执行了一遍(实际 ${turnStarts(fakeBin)} 次);上一版:记账故障变成一次重复执行`);
    check(after.status === "sent" && !!after.sentAt,
      `存储恢复后补偿把它补成 sent(status=${after.status}, sentAt=${after.sentAt ?? "无"})`);
    check(!after.deliveringSince,
      `租约收干净了(deliveringSince=${after.deliveringSince ?? "已清"}) —— 但不是靠退回重投`);
  } finally {
    (dbClient as { execute: typeof execute }).execute = execute;
    await db.delete(scheduledMessages).where(eq(scheduledMessages.id, row.id));
  }
}

console.log("③ 初次 unknown、最终拒收:行必须回到可领取状态(第 2 轮自由审查 F3)");
{
  // 垫片答完 initialize 就对 `thread/resume` 一声不吭(于是回合输入一个字都没写出去),两秒半
  // 后断线 → 最终回执是确证的 refused。实测过的那条洞:租约永远留着,消息停在待发送、任务
  // 已经失败、再扫一遍也领不走它,只有重启能解。
  const taskId = "t-late-refuse";
  await seedTask(taskId, "验证迟到的拒收归还租约");
  codexMode(fakeBin, "resume-silent");
  process.env.ASH_TURN_INPUT_ACK_MS = "800"; // 有界等待要先到期,迟到的那一次才有「迟到」可言
  const row = pendingMessageRow({ taskId, text: "继续:这一条不许卡在在途", mode: "queued" });
  await db.insert(scheduledMessages).values(row as never);
  await deliverPendingMessages(taskId);
  const current = async () => (await db.select().from(scheduledMessages)
    .where(eq(scheduledMessages.id, row.id))).at(0)!;
  for (let i = 0; i < 60 && !(await current()).deliveringSince; i += 1) await sleep(100);
  check(!!(await current()).deliveringSince, "前提:这一条真的被领走了(租约在,否则下面是假绿)");
  for (let i = 0; i < 160 && (await current()).deliveringSince; i += 1) await sleep(100);
  const after = await current();
  // 断言完立刻收掉:挡回那条路会自排重投(pending-redelivery.ts),留着它会再起一轮真 CLI。
  await db.delete(scheduledMessages).where(eq(scheduledMessages.id, row.id));
  process.env.ASH_TURN_INPUT_ACK_MS = "5000";
  check(!after.deliveringSince,
    `迟到的拒收归还了租约(deliveringSince=${after.deliveringSince ?? "已清"}),下一轮扫描领得走它`);
  check(after.status === "pending" && !after.sentAt,
    `行回到待发送、没有被提升成 sent(status=${after.status}, sentAt=${after.sentAt ?? "无"})`);
}

console.log("④ 进展记号欠着时,持久消费水位不许往前走(第 2 轮自由审查 F2 的一致性那一半)");
{
  // F2 的根因是「拿原始 stdout 字节冒充真实进展」。判据改回事件语义层之后,「记号写不进去」
  // 那条缝改从另一头补:**消费水位跟着进展事实一起走** —— 记号欠着就不推进 `agentOffset`,
  // 那段输出留给下一个进程重放,同一份语义判据在新进程里当场认出进展。
  //
  // 这里把 `progressed` 那个路径占成**文件**,于是落记号必然失败(ENOTDIR),而回合照常产出。
  const taskId = "t-offset-gate";
  await seedTask(taskId, "验证进展记号欠着时水位不推进");
  writeFileSync(join(root, "runs", taskId, "progressed"), "占位:让落记号必然失败");
  codexMode(fakeBin, "accept");
  resetTurnStarts(fakeBin);
  const row = pendingMessageRow({ taskId, text: "继续:产出一条正文就够", mode: "queued" });
  await db.insert(scheduledMessages).values(row as never);
  await deliverPendingMessages(taskId);
  const session = async () => (await db.select().from(sessions)
    .where(eq(sessions.taskId, taskId))).at(0);
  for (let i = 0; i < 200 && !(await session()); i += 1) await sleep(50);
  for (let i = 0; i < 200 && (await session())?.endedAt === null; i += 1) await sleep(50);
  const stalled = await session();
  check(!!stalled, "前提:这一轮真的跑起来了(会话行在)");
  check(turnStarts(fakeBin) === 1, `前提:回合真的收下了输入并跑完(${turnStarts(fakeBin)} 次)`);
  // 起跑时那一格本来就是 0(会话行建出来时的初值),判据是「一字未动」而不是「必须为 null」。
  check((stalled?.agentOffset ?? 0) === 0,
    `记号欠着 → 水位一字未动(agentOffset=${String(stalled?.agentOffset)});`
    + "推过去就等于把它「有过进展」的唯一凭据从下一个进程眼前抹掉");
  await db.delete(scheduledMessages).where(eq(scheduledMessages.id, row.id));

  // 对照:记号落得下的那一轮,水位照旧推进(别把这道闸修成「永远不推进」)。
  const control = "t-offset-normal";
  await seedTask(control, "对照:记号正常落盘");
  resetTurnStarts(fakeBin);
  const row2 = pendingMessageRow({ taskId: control, text: "继续:产出一条正文就够", mode: "queued" });
  await db.insert(scheduledMessages).values(row2 as never);
  await deliverPendingMessages(control);
  const session2 = async () => (await db.select().from(sessions)
    .where(eq(sessions.taskId, control))).at(0);
  for (let i = 0; i < 200 && !(await session2()); i += 1) await sleep(50);
  for (let i = 0; i < 200 && (await session2())?.endedAt === null; i += 1) await sleep(50);
  const normal = await session2();
  check((normal?.agentOffset ?? 0) > 0,
    `对照组:记号落得下 → 水位照旧提交(agentOffset=${String(normal?.agentOffset)})`);
  await db.delete(scheduledMessages).where(eq(scheduledMessages.id, row2.id));
}

if (originalPath === undefined) delete process.env.PATH;
else process.env.PATH = originalPath;

if (failures) {
  console.error(`\n✗ ${failures} 项未通过`);
  process.exit(1);
}
console.log("\n✓ 投递回执与消费水位全部通过");
process.exit(0);
