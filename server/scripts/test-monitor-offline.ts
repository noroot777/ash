// 哨兵**跨 ash 重启**那一半的回归:进程活过重启、停服期间跑完的活要补完、补读到的证据要
// 折进结局。
//
// 从 test-monitors.ts 拆出来（全局约定:单文件不超过 700 行）。拆的是一条清楚的缝:那边全部
// 跑在**同一个进程、同一份运行时**里（推、合并、停、回看、闸），这边每一条都要**换一个
// 进程**才成立 —— 另起一个 ash 把自己杀掉、再由下一个接回来。台子是同一份
// （monitors-fixture.ts），所以两边的前提一字不差。
//
// 钉住的立论:
//  ⑦j 补读出来的那一批里，命中那一行就算排在正文的行数上限之后也要单独补上
//  ⑦k 反面:没有命中就不许说成命中，而且只折「它已经不在了」这一档
//  ⑦l **真实接回顺序**（先 attach、再判「进程还在不在」）下，排干读到的命中同样要折进结局
//  ⑩  server 重启:另起一个进程把 ash 杀掉后，哨兵进程仍活着、按 pid + offset 接回来，
//      重启期间产出的行一条不漏 —— 这是整件事相对「挂在会话上的后台进程」的全部增量
//  ⑪  命令在停服期间就跑完了:那条「进程已经不在」的路同样要补读它留下的输出
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import {
  HERE, root, db, isPidAlive, reattachMonitors, detachAllMonitors,
  monitors, until, now, makeTask, insertMonitorRow, pendingOf, teardown,
} from "./monitors-fixture.js";

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

// ── ⑦l 真实接回顺序:**先 attach、再判「进程还在不在」** ⇒ 排干读到的命中也要折进结局 ───
// 新一轮审查 N1 实测的正是这条顺序差:上一节那两条直接调 `finishOffline`（手上没有运行时，
// 证据只能来自它自己那次补读），而**生产的接回是先给每条 running 行挂上 tail**——于是撤运行时
// 那一趟排干就把 `OFFLINE_READY` 送到任务、把游标推了过去，随后的补读一个字都读不到，结局落
// 成「进程已经不在了」。两条路现在接的是同一份证据（`teardownRuntimeLocked` 的返回值）。
{
  const taskId = await makeTask();
  // 号给一个**确认不可能存在**的:接回那一侧要判出「它已经不在了」，才轮到补读这条路。
  const monitorId = await insertMonitorRow(taskId, { status: "running", pid: 999_999, pidStartedAt: now() });
  await db.update(monitors).set({ stopWhen: "^OFFLINE_READY$" }).where(eq(monitors.id, monitorId));
  const seeded = (await db.select().from(monitors).where(eq(monitors.id, monitorId))).at(0)!;
  // 约定的那一行在 ash 不在的时候就已经写进日志了。
  writeFileSync(seeded.logPath, "OFFLINE_READY\n");

  const result = await reattachMonitors();
  assert.ok(result.lost >= 1, `台子前提:那个号确实不在了（实际 lost=${result.lost}）`);
  const row = (await db.select().from(monitors).where(eq(monitors.id, monitorId))).at(0)!;
  assert.equal(row.status, "matched", `先 attach 的那条路也要折（实际 ${row.status}）`);
  assert.match(row.endedReason ?? "", /等到了约定的那一行/, "结局要说出它是怎么收的");
  assert.match(row.endedReason ?? "", /OFFLINE_READY/, "命中那一行要写进结局");
  // 「进程为什么没了」那句话照旧接在后面，退出码照旧拿不到（同 ⑦j）。
  assert.match(row.endedReason ?? "", /这个进程已经不在了|进程已经不在|不在了/, "原来那句话要原样接在后面");
  assert.equal(row.exitCode, null, "不许拿命中去冒充一次正常退出");
  const texts = (await pendingOf(taskId)).map((m) => m.text).join("\n");
  assert.match(texts, /OFFLINE_READY/, "那一行本身要送到任务头上");
  assert.match(texts, /等到了约定的那一行/, "结束通知跟库里那句话同源");
  console.log("✓ 先 attach 再判「进程还在不在」那条真实接回顺序：排干读到的命中也折进结局");
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

console.log("✓ 哨兵跨重启：接回活着的、补完停服期间跑完的、两条收尾都把证据折进结局 均受回归保护");
await teardown();
