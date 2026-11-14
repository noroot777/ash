// 续聊被哨兵隔开之后,醒来那一回合仍然是同一次续聊的后半段(src/follow-up-held.ts)。
//
// 现场(2026-11-14,R8M9Tsn2q0aj):done 的任务被审查打回 → 修复回合给自己改过的测试挂回归哨兵、
// pause_task → 落 paused → 哨兵叫醒 → 执行者 dispute_review、照工具说明不调 complete_task 正常
// 结束 → 任务落 failed,时间线写「本回合没有交卷」。kICyChpSKVZ9 是不涉及审查的同一件事。
//
// 走真实链路:续聊回合由 continueTask 起跑,在回合里挂真哨兵、走真的 /pause 路由收尾,哨兵结果由
// 真实投递叫醒。只换掉「起一个 CLI」那一步(执行器原型),记下每一回合拿到的输入。重启那一节由
// 子进程(follow-up-monitor-held-restart.ts)接着同一个库跑。
//
// 跑:npm -w server run test:follow-up-held(test:accept 里也带着它)
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import type { AgentEvent } from "@ash/shared";
import {
  HERE, continueTask, db, insertMonitorRow, monitors, now, root, runs, schema, sleep, startMonitor, tasks, teardown, until,
} from "./monitors-fixture.js";
import type { RunHandle, RunOpts } from "../src/executors/types.js";

delete process.env.ASH_LAX_DONE;
delete process.env.ASH_ALLOW_REAL_AGENT;
const { ClaudeExecutor } = await import("../src/executors/claude.js");
const { CodexExecutor } = await import("../src/executors/codex.js");
const { mountTaskRunRoutes } = await import("../src/task-run-routes.js");
const { monitorsBlockingComplete } = await import("../src/task-complete-monitors.js");
const { disputeFreeReview, openDisputeOf } = await import("../src/free-review-dispute.js");
const { settleTaskStatus } = await import("../src/settle-status.js");
const { setTaskStatus } = await import("../src/status.js");
const { turnFollowUpFrom, heldFollowUpTaken } = await import("../src/follow-up-held.js");
const { RUNS_DIR } = await import("../src/paths.js");

const api = new Hono();
mountTaskRunRoutes(api);

// ── 假执行器:每一回合记下输入,按剧本走完 ─────────────────────────────────────────────
// 剧本返回一个数字 = 这一回合的退出码(缺省 0)。没剧本的回合什么都不做、正常退出 —— 也就是
// 「没调 complete_task 就结束」,这正是要钉的那种收尾。
type Turn = (taskId: string) => Promise<number | void>;
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
async function pause(taskId: string, resumePrompt: string): Promise<void> {
  const response = await api.request(`/tasks/${taskId}/pause`, {
    method: "POST", headers: await identity(taskId), body: JSON.stringify({ resumePrompt }),
  });
  if (response.status !== 200) turnErrors.push(`${taskId} pause ${response.status}: ${await response.text()}`);
}
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
  const turn = scripts.get(taskId)?.shift();
  const native = `native-${taskId}`;
  return {
    sessionId: native, commandLine: "follow-up held fixture; no CLI", kill() {},
    events: (async function* (): AsyncGenerator<AgentEvent> {
      yield { kind: "session", cliSessionId: native };
      let exitStatus = 0;
      if (turn) exitStatus = await turn(taskId).then((code) => code ?? 0, (error) => {
        turnErrors.push(`${taskId}: ${String(error)}`);
        return 0;
      });
      yield { kind: "done", exitStatus };
    })(),
  };
};
for (const executor of [ClaudeExecutor.prototype, CodexExecutor.prototype]) {
  executor.run = run;
  executor.runSteerable = run;
}

// ── 夹具 ──────────────────────────────────────────────────────────────────────
await db.insert(schema.projects).values({ id: "fuh", name: "follow-up held", repoPath: root, createdAt: now() });
await db.insert(schema.agents).values({ id: "fuh-claude", name: "claude@fixture", type: "claude", isDefault: true });

let seq = 0;
const common = () => ({
  projectId: "fuh", mode: "single", agentType: "claude", executorId: "fuh-claude",
  useWorktree: false, autoTitle: false, createdAt: now(), updatedAt: now(),
});
async function makeTask(status: string, opts: { free?: boolean; groupId?: string } = {}): Promise<string> {
  const id = `fuh-${++seq}`;
  await db.insert(tasks).values({
    ...common(), id, title: id, body: id, status, groupId: opts.groupId ?? null,
    ...(opts.free ? { workflowMode: "free" } : {}),
  });
  return id;
}
/** 最近一轮审查停在未通过、等执行者处理的自由任务(R8M9 那一刻)。 */
async function stoppedReview(taskId: string): Promise<string> {
  const runId = `${taskId}-run`;
  const roundId = `${runId}-round`;
  await db.insert(schema.freeReviewRuns).values({
    id: runId, taskId, reviewerName: "审查者", agentType: "claude", executorId: "fuh-claude",
    checkMode: "logic", retryLimit: 1, currentRound: 1, status: "stopped", createdAt: now(), updatedAt: now(), finishedAt: now(),
  });
  await db.insert(schema.freeReviewRounds).values({
    id: roundId, runId, round: 1, status: "failed", conclusion: "verify_failed",
    reportMarkdown: "第 3 行的 null 检查缺失", startedAt: now(), endedAt: now(),
  });
  return roundId;
}

const row = async (taskId: string) => (await db.select().from(tasks).where(eq(tasks.id, taskId)))[0]!;
const idle = (taskId: string) => !runs.isTurnClaimed(taskId) && !runs.isRunning(taskId);
async function settledAs(taskId: string, status: string, turns: number, label: string) {
  await until(`${label}:${taskId} 第 ${turns} 回合后落 ${status}`,
    async () => inputsOf(taskId).length >= turns && idle(taskId) && (await row(taskId)).status === status)
    .catch(async (error) => {
      throw new Error(`${error.message}(此刻 ${(await row(taskId)).status},回合输入 ${JSON.stringify(inputsOf(taskId))},`
        + `夹具错误 ${JSON.stringify(turnErrors)})`);
    });
  assert.equal(inputsOf(taskId).length, turns, `${label}:回合数 ${JSON.stringify(inputsOf(taskId))}`);
}
/** 这个任务全部会话记录(结算说明作为会话旁注写在这里)。 */
function transcriptOf(taskId: string): string {
  let names: string[] = [];
  try { names = readdirSync(join(RUNS_DIR, taskId)); } catch { return ""; }
  return names.filter((name) => name.endsWith(".md")).map((name) => readFileSync(join(RUNS_DIR, taskId, name), "utf8")).join("\n");
}
const UNCONFIRMED = "本回合没有交卷";
/**
 * 落盘完的会话记录。结算说明是回合收尾时追加到写流里的,任务落位、回合锁放掉的那一刻它还可能在
 * 缓冲里 —— 「没写那句话」的断言要是读在它之前,只会空过。所以等到连续两次读一模一样再算。
 */
async function settledTranscript(taskId: string): Promise<string> {
  let last = transcriptOf(taskId);
  for (let i = 0; i < 40; i++) {
    await sleep(100);
    const next = transcriptOf(taskId);
    if (next === last) return next;
    last = next;
  }
  return last;
}

/** 回合里挂一条等文件出现的真哨兵,再 pause_task 收尾。返回「放它出结果」的开关。 */
function holdTurn(gate: string, resumePrompt = "绿了就接着处理"): Turn {
  return async (taskId) => {
    const started = await startMonitor({
      taskId, command: `until [ -f "${gate}" ]; do sleep 0.1; done; echo GATE_${taskId}`, description: `HELD_${taskId}`,
    });
    if (!started.ok) throw new Error(`挂哨兵失败:${JSON.stringify(started)}`);
    await pause(taskId, resumePrompt);
  };
}
let gateSeq = 0;
const newGate = () => join(root, `gate-${++gateSeq}`);
const release = (gate: string) => writeFileSync(gate, "");

/** 续聊回合被哨兵隔开:落 paused、续聊身份让出来、原状态记在那一列。 */
async function assertHeld(taskId: string, from: string, turns: number, label: string) {
  await settledAs(taskId, "paused", turns, label);
  const t = await row(taskId);
  assert.equal(t.followUpFrom, null, `${label}:暂停期间队列眼里它不是旁路回合`);
  assert.equal(t.followUpHeldFrom, from, `${label}:续聊前的状态记在 follow_up_held_from`);
}

/**
 * 起一个回合的那一笔,照 continueTask 的写法摆出来(用同一个判定函数),给只能直接调结算的那几节用:
 * 熔断判决没法从假执行器里造出来。
 */
async function emulateTurnStart(taskId: string, turn: { system?: boolean; byBackend?: boolean } = {}) {
  const t = await row(taskId);
  const execution = !!turn.system;
  const followUpFrom = turnFollowUpFrom(t, {
    goalExecution: false, goalPriorStatus: t.status, inputExecution: false, system: execution, sideTurn: false, execution,
    checkpointFollowUp: !execution && !turn.byBackend && t.status === "paused" && !!t.resumePrompt,
  });
  await db.update(tasks).set({ followUpFrom, ...(heldFollowUpTaken(t, followUpFrom) ? { followUpHeldFrom: null } : {}) })
    .where(eq(tasks.id, taskId));
  await setTaskStatus(taskId, "running");
}

let failure: unknown = null;
try {
  // ① R8M9:done → 修复回合挂哨兵 pause → paused → 哨兵叫醒 → dispute_review → 正常结束
  {
    const taskId = await makeTask("done", { free: true });
    const roundId = await stoppedReview(taskId);
    const gate = newGate();
    scripts.set(taskId, [
      holdTurn(gate, "绿了就调 dispute_review"),
      async (id) => {
        await disputeFreeReview(id, { summary: "这一条跟本任务无关,建议转出去", reason: "", deferReason: "属于另一个模块" });
      },
    ]);
    await continueTask(taskId, "【审查未通过】请按报告修复");
    await assertHeld(taskId, "done", 1, "①");
    release(gate);
    await settledAs(taskId, "done", 2, "① 醒来驳回");
    assert.ok(inputsOf(taskId)[1]!.includes(`GATE_${taskId}`), `叫醒它的是哨兵结果:${inputsOf(taskId)[1]}`);
    const t = await row(taskId);
    assert.equal(t.followUpFrom, null);
    assert.equal(t.followUpHeldFrom, null, "这次续聊收口了");
    assert.ok(!(await settledTranscript(taskId)).includes(UNCONFIRMED), "时间线不许出现「本回合没有交卷」");
    const round = (await db.select().from(schema.freeReviewRounds).where(eq(schema.freeReviewRounds.id, roundId)))[0]!;
    assert.equal(round.disputeDeferReason, "属于另一个模块", "驳回记录在");
    assert.equal((await openDisputeOf(taskId))?.round.id, roundId, "驳回停在等用户裁定");
    console.log("PASS: 修复回合被哨兵隔开、醒来驳回 —— 回到 done,驳回等裁定,没有「没交卷」");
  }

  // ② 同样的开头,醒来后 complete_task:done,跟没被隔开的续聊确认同一个结局
  {
    const held = await makeTask("done", { free: true });
    const plain = await makeTask("done", { free: true });
    await stoppedReview(held);
    await stoppedReview(plain);
    const gate = newGate();
    scripts.set(held, [holdTurn(gate), complete]);
    scripts.set(plain, [complete]);
    await continueTask(held, "【审查未通过】请按报告修复");
    await assertHeld(held, "done", 1, "②");
    release(gate);
    await settledAs(held, "done", 2, "② 醒来确认");
    await continueTask(plain, "【审查未通过】请按报告修复");
    await settledAs(plain, "done", 1, "② 对照");
    const runsOf = async (taskId: string) => (await db.select().from(schema.freeReviewRuns)
      .where(eq(schema.freeReviewRuns.taskId, taskId))).map((r) => r.status).sort();
    assert.deepEqual(await runsOf(held), await runsOf(plain), "自动复审跟没被隔开的确认一模一样");
    assert.ok(!(await settledTranscript(held)).includes(UNCONFIRMED));
    console.log("PASS: 醒来后确认完成 —— done,复审行为与未被隔开时一致");
  }

  // ③ kICy:done → 用户续聊 → 被哨兵隔开 → 醒来不确认正常结束:回到 done
  {
    const taskId = await makeTask("done");
    const gate = newGate();
    scripts.set(taskId, [holdTurn(gate, "等发布脚本跑完")]);
    await continueTask(taskId, "11.15 的约发吧");
    await assertHeld(taskId, "done", 1, "③");
    release(gate);
    await settledAs(taskId, "done", 2, "③ 醒来答完话");
    assert.ok(!(await settledTranscript(taskId)).includes(UNCONFIRMED));
    console.log("PASS: 普通续聊被哨兵隔开 —— 醒来不确认也回到 done");
  }

  // ④ 续聊前是 failed:回到 failed,不升级、不多说一句没交卷
  {
    const taskId = await makeTask("failed");
    const gate = newGate();
    scripts.set(taskId, [holdTurn(gate)]);
    await continueTask(taskId, "看看日志");
    await assertHeld(taskId, "failed", 1, "④");
    release(gate);
    await settledAs(taskId, "failed", 2, "④ 醒来");
    assert.ok(!(await settledTranscript(taskId)).includes(UNCONFIRMED), "回到原来的 failed,不是这一轮没交卷");
    console.log("PASS: 续聊前是 failed —— 回到 failed,没有「没交卷」");
  }

  // ⑤ 连着隔两次:暂停 → 叫醒 → 又挂哨兵暂停 → 再叫醒 → 正常结束
  {
    const taskId = await makeTask("done");
    const first = newGate();
    const second = newGate();
    scripts.set(taskId, [holdTurn(first), holdTurn(second, "第二段回归")]);
    await continueTask(taskId, "再跑一遍");
    await assertHeld(taskId, "done", 1, "⑤ 第一次");
    release(first);
    await assertHeld(taskId, "done", 2, "⑤ 第二次");
    release(second);
    await settledAs(taskId, "done", 3, "⑤ 第二次醒来");
    assert.ok(!(await settledTranscript(taskId)).includes(UNCONFIRMED));
    console.log("PASS: 连着被哨兵隔开两次 —— 仍回到续聊前的 done");
  }

  // ⑥ 暂停期间用户点「继续」、或者再发一句话:同样按续聊结算
  {
    for (const [label, resume] of [
      ["点继续", (id: string) => continueTask(id, "继续", { system: "run" })],
      ["再发话", (id: string) => continueTask(id, "怎么样了")],
    ] as const) {
      const taskId = await makeTask("done");
      const monitorId = { id: "" };
      scripts.set(taskId, [async (id) => {
        const started = await startMonitor({ taskId: id, command: "sleep 60", description: "不等了的哨兵" });
        if (!started.ok) throw new Error(JSON.stringify(started));
        monitorId.id = started.monitor.id;
        await pause(id, "等回归");
      }]);
      await continueTask(taskId, "再改一下");
      await assertHeld(taskId, "done", 1, `⑥ ${label}`);
      await db.update(monitors).set({ status: "stopped", endedAt: now(), endedReason: "不等了", endedBy: "actor", resultsAbandonedAt: now() })
        .where(eq(monitors.id, monitorId.id));
      await resume(taskId);
      await settledAs(taskId, "done", 2, `⑥ ${label}`);
      assert.ok(!(await settledTranscript(taskId)).includes(UNCONFIRMED), `⑥ ${label}`);
    }
    console.log("PASS: 暂停期间点继续 / 再发话 —— 都按续聊结算");
  }

  // ⑦ 暂停等哨兵期间重启 ash:换一个全新进程接着同一个库,哨兵结果把它叫醒
  {
    const taskId = await makeTask("done");
    let monitorId = "";
    scripts.set(taskId, [async (id) => {
      monitorId = await insertMonitorRow(id, { status: "exited" });
      await db.update(monitors).set({
        sourceRole: "single", exitCode: 0, endedAt: now(), endedReason: "命令自己跑完了",
        resultHandoffAt: now(), resultHandoffText: `RESTART_RESULT_${id}`,
      }).where(eq(monitors.id, monitorId));
      await pause(id, "等通知");
    }]);
    await continueTask(taskId, "发吧");
    await assertHeld(taskId, "done", 1, "⑦ 重启之前");
    const child = spawnSync(process.execPath, ["--import", "tsx", join(HERE, "follow-up-monitor-held-restart.ts"), taskId, monitorId], {
      env: { ...process.env }, encoding: "utf8", timeout: 60_000,
    });
    assert.equal(child.status, 0, `重启后的进程:\n${child.stdout}\n${child.stderr}`);
    const after = JSON.parse(child.stdout.trim().split("\n").at(-1)!) as { status: string; inputs: string[] };
    assert.equal(after.inputs.length, 1, `重启后被叫醒一次:${JSON.stringify(after.inputs)}`);
    assert.ok(after.inputs[0]!.includes(`RESTART_RESULT_${taskId}`), after.inputs[0]);
    assert.equal(after.status, "done", "重启之后仍认得续聊前是 done");
    assert.equal((await row(taskId)).status, "done");
    assert.ok(!(await settledTranscript(taskId)).includes(UNCONFIRMED));
    console.log("PASS: 暂停等哨兵期间重启 —— 醒来后仍回到 done");
  }

  // ⑧ 醒来那一回合异常退出 / 被手停:落位和说明跟没被隔开的续聊回合一致
  {
    for (const [label, wake] of [
      ["异常退出", async () => 2],
      ["手停", async (id: string) => { runs.stopTask(id); return 0; }],
    ] as const) {
      const held = await makeTask("done");
      const plain = await makeTask("done");
      const gate = newGate();
      scripts.set(held, [holdTurn(gate), wake]);
      scripts.set(plain, [wake]);
      await continueTask(held, "改一下");
      await assertHeld(held, "done", 1, `⑧ ${label}`);
      release(gate);
      await settledAs(held, "done", 2, `⑧ ${label}`);
      await continueTask(plain, "改一下");
      await settledAs(plain, "done", 1, `⑧ ${label} 对照`);
      const tail = (taskId: string) => transcriptOf(taskId).match(/续聊回合[^\n]*?不变。/g)?.at(-1) ?? null;
      // 结算说明在回合收尾时异步落盘,等它写出来再比。
      await until(`⑧ ${label}:对照组那句续聊说明落盘`, async () => !!tail(plain) && !!tail(held));
      assert.equal(tail(held), tail(plain), `⑧ ${label}:说明一致`);
      assert.ok(!(await settledTranscript(held)).includes(UNCONFIRMED));
    }
    // ash 判了失败(熔断)造不出来,直接调结算:同一份行状态,两边结论一致。
    for (const from of ["done", "failed"]) {
      const held = await makeTask(from);
      const plain = await makeTask(from);
      const gate = newGate();
      scripts.set(held, [holdTurn(gate)]);
      await continueTask(held, "改一下");
      await assertHeld(held, from, 1, `⑧ 熔断 ${from}`);
      await db.update(monitors).set({ status: "stopped", endedAt: now(), endedBy: "actor", resultsAbandonedAt: now() })
        .where(eq(monitors.taskId, held));
      await emulateTurnStart(held, { byBackend: true });
      await db.update(tasks).set({ followUpFrom: from }).where(eq(tasks.id, plain));
      await setTaskStatus(plain, "running");
      const reason = { kind: "tripped" as const, detail: "上游一直 503" };
      const a = await settleTaskStatus(held, 1, null, undefined, reason);
      const b = await settleTaskStatus(plain, 1, null, undefined, reason);
      assert.deepEqual({ status: a.status, note: a.note }, { status: b.status, note: b.note }, `⑧ 熔断 ${from}`);
      assert.equal(a.status, from, "续聊只能变好,熔断不把它打坏");
    }
    console.log("PASS: 醒来那一回合异常退出 / 手停 / 熔断 —— 与未被隔开的续聊回合一致");
  }

  // ⑨ 对照:不是续聊起头的普通执行回合,隔了哨兵后醒来没交卷 —— 照旧 failed + 那句说明
  {
    const taskId = await makeTask("backlog");
    const gate = newGate();
    scripts.set(taskId, [holdTurn(gate)]);
    await continueTask(taskId, "开工", { system: "run" });
    await settledAs(taskId, "paused", 1, "⑨");
    assert.equal((await row(taskId)).followUpHeldFrom, null, "执行回合被拦下不记续聊");
    release(gate);
    await settledAs(taskId, "failed", 2, "⑨ 醒来");
    assert.ok((await settledTranscript(taskId)).includes(UNCONFIRMED), "普通执行回合照旧写那句说明");
    console.log("PASS: 普通执行回合隔了哨兵没交卷 —— 照旧 failed");
  }

  // ⑩ 串行队列 [A, B]:A 是 done,修复回合被哨兵隔开 → 醒来驳回 → A 回 done,B 恰好起跑一次
  {
    const groupId = "fuh-queue";
    await db.insert(schema.groups).values({ id: groupId, projectId: "fuh", name: "q", mode: "serial", createdAt: now() });
    const a = await makeTask("done", { free: true, groupId });
    const b = await makeTask("backlog", { groupId });
    await db.insert(schema.queueItems).values([
      { taskId: a, queueId: "fuh-q", position: 0, createdAt: now() },
      { taskId: b, queueId: "fuh-q", position: 1, createdAt: now() },
    ]);
    await stoppedReview(a);
    const gate = newGate();
    scripts.set(a, [holdTurn(gate), async (id) => {
      await disputeFreeReview(id, { summary: "这条不成立", reason: "读错了代码", deferReason: null });
    }]);
    scripts.set(b, [complete]);
    await continueTask(a, "【审查未通过】请按报告修复");
    await assertHeld(a, "done", 1, "⑩");
    await sleep(300);
    assert.equal(inputsOf(b).length, 0, "A 在等哨兵:队列照现有口径不越过它");
    release(gate);
    await settledAs(a, "done", 2, "⑩ A 醒来驳回");
    await settledAs(b, "done", 1, "⑩ B 起跑");
    await sleep(300);
    assert.equal(inputsOf(a).length, 2, "A 没被多叫一次");
    assert.equal(inputsOf(b).length, 1, "B 恰好一次,没被重复推进");
    assert.ok(!(await settledTranscript(a)).includes(UNCONFIRMED));
    console.log("PASS: 串行队列 —— A 回 done,B 恰好起跑一次");
  }

  assert.deepEqual(turnErrors, [], "夹具回合里的 pause/complete/dispute 都该成功");
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
console.log("test-follow-up-monitor-held: all passed");
process.exit(0);
