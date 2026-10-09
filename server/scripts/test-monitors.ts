// 哨兵（Monitor）的回归测试。钉住的是这个功能全部的立论，一条都不能松：
//
//  ① 命令吐一行 → 变成这个任务名下一条待发送消息（`origin` 标着是谁推的）
//  ② 任务忙的时候攒下的多批事件**合并进同一行**，而不是一行一个回合（这是花钱的闸）
//  ③ 命令自己跑完 → 落 exited，并推一条收尾事件
//  ④ 任务落终态 → 名下哨兵一并停掉，**而且不回推收尾事件**（否则等于把 done 的任务叫醒）
//  ⑤ 停掉哨兵 = 进程真的死了（不是只改数据库）
//  ⑥ 面板能回看它的原始输出：事件正文里被略去的行（单批超限、合并超长）只剩日志里有
//  ⑦ 四道闸真的挡得住：并发创建不绕过每任务上限、坏参数不留下无主进程
//  ⑧ 位置只在事件落库之后才前进（先走位置再推消息 = 重启那一下静默吞掉几行）
//  ⑨ 任务落终态时，攒着的和排着队的哨兵事件一起作废（否则把 done 的任务又拉起来）
//  ⑩ server 重启：另起一个进程把 ash 杀掉后，哨兵进程仍活着，新进程按 pid + offset
//     接回来，重启期间产出的行一条不漏 —— 这是整件事相对「挂在会话上的后台进程」的
//     全部增量，也是本测试最该守住的一条
//  ⑪ 命令在停服期间就跑完了：重启时那条「进程已经不在」的路同样要补读它留下的输出
//  ⑫ 起不来只失败这一条请求：坏 cwd 不许把 ash 自己的进程组 SIGTERM 掉
//  ⑬⑭ 合并与投递抢同一行 pending：等回合期间追加的照样发出去，CAS 落空就另起一条
//  ⑮ 创建入口与投递出口同一份判据：投不出去的任务上起不来，也不虚报事件数
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { appendFileSync, chmodSync, mkdirSync, mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { and, eq } from "drizzle-orm";
import { MONITOR_MAX_EVENTS, MONITOR_MAX_MERGED_CHARS, MONITOR_MAX_PER_TASK } from "@ash/shared/monitor";
import { readSource } from "../../scripts/read-source.mjs";
import { requireTmpDb, releaseTmpDb } from "./tmp-db.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const root = mkdtempSync(join(tmpdir(), "ash-monitors-"));
process.env.ASH_DB = join(root, "ash.db");
process.env.ASH_RUNS_DIR = join(root, "runs");
requireTmpDb("monitors");

const [{ db, ensureSchema }, schema, monitorsModule, status, { isPidAlive }] = await Promise.all([
  import("../src/db/index.js"),
  import("../src/db/schema.js"),
  import("../src/monitors.js"),
  import("../src/status.js"),
  import("../src/platform.js"),
]);
const { startMonitor, stopMonitor, listMonitors, getMonitor, readMonitorTail, reattachMonitors, detachAllMonitors } = monitorsModule;
const { monitors, projects, scheduledMessages, tasks } = schema;

await ensureSchema();

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(label: string, probe: () => Promise<boolean>, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await probe()) return;
    await sleep(100);
  }
  throw new Error(`等不到：${label}`);
}

const now = () => new Date().toISOString();
let seq = 0;
async function makeTask(): Promise<string> {
  const projectId = `proj-${++seq}`;
  const taskId = `task-${seq}`;
  await db.insert(projects).values({ id: projectId, name: "monitors", repoPath: root, createdAt: now() });
  await db.insert(tasks).values({
    // 刻意落 running：投递链路对「单飞任务正在跑」的判定是**等**，于是事件只排队、
    // 不会真去 spawn 一个 agent。这正是本测试要观察的那个现场（忙的时候攒事件）。
    id: taskId, projectId, title: `t${seq}`, body: "", status: "running",
    agentType: "claude", mode: "single", createdAt: now(), updatedAt: now(),
  });
  return taskId;
}

const pendingOf = (taskId: string) =>
  db.select().from(scheduledMessages).where(and(eq(scheduledMessages.taskId, taskId), eq(scheduledMessages.status, "pending")));

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
  console.log("✓ 推事件 / 多批合并成一次唤醒 / 自己跑完落 exited");
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
  await stopMonitor(monitorId, "测试收尾");
  console.log("✓ 哨兵的原始输出可回看，限行数时留最后几行并如实报截断");
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
    id: `human-${seq}`, taskId, text: "这条是真人排的", attachments: "[]",
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

// ── ⑩ 活得过 server 重启 ─────────────────────────────────────────────────────
// 真的开两个进程：v1 起哨兵后硬退出（模拟 `npm run restart` 那句 kill），本进程确认
// 哨兵仍活着，再由 v2 接回来读完剩下的行。
{
  const stateFile = join(root, "restart-state.json");
  const ticker = join(root, "ticker.mjs");
  writeFileSync(ticker, `let i = 0;
const t = setInterval(() => { i++; console.log("tick " + i); if (i >= 12) { clearInterval(t); process.exit(0); } }, 400);
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
  console.log("✓ 停服期间跑完的活，重启后补读输出并如实通知");
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

detachAllMonitors();
await releaseTmpDb();
rmSync(root, { recursive: true, force: true });
console.log("✓ 哨兵：推送 / 合并 / 连坐停止 / 真杀进程 / 日志回看 / 上限与坏参数 / 位置顺序 / 终态作废 / 跨重启接管与离线补读 / 失败不外溢 / 合并与投递抢同一行 / 入口出口同源 均受回归保护");
