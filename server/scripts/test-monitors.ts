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
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { appendFileSync, mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { and, eq } from "drizzle-orm";
import { MONITOR_MAX_EVENTS, MONITOR_MAX_MERGED_CHARS, MONITOR_MAX_PER_TASK } from "@ash/shared/monitor";
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

detachAllMonitors();
await releaseTmpDb();
rmSync(root, { recursive: true, force: true });
console.log("✓ 哨兵：推送 / 合并 / 连坐停止 / 真杀进程 / 日志回看 / 上限与坏参数 / 位置顺序 / 终态作废 / 跨重启接管与离线补读 均受回归保护");
