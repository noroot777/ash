// 哨兵醒来时**叫哪条会话**。
//
// 一个任务同时可以有两条会话:执行者那条(`single`)和审查者那条(`reviewer`——审查是旁路
// 回合,跑在自己的会话上)。哨兵唯一的出口是「唤醒这个任务」,而唤醒哪一条由待发送消息的
// `session_role` 决定,缺省 `single`。
//
// 不记来源的后果很安静:审查者挂的哨兵醒来时叫的是**执行者**——那一轮既续不上审查(审查链
// 还停在 reviewing 等它续跑),又凭空让执行者跑了一轮。用户 2026-10-16 问的「审查应该停在
// 这等唤醒」的后半截就是它:停住了,醒来却叫错了人,看上去还是「审查没续上」。
//
// **来源不靠「此刻哪个 agent 进程还活着」猜**(第 7 轮审查 F2):那一版在 ps 抽一下、审查者
// 已经 pause、或者两条会话都查得到活时一律判不出角色,然后静默按默认叫执行者。现在创建入口
// 必须交上一份**已核验**的来源(`MonitorCaller`),角色取**运行时事实** `turnRole`;两截都答
// 不出来时要么由调用方显式指定唤醒目标,要么拒绝这次创建 —— 所以这一份也钉「拒」的那几条。
import assert from "node:assert/strict";
import { eq } from "drizzle-orm";
import {
  db, inTurnCaller, monitors, reviewInFlight, root, runs, schema, tasks, makeTask, now, pendingOf,
  startMonitor, stopMonitor, until, teardown,
} from "./monitors-fixture.js";
import type { MonitorCaller } from "../src/monitor-session.js";

const { monitorSourceGate, monitorWakeCheckpoint, monitorWakeGate } = await import("../src/monitor-session.js");
const { serialize } = await import("../src/monitors.js");
const { deliveryOptions, deliveryVerdict } = await import("../src/pending-verdict.js");

/** 「这个哨兵是谁挂的」——创建闸顺带回答的那一问。来源由调用方交上来(入口已核验)。 */
const sourceGate = async (taskId: string, caller: MonitorCaller, status = "running") => {
  // `activeTurnToken` 要**读库里那一份**:落库处核对的就是它(排队结束后的事实),台子上
  // 自己拼一个就等于把 F2 要钉的那一问绕过去了。
  const task = (await db.select().from(tasks).where(eq(tasks.id, taskId))).at(0);
  return monitorSourceGate({ id: taskId, status, archived: false, activeTurnToken: task?.activeTurnToken ?? null }, caller);
};
const sourceRole = async (taskId: string, caller: MonitorCaller, status = "running"): Promise<string | null> =>
  (await sourceGate(taskId, caller, status)).role;

/**
 * agent 在自己回合里调的那一路:回合凭据已核验,**而且被核验的那一轮连令牌带角色一起带下去**
 * (入口做的就是这件事,见 monitor-routes.ts 的 `callerOf`)。
 */
const inTurn = (taskId: string) => inTurnCaller(taskId);
/** 人在界面上点的那一路(或别的任务的 agent):它不是这个任务的任何一条会话。 */
const byUser: MonitorCaller = { kind: "external" };

// ── ① 审查回合里起的哨兵:来源认成 reviewer ──────────────────────────────────
{
  const taskId = await makeTask();
  // 审查是**旁路回合**:它跑起来的时候,回合锁上记着的角色就是 reviewer(`claimTurn` 落的,
  // 审查结论的归属检查 `report_stage` 读的也是这一份)。台子**占到底不放**:放锁会把
  // `continueWhenIdle` 排的回调放出去,那就真去拉一个 agent 了。
  //
  // 那次审查也必须真的在进行:来源在入口一次抓全(`verifiedTurn` 连 run/round 一起抓),而
  // **reviewer 回合却没有审查在进行**这一档现在是拒 —— 它绑出来的是「reviewer + 空来源」,
  // 出口按普通任务判、唤醒时丢掉审查者的执行器配置(第 9 轮审查 F1 第 4 条)。
  await reviewInFlight(taskId, "run-wake-role");
  runs.claimTurn(taskId, "reviewer", { run: "run-wake-role", round: 1 });

  assert.equal(await sourceRole(taskId, await inTurn(taskId)), "reviewer",
    "这次调用来自本任务当前这一回合,而这一回合是审查者 —— 来源就该认成 reviewer");

  const started = await startMonitor({
    taskId, command: 'echo "套件跑完了"', description: "等套件", timeoutMs: 60_000,
    caller: await inTurn(taskId),
  });
  assert.ok(started.ok, `哨兵应该起得来：${started.ok ? "" : started.error}`);
  const monitorId = started.ok ? started.monitor.id : "";
  const row = (await db.select().from(monitors).where(eq(monitors.id, monitorId))).at(0)!;
  assert.equal(row.sourceRole, "reviewer", "哨兵行要记下是哪条会话起的");
  assert.equal(row.sourceReviewRun, "run-wake-role", "连它属于哪一次审查一起记");
  assert.equal(row.sourceReviewRound, 1, "轮次一起记 —— run.id 跨轮复用");

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
  runs.claimTurn(taskId, "single");
  assert.equal(await sourceRole(taskId, await inTurn(taskId)), "single", "执行回合里起的就认执行者");
}

// ── ⑤ 答不出来时**不许静默当执行者**:要么说清,要么拒 ───────────────────────────
//
// 旧版这里把「退回默认」写成期望:没有活会话、两条都活着、ps 抽一下 —— 一律当执行者挂上去,
// 然后那条通知真的会把实现者叫起来烧一个回合(第 7 轮审查 F2)。「不知道」和「确定地不表达」
// 是两件事,下面逐条分开钉。
{
  // ⑤-a 这个任务上没有审查在进行 ⇒ 只有执行者一条线,按默认走**不构成猜测**。
  const plain = await makeTask();
  assert.equal(await sourceRole(plain, byUser), null, "没有第二条线时,默认就是唯一的答案");
  assert.equal((await sourceGate(plain, byUser)).blocked, null, "所以它照旧挂得上");

  // ⑤-b 非终态任务 + 审查在进行 + 没人说清 ⇒ **拒**,并告诉调用方「指定一个再来」。
  //   这一档恰恰是审查者按提示 pause 了一轮等外部结果、用户在面板上补挂一个哨兵的样子:
  //   一个 agent 进程都没有,靠活进程永远判不出来,而猜错的两种后果都不便宜。
  const paused = await makeTask({ status: "paused" });
  await reviewInFlight(paused, "run-ambiguous");
  const ambiguous = await sourceGate(paused, byUser, "paused");
  assert.match(ambiguous.blocked ?? "", /没说清哨兵醒来该叫谁/, "说不清要叫谁时必须拒");
  assert.equal(ambiguous.needsWake, true, "而且要让入口把「指定一个」这件事回给调用方");
  assert.equal(ambiguous.role, null, "更不许顺手记一个角色");
  const refused = await startMonitor({
    taskId: paused, command: "sleep 30", description: "说不清叫谁的", caller: byUser,
  });
  assert.equal(refused.ok, false, "创建入口也要拒 —— 不是记个默认角色就放进去");
  assert.equal(refused.ok === false && refused.needsWakeTarget, true, "拒的理由要能被前端识别");

  // ⑤-c 调用方说清了 ⇒ 按它绑,连轮次一起记。
  const picked = await sourceGate(paused, { kind: "external", wake: "reviewer" }, "paused");
  assert.equal(picked.blocked, null, "指定之后就挂得上");
  assert.equal(picked.role, "reviewer");
  assert.equal(picked.reviewRun, "run-ambiguous", "绑到那次审查上");
  assert.equal(picked.reviewRound, 1, "轮次一起记:run.id 跨轮复用,只有它认得出上一轮的遗留");

  // ⑤-d 自报了回合身份却核验不过 ⇒ **不是任何人**,不许退回默认。
  const bad = await sourceGate(plain, { kind: "unverified" });
  assert.match(bad.blocked ?? "", /回合凭据对不上/, "核验失败要拒,而不是当成执行者");
  assert.equal(bad.role, null);

  // ⑤-e 回合角色不在可唤醒的两种里(团队、duet、SCM 预占)⇒ 这是**确定的**「不表达」,
  //   照老样子退回默认 —— 它跟「不知道」不是一回事。
  const team = await makeTask({ mode: "team" });
  runs.claimTurn(team, "lead");
  assert.equal(await sourceRole(team, await inTurn(team)), null, "不在 single/reviewer 之列的角色不表达");
  assert.equal((await sourceGate(team, await inTurn(team))).blocked, null, "但照旧挂得上");

  // ⑤-f 自报是回合、**抓来源那一刻却没有回合在跑** ⇒ 拒,而且拒的是「那一轮已经不在了」。
  //
  //   凭据只证明了「是这个任务的 agent」。而来源必须出自一份**活着的回合身份**:令牌、角色、
  //   审查代次三样要么来自同一份 `TurnIdentity`,要么这次调用就代表不了任何一轮
  //   (第 10 轮审查 F1)。上一版这一档退成「说不清叫谁、指定一个再来」,可对 agent 那条路
  //   `wake` 根本不参与判定(权威角色优先),那句出路是条死路。
  //   生产里这一档也只有一种来法:那一轮真的过去了 —— 回合锁是在 agent 进程退出之后才放的,
  //   所以任何还能发出来的 MCP 调用,它的回合必然还占着(重启接回那一侧由 reattach 重新绑)。
  const settled = await makeTask({ status: "paused" });
  await reviewInFlight(settled, "run-settled");
  const stale = await sourceGate(settled, await inTurn(settled), "paused");
  assert.match(stale.blocked ?? "", /那一轮已经结束了|换了一轮/, "没有活着的回合身份就不许代表任何一轮");
  assert.equal(stale.role, null);
  assert.equal(stale.reviewRun, null, "更不许顺手绑上「现在正在进行的那次审查」");

  // ⑤-f(对照)**核验那一刻有回合**,排到它时那一轮的锁已经放了 ⇒ 照旧按那一轮的角色挂。
  //   这跟 ⑤-f 是两件事:那边是「提交时就没有回合」(谁提交的无从得知),这边是「提交时是
  //   审查者,它随后按提示 pause 收尾了这一轮」—— 而哨兵本来就是为了以后叫醒它才挂的。
  //   所以角色取**被核验那一刻**的,不回头再问一次 `turnRole`(那会得到 null)。
  const handedOff = await makeTask({ status: "paused" });
  await reviewInFlight(handedOff, "run-handed-off");
  runs.claimTurn(handedOff, "reviewer", { run: "run-handed-off", round: 1 });
  const reviewerCaller = await inTurn(handedOff);
  runs.releaseTurn(handedOff);                    // 审查者 pause 收尾了这一轮(令牌还没清)
  const kept = await sourceGate(handedOff, reviewerCaller, "paused");
  assert.equal(kept.blocked, null, "同一轮的令牌还对得上,就不该因为锁放了而拒");
  assert.equal(kept.role, "reviewer", "角色取被核验那一刻的那一轮,不是「现在是谁」");
  assert.equal(kept.reviewRun, "run-handed-off", "连它属于哪次审查一起记");

  // ⑤-g 显式指定了「叫实现者」却是终态任务 ⇒ 拒。审查豁免只对绑到审查上的那一种成立,
  //   否则挂出来的是一个注定在出口被拦掉、永远唤不醒谁的哨兵。
  const done = await makeTask({ status: "done" });
  await reviewInFlight(done, "run-done-task");
  const pointless = await sourceGate(done, { kind: "external", wake: "single" }, "done");
  assert.match(pointless.blocked ?? "", /任务已经结束/, "终态任务上叫实现者没有出路");
  // 同一个任务上不指定 ⇒ 唯一有出路的归属就是那次审查(它能挂上来就是审查豁免放它进来的)。
  assert.equal(await sourceRole(done, byUser, "done"), "reviewer",
    "终态 + 审查在跑:那次审查是唯一有出路的归属,这不是猜");

  // ⑤-h 指定了「叫审查」却没有审查在进行 ⇒ 拒,别记一个绑不上的角色。
  const noReview = await sourceGate(plain, { kind: "external", wake: "reviewer" });
  assert.match(noReview.blocked ?? "", /没有正在进行的审查/, "绑不上的审查不许记");

  // ⑤-i **权威角色是审查者、却没有审查在进行 ⇒ 同样拒**(第 9 轮审查 F1 第 4 条)。
  //   上一版这一档绑成「reviewer + 空来源」:空来源在事件出口按**普通任务**判资格,唤醒时
  //   `monitorWakeExecutor` 返回 null —— 原审查者的执行器配置整份丢掉(典型是 codex 审
  //   claude 写的代码,唤醒后另起一条 claude 的 reviewer 会话,上下文一个字都接不上)。
  //   外部显式指定 reviewer 本来就是拒的(⑤-h),权威角色这一档没有理由比它宽松。
  const orphanReviewer = await makeTask();
  runs.claimTurn(orphanReviewer, "reviewer");
  const noRun = await sourceGate(orphanReviewer, await inTurn(orphanReviewer));
  assert.match(noRun.blocked ?? "", /不在进行/, "审查者回合却没有那次审查 ⇒ 拒,不绑空来源");
  assert.equal(noRun.role, null, "更不许记一个绑不上的 reviewer");
  assert.equal(noRun.reviewRun, null);
  runs.releaseTurn(orphanReviewer);
}

// ── ⑥ 审查进行中：终态任务上照样挂得上 ──────────────────────────────────────
//
// 自由工作流的审查跑在一个**已经 done 的任务**上（旁路回合，终态原样不动）。只看 status
// 的话审查者一个哨兵都挂不上 —— 而它要等的那件事（跑一遍全量测试）恰恰最需要哨兵。实测
// 后果就是它退而求其次用了 claude 内置的 Monitor，那个活不过这一回合（Bp2LkwfRO37A）。
{
  const taskId = await makeTask({ status: "done" });
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

// ── ⑨ 创建入口:来源由**请求自己**交上来,核验在入口做 ─────────────────────────────
//
// 上面那些打的是闸函数,钉不住「来源从哪儿来」。而 F2 的现场恰恰在那一步:自用模式的
// authGate 直接给 SINGLE_ACTOR,端点只看 actor 的话永远取不到回合身份 —— 于是每一次手动
// 创建都成了「谁都不是」,再被静默当成执行者。这一段打的是真端点,中间件照自用模式那一档装。
{
  const { setActor, SINGLE_ACTOR } = await import("../src/auth/context.js");
  const { mountMonitorRoutes } = await import("../src/monitor-routes.js");
  const { Hono } = await import("hono");

  const api = new Hono();
  api.use("*", async (c, next) => { setActor(c, SINGLE_ACTOR); await next(); });
  mountMonitorRoutes(api);
  const app = new Hono();
  app.route("/api", api);
  const post = (taskId: string, body: Record<string, unknown>, headers: Record<string, string> = {}) =>
    app.request(`/api/tasks/${taskId}/monitors`, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    });
  const rowOf = async (taskId: string) =>
    (await db.select().from(monitors).where(eq(monitors.taskId, taskId))).at(0)!;

  // ⑨-a agent 在自己回合里调:凭据对上 ⇒ 角色取运行时事实(`turnRole`),不查会话、不碰 ps。
  const inTurnTask = await makeTask();                   // running ⇒ 事件只排队,不会真拉 agent
  await reviewInFlight(inTurnTask, "run-entry");
  runs.claimTurn(inTurnTask, "reviewer", { run: "run-entry", round: 1 });
  // 令牌**两处一起落**:库里一份(落库处核对的那份)+ 绑到这一轮的回合身份上。生产里这两笔
  // 就在同一处(orchestrator 写 `active_turn_token` 紧跟 `bindTurnToken`,第 10 轮审查 F1)。
  await db.update(tasks).set({ activeTurnToken: "TURN-OK" }).where(eq(tasks.id, inTurnTask));
  runs.bindTurnToken(inTurnTask, "TURN-OK");
  const ok = await post(
    inTurnTask,
    { command: "sleep 30", description: "审查者挂的" },
    { "x-ash-source-task-id": inTurnTask, "x-ash-turn-token": "TURN-OK" },
  );
  assert.equal(ok.status, 200, "凭据对上就该挂得上");
  const okRow = await rowOf(inTurnTask);
  assert.equal(okRow.sourceRole, "reviewer", "来源 = 本任务当前这一回合的角色");
  assert.equal(okRow.sourceReviewRun, "run-entry", "连它属于哪次审查一起记");
  await db.update(schema.freeReviewRuns).set({ status: "done" })
    .where(eq(schema.freeReviewRuns.id, "run-entry"));   // 收尾事件在出口被丢掉,不触发真投递
  await stopMonitor(okRow.id, "测试收尾");

  // ⑨-b 自报了回合身份、凭据对不上 ⇒ 拒。**不许退回默认**:那等于「谁报一个 taskId 就替谁
  //   挂」,而且挂出来的那条会去叫实现者。
  const bad = await post(
    inTurnTask,
    { command: "sleep 30" },
    { "x-ash-source-task-id": inTurnTask, "x-ash-turn-token": "TURN-WRONG" },
  );
  assert.equal(bad.status, 409);
  assert.match((await bad.json() as { error: string }).error, /回合凭据对不上/);

  // ⑨-c 人在界面上点(没有任何凭据头)+ 非终态 + 审查在进行 ⇒ 409 **且带着出路**:
  //   指定一个唤醒目标,同一个请求就能成。只回一句错误文案的话,手动挂哨兵在这种任务上
  //   就是死胡同 —— 「拒绝歧义」不等于「拒绝这件事」。
  const manual = await makeTask({ status: "paused" });
  await reviewInFlight(manual, "run-manual");
  const asked = await post(manual, { command: "sleep 30", description: "用户补挂的" });
  assert.equal(asked.status, 409);
  assert.equal((await asked.json() as { needsWakeTarget?: boolean }).needsWakeTarget, true,
    "这一档要让前端认出来「还没说清叫谁」,才长得出那个二选一");
  assert.equal((await db.select().from(monitors).where(eq(monitors.taskId, manual))).length, 0,
    "被拒的那一次一行都不许留");

  const picked = await post(manual, { command: "sleep 30", description: "用户补挂的", wake: "reviewer" });
  assert.equal(picked.status, 200, "指定之后就该挂得上");
  const pickedRow = await rowOf(manual);
  assert.equal(pickedRow.sourceRole, "reviewer");
  assert.equal(pickedRow.sourceReviewRun, "run-manual");
  assert.equal(pickedRow.sourceReviewRound, 1, "轮次一起记");

  // ⑨-d 唤醒目标拼错 ⇒ 当场 400。静默当「没指定」会退回 ⑨-c 那句 409,用户看到的是一个
  //   点了没反应的选项,而真正的原因是值不对。
  const typo = await post(manual, { command: "sleep 30", wake: "reviewr" });
  assert.equal(typo.status, 400);
  assert.match((await typo.json() as { error: string }).error, /wake 只能是/);

  // ⑨-e **核验过 ≠ 排到它的时候还是那一轮**(第 8 轮审查 F2)。
  //
  // 创建要在 `task:<id>` 队列里排队(前面可能有另一次创建、一次停止、一次删除)。上一版把
  // 核验结论压成一个 `kind:"turn"`,落库时才现读「现在是谁」—— 于是一份**审查者**提交的
  // 请求在队列里等到审查回合结束、实现者回合接上,就被解释成实现者的哨兵:行上
  // `source_role=single`、审查那条会话继续等不到人,连那次审查的执行器都没进消息
  // (实测 reviewer OLD → single NEW,HTTP 还是 200)。
  //
  // 拒绝是有出路的(新回合里重挂一次),换绑没有任何人能发现 —— 所以这一档必须拒。
  const stale = await makeTask();
  await reviewInFlight(stale, "run-stale");
  runs.claimTurn(stale, "reviewer", { run: "run-stale", round: 1 });
  await db.update(tasks).set({ activeTurnToken: "OLD-REVIEW-TURN" }).where(eq(tasks.id, stale));
  runs.bindTurnToken(stale, "OLD-REVIEW-TURN");
  let openQueue!: () => void;
  const held = serialize(`task:${stale}`, () => new Promise<void>((r) => { openQueue = r; }));
  const submitted = post(
    stale,
    { command: "sleep 30", description: "旧审查回合提交的" },
    { "x-ash-source-task-id": stale, "x-ash-turn-token": "OLD-REVIEW-TURN" },
  );
  // 它已经过了核验(入口那一问是一次库读),正卡在创建队列上 —— 一行还没落。
  await until("旧请求在队列里等着", async () => {
    await new Promise((r) => setTimeout(r, 50));
    return (await db.select().from(monitors).where(eq(monitors.taskId, stale))).length === 0;
  });
  // 审查回合结束,实现者回合接上(真实流程里 orchestrator 每起一轮换一个令牌)。
  runs.releaseTurn(stale);
  runs.claimTurn(stale, "single");
  await db.update(tasks).set({ activeTurnToken: "NEW-IMPL-TURN" }).where(eq(tasks.id, stale));
  runs.bindTurnToken(stale, "NEW-IMPL-TURN");
  openQueue();
  await held;
  const expired = await submitted;
  assert.equal(expired.status, 409, "那一轮已经结束了,不许顺势按「现在这一轮」挂上去");
  assert.match((await expired.json() as { error: string }).error, /已经结束了/,
    "措辞要说清是「那一轮过期了」,不是凭据对不上");
  assert.equal((await db.select().from(monitors).where(eq(monitors.taskId, stale))).length, 0,
    "**一行都不许留** —— 留一行就是换绑");

  // ⑨-f **来源在入口一次抓全,落库只核验**(第 9 轮审查 F1)。
  //
  // 上一版只把 token 和角色带下去,审查代次留到落库处**现查** —— 于是一份来自第 1 轮的请求在
  // 队列里等到第 2 轮开始,落库时被绑上 `round=2`:上一轮的结果就这样成了下一轮的输入(实测
  // `originalRequest.reviewRound=1` → `monitor.source_review_round=2`,HTTP 还是 200,命令
  // 照常开跑,真实 `pushToTask` 把它送进了第 2 轮的待发托盘)。
  //
  // **令牌故意不换**:这一档要单独钉的就是「审查代次」这一维 —— 同一条审查会话续到下一轮时
  // token 可能还对得上,光核令牌拦不住它。
  const bumped = await makeTask();
  await reviewInFlight(bumped, "run-bumped", { round: 1 });
  runs.claimTurn(bumped, "reviewer", { run: "run-bumped", round: 1 });
  await db.update(tasks).set({ activeTurnToken: "ROUND-1-TURN" }).where(eq(tasks.id, bumped));
  runs.bindTurnToken(bumped, "ROUND-1-TURN");
  let openBumped!: () => void;
  const heldBumped = serialize(`task:${bumped}`, () => new Promise<void>((r) => { openBumped = r; }));
  const fromRound1 = post(
    bumped,
    { command: "sleep 30", description: "第 1 轮提交的" },
    { "x-ash-source-task-id": bumped, "x-ash-turn-token": "ROUND-1-TURN" },
  );
  await until("第 1 轮那个请求在队列里等着", async () => {
    await new Promise((r) => setTimeout(r, 50));
    return (await db.select().from(monitors).where(eq(monitors.taskId, bumped))).length === 0;
  });
  // 审查推到第 2 轮(真实 `nextRound` 复用同一个 run,只把 current_round 加一)。
  await db.update(schema.freeReviewRuns).set({ currentRound: 2 })
    .where(eq(schema.freeReviewRuns.id, "run-bumped"));
  openBumped();
  await heldBumped;
  const bumpedRes = await fromRound1;
  assert.equal(bumpedRes.status, 409, "第 1 轮提交的请求不许在第 2 轮里成立");
  assert.match((await bumpedRes.json() as { error: string }).error, /不在进行|下一轮/,
    "措辞要说清是「那一轮过去了」,并给出路(在现在这一轮里重挂一次)");
  assert.equal((await db.select().from(monitors).where(eq(monitors.taskId, bumped))).length, 0,
    "**一行都不许留** —— 留一行就是把上一轮的结果送进下一轮");
  runs.releaseTurn(bumped);

  // ⑨-g 同一件事的另一面:排队期间那次审查**收尾**了 ⇒ 也拒,不许降成「reviewer + 空来源」。
  //   空来源在出口按普通任务判、唤醒时丢掉审查者的执行器配置(同 ⑤-i)。
  const settledRun = await makeTask();
  await reviewInFlight(settledRun, "run-settling", { round: 1 });
  runs.claimTurn(settledRun, "reviewer", { run: "run-settling", round: 1 });
  await db.update(tasks).set({ activeTurnToken: "SETTLING-TURN" }).where(eq(tasks.id, settledRun));
  runs.bindTurnToken(settledRun, "SETTLING-TURN");
  let openSettling!: () => void;
  const heldSettling = serialize(`task:${settledRun}`, () => new Promise<void>((r) => { openSettling = r; }));
  const duringSettle = post(
    settledRun,
    { command: "sleep 30", description: "审查收尾前提交的" },
    { "x-ash-source-task-id": settledRun, "x-ash-turn-token": "SETTLING-TURN" },
  );
  await until("那个请求在队列里等着", async () => {
    await new Promise((r) => setTimeout(r, 50));
    return (await db.select().from(monitors).where(eq(monitors.taskId, settledRun))).length === 0;
  });
  await db.update(schema.freeReviewRuns).set({ status: "passed" })
    .where(eq(schema.freeReviewRuns.id, "run-settling"));
  openSettling();
  await heldSettling;
  const settledRes = await duringSettle;
  assert.equal(settledRes.status, 409, "那次审查已经结束,它的哨兵也就没有出口了");
  assert.match((await settledRes.json() as { error: string }).error, /不在进行/);
  assert.equal((await db.select().from(monitors).where(eq(monitors.taskId, settledRun))).length, 0,
    "不许留一条「reviewer + 空来源」的行");
  runs.releaseTurn(settledRun);

  await db.update(schema.freeReviewRuns).set({ status: "done" })
    .where(eq(schema.freeReviewRuns.id, "run-manual"));
  await stopMonitor(pickedRow.id, "测试收尾");
}

await teardown();
console.log("✓ 哨兵与审查：醒来叫审查会话 / 角色跟着行走到投递参数 / 来源答不出来时要么说清要么拒、不静默当执行者 / 审查进行中终态任务上挂得上 / 叫醒时带回 pause 留下的交代 / 预约审查说得出在等哪几个哨兵 / 创建入口核验回合凭据、歧义带着出路拒、排队期间换了一轮或审查推了一轮都拒不换绑");
