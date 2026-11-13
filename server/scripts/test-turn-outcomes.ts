// 每一回合**自己**的结局要交到页面上:快照(`GET /tasks/:id/sessions` 的 `turnOutcomes`)和直播
// (回合结尾 `done` / `turnEnd` 上的 `turnOutcome`)两路,口径跟落进 `session_turns.outcome` 的同一份。
//
// 起因:页面只拿得到每条会话**最后一回合**的结局,会话一续跑,前一回合崩没崩就不知道了。
// 哨兵叫醒要并回等它的那一回合,但异常结束之后来的叫醒不能并进去 —— 前端只能拿结算说明的文案去猜,
// 而「留了续跑交代、然后进程崩了」那一支服务端压根不写结算说明(settle-status.ts 的 resumePrompt
// 分支排在非零退出判断之前)。于是开着页面看是两个回合,刷新以后被接成一个。
//
// 所以这里真的驱动消费链,从两路产物上对:
//   ① 单飞:留了续跑交代后 exit 1 的那一轮(没有结算说明)、exit 0 却报过执行故障的那一轮、
//      正常的那一轮 —— 直播 done 依次带 failed / failed / completed,快照按回合起点给出同一份,
//      键跟 trace 的 turnStartedAt 对得上;最后一回合那一位(turnOutcome)照旧;
//   ② 团队调度台:被看门狗熔断的那一轮执行器照样报正常收口 —— 直播 turnEnd 带 failed,
//      自发开的下一轮带 completed,快照同上。
//
// 跑法:npm -w server run test:turn-outcomes
import assert from "node:assert/strict";
import { createWriteStream, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { AgentEvent, ServerEvent } from "@ash/shared";
import {
  root, db, dbClient, ensureSchema, projects, sessions, tasks, eq, at, ok, runLead, bus,
} from "./team-lead-resilience-fixture.js";

assert.ok(
  process.env.ASH_ALLOW_REAL_AGENT !== "1",
  "结算钩子一旦失手触发续跑，拦截器失效就会拿用户的真额度跑 agent",
);

const { consumeSingleRun } = await import("../src/single-run.js");
const { sessionsForTask } = await import("../src/task-session-routes.js");
const { RUNS_DIR } = await import("../src/paths.js");
const { parseSessionTrace } = await import("../src/transcript.js");
const { markStallFailure } = await import("../src/turn-stall-verdict.js");

const live: ServerEvent[] = [];
const unsubscribe = bus.subscribe((event) => live.push(event));
const liveEnds = (taskId: string, kind: "done" | "turnEnd") => live.flatMap((event) =>
  event.type === "agent.event" && event.taskId === taskId && event.event.kind === kind ? [event.event] : []);
const traceStarts = (taskId: string, sessId: string) => new Set(parseSessionTrace(
  readFileSync(join(RUNS_DIR, taskId, `${sessId}.trace.jsonl`), "utf8"),
).map((entry) => entry.turnStartedAt));
const snapshot = async (taskId: string) => {
  const [session] = await sessionsForTask(taskId);
  assert.ok(session, `${taskId} 的会话列表是空的`);
  return session;
};

try {
  await ensureSchema();
  await db.insert(projects).values({ id: "project", name: "turn-outcomes", repoPath: root, createdAt: at });

  // ── ① 单飞 ──────────────────────────────────────────────────────────────────
  {
    const taskId = "single-turn-outcomes";
    const sessId = "sess-single-turn-outcomes";
    const T = ["2026-08-25T00:00:01.000Z", "2026-08-25T00:01:00.000Z", "2026-08-25T00:02:00.000Z"];
    await db.insert(tasks).values({
      id: taskId, projectId: "project", title: "回合结局", body: "body",
      status: "running", autoTitle: false, createdAt: at, updatedAt: at,
      // 智能体挂了哨兵、留了续跑交代(pause_task 写下的就是这一列),然后进程崩了。
      resumePrompt: "继续：等回归结果",
    });
    await db.insert(sessions).values({
      id: sessId, taskId, role: "single", agentType: "codex", executor: "codex@stub",
      cliSessionId: sessId, startedAt: T[0], turnStartedAt: T[0],
    });
    mkdirSync(join(RUNS_DIR, taskId), { recursive: true });
    const turn = async (turnStart: string, steps: AgentEvent[]) => {
      await db.update(sessions).set({ turnStartedAt: turnStart, endedAt: null, exitStatus: null }).where(eq(sessions.id, sessId));
      const out = createWriteStream(join(RUNS_DIR, taskId, `${sessId}.md`), { flags: "a" });
      const closed = new Promise<void>((resolve) => out.on("close", resolve));
      const notesBefore = live.length;
      await consumeSingleRun({
        taskId, sessId, agentType: "codex",
        ex: { model: null, reasoningEffort: null, resumeFields: () => ({}) } as never,
        cwd: root,
        handle: {
          sessionId: sessId, commandLine: "fake", kill() {},
          events: (async function* () { for (const step of steps) yield step; })(),
        } as never,
        out, turnStart, cliSessionId: sessId, autoTitle: false,
      });
      await closed;
      return live.slice(notesBefore);
    };

    const crashed = await turn(T[0], [
      { kind: "text", text: "改好了，挂个哨兵跑回归。\n" },
      { kind: "tool", name: "mcp__ash__start_monitor", detail: JSON.stringify({ description: "回归" }) },
      { kind: "done", exitStatus: 1 },
    ]);
    // 这份用例的前提:这一支服务端不写结算说明,前端没有文案可猜 —— 只有结局说得清。
    const crashNotes = crashed.flatMap((event) =>
      event.type === "agent.event" && event.event.kind === "system" && event.event.level === "notice" ? [event.event.text] : []);
    assert.deepEqual(crashNotes, [], `留了续跑交代后崩掉的那一轮写了结算说明,用例前提不成立:${JSON.stringify(crashNotes)}`);
    assert.equal((await db.select().from(tasks).where(eq(tasks.id, taskId))).at(0)?.status, "paused",
      "留了续跑交代后非零退出,任务应落「检查点暂停」—— 前提不成立");
    await turn(T[1], [
      { kind: "text", text: "接着跑。\n" },
      { kind: "error", message: "上游返回 500 api_error" },
      { kind: "done", exitStatus: 0 },
    ]);
    await turn(T[2], [
      { kind: "text", text: "回归过了。\n" },
      { kind: "done", exitStatus: 0 },
    ]);

    assert.deepEqual(
      liveEnds(taskId, "done").map((event) => [event.exitStatus, event.turnOutcome]),
      [[1, "failed"], [0, "failed"], [0, "completed"]],
      "直播的回合结尾没带上这一回合自己的结局(或者 exit 0 却被判失败的那一轮带的不是 failed)",
    );
    const session = await snapshot(taskId);
    assert.deepEqual(session.turnOutcomes, { [T[0]]: "failed", [T[1]]: "failed", [T[2]]: "completed" },
      "快照没按回合起点交出每一回合的结局 —— 会话一续跑,前一回合崩没崩页面就不知道了");
    assert.deepEqual([...traceStarts(taskId, sessId)].sort(), Object.keys(session.turnOutcomes ?? {}).sort(),
      "快照里结局的键跟 trace 的 turnStartedAt 对不上,前端按回合认不回来");
    assert.equal(session.turnOutcome, "completed", "最后一回合那一位被改坏了");
    ok("单飞:留了续跑交代后崩掉 / exit 0 报过执行故障 / 正常,直播与快照给出同一份结局");
  }

  // ── ② 团队调度台 ────────────────────────────────────────────────────────────
  {
    const sessId = "sess-lead-turn-outcomes";
    const run = await runLead("lead-turn-outcomes", {
      cliSessionId: "thread-turn-outcomes",
      script: async function* () {
        yield { kind: "text", text: "第一轮:上游一直不回话。" };
        // 看门狗把这一轮熔断了:结论钉在回合身份上,而被终止的执行器报的仍是正常收口。
        markStallFailure(sessId, at, "注入:上游 10 分钟没有任何输出");
        yield { kind: "turnEnd" };
        await new Promise((done) => setTimeout(done, 4)); // 自发那一轮的起点别跟上一轮撞在同一毫秒
        yield { kind: "text", text: "哨兵叫醒了,接着干。" };
        yield { kind: "turnEnd" };
        yield { kind: "done", exitStatus: 0 };
      },
    });
    const taskId = (await run.task()).id;
    assert.deepEqual(
      liveEnds(taskId, "turnEnd").map((event) => event.turnOutcome),
      ["failed", "completed"],
      "调度台的直播回合结尾没带结局,或者被熔断的那一轮带的不是 failed",
    );
    const session = await snapshot(taskId);
    const starts = [...traceStarts(taskId, sessId)];
    assert.equal(starts.length, 2, `调度台这两轮该有两个回合起点:${JSON.stringify(starts)}`);
    const second = starts.find((start) => start !== at)!;
    assert.deepEqual(session.turnOutcomes, { [at]: "failed", [second]: "completed" },
      "调度台的快照没按回合起点交出每一回合的结局(键要跟 trace 的 turnStartedAt 对得上)");
    ok("团队调度台:熔断的那一轮直播与快照都是 failed,自发开的下一轮是 completed");
  }

  console.log("turn-outcomes: 全部通过");
} finally {
  unsubscribe();
  try {
    dbClient.close();
  } catch { /* 已经关了 */ }
  rmSync(root, { recursive: true, force: true });
}
