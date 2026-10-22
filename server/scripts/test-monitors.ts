// 哨兵（Monitor）这个功能本身的回归：起、推、合并、停、回看、闸、跨重启接管。
// 「终态与投递抢同一条命」的那几个窗口在 test-monitor-races.ts（台子同一份，见
// monitors-fixture.ts）。钉住的是这个功能全部的立论，一条都不能松：
//
//  ① 命令吐一行 → 变成这个任务名下一条待发送消息（`origin` 标着是谁推的）
//  ② 任务忙的时候攒下的多批事件**合并进同一行**，而不是一行一个回合（这是花钱的闸）
//  ③ 命令自己跑完 → 落 exited，并推一条收尾事件
//  ④ 任务落终态 → 名下哨兵一并停掉，**而且不回推收尾事件**（否则等于把 done 的任务叫醒）
//  ⑤ 停掉哨兵 = 进程真的死了（不是只改数据库）
//  ⑥ 面板能回看它的原始输出：事件正文里被略去的行（单批超限、合并超长）只剩日志里有
//  ⑦ 四道闸真的挡得住：并发创建不绕过每任务上限、坏参数不留下无主进程
//  ⑧ 位置只在事件落库之后才前进（先走位置再推消息 = 重启那一下静默吞掉几行）
//  ⑩ server 重启：另起一个进程把 ash 杀掉后，哨兵进程仍活着，新进程按 pid + offset
//     接回来，重启期间产出的行一条不漏 —— 这是整件事相对「挂在会话上的后台进程」的
//     全部增量，也是本测试最该守住的一条
//  ⑪ 命令在停服期间就跑完了：重启时那条「进程已经不在」的路同样要补读它留下的输出
//  ⑫ 起不来只失败这一条请求：坏 cwd 不许把 ash 自己的进程组 SIGTERM 掉
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { appendFileSync, chmodSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import {
  MONITOR_MAX_EVENTS, MONITOR_MAX_MERGED_CHARS, MONITOR_MAX_PER_TASK, MONITOR_TAIL_MAX_BYTES,
} from "@ash/shared/monitor";
import { readSource } from "../../scripts/read-source.mjs";
import {
  HERE, root, db, dbClient, schema, monitorsModule, status, isPidAlive,
  startMonitor, stopMonitor, listMonitors, getMonitor, readMonitorTail, reattachMonitors, detachAllMonitors,
  monitors, projects, tasks,
  sleep, until, now, makeTask, insertMonitorRow, pendingOf, teardown,
} from "./monitors-fixture.js";

// ── ①②③ 推事件、合并、自己跑完 ───────────────────────────────────────────────
{
  const taskId = await makeTask();
  const beat = join(root, "beat.mjs");
  // 三行，彼此隔开 600ms（> MONITOR_BATCH_MS），逼出三批而不是一批。
  writeFileSync(beat, `let i = 0;
const t = setInterval(() => { i++; console.log("第 " + i + " 轮完成"); if (i >= 3) { clearInterval(t); process.exit(0); } }, 600);
`);
  const started = await startMonitor({
    taskId,
    command: `${JSON.stringify(process.execPath)} ${JSON.stringify(beat)}`,
    description: "盯三轮",
  });
  assert.equal(started.ok, true, started.ok ? "" : started.error);
  const monitorId = started.ok ? started.monitor.id : "";

  await until("三行事件都推出来", async () => {
    const row = (await db.select().from(monitors).where(eq(monitors.id, monitorId))).at(0);
    return (row?.events ?? 0) >= 3;
  });

  // ② 三批事件只占一行待发送消息 —— 任务此刻在 paused、投递链路要等它被 flush，
  //    在那之前新事件一律合并进同一行。
  const rows = await pendingOf(taskId);
  assert.equal(rows.length, 1, `三批事件应合并成一条待发送消息，实际 ${rows.length} 条`);
  assert.equal(rows[0]!.origin, `monitor:${monitorId}`, "待发送消息要标明是哪个哨兵推的");
  for (const n of ["第 1 轮完成", "第 2 轮完成", "第 3 轮完成"]) {
    assert.ok(rows[0]!.text.includes(n), `合并后的正文里少了「${n}」：${rows[0]!.text}`);
  }

  // ③ 命令自己跑完 → exited + 一条收尾事件（合并进同一行）。
  await until("哨兵落 exited", async () => {
    const row = (await db.select().from(monitors).where(eq(monitors.id, monitorId))).at(0);
    return row?.status === "exited";
  });
  const after = (await db.select().from(monitors).where(eq(monitors.id, monitorId))).at(0)!;
  assert.equal(after.exitCode, 0, "命令退出码应被记下来");
  const settled = await pendingOf(taskId);
  assert.ok(settled[0]!.text.includes("【哨兵结束】"), "命令自己跑完要告诉 agent 一声");
  // 那条通知里要带上**推了几条**（用户 2026-10-21 要的那半件事）：agent 读到的只有这一句，
  // 光一个结束原因的话，它分不出「哨兵哑了」和「我漏读了几条」，只能靠猜。
  assert.match(settled[0]!.text, /共推送 3 条事件/, "结束通知里要报出推了几条");
  console.log("✓ 推事件 / 多批合并成一次唤醒 / 自己跑完落 exited / 收尾报出事件数");
}
// ── ③b 零输出:一个字都没吐就跑完了,那条通知必须**当场**把这件事说出来 ──────────
// 这正是用户看到的那一幕:哨兵盯满/跑完,agent 只拿到一句结束原因,于是把「它什么都没说」
// 读成「它说了而我没收到」。措辞归 `monitorEventTally`(只说推了几条 + 日志多大,一个字
// 不提它等的条件),这一节钉住它真的出现在**送给 agent 的那条通知**里,而不是只进时间线。
{
  const taskId = await makeTask();
  const started = await startMonitor({ taskId, command: "exit 0", description: "一个字都不吐" });
  assert.equal(started.ok, true, started.ok ? "" : started.error);
  const monitorId = started.ok ? started.monitor.id : "";
  await until("哨兵落 exited", async () => (await getMonitor(monitorId))?.status === "exited");
  const [notice] = await pendingOf(taskId);
  assert.ok(notice, "零输出也要推一条结束通知,不然这条哨兵从头到尾一声不响");
  assert.match(notice!.text, /一条事件都没推/, "零输出要当面说清");
  assert.match(notice!.text, /日志文件也是空的/, "没产出过这件事也要如实说");
  assert.doesNotMatch(notice!.text, /条件/, "不许从没有输出推断它等的业务条件没满足");
  console.log("✓ 零输出的哨兵:结束通知里如实报「一条都没推、日志也是空的」");
}
// ── ⑦d 这一批行没写成，**结束条件照旧算得出来**（第 1 轮审查 F2）────────────────────
// 缓冲是这几行唯一的在内存副本：`splice` 之后 tail 自己的读取位置已经越过去了。上一版把
// 「命中没有」排在通知入队之后，于是那一笔 INSERT 失败一次，这一批里那条 `DONE` 就此蒸发 ——
// 命令后面再没有输出，这条哨兵永远不收工，只能干等到期（审查实测：恢复库之后又等 2 秒仍是
// running，只有把运行时撤了重接、从持久位置重放才认出来）。
// 这一节用真进程、真日志、真库跑一遍：只让那一次通知 INSERT 失败，**不改任何查询结果**。
{
  const taskId = await makeTask();
  const feed = join(root, "once.mjs");
  // 吐一行约定的字样就不再出声（但活着）：没有「后面还会来行」这个救命稻草，才测得出
  // 「那一批被丢掉」和「那一批被放回去重试」的区别。
  writeFileSync(feed, `setTimeout(() => console.log("DONE 全跑完了"), 150);
setInterval(() => {}, 1000);
`);
  // 只打哨兵事件那一条 INSERT，而且只打一次。
  const real = dbClient.execute.bind(dbClient);
  let injected = 0;
  (dbClient as unknown as { execute: unknown }).execute = async (stmt: unknown) => {
    const text = typeof stmt === "string" ? stmt : String((stmt as { sql?: unknown })?.sql ?? "");
    if (injected === 0 && /insert into "scheduled_messages"/i.test(text)) {
      injected += 1;
      throw new Error("INJECTED_MESSAGE_INSERT_FAILURE");
    }
    return real(stmt as never);
  };
  let started: Awaited<ReturnType<typeof startMonitor>>;
  try {
    started = await startMonitor({
      taskId,
      command: `${JSON.stringify(process.execPath)} ${JSON.stringify(feed)}`,
      description: "命中那一行撞上一次写失败",
      stopWhen: "^DONE",
    });
    assert.equal(started.ok, true, started.ok ? "" : started.error);
    const monitorId = started.ok ? started.monitor.id : "";
    // 等到那一次失败真的发生过，再把库放回去 —— 之后**不再有任何新输出**。
    await until("注入的那一次写失败已经发生", async () => injected > 0);
    (dbClient as unknown as { execute: unknown }).execute = real;
    // 不撤运行时、不重启、不喂新行：光靠重试就要收工。
    await until("放回去的那一批重试之后照旧收工", async () => (await getMonitor(monitorId))?.status === "matched");
    const [queued] = await pendingOf(taskId);
    assert.ok(queued, "重试要把那一批真的送出去，不是跳过它直接收工");
    assert.ok(queued!.text.includes("DONE 全跑完了"), `命中的那一行一个字都不能丢：${queued?.text}`);
    const row = (await db.select().from(monitors).where(eq(monitors.id, monitorId))).at(0)!;
    assert.match(row.endedReason ?? "", /等到了约定的那一行/, "结局是「等到了」，不是到期");
    assert.ok(row.offset > 0, "重试成功之后读取位置才前进");
    if (started.ok) await until("进程被收掉", async () => !isPidAlive(started.ok ? started.monitor.pid! : 0));
  } finally {
    (dbClient as unknown as { execute: unknown }).execute = real;
  }
  console.log("✓ 一批行写失败：原样放回缓冲重试，命中照旧算得出来、那一行照旧送达");
}
// ── ⑦e 收尾那一批写失败 ⇒ **不许当它送过了**（第 2 轮审查 F1-A）────────────────────
// 现场：命令自己跑完（`FINAL_DONE` 是最后一行），那一批的通知 INSERT 失败一次。上一版
// 「推一次、成不成都不管」(`.catch(() => {})`)，而放回缓冲那一步在 `closing` 之下排不上
// 重试 —— 于是这几行就地蒸发，终态、结束通知、回收责任照旧一路写下去（审查实测
// status=exited、events=0、offset=0、待发里只有【哨兵结束】、FINAL_DONE 一个字都没到）。
// 接回那条路也捡不回来：它只枚举 running。
//
// 注入按**消息正文**挑，不按次数挑：【哨兵事件】那一笔一律失败、【哨兵结束】那一笔放过去。
// 于是「那一批只能跟着收尾走」这件事与时序无关 —— 不靠「恰好没来得及正常推一次」。
{
  const taskId = await makeTask();
  const feed = join(root, "final.mjs");
  writeFileSync(feed, `setTimeout(() => { console.log("FINAL_DONE 最后一行"); process.exit(0); }, 150);\n`);
  const real = dbClient.execute.bind(dbClient);
  let blocked = 0;
  (dbClient as unknown as { execute: unknown }).execute = async (stmt: unknown) => {
    const text = typeof stmt === "string" ? stmt : String((stmt as { sql?: unknown })?.sql ?? "");
    const args = JSON.stringify((stmt as { args?: unknown })?.args ?? "");
    if (/insert into "scheduled_messages"/i.test(text) && args.includes("【哨兵事件】")) {
      blocked += 1;
      throw new Error("INJECTED_EVENT_INSERT_FAILURE");
    }
    return real(stmt as never);
  };
  let monitorId = "";
  try {
    const started = await startMonitor({
      taskId,
      command: `${JSON.stringify(process.execPath)} ${JSON.stringify(feed)}`,
      description: "最后一批撞上写失败",
    });
    assert.equal(started.ok, true, started.ok ? "" : started.error);
    monitorId = started.ok ? started.monitor.id : "";
    await until("命令自己跑完、收尾走完", async () => (await getMonitor(monitorId))?.status === "exited");
    await until("那一批跟着收尾送出来了", async () =>
      (await pendingOf(taskId)).some((m) => m.text.includes("FINAL_DONE")));
  } finally {
    (dbClient as unknown as { execute: unknown }).execute = real;
  }
  assert.ok(blocked > 0, "这一节要的就是那几笔事件 INSERT 真的失败过（注入没生效的话下面全是空测）");
  const texts = (await pendingOf(taskId)).map((m) => m.text).join("\n");
  assert.match(texts, /FINAL_DONE/, "没能单独送出的那一批必须跟着结束通知走，不许就地蒸发");
  assert.match(texts, /没能单独送出来/, "要说清这几行是从哪来的（人和 agent 都要分得出）");
  assert.equal(
    texts.split("【哨兵结束】").length - 1, 1,
    "收尾只说一条：附在里面的那几行不许再套一层【哨兵事件】抬头（同一个 monitorId 说两遍）",
  );
  const row = (await db.select().from(monitors).where(eq(monitors.id, monitorId))).at(0)!;
  assert.equal(row.offset, 0, "没单独送成的行不许推进读取位置——日志里的原文还要对得上");
  assert.equal(row.resultHandoffAt, null, "通知已经入队 ⇒ 那笔交接凭证销掉");
  console.log("✓ 收尾那一批写失败：附在结束通知里一起落库交接，游标不动，完成闸看得见");
}
// ── ⑦f 一批行有上界：18 万行一口气来也不许把放回那一步撑爆（第 2 轮审查 F1-B）───────
// 上一版放回缓冲是 `rt.buffer.unshift(...lines)` —— 展开传参按参数个数吃栈，18 万行就是一次
// `RangeError`，而排重试那一句排在它后面：连重试都排不上，哨兵就那么挂着（审查实测
// events=0、待发队列空、状态 running）。现在批次本身有上界，拼接也不展开。
{
  const taskId = await makeTask();
  const feed = join(root, "flood.mjs");
  writeFileSync(feed, `for (let i = 0; i < 180000; i++) console.log("flood " + i);\nsetInterval(() => {}, 1000);\n`);
  const started = await startMonitor({
    taskId,
    command: `${JSON.stringify(process.execPath)} ${JSON.stringify(feed)}`,
    description: "一口气吐 18 万行",
  });
  assert.equal(started.ok, true, started.ok ? "" : started.error);
  const monitorId = started.ok ? started.monitor.id : "";
  // 第一批就把事件上限顶满 ⇒ 自动停。要的是「没崩、而且吃进去的那一批有上界」。
  await until("推满上限自动停", async () => (await getMonitor(monitorId))?.status === "stopped", 30_000);
  const texts = (await pendingOf(taskId)).map((m) => m.text).join("\n");
  assert.match(texts, /这一批共 2000 行/, "一批有上界：不是把 18 万行整批渲染成一条消息");
  assert.match((await getMonitor(monitorId))?.endedReason ?? "", /推够了/, "到顶是停，不是静默继续");
  if (started.ok) await until("进程被收掉", async () => !isPidAlive(started.ok ? started.monitor.pid! : 0));
  console.log("✓ 一批行有上界：18 万行一口气来也只按批消费，放回那一步不展开传参");
}
// ── ⑦i 在途/失败的那一批没交付 ⇒ 后面的空行不许把读取位置带过去（第 3 轮审查 F1）──────
// 现场（审查实测）：命令打完 `FINAL_OFFSET=0` 就睡；那一笔事件 INSERT 挂住 ⇒ 这一批已经被
// `splice` 出缓冲、一个字节都还没落库；这期间日志里多了个空行，tail 回调看到「缓冲是空的」
// 就把一个**无条件**的 offset 提交排进队列；随后那笔 INSERT 失败、行回到缓冲等两秒后重试,
// 而排在后面的空行提交成功了 —— 游标走到日志结尾（offset=16、events=0、消息从未入队）。
// 这时重启接回从那个位置开始读，那一行再也读不回来，运行时内存又已经清掉 ⇒ 永久丢失。
//
// 判据因此挪进消费层并**在提交的那一刻现算**（见 monitor-consume.ts 文件头 ④）：排队那一刻
// 和真正提交之间隔着一整笔推送，时序只能在提交那一刻判。
{
  const taskId = await makeTask();
  const feed = join(root, "offsetrace.mjs");
  // 吐一行就睡：后面没有新行，「那一批被跳过去」和「被放回去重试」才区别得出来。
  // 30 秒自毁兜底（同 ⑦g 那一节的理由：这一节也要在失败注入下走真实收尾）。
  writeFileSync(feed, `setTimeout(() => console.log("FINAL_OFFSET=0"), 120);
const keep = setInterval(() => {}, 1000);
setTimeout(() => { clearInterval(keep); process.exit(0); }, 30000);
`);
  const real = dbClient.execute.bind(dbClient);
  let hanging = false;
  let failNow: (() => void) | null = null;
  const held = new Promise<never>((_, reject) => {
    failNow = () => reject(new Error("INJECTED_EVENT_INSERT_FAILURE"));
  });
  void held.catch(() => {});   // 只许在 `await` 那一处抛,别变成 unhandled rejection
  let injected = 0;
  (dbClient as unknown as { execute: unknown }).execute = async (stmt: unknown) => {
    const text = typeof stmt === "string" ? stmt : String((stmt as { sql?: unknown })?.sql ?? "");
    const args = JSON.stringify((stmt as { args?: unknown })?.args ?? "");
    if (injected === 0 && /insert into "scheduled_messages"/i.test(text) && args.includes("FINAL_OFFSET=0")) {
      injected += 1;
      hanging = true;
      await held;              // 挂住:这一刻那一批「在途」—— 不在缓冲里,也还没落库
    }
    return real(stmt as never);
  };
  let monitorId = "";
  let pid = 0;
  try {
    const started = await startMonitor({
      taskId,
      command: `${JSON.stringify(process.execPath)} ${JSON.stringify(feed)}`,
      description: "在途批次撞上空行快进",
    });
    assert.equal(started.ok, true, started.ok ? "" : started.error);
    monitorId = started.ok ? started.monitor.id : "";
    pid = started.ok ? started.monitor.pid ?? 0 : 0;
    await until("那一笔事件 INSERT 真的挂住了", async () => hanging);
    // **判据的第二项单独验一次**:这一刻那一批既不在缓冲里、也还没落库。上面那条路（空行
    // 快进）走的是这条哨兵自己的队列,于是它总排在这笔推送**之后** —— 真正要防的是「哪天
    // 又多一个不走队列的进度写入口」，所以这里直接调那个函数，不借队列的顺序。
    assert.equal(
      await monitorsModule.commitProgress(monitorId, 999), false,
      "在途的那一批没落库 ⇒ 任何进度写入口都不许推游标（不光是排在队列里的那一个）",
    );
    const logPath = (await db.select().from(monitors).where(eq(monitors.id, monitorId))).at(0)!.logPath;
    assert.equal(
      (await db.select().from(monitors).where(eq(monitors.id, monitorId))).at(0)!.offset, 0,
      "……而且真的一个字节都没写进去",
    );
    // 在途期间追加一个空行：下一次 tail 回调看到的就是「缓冲是空的」。
    appendFileSync(logPath, "\n");
    await sleep(900);          // TAIL_POLL_MS=250:够那一拍把空行快进排进队列
    failNow!();                // 这一笔失败 ⇒ 那一批放回缓冲、排两秒后重试
    await sleep(700);          // 远小于 MONITOR_RETRY_FLUSH_MS，重试还没发生
    const mid = (await db.select().from(monitors).where(eq(monitors.id, monitorId))).at(0)!;
    assert.equal(mid.events, 0, "台子前提：这一刻一个字都还没交付（注入没生效的话下面全是空测）");
    assert.equal(
      mid.offset, 0,
      `没交付的那一批在场时，空行一个字节都不许把游标带过去（实际 offset=${mid.offset}）`,
    );
    assert.match(readFileSync(logPath, "utf8"), /FINAL_OFFSET=0/, "日志里那一行还在：游标没越过它，重启就还读得回来");
    await until("重试把那一批真的送出去", async () =>
      (await pendingOf(taskId)).some((m) => m.text.includes("FINAL_OFFSET=0")));
    const after = (await db.select().from(monitors).where(eq(monitors.id, monitorId))).at(0)!;
    assert.ok(after.offset > 0, "交付之后游标才跟着前进");
  } finally {
    (dbClient as unknown as { execute: unknown }).execute = real;
  }
  assert.ok(injected > 0, "注入必须真的发生过");
  await stopMonitor(monitorId, "F1 那一节跑完了");
  if (pid) await until("进程被收掉", async () => !isPidAlive(pid));
  console.log("✓ 空行快进要看消费责任：在途/失败的批次在场时游标不动，重试成功之后才前进");
}
// ── ⑦j 离线补读也要留住**命中那一行**（第 3 轮审查 N1）──────────────────────────────
// 命中那一行多半就是 agent 要的结果本身，而正文只列前 40 行。上一版「保留它」是 `pushLines`
// 的一个可选参数：在线两处都传了、离线补读那一处没传 —— 于是重启之后补读出来的那一批里，
// 排在第 41 行往后的结束结果照旧被正文省掉。可选参数的默认值就是「忘了传」那条路，所以
// 这一版把它做成正文构造层的默认契约（`linesBody` 自己算）。
{
  const taskId = await makeTask();
  const monitorId = await insertMonitorRow(taskId, { status: "running" });
  await db.update(monitors).set({ stopWhen: "^OFFLINE_RESULT=" }).where(eq(monitors.id, monitorId));
  const seeded = (await db.select().from(monitors).where(eq(monitors.id, monitorId))).at(0)!;
  // 60 行，命中那一行排在第 50 —— 正文只列前 40 行，它必须被单独补上。
  const lines = Array.from({ length: 60 }, (_, i) => (i === 49 ? "OFFLINE_RESULT=0 全跑完了" : `noise ${i}`));
  writeFileSync(seeded.logPath, `${lines.join("\n")}\n`);
  const { finishOffline } = await import("../src/monitor-offline-finish.js");
  await finishOffline(seeded, "lost", "命令已经不在了（server 重启期间跑完的，拿不到退出码）");
  const texts = (await pendingOf(taskId)).map((m) => m.text).join("\n");
  assert.match(texts, /约定的那一行在后面/, "离线补读也要把命中那一行单独补上");
  assert.match(texts, /OFFLINE_RESULT=0 全跑完了/, "补上的就是那一行原文");
  assert.match(texts, /这一批共 60 行/, "台子前提：这一批确实超过了正文的行数上限");
  // **补读到的命中要折进那个结局**（新一轮审查 N1 实测:正文补送成功、`events=1`,而卡片上
  // 写的仍是「进程已经不在了」而不是「等到了约定的那一行」）—— 同一份证据不许两种说法。
  const folded = (await db.select().from(monitors).where(eq(monitors.id, monitorId))).at(0)!;
  assert.equal(folded.status, "matched", `补读到约定的那一行 ⇒ 标签跟在线那一侧同一个（实际 ${folded.status}）`);
  assert.match(folded.endedReason ?? "", /等到了约定的那一行/, "结局要说出它是怎么收的");
  assert.match(folded.endedReason ?? "", /OFFLINE_RESULT=0/, "命中那一行要写进结局");
  // **「进程为什么没了」那句话不许被抹掉**:ash 不在的时候它是跑完了、被杀了还是机器重启了,
  // 只有传进来的那句话答得出来;退出码这一路从来就拿不到。
  assert.match(folded.endedReason ?? "", /拿不到退出码/, "原来那句话要原样接在后面，不是换掉");
  assert.equal(folded.exitCode, null, "不许拿命中去冒充一次正常退出");
  assert.match(texts, /等到了约定的那一行/, "结束通知跟库里那句话同源");
  console.log("✓ 离线补读继承命中行保留契约：排在第 41 行往后的结束结果照旧送到，命中也折进结局");
}
// ── ⑦k 反面:补读出来的那几行**没有**命中 ⇒ 结局照旧是「它已经不在了」（新一轮审查 N1）───
// 上一节那一道只能证明「命中时会折」,证不出「不命中时不会乱折」—— 少了这一条，把折叠写成
// 无条件的也照旧绿。
{
  const taskId = await makeTask();
  const monitorId = await insertMonitorRow(taskId, { status: "running" });
  await db.update(monitors).set({ stopWhen: "^OFFLINE_RESULT=" }).where(eq(monitors.id, monitorId));
  const seeded = (await db.select().from(monitors).where(eq(monitors.id, monitorId))).at(0)!;
  writeFileSync(seeded.logPath, "noise 1\nnoise 2\n");
  const { finishOffline } = await import("../src/monitor-offline-finish.js");
  await finishOffline(seeded, "lost", "命令已经不在了（server 重启期间跑完的，拿不到退出码）");
  const row = (await db.select().from(monitors).where(eq(monitors.id, monitorId))).at(0)!;
  assert.equal(row.status, "lost", `没命中就不许说成命中（实际 ${row.status}）`);
  assert.doesNotMatch(row.endedReason ?? "", /等到了约定的那一行/, "没等到就别说等到了");
  // **只折「它已经不在了」这一档**:别的终态是更确定的事实,不许被一行日志改写。
  const other = await insertMonitorRow(taskId, { status: "running" });
  await db.update(monitors).set({ stopWhen: "^OFFLINE_RESULT=" }).where(eq(monitors.id, other));
  const otherRow = (await db.select().from(monitors).where(eq(monitors.id, other))).at(0)!;
  writeFileSync(otherRow.logPath, "OFFLINE_RESULT=0 全跑完了\n");
  await finishOffline(otherRow, "expired", "盯满了约定的时长");
  const expired = (await db.select().from(monitors).where(eq(monitors.id, other))).at(0)!;
  assert.equal(expired.status, "expired", `传进来的终态更确定时不许折（实际 ${expired.status}）`);
  console.log("✓ 离线补读没命中时结局照旧是「它已经不在了」：折叠认的是证据，不是无条件");
}
// ── 事件上限：推满自动停，而且**不会把自己锁死** ─────────────────────────────
// 这一条同时守两件事：到顶要真的停（每条事件都在烧回合），以及收尾必须能跑完 ——
// 触发点在推送队列**内部**，收尾又要往同一条队列再排一次 flush，await 它就是等自己
// 后面那一位，当场死锁（任务永远停不下来，而且一个字的日志都不会留）。
{
  const taskId = await makeTask();
  const flood = join(root, "flood.mjs");
  writeFileSync(flood, `for (let i = 1; i <= ${MONITOR_MAX_EVENTS + 20}; i++) console.log("line " + i);
setInterval(() => {}, 1000); // 吐完不退出：停下来必须是「到顶了」，不能是「它自己跑完了」
`);
  const started = await startMonitor({
    taskId,
    command: `${JSON.stringify(process.execPath)} ${JSON.stringify(flood)}`,
    description: "刷屏的哨兵",
  });
  assert.equal(started.ok, true, started.ok ? "" : started.error);
  const monitorId = started.ok ? started.monitor.id : "";
  const pid = started.ok ? started.monitor.pid! : 0;

  await until("推满上限后自动停", async () => {
    const row = (await db.select().from(monitors).where(eq(monitors.id, monitorId))).at(0);
    return row?.status === "stopped";
  });
  const row = (await db.select().from(monitors).where(eq(monitors.id, monitorId))).at(0)!;
  assert.ok(row.events >= MONITOR_MAX_EVENTS, `到顶时应记满事件数，实际 ${row.events}`);
  assert.match(row.endedReason ?? "", /白烧回合/, "停掉的理由要讲清楚为什么");
  await until("刷屏的进程被杀掉", async () => !isPidAlive(pid));

  const [queued] = await pendingOf(taskId);
  assert.ok(queued, "到顶那一下要留一条消息告诉 agent 哨兵停了");
  assert.ok(queued!.text.includes("【哨兵结束】"), "收尾事件必须送到");
  assert.ok(
    queued!.text.length <= MONITOR_MAX_MERGED_CHARS + 200,
    `合并正文要封顶，实际 ${queued!.text.length} 字符`,
  );
  console.log("✓ 事件推满自动停、进程被杀、收尾消息送达，合并正文有上限");
}
// ── ④ 任务落终态 → 连坐停掉，且不回推 ────────────────────────────────────────
{
  const taskId = await makeTask();
  const started = await startMonitor({
    taskId,
    command: `${JSON.stringify(process.execPath)} -e "setInterval(() => {}, 1000)"`,
    description: "空转",
  });
  assert.equal(started.ok, true);
  const monitorId = started.ok ? started.monitor.id : "";
  const pid = started.ok ? started.monitor.pid! : 0;

  await status.setTaskStatus(taskId, "done");
  await until("任务 done 后哨兵被收走", async () => {
    const row = (await db.select().from(monitors).where(eq(monitors.id, monitorId))).at(0);
    return row?.status === "stopped";
  });
  await until("进程真的死了", async () => !isPidAlive(pid));
  const leftovers = await pendingOf(taskId);
  assert.equal(leftovers.length, 0, "任务都 done 了，绝不能再推一条消息把它叫醒");
  console.log("✓ 任务落终态连坐停哨兵，且不回推唤醒");
}
// ── ⑤ 主动停 = 进程真的死 ────────────────────────────────────────────────────
{
  const taskId = await makeTask();
  const started = await startMonitor({
    taskId,
    command: `${JSON.stringify(process.execPath)} -e "setInterval(() => {}, 1000)"`,
    description: "等着被停",
  });
  assert.equal(started.ok, true);
  const monitorId = started.ok ? started.monitor.id : "";
  const pid = started.ok ? started.monitor.pid! : 0;
  assert.ok(isPidAlive(pid), "刚起来的哨兵进程应该活着");

  const stopped = await stopMonitor(monitorId, "测试主动停");
  assert.equal(stopped?.status, "stopped");
  await until("停掉后进程真的不在了", async () => !isPidAlive(pid));
  const listed = await listMonitors(taskId);
  assert.equal(listed.length, 1);
  assert.equal(listed[0]!.endedReason, "测试主动停");
  console.log("✓ 停哨兵 = 杀进程，不是只改数据库");
}
// ── ⑥ 日志尾巴：面板要能回看它到底吐了什么 ───────────────────────────────────
// 只有事件数的话，「0 条事件」既可能是命令还没开始吐，也可能是过滤条件写错了把什么都
// 滤没了——这两件事的处理方式相反，不看原始输出分不出来。
{
  const taskId = await makeTask();
  // 不用模板串：命令整句要过一次用户 shell，反引号在那儿是命令替换。
  const script = 'for (let i = 1; i <= 7; i++) console.log("line-" + i);';
  const started = await startMonitor({
    taskId,
    command: `${JSON.stringify(process.execPath)} -e ${JSON.stringify(script)}`,
    description: "吐七行就走",
  });
  assert.equal(started.ok, true);
  const monitorId = started.ok ? started.monitor.id : "";
  await until("七行都落到日志里", async () => ((await readMonitorTail(monitorId))?.lines.length ?? 0) >= 7);

  const all = (await readMonitorTail(monitorId))!;
  assert.deepEqual(all.lines.slice(0, 7), ["line-1", "line-2", "line-3", "line-4", "line-5", "line-6", "line-7"]);
  assert.equal(all.truncated, false, "没超上限就不该说自己被截断过");

  // 要看的永远是最后几行：几小时的日志里，最新那截才是「它现在怎么样了」。
  const tail = (await readMonitorTail(monitorId, 3))!;
  assert.deepEqual(tail.lines, ["line-5", "line-6", "line-7"], "限行数时留的必须是最后几行");
  assert.equal(tail.truncated, true, "截过就要如实说，别让人以为这就是全部");

  assert.equal(await readMonitorTail("no-such-monitor"), null, "不存在的哨兵要分得清，不能装作空日志");
  assert.ok((all.bytes ?? 0) > 0, "有输出的日志要报出真实字节数");
  await stopMonitor(monitorId, "测试收尾");

  // ── 空行列表的三种来由必须分得开（第 1 轮审查 F4）──────────────────────────────
  //
  // `lines: []` 推不出「它从头到尾什么都没写过」：日志被删/没权限时读取**失败**，而尾部那段
  // 里一个换行都没有（超长单行）时文件明明有几 KB。上一版这三种都只返回一个空列表，界面于是
  // 把前两种说成了确证的零输出。所以这里逐一钉住 `bytes`：它是对文件本身的实测，不是行数的影子。
  {
    const probe = await insertMonitorRow(taskId, { status: "exited" });
    const logOf = async () => (await db.select({ p: monitors.logPath })
      .from(monitors).where(eq(monitors.id, probe))).at(0)!.p;
    const path = await logOf();

    // ① 文件压根不在（被删掉/挪走/没权限）⇒ 读不出来，一个字都不许声称
    const missing = (await readMonitorTail(probe))!;
    assert.deepEqual(missing.lines, []);
    assert.equal(missing.bytes, null, "读不出来 = null,不是 0（0 是「确证空文件」这条断言）");

    // ② 确证的空文件
    writeFileSync(path, "");
    assert.equal((await readMonitorTail(probe))!.bytes, 0, "真的 0 字节才许报 0");

    // ③ 一条**超过回读上限**、而且从头到尾没有换行的输出：那半行被丢掉（它不是一行），于是
    //    完整行一条都切不出来 —— 而文件实测几百 KB。这两件事混成一句「空的」就是假话。
    const size = MONITOR_TAIL_MAX_BYTES + 1024;
    writeFileSync(path, "x".repeat(size));
    const long = (await readMonitorTail(probe))!;
    assert.deepEqual(long.lines, [], "超长单行 ⇒ 这一段里切不出完整行");
    assert.equal(long.bytes, size, `而文件实测是 ${size} 字节 —— 不能混成一句「空的」`);
    assert.equal(long.truncated, true, "要说清「这一段不是全部」");
  }
  console.log("✓ 哨兵的原始输出可回看，限行数时留最后几行并如实报截断，空行列表的三种来由分得开");
}
// ── ⑦ 四道闸真的挡得住 ───────────────────────────────────────────────────────
{
  const taskId = await makeTask();
  const idle = `${JSON.stringify(process.execPath)} -e "setInterval(() => {}, 1000)"`;
  // 并发打进来的六个创建请求：检查与插入之间隔着 spawn 和好几个 await，不按任务串行
  // 的话每一个都在别人落库前数完了数，于是六个一起过了 4 个的闸、真起六个长跑进程。
  const results = await Promise.all(Array.from({ length: 6 }, () =>
    startMonitor({ taskId, command: idle, description: "抢名额" })));
  const okCount = results.filter((r) => r.ok).length;
  assert.equal(okCount, MONITOR_MAX_PER_TASK, `并发创建只该成功 ${MONITOR_MAX_PER_TASK} 个，实际 ${okCount}`);
  const running = (await listMonitors(taskId)).filter((m) => m.status === "running");
  assert.equal(running.length, MONITOR_MAX_PER_TASK, "真起来的进程数也要受同一个上限约束");

  // 坏参数：必须在**起进程之前**就被挡住。挡晚了进程已经脱离 ash 跑起来、记录却没落，
  // 那个 shell 从此谁也看不见、谁也停不掉。
  const bad = await startMonitor({ taskId, command: idle, description: 7 as unknown as string });
  assert.equal(bad.ok, false, "description 不是字符串就该被拒");
  assert.equal(bad.ok === false ? bad.status : 0, 400, "这是入参错误，不是冲突");
  assert.equal(
    (await listMonitors(taskId)).length,
    MONITOR_MAX_PER_TASK,
    "被拒的那次不该留下任何记录——留不下记录就更不该留下进程",
  );

  for (const m of running) await stopMonitor(m.id, "测试收尾");
  await until("抢名额的进程都收回了", async () =>
    (await listMonitors(taskId)).every((m) => !m.pid || !isPidAlive(m.pid)));
  console.log("✓ 每任务上限扛得住并发创建，坏参数在起进程之前就被挡住");
}
// ── ⑧ 位置只在事件落库之后才前进 ─────────────────────────────────────────────
// 反过来排的话，读过的位置会在那 300ms 批量窗口里先走一步：此刻 server 一停，那几行
// 就永远没人读了——游标已经越过去，内容还躺在日志里，任务一个字都收不到。
{
  const taskId = await makeTask();
  const started = await startMonitor({
    taskId,
    command: `${JSON.stringify(process.execPath)} -e 'console.log("BEFORE_PUSH"); setInterval(() => {}, 1000);'`,
    description: "位置不能先走",
  });
  assert.equal(started.ok, true);
  const monitorId = started.ok ? started.monitor.id : "";

  let advancedWithoutEvent = false;
  for (let i = 0; i < 200; i++) {
    const row = (await db.select().from(monitors).where(eq(monitors.id, monitorId))).at(0)!;
    if (row.events === 0 && row.offset > 0) advancedWithoutEvent = true;
    if (row.events > 0) break;
    await sleep(10);
  }
  assert.equal(advancedWithoutEvent, false, "出现过「位置已前进、事件还没落库」的窗口");
  const after = (await db.select().from(monitors).where(eq(monitors.id, monitorId))).at(0)!;
  assert.ok(after.events > 0 && after.offset > 0, "事件落库之后位置要跟上，否则同一行会被反复推一辈子");
  await stopMonitor(monitorId, "测试收尾");
  console.log("✓ 读取位置只跟在事件落库之后走");
}
// ── ⑩ 活得过 server 重启 ─────────────────────────────────────────────────────
// 真的开两个进程：v1 起哨兵后硬退出（模拟 `npm run restart` 那句 kill），本进程确认
// 哨兵仍活着，再由 v2 接回来读完剩下的行。
{
  const stateFile = join(root, "restart-state.json");
  const ticker = join(root, "ticker.mjs");
  // **前两拍快、后面慢**:v1 一攒到 2 条事件就硬退出(见 monitor-restart-child.ts),之后要留
  // 给 v2 一整个 `npx tsx` 冷启动的时间 —— 这条用例的立论「接回 1 个」要求那个进程**那一刻
  // 还活着**。上一版 12 拍 × 400ms = 总共 4.8 秒,v1 用掉 1 秒,剩下 3.8 秒要够两次冷启动:
  // 机器一忙就不够（第 2 轮审查的审查者那边连着两次拿到 attached=0/lost=1,他们自己也说
  // 这不是产品的问题）。现在总寿命 ~12 秒、行数不变,v2 那一侧的等待上限(30 秒)照旧覆盖。
  writeFileSync(ticker, `let i = 0;
const tick = () => {
  i++;
  console.log("tick " + i);
  if (i >= 12) { process.exit(0); return; }
  setTimeout(tick, i < 2 ? 200 : 1200);
};
setTimeout(tick, 200);
`);

  const child = join(HERE, "monitor-restart-child.ts");

  const tickerCommand = `${JSON.stringify(process.execPath)} ${JSON.stringify(ticker)}`;
  const taskId = await makeTask();
  // 本进程也连着同一个库：先把内存里的 tail 撤掉，免得两个进程同时往同一行写。
  detachAllMonitors();

  // 跟 test-detached-survival 一样走 `npx tsx`：workspace 把 bin 提升到仓库根，
  // server/node_modules/.bin 不一定存在。
  const run = (mode: string) =>
    spawnSync("npx", ["tsx", child, mode, taskId, stateFile, tickerCommand], {
      stdio: "inherit",
      cwd: join(HERE, ".."),
      timeout: 120_000,
      env: { ...process.env, ASH_DB: process.env.ASH_DB, ASH_RUNS_DIR: process.env.ASH_RUNS_DIR },
    });

  assert.equal(run("v1").status, 0, "v1 子进程应正常退出");
  const v1 = JSON.parse(readFileSync(stateFile, "utf8")) as { monitorId: string; pid: number };
  // 立论本身：起它的那个「server」已经没了，哨兵进程照旧活着。
  assert.ok(isPidAlive(v1.pid), "server 退出后哨兵进程必须还活着——这是整个功能的前提");

  assert.equal(run("v2").status, 0, "v2 子进程应正常退出");
  const v2 = JSON.parse(readFileSync(stateFile, "utf8")) as { attached: number; lost: number };
  assert.equal(v2.attached, 1, "重启后应接回 1 个哨兵");
  assert.equal(v2.lost, 0);

  const row = (await db.select().from(monitors).where(eq(monitors.id, v1.monitorId))).at(0)!;
  assert.equal(row.status, "exited", "接回来之后应能看到它自己跑完");
  assert.equal(row.events, 12, `12 行应一条不漏地接回来，实际 ${row.events}`);
  console.log("✓ 哨兵活得过 server 重启，重启期间产出的行一条不漏");
}
// ── ⑪ 停服期间跑完的活，重启后也要把它留下的输出补完 ─────────────────────────
// 「进程不在了」说的是这一刻，不是说它这段时间什么都没干。直接落 lost 就等于：一件跑了
// 两小时的活在 ash 关掉的时候结束了，再打开只剩一句「进程已不在」，进展和结果一个字都
// 没到任务头上——而「一件事要跑很久」正是哨兵存在的全部理由。
{
  const stateFile = join(root, "offline-state.json");
  const offline = join(root, "offline.mjs");
  writeFileSync(offline, `setTimeout(() => { console.log("OFFLINE_DONE"); process.exit(0); }, 1500);\n`);
  const child = join(HERE, "monitor-restart-child.ts");
  const taskId = await makeTask();
  detachAllMonitors();

  const run = (mode: string) =>
    spawnSync("npx", ["tsx", child, mode, taskId, stateFile, `${JSON.stringify(process.execPath)} ${JSON.stringify(offline)}`], {
      stdio: "inherit",
      cwd: join(HERE, ".."),
      timeout: 120_000,
      env: { ...process.env, ASH_DB: process.env.ASH_DB, ASH_RUNS_DIR: process.env.ASH_RUNS_DIR },
    });

  // v3 起完哨兵立刻硬退出：它一个字都没来得及读，命令随后才输出并结束。
  assert.equal(run("v3").status, 0, "v3 子进程应正常退出");
  const v3 = JSON.parse(readFileSync(stateFile, "utf8")) as { monitorId: string; pid: number };
  await until("命令在停服期间自己跑完了", async () => !isPidAlive(v3.pid));

  const result = await reattachMonitors();
  assert.equal(result.lost, 1, "进程确实已经不在了，如实记 lost");
  const row = (await db.select().from(monitors).where(eq(monitors.id, v3.monitorId))).at(0)!;
  assert.equal(row.status, "lost");
  assert.equal(row.exitCode, null, "退出码确实拿不到，就记 null——不拿 0 冒充跑成功了");
  assert.ok(row.events > 0, `它留下的输出必须补读出来，实际 events=${row.events}`);
  const texts = (await pendingOf(taskId)).map((m) => m.text).join("\n");
  assert.match(texts, /OFFLINE_DONE/, "停服期间产出的那一行要送到任务头上");
  assert.match(texts, /哨兵结束/, "结束这件事本身也要如实通知，不能静默");
  // **离线那条收尾通知跟在线那条一字同源**（第 1 轮审查 N2）：事件数和「有没有产出过」要给
  // agent 当面说清。少了这一段，它拿到的只是一句光秃秃的结束，分不出「哨兵哑了」和「我漏读
  // 了几条」—— 而那半件事恰恰是这一轮补上的（见 ③/③b）。
  assert.match(texts, /共推送 \d+ 条事件/, "离线收尾的结束通知也要带上事件数");
  console.log("✓ 停服期间跑完的活，重启后补读输出并如实通知（通知里带事件数）");
}
// ── ⑫ 起不来不许外溢：一次失败的创建不能把整个 ash 带走 ───────────────────────
// 这一段最该守的断言是「**本进程还活着**」。`spawn` 对坏 cwd 的报错是异步的，而旧代码
// 在没拿到 pid 的分支上调了 `child.kill()` —— 那一步走到 `uv_process_kill(0, SIGTERM)`，
// 而 POSIX 的 `kill(0, …)` 是「发给自己所在的整个进程组」：ash 自己当场 SIGTERM
// （第 2 轮审查实测：隔离服务退出码 143，首页从此不响应，所有任务页一起下线）。
// 所以这里不写 try/catch 也不另起进程 —— 真塌了，这条测试就是被信号打死的那个。
{
  const taskId = await makeTask();
  const idle = `${JSON.stringify(process.execPath)} -e "setInterval(() => {}, 1000)"`;

  const gone = await startMonitor({ taskId, command: idle, cwd: join(root, "no-such-dir-ever") });
  assert.equal(gone.ok, false, "工作目录不存在就该干脆地失败");
  assert.equal(gone.ok === false ? gone.status : 0, 409, "这是环境冲突，不是入参错误");

  const notDir = join(root, "a-file-not-a-dir");
  writeFileSync(notDir, "x");
  const wrongKind = await startMonitor({ taskId, command: idle, cwd: notDir });
  assert.equal(wrongKind.ok, false, "cwd 指到一个文件上同样要失败");

  // 预检挡不住的那一类：目录在、但进不去（chdir 返回 EACCES）。这条路真的会走到
  // `spawn` 的异步失败，于是它同时钉住第二道防线——`error` 监听必须在那一刻就挂着，
  // 不然 Node 把它升级成 uncaughtException，整个进程照样没了。
  const sealed = join(root, "sealed-dir");
  mkdirSync(sealed, { recursive: true });
  chmodSync(sealed, 0o000);
  try {
    const denied = await startMonitor({ taskId, command: idle, cwd: sealed });
    // root 跑测试时 chdir 不会被拒，那就只验「没炸」，不强求它失败。
    if (denied.ok) await stopMonitor(denied.monitor.id, "测试收尾");
  } finally {
    chmodSync(sealed, 0o700);
  }

  await sleep(300);
  assert.equal((await listMonitors(taskId)).length, 0, "三次失败一条记录都不该留下");
  assert.ok(process.pid > 0, "本进程还活着——这就是这一段的主断言");

  // 第一道防线的形状也钉一下：`child.kill()` 这一句无论以什么理由都不该回来。
  const spawnSrc = readSource(join(HERE, "../src/monitor-spawn.ts"));
  assert.doesNotMatch(
    spawnSrc,
    /^\s*child\.kill\(/m, // 只认语句，注释里引用这个名字不算
    "没有 pid 就没有进程可杀，`child.kill()` 打的是 ash 自己所在的进程组",
  );
  assert.ok(
    spawnSrc.indexOf('child.on("error"') < spawnSrc.indexOf("if (!child.pid)"),
    "`error` 监听必须挂在拿 pid 之前：spawn 的失败是异步报的，没人听就是 uncaughtException",
  );
  console.log("✓ 起不来只失败这一条请求，不动 ash 自己");
}

await teardown();
console.log("✓ 哨兵：推送 / 合并 / 真杀进程 / 日志回看 / 上限与坏参数 / 位置顺序 / 跨重启接管与离线补读 / 失败不外溢 均受回归保护");
