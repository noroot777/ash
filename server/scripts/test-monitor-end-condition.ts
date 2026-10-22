// 哨兵的**结束条件**（`stopWhen`）这一块的回归:它什么时候算完、谁来保证它一定给得出。
//
// 从 test-monitors.ts 拆出来的（全局约定:单文件不超过 700 行）。台子同一份（见
// monitors-fixture.ts），所以这几节和那边的用例可以互不相干地各自跑。钉住的立论:
//
//  ① 约定的那一行一出现就收工（这是「命令自己永远不会结束」那一类的唯一非到期出路）
//  ② 库里存着一条**这一版读不出来**的条件 ⇒ 出声,不静默降级、也不许界面替它背书
//  ③ 命中那一行哪怕排在摘要之外,也必须出现在推给 agent 的那条消息里
//  ④ 约定的字样赶在到期前最后一批到 ⇒ 结局写成命中,不许写成「盯满了时长」
//
// **创建那一刻的闸和判据在 test-monitor-end-condition-gate.ts**（同一批拆出来的）:没给结束
// 条件就一个字都不跑、判据只认明确的几种、匹配与结构判据的计算上界。
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { endConditionNote } from "@ash/shared/monitor-end-condition";
import { readSource } from "../../scripts/read-source.mjs";
import {
  HERE, root, db, schema, isPidAlive,
  startMonitor, stopMonitor, getMonitor, reattachMonitors, detachAllMonitors,
  until, now, makeTask, pendingOf, teardown,
} from "./monitors-fixture.js";

const { monitors } = schema;

// ── ③c 约定的那一行一出现就收工（用户 2026-10-21 要的「活一结束就唤醒」）────────
// 跟随型命令（`tail -F`、`while true`）自己永远不会结束，于是「命令结束」那条唤醒条件在它
// 身上形同虚设，只剩干等到期。这一节钉住那条非到期出路真的通：命中那一行**照常推给 agent**
// （它多半就是结果本身），哨兵随即落 `matched` 收工，而不是等满时长。
{
  const taskId = await makeTask();
  const feed = join(root, "feed.mjs");
  // 先吐两行无关的，再吐那条约定的行，然后**继续活着**：不这么写的话，进程自己退出也会
  // 让哨兵结束，就分不清是「命中」还是「它自己跑完了」。
  writeFileSync(feed, `console.log("第 1 步");
setTimeout(() => console.log("第 2 步"), 200);
setTimeout(() => console.log("SWEEP_EXIT=0 全跑完了"), 500);
setInterval(() => {}, 1000);
`);
  const started = await startMonitor({
    taskId,
    command: `${JSON.stringify(process.execPath)} ${JSON.stringify(feed)}`,
    description: "盯到收尾行为止",
    stopWhen: "SWEEP_EXIT=",
  });
  assert.equal(started.ok, true, started.ok ? "" : started.error);
  const monitorId = started.ok ? started.monitor.id : "";
  const pid = started.ok ? started.monitor.pid! : 0;
  assert.equal(started.ok ? started.monitor.stopWhen : null, "SWEEP_EXIT=", "结束条件要带回给调用方");

  await until("命中之后落 matched", async () => (await getMonitor(monitorId))?.status === "matched");
  const row = (await db.select().from(monitors).where(eq(monitors.id, monitorId))).at(0)!;
  assert.match(row.endedReason ?? "", /等到了约定的那一行/, "结束原因要说清是等到了，不是被谁停的");
  assert.match(row.endedReason ?? "", /SWEEP_EXIT=0/, "把命中的那一行带上，省得还要去翻日志");
  // **命中那一行本身必须送到**：收工不能把结果一起吞掉——它正是 agent 要的东西。
  const [queued] = await pendingOf(taskId);
  assert.ok(queued, "命中之后要留一条消息给 agent");
  assert.ok(queued!.text.includes("SWEEP_EXIT=0 全跑完了"), `命中的那一行要推给 agent：${queued!.text}`);
  assert.ok(queued!.text.includes("【哨兵结束】"), "收尾通知紧跟在后面");
  await until("进程真的被收掉", async () => !isPidAlive(pid));
  console.log("✓ 命中约定的那一行：那一行照常送达、哨兵当场收工、进程被收掉");
}
// ── ⑦g 库里存着一条**这一版读不出来**的结束条件 ⇒ 出声，不静默降级（第 2 轮审查 F2）──
// 结束条件的语义换过一轮（上一版收 JS 正则源文，这一版是字面量候选）。`^(READY|FAILED)$`
// 在旧语义下合法、今天解析不出来，而运行时对它的处置是「当没有结束条件」—— 静默降级之后
// 库里明明记着一条结束条件、卡片照旧念「…就收工」，哨兵却只会盯到到期（审查实测：READY
// 已经吐出来、status 仍是 running、events=1）。
{
  const taskId = await makeTask();
  const feed = join(root, "legacy.mjs");
  // **自毁兜底**：这一节会在进程内走一遍真实接回（`detachAllMonitors` + `reattachMonitors`），
  // 而接回那一刻身份未必认得回来（pid 边条核实不了就按设计不下刀，责任留在账上）—— 于是
  // 点停只写状态、台子 teardown 也收不走它，一个 `setInterval` 就永远留在机器上了（实测:
  // 跑完这节之后 `pgrep` 还能看到它）。活 30 秒足够这节用，之后它自己退。
  writeFileSync(feed, `setTimeout(() => console.log("READY"), 120);
const keep = setInterval(() => {}, 1000);
setTimeout(() => { clearInterval(keep); process.exit(0); }, 30000);
`);
  const started = await startMonitor({
    taskId,
    command: `${JSON.stringify(process.execPath)} ${JSON.stringify(feed)}`,
    description: "旧语义的结束条件",
    stopWhen: "^READY",
  });
  assert.equal(started.ok, true, started.ok ? "" : started.error);
  const monitorId = started.ok ? started.monitor.id : "";
  // 创建闸不会放这种值进来，所以只有一种来源：**从库里接回来的**。照这个来源造现场。
  await db.update(monitors).set({ stopWhen: "^(READY|FAILED)$" }).where(eq(monitors.id, monitorId));
  await detachAllMonitors();
  const errs: string[] = [];
  const realErr = console.error;
  console.error = (...a: unknown[]) => { errs.push(a.map(String).join(" ")); };
  try {
    await reattachMonitors();
  } finally {
    console.error = realErr;
  }
  assert.ok(
    errs.some((e) => /读不出来的结束条件/.test(e)),
    `接回一条读不出来的条件必须出声：${errs.join(" | ") || "（一声没出）"}`,
  );
  // 处置照旧是「当它没有结束条件」：READY 照常推给任务，但**不许猜一个语义**替它收工。
  await until("READY 照常送到", async () =>
    (await pendingOf(taskId)).some((m) => m.text.includes("READY")));
  assert.equal((await getMonitor(monitorId))?.status, "running", "读不出来 ⇒ 不提前收工，而不是瞎猜");
  await stopMonitor(monitorId, "⑦g 用例跑完了");
  console.log("✓ 读不出来的旧结束条件：接回时当场出声，处置仍是「当没有条件」而不是瞎猜");
}
// ── ⑦h 命中那一行排在第 41 行往后，也必须在消息里（第 2 轮审查 N2）──────────────────
// 单批只列前 40 行，而命中那一行多半就是 agent 要的结果本身。它被省略掉的话，agent 只会
// 收到一句「等到了约定的那一行」加一批看不出所以然的开头几行。
{
  const taskId = await makeTask();
  const feed = join(root, "deep-hit.mjs");
  writeFileSync(feed, `for (let i = 0; i < 60; i++) console.log("noise " + i);\nconsole.log("SWEEP_EXIT=0");\nsetInterval(() => {}, 1000);\n`);
  const started = await startMonitor({
    taskId,
    command: `${JSON.stringify(process.execPath)} ${JSON.stringify(feed)}`,
    description: "命中那一行排在很后面",
    stopWhen: "^SWEEP_EXIT=",
  });
  assert.equal(started.ok, true, started.ok ? "" : started.error);
  const monitorId = started.ok ? started.monitor.id : "";
  await until("等到了就收工", async () => (await getMonitor(monitorId))?.status === "matched");
  const texts = (await pendingOf(taskId)).map((m) => m.text).join("\n");
  assert.match(texts, /SWEEP_EXIT=0/, "命中那一行一个字都不能被摘要吃掉");
  assert.match(texts, /约定的那一行在后面/, "要说清它为什么单独列出来");
  if (started.ok) await until("进程被收掉", async () => !isPidAlive(started.ok ? started.monitor.pid! : 0));
  console.log("✓ 命中那一行排在摘要之外时，照旧出现在推给 agent 的那条消息里");
}
// ── ⑦i 约定的字样赶在到期前最后一批到 ⇒ 结局不许写成「盯满了时长」（第 1 轮审查 N1）──────
// 收尾所有权是单一的:到期先占到槽位,排干时才读到那一行 —— 那一笔命中只能合并等它,于是库里
// 落的是 expired「盯满了约定的时长」,而用户会把这句读成「约定的字样一直没出现」（审查实测:
// 字样比期限早 209ms,正文里 READY 和结束通知都在,状态仍是 expired）。所有权照旧只有一个,
// 改的是**持有者落终态之前把排干阶段那条证据折叠进来**（见 monitor-finish.ts 的 `foldHit`）。
{
  // **这一幕的前提本身是个竞速,所以先验前提再下断言**:子进程启动要几十到几百毫秒,机器一忙
  // （刚跑完另一份回归、还有残留进程在转）那一行就可能压根没来得及赶在收尾之前到 —— 那时落
  // expired 是对的,断言它 matched 等于在量机器负载。
  //
  // 前提判据是**那一行有没有被送出去**,不是「日志里有没有它」。后者是上一版的写法,而它漏掉了
  // 一整类:日志是在 `until(落了终态)` 之后读的,那一行完全可以是**收尾之后**才落盘的 —— 于是
  // 「日志里有 READY」成立、而收尾那一刻排干根本没读到它,断言照常失败（2026-10-22 实测到一次:
  // expired / 盯满了约定的时长,而日志里 READY 在）。送达与否才等价于「排干时读到了它」:
  // 折叠的那份证据正是排干那一笔 `pushLines` 推出去的东西（见 monitor-finish.ts 的 `foldHit`）。
  // 而「送到了、却仍写成 expired」恰恰就是审查实测的那个现场,所以这个判据不会把缺陷挡掉。
  let row: typeof monitors.$inferSelect | null = null;
  let texts = "";
  for (let attempt = 1; attempt <= 4 && !row; attempt += 1) {
    const taskId = await makeTask();
    const feed = join(root, `late-ready-${attempt}.mjs`);
    // 期限有 1 秒地板（monitors.ts 的 `EXPIRY_FLOOR_MS`）,所以这一行**贴着期限**写出来:它落进
    // 缓冲之后那 300ms 的冲刷窗口来不及先把它推出去,到期先占到收尾槽位 —— 正是审查的那个现场。
    writeFileSync(feed, `setTimeout(() => console.log("READY"), 960);\nsetInterval(() => {}, 1000);\n`);
    const started = await startMonitor({
      taskId,
      command: `${JSON.stringify(process.execPath)} ${JSON.stringify(feed)}`,
      description: "字样贴着期限到",
      stopWhen: "^READY$",
      timeoutMs: 1000,
    });
    assert.equal(started.ok, true, started.ok ? "" : started.error);
    const monitorId = started.ok ? started.monitor.id : "";
    await until("落了终态", async () => (await getMonitor(monitorId))?.status !== "running");
    const settled = (await db.select().from(monitors).where(eq(monitors.id, monitorId))).at(0)!;
    if (started.ok) await until("进程被收掉", async () => !isPidAlive(started.ok ? started.monitor.pid! : 0));
    const sent = (await pendingOf(taskId)).map((m) => m.text).join("\n");
    if (!sent.includes("READY")) {
      console.log(`  （第 ${attempt} 轮前提没成立:那一行没赶在收尾之前送出去${
        readFileSync(settled.logPath, "utf8").includes("READY") ? "（收尾之后才落盘）" : "（压根没写出来）"
      },重来）`);
      continue;
    }
    row = settled;
    texts = sent;
  }
  assert.ok(row, "四轮都没能让那一行赶在收尾之前送出去 —— 台子前提不成立,不是产品问题");
  assert.equal(row.status, "matched", `字样到了就不许写成到期：${row.status} / ${row.endedReason}`);
  assert.match(row.endedReason ?? "", /等到了约定的那一行/, "结束原因要说清是等到了");
  assert.match(row.endedReason ?? "", /READY/, "把命中的那一行带上");
  assert.equal(row.endedBy, "system", "不是谁主动停的");
  assert.match(texts, /READY/, "命中那一行照常送到");
  // ↑ 这几条断言在「冲刷先赢」那种排序下同样成立（那时命中自己就是收尾的持有者）—— 所以
  //   折叠这一道另加结构锁:它是「所有权单一」之下唯一的修法,一改就该当场红。
  const src = readSource(join(HERE, "../src/monitor-finish.ts"));
  assert.match(src, /const foldHit = /, "排干阶段的结束证据必须在落终态前折叠进来");
  assert.match(
    src, /!opts\.abandon && opts\.endedBy !== "actor"/,
    "用户点的停不许被折叠改写（第 21 轮审查 F2:停止赢了就是赢了）",
  );
  assert.match(src, /endedBy,$/m, "`endedBy` 要跟着折叠走，不然 matched 会带着「推满上限」的来源");
  console.log("✓ 字样贴着期限到：结局写成命中而不是到期，用户点的停不受折叠影响");
}
console.log("✓ 结束条件在运行期：一出现就收工 / 读不出来的不静默降级 / 命中那一行不被摘要吃掉 / 字样贴着期限到也写成命中 均受回归保护");
await teardown();
