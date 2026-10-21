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
// 持有者 = 维护这份等待状态的那个消费者实例(生产里是进程 handle / lead),只比身份。
const RUN = {};
const notice = (message: string): AgentEvent => ({ kind: "error", message, level: "notice", affectsTurn: false });
const texts = (text: string): AgentEvent => ({ kind: "text", text });

// ── ① 此刻还在等:事件顺序决定,不看落盘 ──────────────────────────────────────
const sid = "sess-waiting";
trackSessionWaiting(sid, RUN, TURN, { kind: "tool", name: "Bash", detail: "{}" });
assert.deepEqual(sessionWaiting(sid), [], "一条提示都没来就说在等上游");
trackSessionWaiting(sid, RUN, TURN, notice(RETRY));
trackSessionWaiting(sid, RUN, TURN, notice(WAITING));
assert.deepEqual(
  sessionWaiting(sid).map((item) => [item.text, item.turnStartedAt]),
  [[RETRY, TURN], [WAITING, TURN]],
  "连环重试只记住了一条,或者丢了回合身份",
);
// **正文就是恢复信号**。它要到下一条非正文事件才冲进 trace,所以这一位必须在事件到达那一刻
// 就翻过来 —— 照 trace 判的那一版会在用户已经在读回答时还说「正在重试」(F2)。
trackSessionWaiting(sid, RUN, TURN, texts("上游已经恢复，正在继续回答。"));
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
  trackSessionWaiting(sid, RUN, TURN, notice(RETRY));
  assert.equal(sessionWaiting(sid).length, 1, `${resume.kind} 之前的提示没记上`);
  trackSessionWaiting(sid, RUN, TURN, resume);
  assert.deepEqual(sessionWaiting(sid), [], `${resume.kind} 来了还说在等上游`);
}

// 没有回合身份的提示不记:它在执行过程里也没有落点,记下来只会挂在别的回合名下。
trackSessionWaiting(sid, RUN, null, notice(RETRY));
assert.deepEqual(sessionWaiting(sid), [], "没有回合身份的提示也被当成了当前状态");

// 上一轮崩在半路(没有 turnEnd / done)时内存里那份会留着 —— 它不是新回合的状态。
trackSessionWaiting(sid, RUN, TURN, notice(RETRY));
assert.equal(sessionWaiting(sid, TURN).length, 1);
assert.deepEqual(sessionWaiting(sid, NEXT_TURN), [], "上一轮悬着的提示被当成了新回合的状态");
trackSessionWaiting(sid, RUN, NEXT_TURN, notice(WAITING));
assert.deepEqual(
  sessionWaiting(sid, NEXT_TURN).map((item) => item.text),
  [WAITING],
  "换了回合还把上一轮的提示一起带着",
);
clearSessionWaiting(sid, RUN);
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

// ── ③ 等待状态有主:换台之后旧消费者一个字都动不了 ────────────────────────────
// 起因(第 4 轮审查 F2):上一版只按会话编号共享。一条会话行会被**换台复用**(团队工作目录
// 被抽走那条路:旧进程摘牌、新进程接着写同一行),而旧进程的事件流还在吐 —— 它迟到的一条
// 正文、一次收尾,都会把新进程刚置上的等待状态删掉,手机上那句「正在重试」凭空消失。
const shared = "sess-handover";
const oldLead = {};
const newLead = {};
trackSessionWaiting(shared, newLead, TURN, notice(RETRY)); // 新台正卡在重试上
trackSessionWaiting(shared, oldLead, TURN, texts("旧台迟到的半句话"));
assert.deepEqual(
  sessionWaiting(shared, TURN).map((item) => item.text),
  [RETRY],
  "旧台迟到的正文解除了新台的等待(F2)",
);
trackSessionWaiting(shared, oldLead, TURN, { kind: "turnEnd" });
clearSessionWaiting(shared, oldLead); // 旧台收尾/摘牌
assert.equal(sessionWaiting(shared, TURN).length, 1, "旧台的收尾撤掉了新台的等待状态(F2)");
trackSessionWaiting(shared, newLead, TURN, notice(WAITING));
assert.deepEqual(
  sessionWaiting(shared, TURN).map((item) => item.text),
  [RETRY, WAITING],
  "同一个持有者同一轮的提示没接着往后攒",
);
// 一条新提示就是**认领**:换台之后由新持有者接手这条会话,前一位那几条不许跟着混进来。
const next = {};
trackSessionWaiting(shared, next, NEXT_TURN, notice(RETRY));
assert.deepEqual(
  sessionWaiting(shared, NEXT_TURN).map((item) => item.text),
  [RETRY],
  "认领之后还带着上一个持有者的提示",
);
clearSessionWaiting(shared, newLead); // 已经不是持有者了:空转
assert.equal(sessionWaiting(shared, NEXT_TURN).length, 1, "不是持有者也撤得动别人的等待状态");
clearSessionWaiting(shared, next);
assert.deepEqual(sessionWaiting(shared, NEXT_TURN), [], "持有者自己也撤不掉");

console.log("test:session-waiting ok：等待状态按事件顺序维护且认持有者,失败现场只认明确的失败结局");
