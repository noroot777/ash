import assert from "node:assert/strict";
import {
  runActivityCopy,
  runActivityExecutor,
  runActivityPhase,
  runActivityTail,
} from "@harness/shared/run-activity";
import { latestActiveDuetTurn, rebuildDuetState } from "../src/duet/duetState.ts";

assert.equal(runActivityPhase("running", "empty"), "starting");
assert.equal(runActivityPhase("running", "user"), "replying");
assert.equal(runActivityPhase("running", "agent-ended"), "continuing");
assert.equal(runActivityPhase("running", "agent-active"), null);
assert.equal(runActivityPhase("backlog", "user"), null);

// 尾巴按最后一条**消息**算：末尾的事件行（「任务又被唤醒」之类）不该把
// 「已收到你的消息」冲成「正在继续处理」。
assert.equal(runActivityTail([]), "empty");
assert.equal(runActivityTail([{ kind: "event" }]), "other");
assert.equal(runActivityTail([{ kind: "user" }, { kind: "event" }]), "user");
assert.equal(runActivityTail([{ kind: "user", bySystem: true }]), "other", "后端交接不能冒充用户刚发的消息");
assert.equal(runActivityTail([{ kind: "agent", endedAt: null }, { kind: "event" }]), "agent-active");
assert.equal(runActivityTail([{ kind: "agent", endedAt: "2026-08-04T00:00:00.000Z" }]), "agent-ended");
assert.equal(runActivityTail([{ kind: "agent", endedAt: null }, { kind: "user" }]), "user");

// 谁在跑就报谁：@grok 召唤进来的会话正在跑时，横幅不能再报任务常设的 codex。
const standing = { agentType: "codex", executor: "codex@cpa·gpt-5.6-sol", startedAt: "2026-08-02T07:10:00.000Z", turnStartedAt: "2026-08-02T07:10:00.000Z", endedAt: "2026-08-02T07:40:00.000Z" };
const summoned = { agentType: "grok", executor: "grok@local", startedAt: "2026-08-02T07:48:00.000Z", turnStartedAt: "2026-08-02T07:49:00.000Z", endedAt: null };
assert.equal(
  runActivityExecutor({ sessions: [standing, summoned], fallback: "codex@cpa·gpt-5.6-sol" }),
  "grok@local",
);
// 回合最新的那条优先（两条都还没收口时）。
assert.equal(
  runActivityExecutor({ sessions: [{ ...standing, endedAt: null }, summoned], fallback: "codex@cpa·gpt-5.6-sol" }),
  "grok@local",
);
// 会话行还没落库的那一两秒：先照抄刚发出去的那一回合目标。
assert.equal(
  runActivityExecutor({ sessions: [standing], pending: "codex@cpa·gpt-5.6-sol", fallback: "claude@ccb" }),
  "codex@cpa·gpt-5.6-sol",
);
// 没会话也没目标才退到任务常设执行器；profile 名缺失时退到类型名。
assert.equal(runActivityExecutor({ sessions: [], fallback: "claude@ccb" }), "claude@ccb");
assert.equal(runActivityExecutor({ sessions: [{ agentType: "grok", executor: "  ", endedAt: null }] }), "grok");
assert.equal(runActivityExecutor({}), null);

assert.deepEqual(runActivityCopy({ status: "running", mode: "single", executor: "codex@local" }), {
  title: "codex@local 正在启动",
  detail: "正在准备运行环境、读取任务并连接执行器。首条输出会自动出现在这里，无需重复点击。",
});
assert.match(runActivityCopy({ status: "running", mode: "team" }).title, /正在启动调度台/);
assert.match(runActivityCopy({ status: "running", mode: "duet" }).detail, /第一位讨论者开始发言后/);
assert.deepEqual(runActivityCopy({ status: "queued", mode: "single", queuePosition: 1 }), {
  title: "已进入队列 · 第 2 位",
  detail: "前面的任务结束后会自动启动，无需重复点击。",
});
assert.deepEqual(runActivityCopy({ status: "running", mode: "single", phase: "replying", executor: "codex@local" }), {
  title: "codex@local 已收到你的消息",
  detail: "正在恢复原会话并读取你的补充，下一条回复会自动出现在这里。",
});
assert.match(runActivityCopy({ status: "running", mode: "team", phase: "replying" }).detail, /调整方向/);
assert.match(runActivityCopy({ status: "running", mode: "duet", phase: "replying" }).title, /收到你的补充/);
assert.equal(runActivityCopy({ status: "done", mode: "single", phase: "continuing" }), null);

const openingStarts = [
  { type: "duet.progress", taskId: "duet-1", round: 1, speaker: "A", phase: "start", startedAt: "2026-08-04T00:00:00.000Z" },
  { type: "duet.progress", taskId: "duet-1", round: 1, speaker: "B", phase: "start", startedAt: "2026-08-04T00:00:01.000Z" },
];
const parallelOpening = rebuildDuetState([
  ...openingStarts,
  { round: 1, speaker: "B", text: "B 先完成", at: "2026-08-04T00:00:02.000Z" },
]);
assert.equal(parallelOpening.turns.length, 2);
assert.equal(parallelOpening.turns.at(-1)?.speaker, "B");
assert.equal(parallelOpening.turns.at(-1)?.done, true);
assert.equal(latestActiveDuetTurn(parallelOpening.turns)?.speaker, "A");

const completedOpening = rebuildDuetState([
  ...openingStarts,
  { round: 1, speaker: "B", text: "B 先完成" },
  { round: 1, speaker: "A", text: "A 后完成" },
]);
assert.equal(completedOpening.turns.length, 2);
assert.equal(latestActiveDuetTurn(completedOpening.turns), null);

console.log("run activity state tests passed");
