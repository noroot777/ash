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
import { endConditionHit, neverExitsOnItsOwn, parseEndCondition } from "@ash/shared/monitor-end-condition";
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
// ── ⑦b 结束条件的**闸**：命令自己不会结束、又没给结束条件 ⇒ 一个字都不许跑 ────────
// 用户 2026-10-21 问的是「你能保证 agent 一定会加吗」——不能，所以不靠自觉靠闸。判据在
// shared（前端表单用的是同一份），三条出路各验一次：改写命令 / 给 stopWhen / 明说盯到到期。
{
  // 判据本身：误判的代价不对称（拦错 = 本来做得成的事做不成），所以只认明确的那几种。
  for (const [command, hit] of [
    ["tail -F build.log | grep --line-buffered ERROR", "tail -f/-F"],
    ["tail -f x.log", "tail -f/-F"],
    ["while true; do sleep 5; done", "while true / until false"],
    ["watch -n 5 ls", "watch"],
    ["inotifywait -m /tmp", "inotifywait -m"],
    // ↓ 第 1 轮审查 F3 实测的漏判，判据改成按结构看之后才认得出来
    ["tail -n 0 -F /dev/null", "tail -f/-F"],            // 开关不紧跟在命令词后面
    ["timeout 1 true; tail -F /tmp/x", "tail -f/-F"],    // 前一条的死线不传染给后一条
    ["stdbuf -oL tail -F build.log", "tail -f/-F"],      // 包一层的词是透明的
    ["/usr/bin/tail --follow=name build.log", "tail -f/-F"], // 带路径、长开关带值
    ["docker logs -f app", "docker logs -f"],
    // 引号里那个 `exit` 不是出路:这条循环真的永远不结束
    ["while true; do echo 'waiting for exit'; sleep 5; done", "while true / until false"],
  ] as const) assert.equal(neverExitsOnItsOwn(command), hit, `该判成不会自退：${command}`);
  for (const command of [
    "npm test",
    "timeout 600 tail -F build.log", // 自带死线
    "until grep -q DONE log; do sleep 5; done; tail -4 log", // 条件满足就跳出
    "while true; do grep -q DONE log && break; sleep 5; done", // 循环体里有 break
    "tail -20 build.log",
    // ↓ 第 1 轮审查 F3 实测的**误判**:这几条都会自己结束,拦下来等于把做得成的事拦死
    "printf '%s\\n' 'tail -F build.log'",   // 命中的是 printf 的参数
    "grep -rn 'tail -f' src",                // 同上:引号里的字不是执行节点
    "echo \"while true; do :; done\"",        // 同上:引号里的循环没人跑
    "timeout 5 tail -F build.log",           // 死线在同一条简单命令上
    "docker logs app",                       // 没有 -f
    "fswatch -1 ./build",                    // 等第一次事件就退
  ]) assert.equal(neverExitsOnItsOwn(command), null, `不许拦：${command}`);

  const taskId = await makeTask();
  const follower = "tail -F /tmp/ash-never.log | grep --line-buffered ERROR";
  const denied = await startMonitor({ taskId, command: follower, description: "没有结束条件的跟随器" });
  assert.equal(denied.ok, false, "跟随型命令没给结束条件时不许放行");
  if (!denied.ok) {
    assert.equal(denied.status, 409);
    assert.equal(denied.needsEndCondition, true, "这一档要带出去，前端表单据它长出那个选择");
    // 三条出路一条都不能少：少给一条，那一种合法意图就只能去照抄另一种（比如编一个永远
    // 不命中的正则来绕过闸）。
    assert.match(denied.error, /stopWhen/, "出路②");
    assert.match(denied.error, /untilExpiry/, "出路③");
    assert.match(denied.error, /EXIT=/, "出路①要给出可照抄的写法");
  }
  assert.equal((await listMonitors(taskId)).length, 0, "被拦下时一行都不许留，更不许起进程");

  // 用不了的条件 = 一个永远不会命中的条件，等于没设 —— 当场 400，别让它变成另一条干等的哨兵。
  for (const pattern of ["^(OK", "^(a+)+$", "OK|", "OK$FAILED"]) {
    const bad = await startMonitor({ taskId, command: follower, stopWhen: pattern });
    assert.equal(bad.ok, false, `用不了的结束条件要拒：${pattern}`);
    assert.equal(bad.ok ? 0 : bad.status, 400);
    if (!bad.ok) assert.match(bad.error, /不是正则|不在两头|空的/, `拒绝要说清为什么：${pattern}`);
  }

  // 两头的锚点是**合法**的，别跟上面那种混为一谈（`a$|b` = 行尾是 a 或出现 b）。
  const anchored = parseEndCondition("DONE$|^READY");
  assert.equal(anchored.ok, true, "两头的锚点要收");
  assert.deepEqual(anchored.ok ? anchored.cond : null, [
    { needle: "DONE", atStart: false, atEnd: true },
    { needle: "READY", atStart: true, atEnd: false },
  ]);

  // 出路③：明说「就是要盯到到期」就照原样放行。
  const forever = await startMonitor({ taskId, command: follower, description: "盯错误日志", untilExpiry: true });
  assert.equal(forever.ok, true, forever.ok ? "" : forever.error);
  if (forever.ok) {
    assert.equal(forever.monitor.stopWhen, null, "这一种没有结束条件，不许替它编一个");
    await stopMonitor(forever.monitor.id, "闸的用例跑完了");
  }
  // 不是跟随型的命令一个字都不问（闸不许顺手改掉正常路径）。
  const plain = await startMonitor({ taskId, command: "echo hi", description: "普通命令" });
  assert.equal(plain.ok, true, plain.ok ? "" : plain.error);
  if (plain.ok) await stopMonitor(plain.monitor.id, "闸的用例跑完了");
  console.log("✓ 结束条件闸：判据只认明确的几种、拦下时三条出路给全、三条出路各自真的走得通");
}
// ── ⑦c 结束条件的匹配**有计算上界**（第 1 轮审查 F1）────────────────────────────────
// 上一版收 JS 正则源文，`new RegExp` 编过就拿去 `.test`。编过只证明语法对：`^(a+)+$` 配上
// 41 个字符的一行就能回溯到停不下来，而这一笔跑在服务唯一那条线程上 —— 页面、停止按钮、
// 到期收尾一起卡住（审查实测：隔离子进程 2504ms 还没返回，同时安排的 100ms 定时器没执行）。
// 所以这一节钉两样：那种条件根本进不来（上面 ⑦b 已经拒掉），以及**服务里一条调用方正则都
// 不构造** —— 后者是结构锁，不靠「这次跑得挺快」。
{
  const src = readSource(join(HERE, "../../shared/src/monitor-end-condition.ts"));
  assert.doesNotMatch(
    src,
    /^\s*(?:return |const |let )?.*new RegExp\(/m, // 只认语句，注释里提这个名字不算
    "结束条件不许拿调用方给的串去构造正则：编得过不等于跑得完（见该文件头 ①）",
  );
  // 字面量匹配:同一个在正则下会爆炸的输入，这里必须是线性的。给一个很松的预算（50ms），
  // 它要的只是「不是指数级」——真爆炸的那种在这台机器上 2.5 秒都回不来。
  const parsed = parseEndCondition("^DONE|FAILED$|SWEEP_EXIT=");
  assert.equal(parsed.ok, true);
  const cond = parsed.ok ? parsed.cond! : [];
  const nasty = `${"a".repeat(40)}!`;
  const lines = Array.from({ length: 200 }, () => nasty);
  const t0 = Date.now();
  assert.equal(endConditionHit(lines, cond), null, "没命中就是没命中");
  assert.ok(Date.now() - t0 < 50, `匹配必须是线性的，实际 ${Date.now() - t0}ms`);
  // 三种锚点各自的语义（锚点错了会把「行首是」读成「出现过」，那是另一个条件）。
  assert.equal(endConditionHit(["xx DONE"], cond), null, "^DONE 只认行首");
  assert.equal(endConditionHit(["DONE now"], cond), "DONE now", "行首命中");
  assert.equal(endConditionHit(["FAILED xx"], cond), null, "FAILED$ 只认行尾");
  assert.equal(endConditionHit(["went FAILED"], cond), "went FAILED", "行尾命中");
  assert.equal(endConditionHit(["log: SWEEP_EXIT=1 done"], cond), "log: SWEEP_EXIT=1 done", "不带锚点的在任意位置");
  console.log("✓ 结束条件的匹配有计算上界：服务里不构造调用方正则，锚点语义各自正确");
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
