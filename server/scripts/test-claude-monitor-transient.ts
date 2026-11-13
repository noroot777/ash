// 内置 Monitor 实时投影的**写库责任**：事件一旦从流里消费掉，来源侧不会再发一遍，库里也没有
// 别的地方能补回来（翻会话记录的历史扫描已经删了）。所以一笔事实只有写成了或被明确撤销才
// 销账（claude-monitor-write-queue.ts）。这份回归钉六件事：
//
// ① 一次几百毫秒的读库故障之后，卡片照样落库，回合收尾那条说明照样留下（它数的正是这些行）；
// ② 库坏的时间远超退避阶梯：故障期间起的那几个**一个不丢**，库恢复后依次补上，收尾数字把它们
//    全数进去（第 2 轮审查实测：上一版 5 个只落 1 个，说明也写 1 个）；
// ③ 流结束时库还坏着：收尾最多等 `finishWaitMs` 就放行，收尾那一笔留在队里，恢复后照样补上，
//    且按流结束那一刻圈范围，不会把下一代刚起的监听一起收掉；
// ④ 删任务：**删除中只是先等着，确认删掉了才放弃**。删除失败整批回滚时，排着的卡片、收尾和
//    说明一笔不少地接着写（新一轮第 1 轮审查实测：上一版把「正在删」当成「删掉了」，回滚后
//    全没了）；队头那道闸、job 自己落库前那道闸、收尾按任务那道闸三处同一个分法；
// ⑤ 积压有上界：超出的新事件不进队，收尾那一笔不受限制；丢掉的那几个**算进收尾说明的总数、
//    并说清没能记成卡片**，不是只写进日志（第 3 轮审查）；
// ⑥ 注定写不成的（约束冲突、代码错）不占着队头，后面的照常写，丢掉的同样报出来；
// ⑦ 收尾说明自己没写成（写盘出错）不算写成：收尾留在队里重试，恢复后那句话照样落下，且只落
//    一遍（第 3 轮审查实测：上一版把 `appendTaskTimeline` 的 false 当成功销账，说明永久缺失）。
import { db, makeTask, monitors, now, root, sessions, teardown } from "./monitors-fixture.js";
import { eq } from "drizzle-orm";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const { ClaudeMonitorTrace } = await import("../src/claude-monitors.js");
const { MonitorWriteQueue, permanentWriteFailure } = await import("../src/claude-monitor-write-queue.js");
const { beginTaskRevocation, confirmTaskRevocation, releaseTaskRevocation } = await import("../src/claude-monitor-revoked.js");
const { TaskDeletingError } = await import("../src/claude-monitor-write-queue.js");
const { dbClient } = await import("../src/db/index.js");
const { deleteTaskCompletely } = await import("../src/task-delete-routes.js");
const { reapClaudeMonitors } = await import("../src/claude-monitor-reaped.js");
const { bus } = await import("../src/bus.js");

let failures = 0;
const check = (ok: boolean, label: string, detail = "") => {
  if (ok) return;
  failures += 1;
  console.error(`✗ ${label}${detail ? ` —— ${detail}` : ""}`);
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const ORIGIN = { pid: null, pidStartedAt: null, runPath: "" };
type Trace = InstanceType<typeof ClaudeMonitorTrace>;

/** 像 claude-stream.ts 那样喂一次 Monitor 调用 + 它的 task_started。 */
function startMonitor(trace: Trace, cli: string, n: string): void {
  const input = { command: `tail -F /tmp/${n}.log`, description: `监听 ${n}` };
  trace.event({ type: "assistant", timestamp: now(), message: { content: [{ type: "tool_use", name: "Monitor", input, id: `tu-${n}` }] } });
  trace.toolUse("Monitor", input, `tu-${n}`);
  trace.event({ type: "system", subtype: "task_started", task_id: `b-${n}`, tool_use_id: `tu-${n}`, task_type: "local_bash", session_id: cli });
}

/** 让 `db.select` 整个抛错（会话定位、认行、查重都走它），返回恢复函数。 */
function breakReads(): () => void {
  const original = db.select.bind(db);
  (db as any).select = () => { throw new Error("INJECTED_SQLITE_BUSY"); };
  return () => { (db as any).select = original; };
}

/** 一个任务 + 它的 claude 会话 + 一条已经认领完上一轮的流 + 盯着它时间线的耳朵。 */
async function session(name: string) {
  const taskId = await makeTask();
  const cli = `cli-${name}-${taskId}`;
  await db.insert(sessions).values({ id: `s-${name}-${taskId}`, taskId, role: "single", agentType: "claude",
    executor: "claude@test", cliSessionId: cli, cwd: "/tmp/wt", startedAt: now() });
  const notes: string[] = [];
  const stop = bus.subscribe((ev: any) => {
    if (ev.type === "agent.event" && ev.taskId === taskId) notes.push(String(ev.event?.text ?? ""));
  });
  const trace = new ClaudeMonitorTrace(cli, ORIGIN);
  await trace.settled();                     // 认领上一轮那一步先走完
  const notice = () => notes.find((t) => t.includes("内置 Monitor"));
  const notices = () => notes.filter((t) => t.includes("内置 Monitor"));
  return { taskId, cli, trace, notice, notices, stop };
}

/** 断言自己读库不走注入（注入只拦被测代码那一侧）。 */
const select = db.select.bind(db);
const rowsOf = (cli: string) => select().from(monitors).where(eq(monitors.cliSessionId, cli));
const pendingOf = (trace: Trace) => (trace as any).writes.pending as number;
const ids = (rows: { nativeId: string | null }[]) => rows.map((r) => r.nativeId).sort().join(",") || "(空)";

async function main(): Promise<void> {
  // ── ① 暂态故障：几百毫秒之后库好了，那笔事实不能丢 ───────────────────────────
  {
    const s = await session("transient");
    const restore = breakReads();
    startMonitor(s.trace, s.cli, "flaky");
    await sleep(300);
    restore();
    await s.trace.finishAll();
    s.stop();
    const rows = await rowsOf(s.cli);
    check(rows.length === 1, "①短暂读库失败之后，那张卡照样落库", `${rows.length} 张`);
    check(rows[0]?.status === "lost", "①收尾照常把它收成「进程已不在」", String(rows[0]?.status));
    check(!!s.notice()?.includes("1 个"), "①回合收尾那条说明照样留下，数字跟卡片对得上", String(s.notice()));
  }

  // 后面几组把阶梯压到百毫秒级：要证的是「库坏得比整条阶梯久」，不是「等满真实的 5 秒」。
  const ladder = MonitorWriteQueue.retryMs;
  MonitorWriteQueue.retryMs = [20, 50, 100];
  const ladderTotal = MonitorWriteQueue.retryMs.reduce((a, b) => a + b, 0);

  // ── ② 库坏得远比阶梯久：故障期间的事实恢复后全部补上 ─────────────────────────
  {
    const s = await session("outage");
    const restore = breakReads();
    for (const n of ["o1", "o2", "o3", "o4"]) startMonitor(s.trace, s.cli, n);
    await sleep(ladderTotal * 10);
    check((await rowsOf(s.cli)).length === 0, "②库不可用期间确实一张都没写成（注入生效）");
    check(pendingOf(s.trace) === 4, "②阶梯早就试满了，那四笔仍然一笔不少地排着", `还排着 ${pendingOf(s.trace)} 笔`);
    restore();
    startMonitor(s.trace, s.cli, "after");
    await s.trace.finishAll();
    s.stop();
    const rows = await rowsOf(s.cli);
    check(ids(rows) === "b-after,b-o1,b-o2,b-o3,b-o4", "②库恢复后故障期间起的那四个全部补上", ids(rows));
    check(rows.every((r) => r.status === "lost"), "②补上的那些照样被收尾收成「进程已不在」",
      rows.map((r) => r.status).join(","));
    check(!!s.notice()?.includes("5 个"), "②收尾说明把故障期间的也数进去（5 个，不是 1 个）", String(s.notice()));
  }

  // ── ③ 流结束时库还坏着：收尾有界放行，恢复后补上，不误收下一代 ────────────────
  {
    const wait = ClaudeMonitorTrace.finishWaitMs;
    ClaudeMonitorTrace.finishWaitMs = 300;
    const s = await session("finish-down");
    const restore = breakReads();
    startMonitor(s.trace, s.cli, "x");
    const began = Date.now();
    await s.trace.finishAll();
    const waited = Date.now() - began;
    check(waited < 1_500, "③库坏着时收尾最多等 finishWaitMs 就放行，不把 agent 的收尾拖住", `${waited}ms`);
    check(pendingOf(s.trace) === 2, "③放行之后那一笔和收尾仍排在队里", `还排着 ${pendingOf(s.trace)} 笔`);
    // 收尾放行之后、库恢复之前，同一条会话的下一代起了一个新监听（直接插行：insert 不走注入）。
    await sleep(5);
    await db.insert(monitors).values({
      id: `next-${s.taskId}`, taskId: s.taskId, command: "tail -F next.log", description: "下一代的", cwd: "/tmp/wt",
      status: "running", pid: null, pidStartedAt: null, logPath: "", offset: 0, events: 0, exitCode: null,
      startedAt: now(), expiresAt: now(), endedAt: null, endedReason: null, ownerUserId: null,
      kind: "claude", nativeId: "b-next", cliSessionId: s.cli, sourceLifetime: "unknown",
    });
    restore();
    await s.trace.settled();
    s.stop();
    ClaudeMonitorTrace.finishWaitMs = wait;
    const rows = new Map((await rowsOf(s.cli)).map((r) => [r.nativeId, r]));
    check(rows.get("b-x")?.status === "lost", "③库恢复后那一笔补上、晚到的收尾照样把它收掉", String(rows.get("b-x")?.status));
    check(rows.get("b-next")?.status === "running", "③晚到的收尾按流结束那一刻圈范围，下一代的不被收掉",
      String(rows.get("b-next")?.status));
    check(!!s.notice()?.includes("1 个"), "③晚到的收尾说明只数这一代（1 个）", String(s.notice()));
  }

  // ── ④a 真删除失败回滚：删除中排着的那几笔一笔不丢 ─────────────────────────────
  {
    const wait = ClaudeMonitorTrace.finishWaitMs;
    ClaudeMonitorTrace.finishWaitMs = 300;
    const s = await session("delete-rollback");
    startMonitor(s.trace, s.cli, "d1");
    await s.trace.settled();
    const restore = breakReads();
    startMonitor(s.trace, s.cli, "d2");
    await s.trace.finishAll();               // 收尾有界放行：d2 和收尾都还排着，任务这时可以被删
    check(pendingOf(s.trace) === 2, "④a（前提）流结束后 d2 和收尾仍排在队里", `排着 ${pendingOf(s.trace)} 笔`);
    // 删除批在真正执行前停一会儿再失败：这段时间里库已经好了、闸是「删除中」。
    const realBatch = dbClient.batch.bind(dbClient);
    let held = -1;
    (dbClient as any).batch = async (stmts: any[], mode?: any) => {
      if (!stmts.some((st) => /delete from "tasks"/i.test(String(st?.sql ?? st)))) return realBatch(stmts, mode);
      await sleep(ladderTotal * 3);
      held = pendingOf(s.trace);
      throw new Error("INJECTED_DELETE_FAILURE");
    };
    // 库先好、闸紧跟着在同一拍里关上（删除一进门就同步关闸）：队头下一次醒来看到的已经是
    // 「删除中」，夹在中间的是删除本身要读的那几下，不能让它们撞上注入。
    restore();
    const deleting = deleteTaskCompletely(s.taskId);
    const failed = await deleting.then(() => false, () => true);
    (dbClient as any).batch = realBatch;
    ClaudeMonitorTrace.finishWaitMs = wait;
    check(failed, "④a（前提）删除确实失败了、任务还在");
    check(held === 2, "④a删除中库已经好了，那两笔也只是先等着，不写、不丢", `删除中还排着 ${held} 笔`);
    await s.trace.settled();
    s.stop();
    const rows = await rowsOf(s.cli);
    check(ids(rows) === "b-d1,b-d2", "④a删除回滚后，删除中排着的那张卡照样补上", ids(rows));
    check(rows.every((r) => r.status === "lost"), "④a收尾也照样做了（两张都收成「进程已不在」）", rows.map((r) => r.status).join(","));
    check(s.notices().length === 1 && s.notices()[0]!.includes("2 个"), "④a收尾说明照样落下、数字完整（2 个）", String(s.notice()));
  }

  // ── ④b 确认删掉了：队头那一笔才销账 ──────────────────────────────────────────
  {
    const s = await session("revoked");
    startMonitor(s.trace, s.cli, "r");
    await s.trace.settled();                 // 先正常落一张卡：这条流已经知道自己归哪个任务
    const restore = breakReads();
    s.trace.event({ type: "system", subtype: "task_notification", task_id: "b-r", status: "completed", summary: "", session_id: s.cli });
    await sleep(ladderTotal);
    check(pendingOf(s.trace) === 1, "④b库坏着时那条终态在排队重试", `还排着 ${pendingOf(s.trace)} 笔`);
    beginTaskRevocation(s.taskId);
    await sleep(ladderTotal * 2);
    check(pendingOf(s.trace) === 1, "④b删除中不销账", `还排着 ${pendingOf(s.trace)} 笔`);
    confirmTaskRevocation(s.taskId);
    await Promise.race([s.trace.settled(), sleep(1_000)]);
    check(pendingOf(s.trace) === 0, "④b确认删掉了，队头那一笔立即销账（库仍然坏着）", `还排着 ${pendingOf(s.trace)} 笔`);
    releaseTaskRevocation(s.taskId);
    restore();
    await s.trace.finishAll();
    s.stop();
  }

  // ── ④c job 自己那道闸：这条流还不知道归哪个任务时，删除中同样只是等着 ─────────────
  {
    const s = await session("job-gate");
    // 带着显式来源的流不在构造时查会话，第一次知道自己归哪个任务是在 job 里 —— 队头那道闸
    // 这时帮不上忙，挡的是 job 落库前那一道。
    const trace = new ClaudeMonitorTrace(s.cli, { pid: 999_999, pidStartedAt: null, runPath: "" });
    await trace.settled();
    beginTaskRevocation(s.taskId);
    startMonitor(trace, s.cli, "j");
    await sleep(ladderTotal * 2);
    check(pendingOf(trace) === 1, "④c删除中 job 自己那道闸没放手", `还排着 ${pendingOf(trace)} 笔`);
    check((await rowsOf(s.cli)).length === 0, "④c删除中确实没写");
    releaseTaskRevocation(s.taskId);   // 删除回滚
    await trace.settled();
    check(ids(await rowsOf(s.cli)) === "b-j", "④c回滚后那张卡照样落库", ids(await rowsOf(s.cli)));

    // ── ④d 收尾按任务那道闸：删除中抛出去等结果，回滚后说明照样落下 ─────────────────
    const key = `claude-monitors-reaped:${s.cli}:job-gate`;
    const origin = { pid: null, pidStartedAt: null, runPath: "" };
    beginTaskRevocation(s.taskId);
    const deferred = await reapClaudeMonitors(s.cli, origin, "1970-01-01T00:00:00.000Z", undefined, { eventKey: key })
      .then(() => null, (e) => e);
    check(deferred instanceof TaskDeletingError, "④d删除中收尾不跳过说明，而是抛出去等结果", String(deferred));
    check(s.notices().length === 0, "④d删除中说明确实没落");
    releaseTaskRevocation(s.taskId);
    await reapClaudeMonitors(s.cli, origin, "1970-01-01T00:00:00.000Z", undefined, { eventKey: key });
    check(s.notices().length === 1, "④d回滚后整笔重来，说明照样落下", `${s.notices().length} 条`);
    await trace.finishAll();
    await s.trace.finishAll();
    s.stop();
  }

  // ── ⑤ 积压有上界：超出的不进队，收尾不受限，数字跟卡片对得上 ───────────────────
  {
    const cap = MonitorWriteQueue.maxBacklog;
    MonitorWriteQueue.maxBacklog = 3;
    const s = await session("overflow");
    const restore = breakReads();
    for (const n of ["m1", "m2", "m3", "m4", "m5"]) startMonitor(s.trace, s.cli, n);
    check(pendingOf(s.trace) === 3, "⑤积压到上界就不再进队", `排着 ${pendingOf(s.trace)} 笔`);
    const finished = s.trace.finishAll();
    check(pendingOf(s.trace) === 4, "⑤收尾那一笔不受上界限制", `排着 ${pendingOf(s.trace)} 笔`);
    restore();
    await finished;
    await s.trace.settled();
    s.stop();
    MonitorWriteQueue.maxBacklog = cap;
    const rows = await rowsOf(s.cli);
    check(ids(rows) === "b-m1,b-m2,b-m3", "⑤进了队的三笔全部补上", ids(rows));
    check(!!s.notice()?.includes("起了 5 个"), "⑤收尾说明的总数把没进队的两个也算上（5 个，不是 3 个）", String(s.notice()));
    check(!!s.notice()?.includes("其中 2 个") && !!s.notice()?.includes("没能记成卡片"),
      "⑤并且说清其中几个没能记成卡片（面板上只有 3 张）", String(s.notice()));
  }

  // ── ⑥ 注定写不成的不占着队头 ──────────────────────────────────────────────────
  {
    const unique = Object.assign(new Error("UNIQUE constraint failed"), { errcode: 2067 }); // SQLITE_CONSTRAINT_UNIQUE
    check(permanentWriteFailure(unique), "⑥约束冲突（扩展码）认得出是写不成的");
    check(permanentWriteFailure(new TypeError("x is undefined")), "⑥代码自己的错认得出是写不成的");
    check(!permanentWriteFailure(Object.assign(new Error("busy"), { errcode: 5 })), "⑥SQLITE_BUSY 是等得好的");
    check(!permanentWriteFailure(new Error("不知道是什么")), "⑥认不出来的一律当作等得好的（宁可多等，不可错丢）");
    const warns: string[] = [];
    const dropped: string[] = [];
    const q = new MonitorWriteQueue({
      revocation: () => null, warn: (what) => warns.push(what), dropped: (fact) => dropped.push(fact),
    });
    let attempts = 0;
    let after = false;
    q.push(async () => { attempts += 1; throw unique; }, { fact: "start" });
    q.push(async () => { after = true; });
    await Promise.race([q.settled(), sleep(1_000)]);
    check(attempts === 1 && after, "⑥写不成的那一笔试一次就丢、留诊断，后面那笔照常写", `attempts=${attempts} after=${after}`);
    check(warns.some((w) => w.includes("不会成功")), "⑥丢掉时留了诊断", warns.join(" | "));
    check(dropped.join(",") === "start", "⑥丢掉的那一笔报给了调用方（收尾说明据此补数）", dropped.join(",") || "(没报)");
  }

  // ── ⑦ 收尾说明自己没写成：留在队里重试，恢复后只落一遍 ─────────────────────────
  {
    const wait = ClaudeMonitorTrace.finishWaitMs;
    ClaudeMonitorTrace.finishWaitMs = 300;
    const s = await session("notice-io");
    startMonitor(s.trace, s.cli, "n");
    await s.trace.settled();
    // 把这个任务的时间线目录占成一个普通文件：建目录 / 写盘都报 ENOTDIR —— 真实的写盘故障。
    const runs = join(root, "runs");
    const taskDir = join(runs, s.taskId);
    check(!existsSync(taskDir), "⑦（前提）这个任务的时间线目录还不存在");
    mkdirSync(runs, { recursive: true });
    writeFileSync(taskDir, "");
    await s.trace.finishAll();
    const [row] = await rowsOf(s.cli);
    check(row?.status === "lost", "⑦卡片照常收成「进程已不在」", String(row?.status));
    check(s.notices().length === 0, "⑦（注入生效）写盘出错期间说明确实没落下");
    check(pendingOf(s.trace) === 1, "⑦说明没写成，收尾那一笔仍排在队里", `还排着 ${pendingOf(s.trace)} 笔`);
    rmSync(taskDir);
    await s.trace.settled();
    ClaudeMonitorTrace.finishWaitMs = wait;
    check(s.notices().length === 1 && s.notices()[0]!.includes("1 个"), "⑦恢复后那句说明照样落下，且只落一遍",
      `${s.notices().length} 条`);
    // 重试时已经落下的那条不再落第二遍：同一个稳定身份再收一次尾，什么都不多写。
    const transcript = () => readFileSync(join(taskDir, `s-notice-io-${s.taskId}.md`), "utf8")
      .split("\n").filter((line) => line.includes("内置 Monitor")).length;
    check(transcript() === 1, "⑦时间线文件里只有一条", `${transcript()} 条`);
    const key = (s.trace as any).openedAt as string;
    await reapClaudeMonitors(s.cli, { pid: null, pidStartedAt: null, runPath: "" }, key, undefined,
      { eventKey: `claude-monitors-reaped:${s.cli}:${key}` });
    check(transcript() === 1 && s.notices().length === 1, "⑦同一摊收尾重跑一遍，说明不会落第二条",
      `文件 ${transcript()} 条 / 推送 ${s.notices().length} 条`);
    s.stop();
  }

  MonitorWriteQueue.retryMs = ladder;
  if (failures) {
    console.error(`\n${failures} 条断言未通过`);
    process.exitCode = 1;
  } else {
    console.log("✓ 内置 Monitor 实时投影的写库责任：暂态故障后照样落库 / 长故障期间的事实恢复后全部补上且收尾计数完整 / "
      + "流结束时库还坏着收尾有界放行、恢复后补上且不误收下一代 / 删除中只等不丢、回滚后照样补上、确认删掉才销账 / 积压有上界且丢掉的算进说明 / 写不成的不堵队头 / "
      + "说明没写成就重试且只落一遍 均受回归保护");
  }
}

try {
  await main();
} finally {
  await teardown();
}
