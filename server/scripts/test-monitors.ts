// 哨兵（Monitor）的回归测试。钉住的是这个功能全部的立论，一条都不能松：
//
//  ① 命令吐一行 → 变成这个任务名下一条待发送消息（`origin` 标着是谁推的）
//  ② 任务忙的时候攒下的多批事件**合并进同一行**，而不是一行一个回合（这是花钱的闸）
//  ③ 命令自己跑完 → 落 exited，并推一条收尾事件
//  ④ 任务落终态 → 名下哨兵一并停掉，**而且不回推收尾事件**（否则等于把 done 的任务叫醒）
//  ⑤ 停掉哨兵 = 进程真的死了（不是只改数据库）
//  ⑥ 面板能回看它的原始输出：事件正文里被略去的行（单批超限、合并超长）只剩日志里有
//  ⑦ server 重启：另起一个进程把 ash 杀掉后，哨兵进程仍活着，新进程按 pid + offset
//     接回来，重启期间产出的行一条不漏 —— 这是整件事相对「挂在会话上的后台进程」的
//     全部增量，也是本测试最该守住的一条
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { and, eq } from "drizzle-orm";
import { MONITOR_MAX_EVENTS, MONITOR_MAX_MERGED_CHARS } from "@ash/shared/monitor";
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
const { startMonitor, stopMonitor, listMonitors, readMonitorTail, detachAllMonitors } = monitorsModule;
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

// ── ⑦ 活得过 server 重启 ─────────────────────────────────────────────────────
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

detachAllMonitors();
await releaseTmpDb();
rmSync(root, { recursive: true, force: true });
console.log("✓ 哨兵：推送 / 合并 / 连坐停止 / 真杀进程 / 日志回看 / 跨重启接管 均受回归保护");
