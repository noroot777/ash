// 窄出口(`GET /sessions/:id/notices`)那两种投影各自的判据。跑:npm -w server run test:session-waiting
//
// 起因(2026-10-21 第 3 轮审查 F1):上一版把「有 endedAt 且退出码不是 0」当成失败现场,于是
// **常驻调度台每一轮健康收尾**都落进了这一档 —— 它每轮都写 endedAt,而进程还在跑,exitStatus
// 合法地仍是 null。结果一台答完待命的调度台在手机上重新挂出整轮的「正在重试」。
//
// 同一轮 F2 的另一半是「此刻还在等」压根不该从落盘产物反推:正文有缓冲(要到下一条非正文
// 事件才冲进 trace),照 trace 判会在整段恢复回答期间一直说正在重试。所以这件事由事件消费链
// 顺序维护,这里钉的就是那个状态机。
import assert from "node:assert/strict";
import type { AgentEvent } from "@ash/shared";
import {
  clearSessionWaiting,
  failedTurnNotices,
  sessionWaiting,
  trackSessionWaiting,
} from "../src/session-waiting.js";
import type { SessionTraceEntry } from "../src/transcript.js";

const TURN = "2026-10-21T06:00:00.000Z";
const NEXT_TURN = "2026-10-21T07:00:00.000Z";
const RETRY = "上游返回 502 server_error，正在重试（第 1/10 次，等 0.6 秒）";
const WAITING = "已经等上游 5 分钟没有响应，本回合仍在等待中";
const notice = (message: string): AgentEvent => ({ kind: "error", message, level: "notice", affectsTurn: false });
const texts = (text: string): AgentEvent => ({ kind: "text", text });

// ── ① 此刻还在等:事件顺序决定,不看落盘 ──────────────────────────────────────
const sid = "sess-waiting";
trackSessionWaiting(sid, TURN, { kind: "tool", name: "Bash", detail: "{}" });
assert.deepEqual(sessionWaiting(sid), [], "一条提示都没来就说在等上游");
trackSessionWaiting(sid, TURN, notice(RETRY));
trackSessionWaiting(sid, TURN, notice(WAITING));
assert.deepEqual(
  sessionWaiting(sid).map((item) => [item.text, item.turnStartedAt]),
  [[RETRY, TURN], [WAITING, TURN]],
  "连环重试只记住了一条,或者丢了回合身份",
);
// **正文就是恢复信号**。它要到下一条非正文事件才冲进 trace,所以这一位必须在事件到达那一刻
// 就翻过来 —— 照 trace 判的那一版会在用户已经在读回答时还说「正在重试」(F2)。
trackSessionWaiting(sid, TURN, texts("上游已经恢复，正在继续回答。"));
assert.deepEqual(sessionWaiting(sid), [], "上游已经在吐正文了,还挂着等待提示(F2)");

for (const resume of [
  { kind: "thinking", text: "想一下" },
  { kind: "tool", name: "Read", detail: "{}" },
  { kind: "attachment", path: "/tmp/shot.png" },
  { kind: "usage", usage: { inputTokens: 1, outputTokens: 1 } },
  { kind: "turnEnd" },
  { kind: "done", exitStatus: 0 },
  { kind: "error", message: "真的崩了" },
] as AgentEvent[]) {
  trackSessionWaiting(sid, TURN, notice(RETRY));
  assert.equal(sessionWaiting(sid).length, 1, `${resume.kind} 之前的提示没记上`);
  trackSessionWaiting(sid, TURN, resume);
  assert.deepEqual(sessionWaiting(sid), [], `${resume.kind} 来了还说在等上游`);
}

// 没有回合身份的提示不记:它在执行过程里也没有落点,记下来只会挂在别的回合名下。
trackSessionWaiting(sid, null, notice(RETRY));
assert.deepEqual(sessionWaiting(sid), [], "没有回合身份的提示也被当成了当前状态");

// 上一轮崩在半路(没有 turnEnd / done)时内存里那份会留着 —— 它不是新回合的状态。
trackSessionWaiting(sid, TURN, notice(RETRY));
assert.equal(sessionWaiting(sid, TURN).length, 1);
assert.deepEqual(sessionWaiting(sid, NEXT_TURN), [], "上一轮悬着的提示被当成了新回合的状态");
trackSessionWaiting(sid, NEXT_TURN, notice(WAITING));
assert.deepEqual(
  sessionWaiting(sid, NEXT_TURN).map((item) => item.text),
  [WAITING],
  "换了回合还把上一轮的提示一起带着",
);
clearSessionWaiting(sid);
assert.deepEqual(sessionWaiting(sid), [], "clearSessionWaiting 没撤掉");

// ── ② 失败现场:只有真收在失败上的那一轮才回放 ──────────────────────────────
const entry = (turnStartedAt: string, event: SessionTraceEntry["event"], at: string): SessionTraceEntry =>
  ({ at, turnStartedAt, event });
const entries: SessionTraceEntry[] = [
  entry(TURN, { kind: "tool", name: "Bash", detail: "{}" }, "2026-10-21T06:00:01.000Z"),
  entry(TURN, { kind: "error", message: RETRY, level: "notice", affectsTurn: false }, "2026-10-21T06:00:02.000Z"),
  entry(TURN, { kind: "error", message: "真的崩了" }, "2026-10-21T06:00:03.000Z"),
  entry(NEXT_TURN, { kind: "error", message: WAITING, level: "notice", affectsTurn: false }, "2026-10-21T07:00:01.000Z"),
];
const replayed = [{ at: "2026-10-21T06:00:02.000Z", turnStartedAt: TURN, text: RETRY }];

assert.deepEqual(
  failedTurnNotices(entries, { turnStartedAt: TURN, exitStatus: 1, stoppedAs: null }),
  replayed,
  "这一轮真收在失败上,失败现场却没给 —— 用户要的正是「它卡在哪儿」",
);
// F1 的现场:常驻调度台健康收尾。endedAt 有值、进程还在跑,所以 exitStatus 仍是 null。
assert.deepEqual(
  failedTurnNotices(entries, { turnStartedAt: TURN, exitStatus: null, stoppedAs: null }),
  [],
  "一台答完待命的调度台被当成失败现场,整轮提示在手机上重新挂了出来(F1)",
);
assert.deepEqual(
  failedTurnNotices(entries, { turnStartedAt: TURN, exitStatus: 0, stoppedAs: null }),
  [],
  "这一轮跑完且成功了,重试提示却还挂着 —— 那就是用户要删掉的「会话结尾一坨」",
);
// 被人停下来的不是失败:CLI 吃 SIGTERM 后按 signal 写非零退出码,光看 exitStatus 分不出来。
assert.deepEqual(
  failedTurnNotices(entries, { turnStartedAt: TURN, exitStatus: 143, stoppedAs: "canceled" }),
  [],
  "用户自己停的那一轮被当成了失败现场",
);
assert.deepEqual(
  failedTurnNotices(entries, { turnStartedAt: null, exitStatus: 1, stoppedAs: null }),
  [],
  "会话行上压根没有回合身份时不该猜",
);
assert.deepEqual(
  failedTurnNotices(entries, { turnStartedAt: NEXT_TURN, exitStatus: 1, stoppedAs: null }),
  [{ at: "2026-10-21T07:00:01.000Z", turnStartedAt: NEXT_TURN, text: WAITING }],
  "回放串到了别的回合去",
);

console.log("test:session-waiting ok：等待状态按事件顺序维护,失败现场只认明确的失败结局");
