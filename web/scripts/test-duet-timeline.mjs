import assert from "node:assert/strict";
import { parseAttachmentText } from "@ash/shared/attachments";
import { applyDuetEvent, emptyDuet, rebuildDuetState } from "../src/duet/duetState.ts";

const start = { type: "duet.progress", taskId: "t1", round: 1, speaker: "A", phase: "start", startedAt: "2026-08-06T01:00:00.000Z" };
const agent = (event) => ({ type: "agent.event", taskId: "t1", sessionId: "s1", role: "voiceA", event });

// 讨论者回合里的 exec / 读文件 / 思考,都归进「执行过程」块(与普通任务同一副形状),
// 而不是散落成一排裸的 ▶ exec。
let state = applyDuetEvent(emptyDuet(), start);
state = applyDuetEvent(state, agent({ kind: "tool", name: "exec", detail: "rg -n ExecutionDetails" }));
state = applyDuetEvent(state, agent({ kind: "thinking", text: "先看现状" }));
state = applyDuetEvent(state, agent({ kind: "text", text: "我的观点是…" }));
state = applyDuetEvent(state, agent({ kind: "system", text: "旧会话已轮换", at: "2026-08-06T01:01:00.000Z" }));
assert.deepEqual(state.turns[0].events, [
  { kind: "tool", label: "exec", detail: "rg -n ExecutionDetails" },
  { kind: "thinking", label: "思考过程", detail: "先看现状" },
]);
assert.equal(state.turns[0].text, "我的观点是…");
assert.equal(state.turns[0].notice, "旧会话已轮换");

// 一个回合出多条 error / 旁注：实时也要**累积**。服务端 runTurn 落 transcript 时就是
// 拼接的，这里要是覆盖，同一个回合实时只剩最后一条、刷新后又变成全部，两个面读不一样。
let multi = applyDuetEvent(emptyDuet(), start);
multi = applyDuetEvent(multi, agent({ kind: "error", message: "第一条失败" }));
multi = applyDuetEvent(multi, agent({ kind: "error", message: "第二条失败" }));
multi = applyDuetEvent(multi, agent({ kind: "system", text: "会话已轮换", at: "2026-08-06T01:01:30.000Z" }));
assert.equal(multi.turns[0].error, "第一条失败\n第二条失败");
assert.equal(multi.turns[0].notice, "会话已轮换");

// 刷新后从 transcript 重建:回合行带着 events,执行过程还在。
const rebuilt = rebuildDuetState([
  start,
  { round: 1, speaker: "A", text: "我的观点是…", raised: true, at: "2026-08-06T01:02:00.000Z", events: [{ kind: "tool", label: "exec", detail: "npm test" }] },
]);
assert.equal(rebuilt.turns.length, 1);
assert.deepEqual(rebuilt.turns[0].events, [{ kind: "tool", label: "exec", detail: "npm test" }]);
assert.equal(rebuilt.turns[0].done, true);

// 旧讨论的 transcript 没有 events 字段:不能因此报错,也不能把实时攒到的执行过程抹掉。
let live = applyDuetEvent(emptyDuet(), start);
live = applyDuetEvent(live, agent({ kind: "tool", name: "exec", detail: "ls" }));
const merged = applyDuetEvent(live, { type: "duet.progress", taskId: "t1", round: 1, speaker: "A", phase: "end", raisedHand: false, at: "2026-08-06T01:02:00.000Z" });
assert.deepEqual(merged.turns[0].events, [{ kind: "tool", label: "exec", detail: "ls" }]);
const legacy = rebuildDuetState([start, { round: 1, speaker: "A", text: "旧回合", at: "2026-08-06T01:02:00.000Z" }]);
assert.deepEqual(legacy.turns[0].events, []);

// 用户干预(注入意见/提问)也是一条回合,只是没有执行过程。
const withUser = applyDuetEvent(emptyDuet(), { type: "duet.user", taskId: "t1", round: 2, text: "看这张图", at: "2026-08-06T01:05:00.000Z", target: "A" });
assert.equal(withUser.turns[0].speaker, "user");
assert.deepEqual(withUser.turns[0].events, []);
assert.equal(withUser.turns[0].target, "A");

// 带附件的那一句:气泡要把附件段还原成缩略图,而不是把本地路径原样念给用户看。
const withFiles = applyDuetEvent(emptyDuet(), {
  type: "duet.user",
  taskId: "t1",
  round: 2,
  text: "看这张图\n\n[用户附带的文件，请用 Read 工具查看以下本地文件]\n- /tmp/uploads/a-image.png",
  at: "2026-08-06T01:05:00.000Z",
});
const said = parseAttachmentText(withFiles.turns[0].text);
assert.equal(said.body, "看这张图");
assert.deepEqual(said.paths, ["/tmp/uploads/a-image.png"]);

console.log("duet timeline ok");
