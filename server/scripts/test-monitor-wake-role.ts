// 哨兵醒来时**叫哪条会话**。
//
// 一个任务同时可以有两条会话:执行者那条(`single`)和审查者那条(`reviewer`——审查是旁路
// 回合,跑在自己的会话上)。哨兵唯一的出口是「唤醒这个任务」,而唤醒哪一条由待发送消息的
// `session_role` 决定,缺省 `single`。
//
// 不记来源的后果很安静:审查者挂的哨兵醒来时叫的是**执行者**——那一轮既续不上审查(审查链
// 还停在 reviewing 等它续跑),又凭空让执行者跑了一轮。用户 2026-10-16 问的「审查应该停在
// 这等唤醒」的后半截就是它:停住了,醒来却叫错了人,看上去还是「审查没续上」。
import assert from "node:assert/strict";
import { eq } from "drizzle-orm";
import {
  db, monitors, root, schema, sessions, tasks, makeTask, now, pendingOf, startMonitor, stopMonitor, until, teardown,
} from "./monitors-fixture.js";
import { inspectProcess } from "../src/proc.js";

const { monitorSourceGate, monitorWakeCheckpoint, monitorWakeGate } = await import("../src/monitor-session.js");

/** 「起哨兵这一刻,活着的那条会话是什么角色」——创建闸顺带回答的那一问。 */
const sourceRole = async (taskId: string, status = "running"): Promise<string | null> =>
  (await monitorSourceGate({ id: taskId, status, archived: false })).role;
const { deliveryOptions, deliveryVerdict } = await import("../src/pending-verdict.js");

/** 一个**活着的**进程身份:本进程自己。pid 会被复用,所以启动时刻必须一起给。 */
const livePid = { pid: process.pid, startedAt: inspectProcess(process.pid)?.startedAt ?? null };
/** 一个**早就没了**的进程身份。pid 极大 = 系统里不会有,启动时刻也对不上。 */
const deadPid = { pid: 999_999, startedAt: "Thu Jan  1 00:00:00 1970" };

async function addSession(
  id: string, taskId: string, role: string, who: { pid: number; startedAt: string | null },
): Promise<void> {
  await db.insert(sessions).values({
    id, taskId, role, agentType: "claude", executor: "claude@test",
    cwd: root, startedAt: now(), agentPid: who.pid, agentStartedAt: who.startedAt,
  });
}

// ── ① 审查回合里起的哨兵:来源认成 reviewer ──────────────────────────────────
{
  const taskId = await makeTask();
  // 执行者那条会话的进程**上一轮就结束了**(这正是审查旁路回合跑起来时的真实样子)。
  await addSession("s-impl", taskId, "single", deadPid);
  await addSession("s-review", taskId, "reviewer", livePid);

  assert.equal(await sourceRole(taskId), "reviewer",
    "起哨兵这一刻活着的是审查会话,来源就该认成 reviewer");

  const started = await startMonitor({
    taskId, command: 'echo "套件跑完了"', description: "等套件", timeoutMs: 60_000,
  });
  assert.ok(started.ok, `哨兵应该起得来：${started.ok ? "" : started.error}`);
  const monitorId = started.ok ? started.monitor.id : "";
  const row = (await db.select().from(monitors).where(eq(monitors.id, monitorId))).at(0)!;
  assert.equal(row.sourceRole, "reviewer", "哨兵行要记下是哪条会话起的");

  // ② 它推的事件,入队时必须带着这个角色 —— 否则投递按默认的 single 叫执行者。
  await until("事件入队", async () => (await pendingOf(taskId)).length > 0);
  const [queued] = await pendingOf(taskId);
  assert.equal(queued!.origin, `monitor:${monitorId}`, "这条待发送消息应该是这个哨兵推的");
  assert.equal(queued!.sessionRole, "reviewer", "哨兵事件要叫醒起它的那条会话,不是默认的执行者");
  // ③ 投递参数拼装那一层也得把它带出去(continueTask 认的就是这个字段)。
  assert.equal(deliveryOptions(queued!).sessionRole, "reviewer", "投递时要把角色传给 continueTask");

  // 等它自己跑完并把收尾事件也推完,再往下走:fixture 的 teardown 对哨兵是**撒手不杀**
  // （它们本来就该活过 ash）,这一步不等的话,收尾那一推会落在关库之后刷一串 stack trace。
  await until("哨兵自己跑完并收尾", async () => {
    const after = (await db.select().from(monitors).where(eq(monitors.id, monitorId))).at(0);
    const queue = await pendingOf(taskId);
    return after?.status === "exited" && queue.some((m) => m.text.includes("【哨兵结束】"));
  });
}

// ── ④ 执行回合里起的:还是老样子 ─────────────────────────────────────────────
{
  const taskId = await makeTask();
  await addSession("s-impl-2", taskId, "single", livePid);
  assert.equal(await sourceRole(taskId), "single", "执行回合里起的就认执行者");
}

// ── ⑤ 认不出来时**退回默认**,不猜 ───────────────────────────────────────────
{
  // 一条活会话都没有(所有进程都结束了)。
  const idle = await makeTask();
  await addSession("s-idle", idle, "single", deadPid);
  assert.equal(await sourceRole(idle), null, "没有活会话就说不知道");

  // 两条都活着:分不清是谁调的 start_monitor,猜一个还不如退回默认。
  const both = await makeTask();
  await addSession("s-both-1", both, "single", livePid);
  await addSession("s-both-2", both, "reviewer", livePid);
  assert.equal(await sourceRole(both), null, "两条会话都活着时不许猜");

  // 团队/duet 那些角色不在可唤醒的两种里,同样退回默认。
  const team = await makeTask({ mode: "team" });
  await addSession("s-lead", team, "lead", livePid);
  assert.equal(await sourceRole(team), null, "不在 single/reviewer 之列的角色不表达");
}

// ── ⑥ 审查进行中：终态任务上照样挂得上 ──────────────────────────────────────
//
// 自由工作流的审查跑在一个**已经 done 的任务**上（旁路回合，终态原样不动）。只看 status
// 的话审查者一个哨兵都挂不上 —— 而它要等的那件事（跑一遍全量测试）恰恰最需要哨兵。实测
// 后果就是它退而求其次用了 claude 内置的 Monitor，那个活不过这一回合（Bp2LkwfRO37A）。
{
  const taskId = await makeTask({ status: "done" });
  await addSession("s-rev-done", taskId, "reviewer", livePid);
  const view = { id: taskId, status: "done", archived: false };

  // 没有审查在跑：照旧拒 —— 这条豁免只给「审查这件事还没完」，不是把终态闸拆了。
  const denied = await startMonitor({ taskId, command: 'echo "x"', description: "不该起得来" });
  assert.equal(denied.ok, false, "任务终态、又没有审查在跑时，哨兵仍然挂不上");
  assert.equal(denied.ok ? 0 : denied.status, 409, "拒绝要给 409");
  assert.ok(await monitorWakeGate(view, null) !== null, "出口那道闸同理：没有审查就不放行");

  await db.insert(schema.freeReviewRuns).values({
    id: "rev-1", taskId, reviewerName: "claude@test", agentType: "claude",
    checkMode: "logic", status: "reviewing", createdAt: now(), updatedAt: now(),
  });

  // 入口放行。命令故意**什么都不输出**：一旦有事件入队,投递链路会当场判定「终态+审查
  // 在跑 = 该发」,然后真去拉一个 agent 续审查会话 —— 那是生产里正确的后半截,但台子上
  // 不该真起 claude（见 memory「测试脚本会真拉起 agent」）。所以这里只验闸,事件入队与
  // 带角色那两条由上面 ② 段在一个 running 任务上覆盖。
  const allowed = await startMonitor({
    taskId, command: "sleep 30", description: "审查者等套件", timeoutMs: 60_000,
  });
  assert.ok(allowed.ok, `审查进行中就该挂得上：${allowed.ok ? "" : allowed.error}`);
  const monitorId = allowed.ok ? allowed.monitor.id : "";
  const row = (await db.select().from(monitors).where(eq(monitors.id, monitorId))).at(0)!;
  assert.equal(row.sourceReviewRun, "rev-1", "靠审查豁免挂上的哨兵要记住是哪一次审查放它进来的");
  // 出口（pushToTask）与唤醒前最后一道（monitorWakeGuard）用的是同一个判据函数,而且问的是
  // **起它的那一次**审查还在不在,不是「这个任务上有没有任意一条在跑」。
  assert.equal(await monitorWakeGate(view, { reviewRun: "rev-1" }), null, "审查进行中，哨兵事件的出口也要放行");
  assert.ok(await monitorWakeGate(view, { reviewRun: "rev-别的一次" }) !== null,
    "别的审查在跑不等于这条哨兵还该唤醒任务");

  // 归档不吃这条豁免：任务都被收走了，审查链也没有续下去的地方。
  assert.ok(await monitorWakeGate({ ...view, archived: true }, { reviewRun: "rev-1" }) !== null,
    "归档任务上，审查在跑也不放行");

  // 投递那一层同理：来源审查还在跑（`monitorSource: "live"`）时，不许当成「任务都结束了
  // 还醒什么」取消掉；而它一旦失效（`stale`），终态与否都要作废（见 pending-verdict）。
  const message = { mode: "queued", sendAt: now(), origin: `monitor:${monitorId}` };
  const taskView = { mode: "single", status: "done", archived: false };
  assert.notEqual(
    deliveryVerdict(message, { ...taskView, monitorSource: "live" }, new Date()).action, "cancel",
    "审查进行中，哨兵事件不该在投递口被取消");
  assert.equal(
    deliveryVerdict(message, { ...taskView, monitorSource: "stale" }, new Date()).action, "cancel",
    "审查结束之后，终态任务上的哨兵事件照旧取消");

  // 收尾：先让审查「结束」,再停哨兵 —— 这样它的收尾事件在出口被丢掉,不会在拆台子的同时
  // 触发一次真投递。
  await db.update(schema.freeReviewRuns)
    .set({ status: "done" }).where(eq(schema.freeReviewRuns.id, "rev-1"));
  await stopMonitor(monitorId, "回归用完了");
  await until("哨兵停干净", async () => {
    const after = (await db.select().from(monitors).where(eq(monitors.id, monitorId))).at(0);
    return after?.status === "stopped" && (await pendingOf(taskId)).length === 0;
  });
}

// ── ⑦ 被叫醒的那一轮要带上 agent 自己留下的交代 ──────────────────────────────
//
// `start_monitor` 许诺 agent「这一轮用 pause_task 收尾,resumePrompt 写清被叫醒后该干什么」。
// 哨兵事件走的是 byBackend 投递,而消费检查点那一条只认真人消息 —— 不补这一手,agent 收到
// 的只有一行事件,而那段交代会永远留在库里,把任务钉在「在等续跑」上(派审/预约/修复/预览
// 整排按钮都被那条门禁灰掉)。
{
  const taskId = await makeTask({ status: "paused" });
  const checkpoint = "套件绿了就接着做 tts 那一段";
  await db.update(tasks).set({ resumePrompt: checkpoint }).where(eq(tasks.id, taskId));
  const msg = {
    id: "msg-wake-role", taskId, text: "【哨兵】SUITE_GREEN",
    origin: "monitor:m-1", checkpointTaken: null as string | null,
  };
  await db.insert(schema.scheduledMessages).values({
    ...msg, attachments: "[]", mode: "queued", status: "pending", sendAt: now(), createdAt: now(),
  });
  const taskRow = async () => (await db.select().from(tasks).where(eq(tasks.id, taskId))).at(0);

  assert.equal(await monitorWakeCheckpoint({ ...msg, origin: null }), null,
    "不是哨兵推的消息,检查点不归它消费");

  const hit = await monitorWakeCheckpoint(msg);
  assert.ok(hit, "哨兵事件 + 任务挂着交代,就该带上它");
  assert.match(hit.text, /套件绿了就接着做 tts 那一段/, "交代原文要拼进这一轮的输入");
  assert.match(hit.text, /SUITE_GREEN/, "事件本身当然也还在");

  // **就地取走**（CAS）：留到「送达之后」才清的话，清不掉的那一次没有任何人会再来补 ——
  // 消息已 sent、交代还在，任务做完了仍被结算判成 paused（第 1 轮审查 F4 第 3 种）。
  assert.equal((await taskRow())?.resumePrompt, null, "读到就该取走,否则任务永远「在等续跑」");

  assert.equal(await monitorWakeCheckpoint(msg), null,
    "已经取走了就没有第二次（拿着那份过期投影再来也不行）");

  // 一个字都没送出去时要放回原位（投递侧在未送达的每条出路上调它）。
  await hit.restore();
  assert.equal((await taskRow())?.resumePrompt, checkpoint,
    "没送出去就得把交代放回去,清了不回写就是永久丢失");

  // 落账那一半落不下去时,取走也不许生效:否则那段交代只活在返回值这个内存字符串里
  // （第 2 轮审查 F4 要消掉的正是这个形状）。
  assert.equal(await monitorWakeCheckpoint({ ...msg, id: "msg-不存在" }), null,
    "消息行都不在了,这一轮不带交代");
  assert.equal((await taskRow())?.resumePrompt, checkpoint, "更不许把它从任务行上取走");
}

// ── ⑧ 「预约审查还在等什么」要说得出口 ───────────────────────────────────────
//
// 执行者起了哨兵、用 pause_task 停在检查点时,预约审查本来就不该开跑(它要看的是这件事
// 落地之后的工作区)。但等待态那条路原先一个字都不写,界面上只剩一个亮着的「已预约审查」
// 而审查迟迟不开始 —— 用户只能得出「预约坏了」(用户 2026-10-16 指出)。
{
  const taskId = await makeTask({ status: "paused" });
  const { reservationWaitReason } = await import("../src/free-review-reservations.js");
  const { liveMonitorSummary } = await import("../src/monitor-session.js");

  assert.match(
    await reservationWaitReason({ id: taskId, resumePrompt: "等套件" }),
    /检查点/, "没挂哨兵时说的是「停在检查点等续跑」");
  assert.match(
    await reservationWaitReason({ id: taskId, question: "选哪个方案？" }),
    /答复/, "挂着提问时说的是「等你答复」");

  const row = (id: string, description: string, status: string) => ({
    id, taskId, kind: "ash", command: "sleep 30", description, cwd: root, status,
    logPath: `${root}/${id}.log`, readOffset: 0, events: 0,
    startedAt: now(), expiresAt: now(), sourceLifetime: "bounded",
  });
  await db.insert(monitors).values([
    row("mw-1", "等全量 unittest 跑完", "running"),
    row("mw-2", "等 web 产物构建出来", "running"),
    // 已经结束的不算「在等」,内置 Monitor 的只读投影也不算（它唤不醒任何人）。
    { ...row("mw-3", "早就停了的那个", "exited") },
    { ...row("mw-4", "claude 自带的那个", "running"), kind: "claude" },
  ]);

  const live = await liveMonitorSummary(taskId);
  assert.equal(live.count, 2, "只数还在盯着的 ash 哨兵");
  const reason = await reservationWaitReason({ id: taskId, resumePrompt: "等套件" });
  assert.match(reason, /2 个哨兵/, "等待原因里要说清在等几个哨兵");
  assert.match(reason, /等全量 unittest 跑完/, "还要说出它在盯什么,否则用户仍然不知道在等什么");
}

await teardown();
console.log("✓ 哨兵与审查：醒来叫审查会话 / 角色跟着行走到投递参数 / 认不出来退回默认 / 审查进行中终态任务上挂得上 / 叫醒时带回 pause 留下的交代 / 预约审查说得出在等哪几个哨兵");
