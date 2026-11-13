// 串行队列的成员挂着哨兵、用 pause_task 收尾等结果:队列不许把它空手叫起来。
//
// 现场(2026-11-13,任务 aY1GMs-EHxqf):挂回归哨兵 → pause_task → 0.1 秒后「〔系统〕继续(从中断
// 处)」→ 智能体说「这次被唤醒时结果其实还没出来」再暂停 → 队列再叫,三轮之后哨兵才跑完。全库
// 16 次全是队列成员。判据与补推的办法见 src/queue-monitor-hold.ts。
//
// 走的是真实链路:第一回合由队列推进起跑,在回合里挂真哨兵、走真的 /pause 路由收尾,结算落
// paused 时状态钩子照生产那样推进队列;哨兵结果由真实投递叫醒。只换掉「起一个 CLI」那一步
// (执行器原型),记下每一回合拿到的输入。全程不起 scheduler 的定时 tick。
//
// 跑:npm -w server run test:monitor-checkpoint-recovery(本文件排在它后面)
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import type { AgentEvent } from "@ash/shared";
import {
  db, insertMonitorRow, monitors, now, root, runs, scheduledMessages, schema, sleep, startMonitor,
  tasks, teardown, until,
} from "./monitors-fixture.js";
import type { RunHandle, RunOpts } from "../src/executors/types.js";

delete process.env.ASH_LAX_DONE;
delete process.env.ASH_ALLOW_REAL_AGENT;
const { ClaudeExecutor } = await import("../src/executors/claude.js");
const { CodexExecutor } = await import("../src/executors/codex.js");
const { mountTaskRunRoutes } = await import("../src/task-run-routes.js");
const { advanceQueue, groupLaunchTargets, pickNextLaunchable, queueMembers, recoverQueueAdvances, runGroup } = await import("../src/scheduler.js");
const { sweepOwedQueueAdvances } = await import("../src/queue-monitor-hold.js");
const { deferQueueAdvance, replayQueueAdvances, requestQueueAdvance } = await import("../src/queue-advance-retry.js");
const { noteMissedAdvance } = await import("../src/queue-seat.js");
const { monitorsBlockingComplete } = await import("../src/task-complete-monitors.js");
const { stopMonitorChecked } = await import("../src/monitor-stop.js");
const { deliverResultHandoff } = await import("../src/monitor-events.js");
const { reattachMonitors } = await import("../src/monitors.js");
const { occupyResumePrompt } = await import("../src/task-resume-prompt.js");

const api = new Hono();
mountTaskRunRoutes(api);

// ── 假执行器:每一回合记下输入,按剧本走完,没剧本就确认完成 ───────────────────────────────
type Turn = (taskId: string) => Promise<void>;
const inputs = new Map<string, string[]>();
const scripts = new Map<string, Turn[]>();
const turnErrors: string[] = [];
const inputsOf = (taskId: string) => inputs.get(taskId) ?? [];

async function identity(taskId: string): Promise<Record<string, string>> {
  const row = (await db.select().from(tasks).where(eq(tasks.id, taskId)))[0]!;
  return {
    "content-type": "application/json",
    ...(row.activeTurnToken ? { "x-ash-turn-token": row.activeTurnToken } : {}),
    ...(row.activeDirectionToken ? { "x-ash-direction-token": row.activeDirectionToken } : {}),
  };
}

/** 回合里调 pause_task 那条生产路由。 */
async function pause(taskId: string, resumePrompt: string): Promise<void> {
  const response = await api.request(`/tasks/${taskId}/pause`, {
    method: "POST", headers: await identity(taskId), body: JSON.stringify({ resumePrompt }),
  });
  if (response.status !== 200) turnErrors.push(`${taskId} pause ${response.status}: ${await response.text()}`);
}

/** 回合里调 complete_task:等完成闸放行(刚送进来的那条哨兵结果要先记成已送达)再交。 */
async function complete(taskId: string): Promise<void> {
  const deadline = Date.now() + 8_000;
  while (await monitorsBlockingComplete(taskId)) {
    if (Date.now() > deadline) { turnErrors.push(`${taskId} 完成闸一直不放行`); return; }
    await sleep(50);
  }
  const response = await api.request(`/tasks/${taskId}/complete`, {
    method: "POST", headers: await identity(taskId), body: "{}",
  });
  if (response.status !== 200) turnErrors.push(`${taskId} complete ${response.status}: ${await response.text()}`);
}

const run = (opts: RunOpts): RunHandle => {
  const taskId = opts.env!.ASH_TASK_ID!;
  inputs.set(taskId, [...inputsOf(taskId), opts.prompt]);
  const turn = scripts.get(taskId)?.shift() ?? complete;
  const native = `native-${taskId}`;
  return {
    sessionId: native, commandLine: "queue monitor hold fixture; no CLI", kill() {},
    events: (async function* (): AsyncGenerator<AgentEvent> {
      yield { kind: "session", cliSessionId: native };
      await turn(taskId).catch((error) => { turnErrors.push(`${taskId}: ${String(error)}`); });
      yield { kind: "done", exitStatus: 0 };
    })(),
  };
};
for (const executor of [ClaudeExecutor.prototype, CodexExecutor.prototype]) {
  executor.run = run;
  executor.runSteerable = run;
}

// ── 故障注入:只在计数大于零时生效,其余时候原样放行 ───────────────────────────────
// 推进意图那一笔写入失败(第 1 轮审查发现 2),以及哨兵事件复查那一趟的读取失败(发现 1)。
let failIntentWrites = 0;
let failRecheckReads = 0;
const realInsert = db.insert.bind(db);
const realSelect = db.select.bind(db);
(db as { insert: unknown }).insert = (table: Parameters<typeof db.insert>[0]) => {
  if (table === schema.queueAdvanceIntents && failIntentWrites > 0) {
    failIntentWrites--;
    throw new Error("SQLITE_BUSY: 测试注入一次推进意图写入失败");
  }
  return realInsert(table);
};
(db as { select: unknown }).select = (...args: Parameters<typeof db.select>) => {
  // 只打 queue-monitor-hold.ts 的 `recheck`:它的第一句读排在任何 await 之前,调用栈里认得出来。
  if (failRecheckReads > 0 && new Error().stack?.includes("recheck")) {
    failRecheckReads--;
    throw new Error("SQLITE_BUSY: 测试注入一次复查读取失败");
  }
  return realSelect(...args);
};
/** 这个任务的时间线里有没有这句话(时间线写在 runs/<taskId>/ 下的会话正文里)。 */
const timelineHas = (taskId: string, text: string): boolean => {
  const dir = join(root, "runs", taskId);
  return existsSync(dir) && readdirSync(dir).some((name) => name.endsWith(".md")
    && readFileSync(join(dir, name), "utf8").includes(text));
};

// ── 夹具 ──────────────────────────────────────────────────────────────────────
await db.insert(schema.projects).values({ id: "qmh", name: "queue monitor hold", repoPath: root, createdAt: now() });
await db.insert(schema.agents).values({ id: "qmh-claude", name: "claude@fixture", type: "claude", isDefault: true });

let seq = 0;
/** 一条串行队列 [A, B],同一个 serial 分组,两位都还没开工。 */
async function queuePair(name: string) {
  const n = ++seq;
  const queueId = `q-${name}-${n}`;
  const groupId = `g-${name}-${n}`;
  const a = `qmh-${name}-${n}-a`;
  const b = `qmh-${name}-${n}-b`;
  await db.insert(schema.groups).values({ id: groupId, projectId: "qmh", name, mode: "serial", createdAt: now() });
  const common = {
    projectId: "qmh", groupId, mode: "single", agentType: "claude", executorId: "qmh-claude",
    status: "backlog", useWorktree: false, autoTitle: false, createdAt: now(), updatedAt: now(),
  };
  await db.insert(tasks).values([{ ...common, id: a, title: a, body: "A" }, { ...common, id: b, title: b, body: "B" }]);
  await db.insert(schema.queueItems).values([
    { taskId: a, queueId, position: 0, createdAt: now() },
    { taskId: b, queueId, position: 1, createdAt: now() },
  ]);
  return { queueId, groupId, a, b };
}

const statusOf = async (taskId: string) => (await db.select().from(tasks).where(eq(tasks.id, taskId)))[0]!.status;
const intentOf = async (queueId: string) => (await db.select().from(schema.queueAdvanceIntents)
  .where(eq(schema.queueAdvanceIntents.queueId, queueId))).at(0);
const idle = (taskId: string) => !runs.isTurnClaimed(taskId) && !runs.isRunning(taskId);
async function settledAs(taskId: string, status: string, label: string) {
  await until(`${label}:${taskId} 落 ${status}`, async () => idle(taskId) && await statusOf(taskId) === status)
    .catch(async (error) => {
      throw new Error(`${error.message}(此刻 ${await statusOf(taskId)},回合输入 ${JSON.stringify(inputsOf(taskId))})`);
    });
}
async function bothDone(q: { a: string; b: string }, label: string) {
  await settledAs(q.a, "done", label);
  await until(`${label}:B 起跑并完成`, async () => inputsOf(q.b).length === 1 && idle(q.b) && await statusOf(q.b) === "done");
}

/** 「这一刻起没人被叫醒」:隔一段再看,A 没有新回合、B 没开工、A 还停在 paused。 */
async function assertHeld(q: { queueId: string; a: string; b: string }, turns: number, label: string) {
  await sleep(400);
  assert.equal(inputsOf(q.a).length, turns, `${label}:A 不该被叫起来跑新回合 —— ${JSON.stringify(inputsOf(q.a).slice(turns))}`);
  assert.equal(inputsOf(q.b).length, 0, `${label}:也不该越过 A 起 B`);
  assert.equal(await statusOf(q.a), "paused", `${label}:A 还停在 paused`);
  assert.equal(await statusOf(q.b), "backlog", label);
  assert.ok(await intentOf(q.queueId), `${label}:这次推进还欠着(意图行留着),它的哨兵了结时才有人补推`);
}

/** 第一回合:按 `setup` 挂好哨兵(或别的现场),再用 pause_task 收尾。 */
async function firstTurnPaused(q: { queueId: string; a: string }, resumePrompt: string, setup: Turn = async () => {}) {
  scripts.set(q.a, [async (taskId) => { await setup(taskId); await pause(taskId, resumePrompt); }]);
  await advanceQueue(q.queueId);
  await settledAs(q.a, "paused", "第一回合");
  assert.equal(inputsOf(q.a).length, 1);
}

let failure: unknown = null;
try {
  // ① 挂着在跑的哨兵落 paused:队列不续跑它,也不起 B;每一个自动推进入口都一样
  {
    const q = await queuePair("live");
    const go = join(root, `go-${q.a}`);
    let monitorId = "";
    await firstTurnPaused(q, "等回归跑完再继续", async (taskId) => {
      const started = await startMonitor({
        taskId, command: `until [ -f "${go}" ]; do sleep 0.1; done`, description: `HOLD_LIVE_${taskId}`,
      });
      assert.ok(started.ok, JSON.stringify(started));
      monitorId = started.monitor.id;
    });
    await assertHeld(q, 1, "落 paused 的状态钩子");

    await advanceQueue(q.queueId);
    await assertHeld(q, 1, "advanceQueue");
    await runGroup(q.groupId);
    await assertHeld(q, 1, "分组运行(serial)");
    await recoverQueueAdvances();
    await assertHeld(q, 1, "重启恢复补办");
    noteMissedAdvance(q.a, q.queueId);
    await assertHeld(q, 1, "让位补办(queue-seat)");
    const a = (await db.select().from(tasks).where(eq(tasks.id, q.a)))[0]!;
    assert.ok(await requestQueueAdvance(q.queueId, a));
    await replayQueueAdvances(q.queueId);
    await assertHeld(q, 1, "推进请求重放");
    assert.equal((await db.select().from(tasks).where(eq(tasks.id, q.a)))[0]!.queueAdvanceRequest, null,
      "挑不起的推进请求就地作废,不按秒退避重放下去");
    deferQueueAdvance(q.queueId);
    await sleep(1_200);
    await assertHeld(q, 1, "退避重试");

    // 哨兵出结果:恰好叫醒一次,输入是哨兵结果;它完成后队列起 B。
    writeFileSync(go, "");
    await bothDone(q, "哨兵出结果");
    assert.equal(inputsOf(q.a).length, 2, `A 恰好被叫醒一次:${JSON.stringify(inputsOf(q.a))}`);
    assert.ok(inputsOf(q.a)[1]!.includes(`HOLD_LIVE_${q.a}`), `叫醒的输入是哨兵结果:${inputsOf(q.a)[1]}`);
    assert.equal((await db.select().from(monitors).where(eq(monitors.id, monitorId)))[0]!.status, "exited");
    assert.equal(await intentOf(q.queueId), undefined, "推进兑现了,欠账了结");
    console.log("PASS: 挂着在跑的哨兵落 paused —— 六个自动推进入口都不续跑它;哨兵出结果叫醒一次,随后 B 起跑");
  }

  // ② 哨兵已经结束、结束通知还没入队的那一刻:不续跑它;通知入队后由投递叫醒一次
  {
    const q = await queuePair("handoff");
    let monitorId = "";
    await firstTurnPaused(q, "等通知", async (taskId) => {
      monitorId = await insertMonitorRow(taskId, { status: "exited" });
      await db.update(monitors).set({
        sourceRole: "single", exitCode: 0, endedAt: now(), endedReason: "命令自己跑完了",
        resultHandoffAt: now(), resultHandoffText: `HANDOFF_RESULT_${taskId}`,
      }).where(eq(monitors.id, monitorId));
    });
    await assertHeld(q, 1, "结局已定、通知未入队");
    await advanceQueue(q.queueId);
    await assertHeld(q, 1, "结局已定、通知未入队(再推一次)");
    await deliverResultHandoff(monitorId);
    await bothDone(q, "通知入队");
    assert.equal(inputsOf(q.a).length, 2, `A 恰好被叫醒一次:${JSON.stringify(inputsOf(q.a))}`);
    assert.ok(inputsOf(q.a)[1]!.includes(`HANDOFF_RESULT_${q.a}`), inputsOf(q.a)[1]);
    console.log("PASS: 哨兵结束、通知未送达 —— 队列不续跑;通知送达叫醒一次");
  }

  // ③ 哨兵已经结束、结果排在待发送里还没送到的那一刻:队列重新评估不续跑它,唯一的叫醒是那条结果。
  //    哨兵结果入队就会被当场投递,所以这一刻只能直接摆出来:A 停在 paused(检查点 + 能续的会话),
  //    托盘里一条 pending 的哨兵结果,中间不经过任何钩子。
  {
    const q = await queuePair("unread");
    await db.update(tasks).set({ status: "paused" }).where(eq(tasks.id, q.a));
    await occupyResumePrompt(q.a, "RESUME_UNREAD", false);
    await db.insert(schema.sessions).values({
      id: `s-${q.a}`, taskId: q.a, role: "single", agentType: "claude", executor: "claude@fixture",
      executorId: "qmh-claude", cliSessionId: `native-${q.a}`, cwd: root, startedAt: now(), turnStartedAt: now(), endedAt: now(),
    });
    const monitorId = await insertMonitorRow(q.a, { status: "exited" });
    await db.update(monitors).set({ sourceRole: "single", exitCode: 0, endedAt: now() }).where(eq(monitors.id, monitorId));
    await db.insert(scheduledMessages).values({
      id: `m-${q.a}`, taskId: q.a, text: `UNREAD_RESULT_${q.a}`, origin: `monitor:${monitorId}`, mode: "queued",
      sessionRole: "single", sendAt: now(), status: "pending", createdAt: now(),
    });
    assert.equal(await pickNextLaunchable(q.queueId), null, "结果还没送到:队列眼里 A 在等,不是可以续跑");
    assert.equal((await queueMembers(q.queueId))[0]!.monitorHold, true);
    // 这一推照生产那样顺手扫一遍成员的待发送(advanceQueue 的空闲分支):送进去的是那条结果。
    await advanceQueue(q.queueId);
    await bothDone(q, "结果送达");
    assert.equal(inputsOf(q.a).length, 1, `A 只被那条结果叫醒一次:${JSON.stringify(inputsOf(q.a))}`);
    assert.ok(inputsOf(q.a)[0]!.includes(`UNREAD_RESULT_${q.a}`), inputsOf(q.a)[0]);
    console.log("PASS: 结果排在待发送里没送到 —— 队列不续跑;叫醒它的只有那条结果");
  }

  // ④ 在跑的哨兵被放弃(界面上的「不等了」/ stop_monitor):随后按检查点续跑,恰好一次
  {
    const q = await queuePair("abandon-live");
    let monitorId = "";
    await firstTurnPaused(q, `RESUME_ABANDON_LIVE`, async (taskId) => {
      const started = await startMonitor({ taskId, command: "sleep 60", description: "等不到的哨兵" });
      assert.ok(started.ok, JSON.stringify(started));
      monitorId = started.monitor.id;
    });
    await assertHeld(q, 1, "放弃之前");
    const stopped = await stopMonitorChecked(monitorId, "不等了");
    assert.ok(stopped.ok);
    await bothDone(q, "放弃在跑的哨兵");
    assert.equal(inputsOf(q.a).length, 2, `A 恰好续跑一次:${JSON.stringify(inputsOf(q.a))}`);
    assert.ok(inputsOf(q.a)[1]!.includes("RESUME_ABANDON_LIVE"), `续跑喂的是检查点交代:${inputsOf(q.a)[1]}`);
    console.log("PASS: 放弃在跑的哨兵 —— 队列随后按检查点续跑一次");
  }

  // ⑤ 已经结束、结果还欠着的哨兵被 stop_monitor 放弃:没有结果要送了,同样续跑一次
  {
    const q = await queuePair("abandon-ended");
    let monitorId = "";
    await firstTurnPaused(q, "RESUME_ABANDON_ENDED", async (taskId) => {
      monitorId = await insertMonitorRow(taskId, { status: "exited" });
      await db.update(monitors).set({
        sourceRole: "single", exitCode: 0, endedAt: now(), resultHandoffAt: now(), resultHandoffText: "不会送到的通知",
      }).where(eq(monitors.id, monitorId));
    });
    await assertHeld(q, 1, "放弃之前");
    const stopped = await stopMonitorChecked(monitorId, "不要这个结果了");
    assert.ok(stopped.ok);
    await bothDone(q, "放弃已结束的哨兵");
    assert.equal(inputsOf(q.a).length, 2, `A 恰好续跑一次:${JSON.stringify(inputsOf(q.a))}`);
    assert.ok(inputsOf(q.a)[1]!.includes("RESUME_ABANDON_ENDED"), inputsOf(q.a)[1]);
    console.log("PASS: 放弃已结束的哨兵 —— 队列随后按检查点续跑一次");
  }

  // ⑥ 重启:没有意图行(升级前留下的现场),哨兵在接回时落 lost —— 队列照样不会永远停在它身上
  {
    const q = await queuePair("restart");
    const dead = spawnSync("true").pid!;
    await firstTurnPaused(q, "RESUME_RESTART", async (taskId) => {
      const monitorId = await insertMonitorRow(taskId, { pid: dead });
      await db.update(monitors).set({ sourceRole: "single" }).where(eq(monitors.id, monitorId));
    });
    await assertHeld(q, 1, "重启之前");
    await db.delete(schema.queueAdvanceIntents).where(eq(schema.queueAdvanceIntents.queueId, q.queueId));
    // 开机补记那一笔也撞上一次写失败:不许当它记下了,退避之后补记成功(第 1 轮审查发现 2 的同类位置)。
    failIntentWrites = 1;
    await recoverQueueAdvances();
    assert.equal(failIntentWrites, 0, "补记确实撞上了那次注入");
    await until("开机补记退避重试后落库", async () => !!await intentOf(q.queueId), 5_000);
    await assertHeld(q, 1, "开机补办(哨兵行还写着 running)");
    await reattachMonitors();
    await bothDone(q, "哨兵落 lost");
    assert.equal(inputsOf(q.a).length, 2, `A 恰好被叫醒一次:${JSON.stringify(inputsOf(q.a))}`);
    console.log("PASS: 重启后哨兵落 lost —— 队列接着推,A 恰好被叫醒一次");
  }

  // ⑦ 名下没有哨兵的检查点暂停:行为不变,落 paused 就由队列续跑
  {
    const q = await queuePair("checkpoint");
    scripts.set(q.a, [async (taskId) => { await pause(taskId, "RESUME_PLAIN_CHECKPOINT"); }]);
    await advanceQueue(q.queueId);
    await bothDone(q, "检查点暂停");
    assert.equal(inputsOf(q.a).length, 2, JSON.stringify(inputsOf(q.a)));
    assert.ok(inputsOf(q.a)[1]!.includes("RESUME_PLAIN_CHECKPOINT"), inputsOf(q.a)[1]);
    console.log("PASS: 没有哨兵的检查点暂停 —— 照旧由队列续跑");
  }

  // ⑧ parallel 分组运行:等哨兵的暂停一个都不拉 —— 带着续跑交代的(自己 pause_task 的),和没有交代的
  //    (挂着哨兵时被「暂停整组」打断的,第 1 轮审查发现 3)都一样;启动失败的交代名单也用同一把尺子。
  //    没有哨兵、被组暂停打断的那一位照旧续跑。
  {
    const groupId = "g-parallel";
    await db.insert(schema.groups).values({ id: groupId, projectId: "qmh", name: "parallel", mode: "parallel", createdAt: now() });
    const member = async (id: string) => {
      await db.insert(tasks).values({
        id, title: id, body: id, projectId: "qmh", groupId, mode: "single", agentType: "claude",
        executorId: "qmh-claude", status: "paused", useWorktree: false, autoTitle: false, createdAt: now(), updatedAt: now(),
      });
      return id;
    };
    const checkpointed = await member("qmh-parallel-checkpoint");
    await occupyResumePrompt(checkpointed, "等哨兵", false);
    await insertMonitorRow(checkpointed);
    const interrupted = await member("qmh-parallel-interrupted");
    await insertMonitorRow(interrupted);
    const plain = await member("qmh-parallel-plain");
    assert.deepEqual(await groupLaunchTargets(groupId), [plain], "启动名单只有那位没在等哨兵的");
    await runGroup(groupId);
    await settledAs(plain, "done", "没在等哨兵的组暂停成员");
    assert.equal(inputsOf(plain).length, 1);
    await sleep(400);
    for (const held of [checkpointed, interrupted]) {
      assert.equal(inputsOf(held).length, 0, `分组运行不拉等哨兵的暂停:${held}`);
      assert.equal(await statusOf(held), "paused");
    }
    await db.delete(monitors).where(eq(monitors.taskId, checkpointed));
    await db.delete(monitors).where(eq(monitors.taskId, interrupted));
    console.log("PASS: parallel 分组运行不拉等哨兵的暂停(有没有续跑交代都一样),启动名单同口径");
  }

  // ⑨ 哨兵事件那一趟复查撞上一次读失败:事件没有第二条,欠账由调度 tick 的巡检接住
  {
    const q = await queuePair("recheck-failure");
    let monitorId = "";
    await firstTurnPaused(q, "RESUME_AFTER_SWEEP", async (taskId) => {
      monitorId = await insertMonitorRow(taskId, { status: "exited" });
      await db.update(monitors).set({
        sourceRole: "single", exitCode: 0, endedAt: now(), resultHandoffAt: now(), resultHandoffText: "不会送到的通知",
      }).where(eq(monitors.id, monitorId));
    });
    await assertHeld(q, 1, "放弃之前");
    failRecheckReads = 1;
    assert.ok((await stopMonitorChecked(monitorId, "不等了")).ok);
    await until("复查撞上了那次注入", async () => failRecheckReads === 0, 5_000);
    await sleep(400);
    assert.equal(inputsOf(q.a).length, 1, "事件那一路这次没接上(这正是要兜住的现场)");
    assert.ok(await intentOf(q.queueId), "欠账还在");
    await sweepOwedQueueAdvances();
    await bothDone(q, "巡检补推");
    assert.equal(inputsOf(q.a).length, 2, `A 恰好续跑一次:${JSON.stringify(inputsOf(q.a))}`);
    assert.ok(inputsOf(q.a)[1]!.includes("RESUME_AFTER_SWEEP"), inputsOf(q.a)[1]);
    console.log("PASS: 哨兵事件复查读失败 —— 调度 tick 的巡检补推,A 续跑一次");
  }

  // ⑩ 停在等哨兵的成员上、推进意图那一笔写失败:不按「已接受」收场 —— 时间线留交代,进程里重试到
  //    意图落库;哨兵随后被放弃时照常续跑
  {
    const q = await queuePair("intent-failure");
    let monitorId = "";
    await firstTurnPaused(q, "RESUME_AFTER_INTENT_RETRY", async (taskId) => {
      monitorId = await insertMonitorRow(taskId, { status: "exited" });
      await db.update(monitors).set({
        sourceRole: "single", exitCode: 0, endedAt: now(), resultHandoffAt: now(), resultHandoffText: "不会送到的通知",
      }).where(eq(monitors.id, monitorId));
      failIntentWrites = 1; // 打的是落 paused 那一刻状态钩子推的那一趟
    });
    assert.equal(failIntentWrites, 0, "落 paused 的那一趟确实撞上了注入");
    await until("交代写进时间线", async () => timelineHas(q.a, "队列推进未接受"), 5_000);
    await until("退避重试后意图落库", async () => !!await intentOf(q.queueId), 5_000);
    await assertHeld(q, 1, "意图补上之后");
    assert.ok((await stopMonitorChecked(monitorId, "不等了")).ok);
    await bothDone(q, "意图补上后放弃哨兵");
    assert.equal(inputsOf(q.a).length, 2, `A 恰好续跑一次:${JSON.stringify(inputsOf(q.a))}`);
    assert.ok(inputsOf(q.a)[1]!.includes("RESUME_AFTER_INTENT_RETRY"), inputsOf(q.a)[1]);
    console.log("PASS: 推进意图写失败 —— 不谎报接受,时间线留交代,重试补上后照常续跑");
  }

  assert.deepEqual(turnErrors, [], "夹具回合里的 pause/complete 都该成功");
} catch (error) {
  failure = error;
} finally {
  for (const taskId of inputs.keys()) {
    runs.stopTask(taskId);
    await until("夹具回合退出", async () => !runs.isRunning(taskId)).catch(() => undefined);
  }
  await teardown();
}
if (failure) {
  console.error(failure);
  if (turnErrors.length) console.error("夹具回合里的错误:", turnErrors);
  process.exit(1);
}
console.log("test-queue-monitor-hold: all passed");
process.exit(0);
