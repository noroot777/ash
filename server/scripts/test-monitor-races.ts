// 哨兵的**终态与投递**回归：任务自己结束的那一瞬间，谁还能把它叫醒。
// 这一份专收「两个写者抢同一条命」的窗口——它们每一条都是实测复现过的，不是假想：
//
//  ⑨ 任务落终态时，攒着的和排着队的哨兵事件一起作废（否则把 done 的任务又拉起来）
//  ⑬⑭ 合并与投递抢同一行 pending：等回合期间追加的照样发出去，CAS 落空就另起一条
//  ⑮ 创建入口与投递出口同一份判据：投不出去的任务上起不来，也不虚报事件数
//  ⑯ 迟到一步的事件：清理全跑完之后才入库的那一行，出口上照样认终态
//  ⑰ 收尾那一瞬起的哨兵：终态先落库，排在清理后面的创建读到的就是终态
//  ⑱ 抢到租约 ≠ 已送达：等回合期间任务被标完成，运行入口上再挡一道
//  ⑲ 资格检查读失败：这一轮不起，但回合占位必须还回去（不然任务被锁死）
//  ⑳ 完成操作与「起这一轮」争同一把回合锁：两种顺序都收口
//  ㉑ 团队调度台那条路同样要互斥：完成之后不许再开台、不许把那条通知记成已发送
//  ㉒ 团队资格读失败一次 ≠ 调度台不可用：消息留在托盘里重投，不许当场销毁
//
// 台子（临时库、真模块、makeTask/pendingOf）在 monitors-fixture.ts，与 test-monitors.ts 共用。
import assert from "node:assert/strict";
import { appendFileSync, writeFileSync } from "node:fs";
import { Hono } from "hono";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { monitorMessageOrigin } from "@ash/shared/monitor";
import { readSource } from "../../scripts/read-source.mjs";
import {
  HERE, root, db, schema, monitorsModule, status, pending, continueTask, runs, mountTaskRoutes,
  startMonitor, stopMonitor, listMonitors, getMonitor,
  monitors, scheduledMessages, sessions, tasks,
  sleep, until, now, uniq, makeTask, pendingOf, teardown,
} from "./monitors-fixture.js";

// ── ⑨ 任务落终态：攒着的和排着队的哨兵事件一起作废 ───────────────────────────
// `notify=false` 只挡住最后那条「哨兵结束」。缓冲里的行照样会排进待发队列，而终态之后
// 紧接着就是 flushPendingForTask —— 于是一个刚 done 的任务被自己的哨兵重新拉起来跑一轮。
{
  const taskId = await makeTask();
  const started = await startMonitor({
    taskId,
    command: `${JSON.stringify(process.execPath)} -e 'console.log("EVENT_BEFORE_DONE"); setInterval(() => {}, 1000);'`,
    description: "任务结束就该收手",
  });
  assert.equal(started.ok, true);
  const monitorId = started.ok ? started.monitor.id : "";
  await until("第一条事件已排队", async () => (await pendingOf(taskId)).length > 0);

  // 真人排的那条追问必须活下来：他排的时候就知道任务可能正要结束，那句话的意思是
  // 「下次醒来处理」，替他取消等于把他的话吞了。
  await db.insert(scheduledMessages).values({
    id: uniq("human"), taskId, text: "这条是真人排的", attachments: "[]",
    mode: "queued", sendAt: now(), status: "pending", createdAt: now(),
  });

  await status.setTaskStatus(taskId, "done");

  const pending = await pendingOf(taskId);
  assert.equal(pending.filter((m) => m.origin?.startsWith("monitor:")).length, 0, "排着队的哨兵事件必须一起作废");
  assert.equal(pending.filter((m) => !m.origin).length, 1, "真人排的那条要原样留着");
  assert.equal((await getMonitor(monitorId))?.status, "stopped", "任务结束了哨兵也该停");

  // 收手之后再吐的行一个都不该进来（pushToTask 在唯一出口上认任务状态）。
  const row = (await db.select().from(monitors).where(eq(monitors.id, monitorId))).at(0)!;
  appendFileSync(row.logPath, "AFTER_DONE\n");
  await sleep(1200);
  assert.equal(
    (await pendingOf(taskId)).filter((m) => m.origin?.startsWith("monitor:")).length,
    0,
    "任务已经结束，哨兵不该再往它头上排任何事件",
  );
  console.log("✓ 任务落终态：缓冲、队列、后续输出三头都不再唤醒它");
}
// ── ⑬⑭ 事件与投递抢同一行：追加进去的内容一个字都不能丢 ───────────────────────
// 合并（几十条事件只唤醒任务一次）和投递是两个写者在抢同一行 pending。两个方向各有一个
// 真窗口，第 2 轮审查都实测到了：
//   A. 投递方从「选中这一条」到真正送出去中间要等当前回合退干净，按**旧快照**发 = 那段
//      时间里追加进去的事件等于没发，行却被标 sent，再也不会补发。
//   B. 合并那一发是 CAS（条件是租约为空），它可以合法落空；不看结果就当成功，那一批行
//      既没进任何消息、位置还跟着前进，整批进展静默消失。
{
  const pending = await import("../src/pending-messages.js");
  const taskId = await makeTask();
  const logFile = join(root, "race.log");
  writeFileSync(logFile, "");
  const started = await startMonitor({
    taskId,
    command: `${JSON.stringify(process.execPath)} -e 'process.stdout.write(require("fs").readFileSync(${JSON.stringify(logFile)}, "utf8")); setInterval(() => {}, 1000);'`,
    description: "抢同一行",
  });
  assert.equal(started.ok, true);
  const monitorId = started.ok ? started.monitor.id : "";
  const row = (await db.select().from(monitors).where(eq(monitors.id, monitorId))).at(0)!;

  appendFileSync(row.logPath, "FIRST_BEFORE_PAUSE\n");
  await until("第一条事件已排队", async () => (await pendingOf(taskId)).length > 0);
  const queued = (await pendingOf(taskId))[0]!;

  // ⑬ 投递方抢租约那一刻拿到的必须是**此刻**那一行，而不是它选中时的快照。
  appendFileSync(row.logPath, "SECOND_WHILE_WAITING\n");
  await until("第二条已合并进同一行", async () =>
    (await pendingOf(taskId)).some((m) => m.text.includes("SECOND_WHILE_WAITING")));
  const claimed = await pending.beginDelivery(queued.id);
  assert.ok(claimed, "没抢到租约，这一段的前提就不成立");
  assert.equal(
    typeof claimed?.text,
    "string",
    "beginDelivery 要把抢到的那一行交回来——只回一个 true 的话，投递方手里永远只有旧快照",
  );
  assert.match(claimed!.text, /FIRST_BEFORE_PAUSE/);
  assert.match(
    claimed!.text,
    /SECOND_WHILE_WAITING/,
    "等回合期间追加进去的那条必须在抢租约时一起拿到——按旧快照发等于把它吞了",
  );

  // 投递链路两处发送都必须用抢到的那一行，不能用调用方手里的快照。
  const deliverySrc = readSource(join(HERE, "../src/pending-messages.ts"));
  assert.equal(
    /continueTask\((?:message|m)\.taskId, (?:message|m)\.text/.test(deliverySrc),
    false,
    "投递要发的是 beginDelivery 抢到的那一行的正文（claimed.text），不是选中时的快照",
  );

  // ⑭ 「查到可合并的那一行之后，投递方才抢走租约」——那一发 CAS 必然落空。拿一份**已经
  // 过期**的 `existing` 调生产函数就是这个现场本身（不需要往产线里埋钩子）：行是查出来
  // 的，租约是真抢的，落空之后该怎么办全由生产代码自己决定。
  await monitorsModule.mergeOrEnqueueMonitorEvent(row, "【哨兵事件】THIRD_AFTER_LEASE", queued);
  const after = await pendingOf(taskId);
  assert.equal(
    after.filter((m) => m.text.includes("THIRD_AFTER_LEASE")).length,
    1,
    "合并落空不是「改成功了」：那一批行必须另起一条消息，不能静默消失",
  );
  // 带着租约的那一行已经出口了（行还是 pending —— 租约不是 sent），但它的正文不许再被
  // 改动：改它等于改一句已经交到投递方手里的话。另起的那一条也得是真的另一行。
  const leased = after.find((m) => m.id === queued.id)!;
  assert.match(leased.text, /FIRST_BEFORE_PAUSE/);
  assert.match(leased.text, /SECOND_WHILE_WAITING/);
  assert.doesNotMatch(leased.text, /THIRD_AFTER_LEASE/, "租约落下之后追加的内容不该再挤进这一行");

  await stopMonitor(monitorId, "测试收尾");
  console.log("✓ 合并与投递抢同一行：等回合期间追加的照样发出去，CAS 落空就另起一条");
}
// ── ⑮ 入口与出口同一份判据：投不出去的任务上不许起，也不许虚报事件数 ───────────
// 两边不同源就会长出这个洞：界面允许在已完成的任务上起哨兵，命令真跑起来、卡片上事件数
// 还在涨，而投递那一侧按终态把每一条都拒了，任务永远不醒（第 2 轮审查实测：待发送消息
// 数 0、任务一直 done，而用户看到「1 条事件」，只会以为通知已经处理过了）。
{
  const taskId = await makeTask();
  const idle = `${JSON.stringify(process.execPath)} -e "setInterval(() => {}, 1000)"`;
  await status.setTaskStatus(taskId, "done");
  const refused = await startMonitor({ taskId, command: idle, description: "已结束的任务" });
  assert.equal(refused.ok, false, "投不出去的任务上就不该起得来");
  assert.equal(refused.ok === false ? refused.status : 0, 409);
  assert.match(refused.ok === false ? refused.error : "", /已经结束/, "拒的理由要能直接给用户看");
  assert.equal((await listMonitors(taskId)).length, 0, "拒了就不该留下记录，更不该留下进程");

  // 事件数只数「唤醒过任务几次」。归档不走连坐（它不是终态迁移），正好留出一个
  // 「哨兵还在跑、但推不出去」的现场来验这一条。
  const live = await makeTask();
  const running = await startMonitor({ taskId: live, command: idle, description: "归档后推不出去" });
  assert.equal(running.ok, true);
  const monitorId = running.ok ? running.monitor.id : "";
  const row = (await db.select().from(monitors).where(eq(monitors.id, monitorId))).at(0)!;
  await db.update(tasks).set({ archived: true }).where(eq(tasks.id, live));
  appendFileSync(row.logPath, "AFTER_ARCHIVE\n");
  await sleep(1500);
  const settled = (await db.select().from(monitors).where(eq(monitors.id, monitorId))).at(0)!;
  assert.equal(settled.events, 0, "一次唤醒都没造成，就不能报「已有 1 条事件」");
  assert.equal(settled.offset, 0, "没人读过的行，位置也不该越过去");
  assert.equal((await pendingOf(live)).length, 0, "归档的任务上确实一条都没排进去");
  await stopMonitor(monitorId, "测试收尾");
  console.log("✓ 入口与出口同一份判据：终态任务上起不来，推不出去也不虚报事件数");
}
// ── ⑯ 迟到一步的事件：清理都跑完了才入库的那一行，也不许唤醒已经结束的任务 ───────
// 生产端那个闸永远留着一条缝:投递读到「任务还在跑」之后、消息写进库之前,任务刚好收尾。
// 这一批行手里拿着自己的 `lines`、也早就过了状态闸,缓冲被清空不影响它;`cancelPending
// MonitorEvents` 那一刻又扫不到尚未入库的它 —— 于是它在**所有清理之后**入队,把一个已经
// done 的任务重新叫起来(第 3 轮审查实测:总线真的走了 done → running → done,正文就是
// 那条迟到的进展)。所以出口上也要认一次终态,判据跟创建入口同一份。
//
// 这里用生产的那两个函数把这个现场摆出来:先让任务真的收尾完,再调真正的入库函数
// (`mergeOrEnqueueMonitorEvent` = 迟到那一步落地),然后问生产的投递判定和结算判据。
{
  const taskId = await makeTask();
  const started = await startMonitor({
    taskId,
    command: `${JSON.stringify(process.execPath)} -e "setInterval(() => {}, 1000)"`,
    description: "在途事件不许叫醒已结束的任务",
  });
  assert.equal(started.ok, true);
  const row = (await db.select().from(monitors).where(eq(monitors.id, started.ok ? started.monitor.id : ""))).at(0)!;

  await status.setTaskStatus(taskId, "done");
  assert.equal((await pendingOf(taskId)).length, 0, "收尾之后队列是干净的——下面那一行是**之后**才落的");

  // 迟到的那一步:走生产的入库函数,`existing=null` 就是「没有可合并的那一行」,
  // 跟真实在途投递走到这一句时的处境一样。
  await monitorsModule.mergeOrEnqueueMonitorEvent(row, "OUTPUT_IN_FLIGHT_AT_DONE", null);
  const late = (await pendingOf(taskId)).find((m) => m.origin === `monitor:${row.id}`);
  assert.ok(late, "这一行确实落进了队列——清理已经管不到它了");

  const task = (await db.select().from(tasks).where(eq(tasks.id, taskId))).at(0)!;
  const verdict = pending.deliveryVerdict(late, { mode: task.mode, status: task.status, archived: !!task.archived }, new Date());
  assert.equal(verdict.action, "cancel", "任务已经结束,这条迟到的哨兵事件只能作废,不能送进会话");
  assert.equal(await pending.hasDeliverablePendingMessages(taskId), false, "结算那一侧也不该因为它把任务判成「还有话要说」");

  // 真人排的那条在同一个终态上走的是相反的语义:「下次醒来处理」正是他排它的意思。
  await db.insert(scheduledMessages).values({
    id: uniq("human-late"), taskId, text: "这条是真人排的", attachments: "[]",
    mode: "queued", sendAt: now(), status: "pending", createdAt: now(),
  });
  const human = (await pendingOf(taskId)).find((m) => !m.origin)!;
  assert.equal(
    pending.deliveryVerdict(human, { mode: task.mode, status: task.status, archived: !!task.archived }, new Date()).action,
    "deliver",
    "这道闸只能拦哨兵自己推的,拦到真人头上就是把他的话吞了",
  );

  // 收尾那一侧的边界也钉一下:只清缓冲不等在途,那条缝就一直在。
  const monitorsSrc = readSource(join(HERE, "../src/monitors.ts"));
  assert.match(
    monitorsSrc,
    /for \(const m of all\) await serialize\(m\.id/,
    "连坐停止必须把每条哨兵自己的队列排空——轮到那个空活,才说明在途那一批已经写完",
  );
  console.log("✓ 迟到一步的事件:落库在清理之后,出口上照样认终态,只拦哨兵不拦真人");
}
// ── ⑰ 收尾那一瞬起的哨兵:创建权限不许早于终态落库放开 ─────────────────────────
// 任务级队列保护了「先开始创建、后扫到这条命令」那一头,却盖不住尾段:终态是 `status.ts`
// 在队列**外面、之后**才写的,于是排在清理后面的创建读到的还是 running —— 任务 done 了
// 还真起得来一个新哨兵,它一直盯到超时,而它推的每一条又都被终态挡回,再也没人会被通知
// (第 3 轮审查实测:natural-terminal-start-queue 里第二次创建 ok:true、任务 done、
// 新命令 running)。顺序必须是「先落终态、再清理」。
//
// 用生产的总线把创建塞进那个窗口:旧哨兵被连坐停掉时会发一条 `task.monitors`,那一刻
// 清理正握着 `task:<id>` 这条队列,于是这一发创建必然排在它后面。
{
  const taskId = await makeTask();
  const idle = `${JSON.stringify(process.execPath)} -e "setInterval(() => {}, 1000)"`;
  assert.equal((await startMonitor({ taskId, command: idle, description: "收尾前就在盯的" })).ok, true);

  const { bus } = await import("../src/bus.js");
  let second: Promise<Awaited<ReturnType<typeof startMonitor>>> | null = null;
  const off = bus.subscribe((e) => {
    if (e.type === "task.monitors" && e.taskId === taskId && !second)
      second = startMonitor({ taskId, command: idle, description: "收尾那一瞬插进来的" });
  });
  try {
    await status.setTaskStatus(taskId, "done");
  } finally {
    off();
  }
  assert.ok(second, "没等到连坐停止发出的那一条变化信号,这一段就没验到东西");
  const created = await second;

  // 先收场再断言:没修的那一版这里真会留下一个长跑进程,断言先抛就带着它一起走了。
  for (const m of await listMonitors(taskId)) if (m.status === "running") await stopMonitor(m.id, "测试收尾");

  assert.equal(created.ok, false, "清理已经在跑了,这一发创建必须读到终态、直接拒");
  assert.equal(created.ok === false ? created.status : 0, 409);
  assert.equal(
    (await db.select().from(tasks).where(eq(tasks.id, taskId))).at(0)?.status,
    "done",
    "任务确实已经落了终态——拒的理由不是「任务不存在」之类的别的东西",
  );
  console.log("✓ 收尾那一瞬:终态先落库,排在清理后面的创建读到的就是终态");
}
// ── ⑱ 抢到租约 ≠ 已送达：等回合期间任务被标完成，这一轮就不许起 ─────────────────
// 扫描那一层的终态判据（⑯）只在**选中这一条**的时候问了一次。`beginDelivery` 抢下的是
// 租约，不是送达：从抢到租约到真正续跑中间还要等当前这一轮退干净，那段时间里用户完全
// 可以把任务标成完成 —— 而连坐清理刻意不碰带租约的那一行（它归正在送它的那位）。于是
// 一条压根没进会话的事件把一个已经 done 的任务拉回 running、多烧一轮会话（第 4 轮审查
// 实测：总线真的走了 paused → done → running → done，消息随后被标 sent、会话数 1）。
//
// 所以最后一道闸必须摆在**真正起这一轮的那个入口**上。现场只能这么摆：租约一落下，扫描
// 那条路就跳过这一行，于是拿着抢到的那一行去走运行入口 —— 三件都是生产件，装法与
// `deliverWhenIdle` 逐字一致（见 monitorWakeGuard 的导出理由）。
{
  const taskId = await makeTask();
  const started = await startMonitor({
    taskId,
    command: `${JSON.stringify(process.execPath)} -e "setInterval(() => {}, 1000)"`,
    description: "租约不等于送达",
  });
  assert.equal(started.ok, true);
  const row = (await db.select().from(monitors).where(eq(monitors.id, started.ok ? started.monitor.id : ""))).at(0)!;
  appendFileSync(row.logPath, "LEASED_OUTPUT_AT_USER_COMPLETION\n");
  await until("事件已排队", async () => (await pendingOf(taskId)).length > 0);

  // 等回合退干净的那一位就停在这儿：租约已经抢下，正文也重读过了。
  const claimed = await pending.beginDelivery((await pendingOf(taskId))[0]!.id);
  assert.ok(claimed, "没抢到租约，这一段的前提就不成立");
  assert.match(claimed!.text, /LEASED_OUTPUT_AT_USER_COMPLETION/);

  // 用户这会儿把它标成完成（走生产的 setTaskStatus）。
  await status.setTaskStatus(taskId, "done");
  const afterDone = (await pendingOf(taskId)).find((m) => m.id === claimed!.id);
  assert.ok(afterDone, "带租约的那一行归正在送它的那位，连坐清理刻意不碰它——这正是报告指的窗口");

  // 真正的运行入口。这一句必须干干净净地回 false：一个字都没送出去。
  const ran = await continueTask(taskId, claimed!.text, {
    ...pending.deliveryOptions(claimed!),
    wakeGuard: pending.monitorWakeGuard(claimed!),
  });
  assert.equal(ran, false, "任务已经结束，这条还没送达的哨兵事件不许起这一轮");
  assert.equal(
    (await db.select().from(tasks).where(eq(tasks.id, taskId))).at(0)?.status,
    "done",
    "它不该把一个已经完成的任务拉回 running",
  );
  assert.equal(
    (await db.select().from(schema.sessions).where(eq(schema.sessions.taskId, taskId))).length,
    0,
    "没起这一轮就不该多出一条会话",
  );

  // 真人排的那条在同一个现场走的是相反语义：终态正是它该发的时候，不挂这道闸。
  await db.insert(scheduledMessages).values({
    id: uniq("human-lease"), taskId, text: "这条是真人排的", attachments: "[]",
    mode: "queued", sendAt: now(), status: "pending", createdAt: now(),
  });
  const human = (await pendingOf(taskId)).find((m) => !m.origin)!;
  assert.equal(pending.monitorWakeGuard(human), undefined, "这道闸只认哨兵推的那些，挂到真人头上就是把他的话吞了");

  // 调用方那一侧的两件事也钉住：两条投递分支都挂了闸，被挡下的一律取消而不是退回托盘
  // （任务已经结束，退回去下一次、下一百次都是同一个结果，只会一直挂在用户的托盘里）。
  const deliverySrc = readSource(join(HERE, "../src/pending-messages.ts"));
  assert.equal(
    (deliverySrc.match(/wakeGuard: async \(\) => \(refused = await guard\(\)\)/g) ?? []).length,
    2,
    "单任务和团队两条真实投递分支都要带上这道闸，少一条就等于那条路没防",
  );
  assert.equal(
    (deliverySrc.match(/if \(refused\) await cancelPendingMessage\(/g) ?? []).length,
    2,
    "被终态挡下的不能 abortDelivery 退回托盘重投——那是一条永远送不出去的消息",
  );
  console.log("✓ 抢到租约不等于已送达：等回合期间任务被标完成，运行入口上再挡一道");
}


// ── ⑲ 资格检查读失败：不许留下一个没人放的回合占位 ───────────────────────────
// 那一问要读库，它**可能抛**。从 `claimTurn` 到大 try 之间没有 finally 兜着，抛在那儿
// 就等于占位留在内存里没人放：任务停在 paused，点运行说「回合正在进行」、点停止说
// 「没有在运行的进程」，连真人后续回复都起不来 —— 而库早就恢复正常了（第 5 轮审查对
// 那一次读注入单次故障实测：isTurnClaimed=true / isRunning=false，run 与 stop 双 409）。
//
// 这一段的主断言是「**第二次还起得来**」：占位真漏了的话，下一次 claimTurn 必然失败，
// 它的闸压根不会被调到。
{
  const taskId = await makeTask();
  await status.setTaskStatus(taskId, "paused");

  // 这一句自己接住异常：**先**断言锁，再断言别的——不接的话测试会被那个异常直接打死，
  // 看到的人只知道「抛了」，不知道真正的后果是那个任务从此被锁死。
  let thrown: unknown = null;
  const ran = await continueTask(taskId, "【哨兵事件】GUARD_READ_FAILURE", {
    byBackend: true,
    wakeGuard: async () => { throw new Error("INJECTED_SINGLE_DATABASE_READ_FAILURE"); },
  }).catch((error) => { thrown = error; return false; });
  assert.equal(runs.isTurnClaimed(taskId), false, "占位必须还回去——漏了它这个任务就被锁死了");
  assert.equal(thrown, null, "读失败不该把异常甩给调用方：上层那条 catch 会把消息直接取消掉");
  assert.equal(ran, false, "读不到状态就不该起这一轮");
  assert.equal(
    (await db.select().from(tasks).where(eq(tasks.id, taskId))).at(0)?.status,
    "paused",
    "一轮都没起，状态不该被动过",
  );

  // 再来一次：拿得到回合、闸真的被调到，就说明上面那一次确实没留下占位。
  let asked = false;
  const again = await continueTask(taskId, "【哨兵事件】AFTER_RECOVERY", {
    byBackend: true,
    wakeGuard: async () => { asked = true; return "就到这儿，别真起 agent"; },
  });
  assert.equal(again, false);
  assert.equal(asked, true, "第二次连闸都没问到 = 回合锁没放回来，任务已经被锁死");
  assert.equal(runs.isTurnClaimed(taskId), false, "拒绝那条路同样不留占位");
  console.log("✓ 资格检查读失败：这一轮不起，但占位还回去，任务还能再跑");
}

// ── ⑳ 完成操作与「起这一轮」争同一把锁 ───────────────────────────────────────
// 把检查挪到占位之后，只挡得住**同样要占这把锁**的启动，挡不住不占锁的终态修改：最终
// 检查读到 paused、用户的完成操作照样 200，放开之后 `paused → done → running → done`，
// 多出一轮会话（第 5 轮审查实测）。所以手动改终态也得占同一把锁，两种顺序才都收口。
{
  const taskId = await makeTask();
  await status.setTaskStatus(taskId, "paused");
  const api = new Hono();
  mountTaskRoutes(api);
  const markDone = () => api.request(`/tasks/${taskId}`, {
    method: "PATCH",
    headers: { "content-type": "application/json", "x-ash-user-action": "1" },
    body: JSON.stringify({ status: "done" }),
  });
  const statusOf = async () => (await db.select().from(tasks).where(eq(tasks.id, taskId))).at(0)?.status;

  // 顺序 ①：那条还没送达的事件先占住位（库里还是 paused）→ 完成操作必须被挡回。
  assert.ok(runs.claimTurn(taskId, "single"), "这一段的前提：先占住位");
  const refused = await markDone();
  assert.equal(refused.status, 409, "占位期间的完成操作不能放行——放行了就是上面那条链");
  assert.match((await refused.json()).error as string, /回合正在进行/, "拒的理由要能直接给用户看");
  assert.equal(await statusOf(), "paused", "被挡回就一个字都不许写库");
  runs.releaseTurn(taskId);

  // 顺序 ②：完成操作先占住位 → 那条事件的 claimTurn 失败，这一轮压根起不来。
  let asked = false;
  assert.ok(runs.claimTurn(taskId, "status"), "模拟完成操作正握着那把锁");
  const blocked = await continueTask(taskId, "【哨兵事件】OUTPUT_AFTER_FINAL_GUARD_READ", {
    byBackend: true,
    wakeGuard: async () => { asked = true; return null; },
  });
  assert.equal(blocked, false, "锁在别人手里，这一轮就该干净地回 false");
  assert.equal(asked, false, "连闸都不该问到——抢不到位的时候一个字都没送出去");
  runs.releaseTurn(taskId);

  // 正常那条路照旧：没人占位，完成操作该成，而且**必须把锁还回去**。
  const ok = await markDone();
  assert.equal(ok.status, 200);
  assert.equal(await statusOf(), "done");
  assert.equal(runs.isTurnClaimed(taskId), false, "一次 PATCH 把任务锁死，比不互斥还糟");

  // 路由那一侧占的得是**同一把**锁，而且得在 finally 里还 —— 这两件事钉住。
  const routeSrc = readSource(join(HERE, "../src/task-routes.ts"));
  assert.match(routeSrc, /claimTurn\(tid, "status"\)/, "手动改终态要占的是同一把回合锁");
  assert.match(routeSrc, /\} finally \{\n    \/\/[^\n]*\n    if \(lockTurn\) releaseTurn\(tid\);/,
    "每一条出路都得还回去——含被挡回的那次 early return");
  console.log("✓ 完成操作与起这一轮争同一把锁：两种顺序都收口，锁不留手");
}

// ── ㉑ 团队任务：完成操作与哨兵通知同样要互斥 ─────────────────────────────────
// 第 5 轮把单飞那一侧补齐了，团队那一侧原样留着：常驻调度台不占单飞锁，于是「最终资格
// 读到 idle」与「用户标完成」照旧能交错 —— 第 6 轮审查实测：完成操作 200、任务 done、
// 哨兵也 stopped，放开之后团队那侧拿着旧结果照样开台，**新开一条 lead 会话、原通知记成
// sent**，总线走了 idle → done → running → idle。两种顺序都得收口。
{
  const api = new Hono();
  mountTaskRoutes(api);
  const markDone = (taskId: string) => api.request(`/tasks/${taskId}`, {
    method: "PATCH",
    headers: { "content-type": "application/json", "x-ash-user-action": "1" },
    body: JSON.stringify({ status: "done" }),
  });
  const statusOf = async (taskId: string) =>
    (await db.select().from(tasks).where(eq(tasks.id, taskId))).at(0)?.status;
  const sessionsOf = (taskId: string) => db.select().from(sessions).where(eq(sessions.taskId, taskId));

  // 顺序 ①：通知正握着锁往下走（资格 SELECT 已经读到 idle、结果还没交回调用方，正是
  // 审查那个可控暂停的位置）→ 用户的完成操作必须被挡回，一个字都不许写库。
  // 这里让闸返回一个理由收尾，纯粹是为了不真去开调度台；要钉的是上面那个 409。
  {
    const taskId = await makeTask({ mode: "team", status: "idle" });
    let patched = 0;
    const ran = await continueTask(taskId, "【哨兵事件】TEAM_OUTPUT_AFTER_DONE", {
      byBackend: true,
      wakeGuard: async () => {
        patched = (await markDone(taskId)).status;
        return "就到这儿，别真开台";
      },
    });
    assert.equal(patched, 409, "通知正在送的时候完成操作不能放行——放行了就是上面那条链");
    assert.equal(await statusOf(taskId), "idle", "被挡回就一个字都不许写库");
    assert.equal(ran, false);
    assert.equal((await sessionsOf(taskId)).length, 0, "被闸挡下的通知不许开台");
    assert.equal(runs.isTurnClaimed(taskId), false, "拒绝那条路也得把锁还回去");
    assert.equal((await markDone(taskId)).status, 200, "放开之后照样标得完成");
  }

  // 顺序 ②：完成操作先成功 → 这条通知既不许开台，也不许被记成已发送。
  {
    const taskId = await makeTask({ mode: "team", status: "idle" });
    const started = await startMonitor({
      taskId,
      command: `${JSON.stringify(process.execPath)} -e 'setInterval(() => {}, 1000);'`,
      description: "团队任务完成之后",
    });
    assert.equal(started.ok, true);
    const monitorId = started.ok ? started.monitor.id : "";
    // 事件那一行手造（来源标记用生产那一份 `monitorMessageOrigin`）：团队任务的推送出口
    // 会**当场**触发投递（调度台正说话也接得住），真让哨兵吐一行就攒不住「先排一条、再标
    // 完成」这个现场。推送那一侧的终态判据由 ⑮⑯ 覆盖，这里要观察的是投递那一侧。
    const row = await pending.enqueueMessage({
      taskId,
      text: "【哨兵事件】TEAM_OUTPUT_AFTER_DONE",
      origin: monitorMessageOrigin(monitorId),
    });

    assert.equal((await markDone(taskId)).status, 200);
    assert.equal((await getMonitor(monitorId))?.status, "stopped", "任务结束,哨兵一并收回");

    // 租约已经在手、完成操作刚成功的那一刻：真实的那道闸(生产的 monitorWakeGuard)必须
    // 说不，装法与两条投递分支逐字一致（`refused` 非空 = 调用方把消息取消掉）。
    const guard = pending.monitorWakeGuard(row);
    assert.ok(guard, "哨兵来源的消息必须带着这道闸");
    let refused: string | null = null;
    const woke = await continueTask(taskId, row.text, {
      byBackend: true,
      wakeGuard: async () => (refused = await guard()),
    });
    assert.equal(woke, false, "已经结束的任务不许被一条在途通知重新开台");
    assert.match(refused ?? "", /任务已经结束/, "这是明确拒绝,调用方据此取消消息而不是重投");
    assert.equal((await sessionsOf(taskId)).length, 0, "不得新增 lead 会话");
    assert.equal(await statusOf(taskId), "done", "也不许把 done 改回 running/idle");

    // 生产链路自己也会把它作废(终态钩子 → flushPendingForTask → 出口那道闸)。
    await until("那条通知按终态作废", async () => {
      const after = (await db.select().from(scheduledMessages).where(eq(scheduledMessages.id, row.id))).at(0);
      return after?.status === "canceled";
    });
    assert.equal((await sessionsOf(taskId)).length, 0, "作废的路上同样不许开台");
  }

  // 锁要覆盖到**真正写进 stdin 那一刻**，不是只盖住那一问：所以释放必须在 finally 里。
  const orchSrc = readSource(join(HERE, "../src/orchestrator.ts"));
  assert.match(orchSrc, /\} finally \{\n      releaseLead\(\);\n    \}/,
    "deliverToLead 抛错那条出路也得把锁还回去,否则这个任务的状态从此改不动");
  console.log("✓ 团队任务:完成操作与哨兵通知互斥,两种顺序都不开台、不记已发送");
}

// ── ㉒ 团队资格读失败一次 ≠ 调度台不可用 ──────────────────────────────────────
// 团队那一侧原来是直接 `await opts.wakeGuard()`：读错误顺着抛出去，投递那边的 catch 按
// 「调度台不可用」**无条件取消**消息 —— 一次数据库抖动就永久销毁一条进展，而哨兵的读取
// 游标早就推过去了，同一行不会再生成第二次（第 6 轮审查实测：只拒一次资格 SELECT，消息
// 当场 canceled，恢复并等过投递冷却也不再补送）。
{
  const taskId = await makeTask({ mode: "team", status: "idle" });
  const started = await startMonitor({
    taskId,
    command: `${JSON.stringify(process.execPath)} -e 'setInterval(() => {}, 1000);'`,
    description: "团队任务:资格读失败",
  });
  assert.equal(started.ok, true);
  // 同 ㉑ 顺序②：团队任务上的推送会当场触发投递，所以那一行手造（来源标记同生产），
  // 下面走的是真实的投递扫描 —— 租约、那道闸、挡回后的处置全是生产代码。
  const row = await pending.enqueueMessage({
    taskId,
    text: "【哨兵事件】TEAM_GUARD_READ_FAILURE",
    origin: monitorMessageOrigin(started.ok ? started.monitor.id : ""),
  });

  // 只拒**那一问**：投递链路里按 `{status, archived}` 两字段投影读 tasks 的只有它
  // （`monitorWakeGuard`）。拒一次就恢复；要是被别处消费掉了，下面的断言会整段失败而
  // 不是悄悄变成空测。
  const realSelect = db.select.bind(db);
  let armed = true;
  (db as unknown as { select: unknown }).select = (...args: unknown[]) => {
    const projection = args[0] as Record<string, unknown> | undefined;
    if (armed && projection && "status" in projection && "archived" in projection
      && Object.keys(projection).length === 2) {
      armed = false;
      throw new Error("INJECTED_TEAM_DATABASE_READ_FAILURE");
    }
    return (realSelect as (...a: unknown[]) => unknown)(...args);
  };
  try {
    await pending.deliverPendingMessages(taskId);
  } finally {
    (db as unknown as { select: unknown }).select = realSelect;
  }
  assert.equal(armed, false, "这一轮压根没问到那道闸,下面的断言就不成立了");

  const after = (await db.select().from(scheduledMessages).where(eq(scheduledMessages.id, row.id))).at(0)!;
  assert.equal(after.status, "pending", "一次读故障不该让一条进展永久消失——宁可晚发,不能不发");
  assert.equal(after.deliveringSince, null, "租约必须还回去,不然没人再碰它");
  assert.equal((await db.select().from(sessions).where(eq(sessions.taskId, taskId))).length, 0,
    "读不到状态就不该开台");
  assert.equal(runs.isTurnClaimed(taskId), false, "唤醒锁也要还");

  // 恢复之后它仍然是「该送」的那一条，而且全程只有这一条：补送走的是同一行。
  const task = (await db.select().from(tasks).where(eq(tasks.id, taskId))).at(0)!;
  assert.equal(
    pending.deliveryVerdict(
      { mode: after.mode, sendAt: after.sendAt, origin: after.origin },
      { mode: task.mode, status: task.status, archived: !!task.archived },
      new Date(),
    ).action,
    "deliver",
    "库一恢复,这条通知就该重新进入投递 —— 取消掉的那种永远等不到了",
  );
  assert.equal((await db.select().from(scheduledMessages).where(eq(scheduledMessages.taskId, taskId))).length, 1,
    "只有这一条:哨兵的游标已经推过去了,系统不会再补生成一条");
  console.log("✓ 团队资格读失败一次:消息留在托盘等重投,不当场销毁");
}

await teardown();
console.log("✓ 哨兵终态与投递：连坐作废 / 合并与投递抢同一行 / 入口出口同源 / 迟到事件 / 收尾那一瞬的创建 / 租约不等于送达 / 读失败不锁死 / 完成与起跑互斥 / 团队那条路同样互斥且读失败不销毁 均受回归保护");
