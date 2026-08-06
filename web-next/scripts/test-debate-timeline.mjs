import assert from "node:assert/strict";
import { applyDebateEvent, emptyDebate, rebuildDebateState } from "../src/debate/debateState.ts";

const start = { type: "debate.progress", taskId: "t1", round: 1, speaker: "A", phase: "start", startedAt: "2026-08-06T01:00:00.000Z" };
const agent = (event) => ({ type: "agent.event", taskId: "t1", sessionId: "s1", role: "debaterA", event });

// 辩手回合里的 exec / 读文件 / 思考,都归进「执行过程」块(与普通任务同一副形状),
// 而不是散落成一排裸的 ▶ exec。
let state = applyDebateEvent(emptyDebate(), start);
state = applyDebateEvent(state, agent({ kind: "tool", name: "exec", detail: "rg -n ExecutionDetails" }));
state = applyDebateEvent(state, agent({ kind: "thinking", text: "先看现状" }));
state = applyDebateEvent(state, agent({ kind: "text", text: "我的观点是…" }));
assert.deepEqual(state.turns[0].events, [
  { kind: "tool", label: "exec", detail: "rg -n ExecutionDetails" },
  { kind: "thinking", label: "思考过程", detail: "先看现状" },
]);
assert.equal(state.turns[0].text, "我的观点是…");

// 刷新后从 transcript 重建:回合行带着 events,执行过程还在。
const rebuilt = rebuildDebateState([
  start,
  { round: 1, speaker: "A", text: "我的观点是…", raised: true, at: "2026-08-06T01:02:00.000Z", events: [{ kind: "tool", label: "exec", detail: "npm test" }] },
]);
assert.equal(rebuilt.turns.length, 1);
assert.deepEqual(rebuilt.turns[0].events, [{ kind: "tool", label: "exec", detail: "npm test" }]);
assert.equal(rebuilt.turns[0].done, true);

// 旧辩论的 transcript 没有 events 字段:不能因此报错,也不能把实时攒到的执行过程抹掉。
let live = applyDebateEvent(emptyDebate(), start);
live = applyDebateEvent(live, agent({ kind: "tool", name: "exec", detail: "ls" }));
const merged = applyDebateEvent(live, { type: "debate.progress", taskId: "t1", round: 1, speaker: "A", phase: "end", raisedHand: false, at: "2026-08-06T01:02:00.000Z" });
assert.deepEqual(merged.turns[0].events, [{ kind: "tool", label: "exec", detail: "ls" }]);
const legacy = rebuildDebateState([start, { round: 1, speaker: "A", text: "旧回合", at: "2026-08-06T01:02:00.000Z" }]);
assert.deepEqual(legacy.turns[0].events, []);

// 用户干预(注入意见/提问)也是一条回合,只是没有执行过程。
const withUser = applyDebateEvent(emptyDebate(), { type: "debate.user", taskId: "t1", round: 2, text: "看这张图", at: "2026-08-06T01:05:00.000Z", target: "A" });
assert.equal(withUser.turns[0].speaker, "user");
assert.deepEqual(withUser.turns[0].events, []);
assert.equal(withUser.turns[0].target, "A");

console.log("debate timeline ok");
