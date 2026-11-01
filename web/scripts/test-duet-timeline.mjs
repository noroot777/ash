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

// 发言**还没结束**时刷新页面:那条停滞诊断必须还在(第 1 轮审查 F4)。
// 讨论页首次进入和刷新都只读 transcript.jsonl,而一轮发言的完整记录要等 runTurn 收尾才追加 ——
// 停滞警告出现到发言结束之间按定义很长(上游一直连不上才会报警),这段窗口里刷新一下警告就
// 不见了,只剩「正在组织本轮观点」。所以服务端在警告/熔断那一刻就把**与实时 SSE 一模一样**的
// 那条 agent.event 落进同一份 transcript(server/src/duet/timeline.ts 的 recordTurnDiagnostic),
// 回放这里认它。
const WARN = { kind: "error", message: "上游已连续 5 次重试、4 分钟没有任何回话", level: "notice", affectsTurn: false };
const TRIP = { kind: "error", message: "已自动终止本回合并按失败结算:只收到错误事件" };
// 警告档:发言还开着,刷新之后那句提示和「正在等上游」两样都得在。警告是「过程里的一句提示」,
// 跟实时同一个去处 —— 进执行过程的 notice,不进 error(那条口径上面几段已经钉过)。
const warned = rebuildDuetState([start, agent(WARN)]);
assert.equal(warned.turns.length, 1, "回放把那条诊断当成了别的回合");
assert.equal(warned.turns[0].done, false, "发言还没结束,回合却被标成了已完成");
assert.deepEqual(warned.turns[0].events, [{ kind: "notice", label: "提示", detail: WARN.message }],
  "发言进行中刷新页面,停滞警告没了 —— 警告档承诺的「持久可见、刷新仍在」在讨论页上没兑现");
assert.equal(warned.turns[0].awaiting, true, "刷新后那条「正在等上游」的等待状态没跟着回来");
// 熔断档:红字也得跨得过刷新。它顺带把「正在等」撤掉 —— 这一轮已经被我们终止,不再是在等谁。
const midStatement = rebuildDuetState([start, agent(WARN), agent(TRIP)]);
assert.equal(midStatement.turns.length, 1, "回放把那两条诊断当成了别的回合");
assert.equal(midStatement.turns[0].error, TRIP.message, "刷新之后熔断那条红字没了");
assert.equal(midStatement.turns[0].awaiting, false, "都已经熔断了还显示「正在等上游」");

// 这一轮真收尾之后:整轮记录把同一个回合**整体替掉**,不许出现两份。
const afterStatement = rebuildDuetState([
  start,
  agent(WARN),
  agent(TRIP),
  { round: 1, speaker: "A", text: "我的观点是…", raised: false, at: "2026-08-06T01:02:00.000Z",
    error: TRIP.message,
    events: [{ kind: "tool", label: "exec", detail: "npm test" }, { kind: "notice", label: "提示", detail: WARN.message }] },
]);
assert.equal(afterStatement.turns.length, 1, "那两条诊断和整轮记录各占了一个回合 —— 同一轮发言显示成了两条");
assert.equal(afterStatement.turns[0].done, true, "整轮记录没把这个回合收口");
assert.equal(afterStatement.turns[0].text, "我的观点是…", "落盘那份正文没盖上去");
assert.equal(afterStatement.turns[0].error, TRIP.message, "收尾之后熔断那条红字反而没了");
assert.deepEqual(afterStatement.turns[0].events,
  [{ kind: "tool", label: "exec", detail: "npm test" }, { kind: "notice", label: "提示", detail: WARN.message }],
  "落盘那份执行过程没盖上去(诊断在里面,所以不能只看条数)");

console.log("duet timeline ok");
