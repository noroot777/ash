// 一轮异常结束以后会话里那一句（docs/ui-ux-audit run-8）：刷新以后从会话行认出来，补在那条会话
// 最后一回合后面；直播那一路已经落了异常边界就不重复；正常收口、手动停、审查会话都不补。
// 跑:npm -w web run test:turn-failure
import assert from "node:assert/strict";
import { crashedTurns } from "../src/task-detail/turnFailure.ts";

const sess = (over = {}) => ({ id: "s1", role: "single", endedAt: "2026-11-12T00:00:00.000Z", exitStatus: 1, ...over });
const agent = (id, session, over = {}) => ({ kind: "agent", id, session, segments: [], markdown: "", ...over });
const boundary = (tone) => ({ kind: "event", id: "b", text: "执行异常结束 · exit 1", variant: "boundary", tone });

assert.deepEqual([...crashedTurns([agent("a1", sess()), agent("a2", sess())])], [["a2", "执行异常结束 · exit 1"]], "只补在这条会话的最后一回合后面");
assert.equal(crashedTurns([agent("a1", sess({ exitStatus: 0 }))]).size, 0, "正常收口不补");
assert.equal(crashedTurns([agent("a1", sess({ endedAt: null }))]).size, 0, "还在跑的会话不补");
assert.equal(crashedTurns([agent("a1", sess({ stoppedAs: "user" }))]).size, 0, "手动停下的不算异常");
assert.equal(crashedTurns([agent("a1", sess({ exitStatus: 0, turnOutcome: "failed" }))]).get("a1"), "执行异常结束 · exit 0", "权威结局优先于退出码");
assert.equal(crashedTurns([agent("a1", sess(), { reviewer: { round: 1 } })]).size, 0, "审查会话有自己的卡");
assert.equal(crashedTurns([agent("a1", sess()), boundary("error")]).size, 0, "直播那一路已经有异常边界");
assert.equal(crashedTurns([agent("a1", sess()), boundary("neutral")]).size, 1, "正常边界不顶替异常那一句");
console.log("turn failure ok");
