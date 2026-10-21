import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { dirname } from "node:path";
import {
  appendSessionTrace,
  parseSessionTrace,
  readRecentTraceEntries,
  sessionTracePath,
} from "../src/transcript.js";
import { pendingSessionNotices } from "../src/session-notice.js";

const taskId = `trace-test-${process.pid}`;
const sessionId = "session-1";
const turnStartedAt = "2026-08-01T01:00:00.000Z";
const path = sessionTracePath(taskId, sessionId);

try {
  assert.match(path, /session-1\.trace\.jsonl$/);
  appendSessionTrace(taskId, sessionId, turnStartedAt, {
    kind: "run",
    model: "gpt-5.6-sol",
    reasoningEffort: "xhigh",
  }, "2026-08-01T01:00:00.000Z");
  appendSessionTrace(taskId, sessionId, turnStartedAt, {
    kind: "thinking",
    text: "检查现有实现",
  }, "2026-08-01T01:00:01.000Z");
  appendSessionTrace(taskId, sessionId, turnStartedAt, {
    kind: "text",
    text: "先说明第一段。",
  }, "2026-08-01T01:00:01.500Z");
  appendSessionTrace(taskId, sessionId, turnStartedAt, {
    kind: "tool",
    name: "exec",
    detail: "rg -n trace",
  }, "2026-08-01T01:00:02.000Z");
  appendSessionTrace(taskId, sessionId, turnStartedAt, {
    kind: "attachment",
    path: "/tmp/data/uploads/agent-result.png",
  }, "2026-08-01T01:00:03.000Z");

  const parsed = parseSessionTrace(`${readFileSync(path, "utf8")}not-json\n`);
  assert.equal(parsed.length, 5);
  assert.deepEqual(parsed[0]?.event, { kind: "run", model: "gpt-5.6-sol", reasoningEffort: "xhigh" });
  assert.equal(parsed[1]?.event.kind, "thinking");
  assert.equal(parsed[2]?.event.kind, "text");
  assert.equal(parsed[3]?.event.kind, "tool");
  assert.equal(parsed[3]?.turnStartedAt, turnStartedAt);
  assert.deepEqual(parsed[4]?.event, {
    kind: "attachment",
    path: "/tmp/data/uploads/agent-result.png",
  });

  // 就地验证轮:run 事件多带一个轮次号。它是会话里唯一能把审查者的发言跟实现回合
  // 分开的信号(两者常跑在同一条会话上),落盘丢了它,读端就只能显示成同一个人接着说。
  appendSessionTrace(taskId, sessionId, "2026-08-01T02:00:00.000Z", {
    kind: "run",
    model: "gpt-5.6-sol",
    reasoningEffort: "xhigh",
    verifyRound: 2,
  }, "2026-08-01T02:00:00.000Z");
  const withVerify = parseSessionTrace(readFileSync(path, "utf8"));
  assert.deepEqual(withVerify.at(-1)?.event, {
    kind: "run",
    model: "gpt-5.6-sol",
    reasoningEffort: "xhigh",
    verifyRound: 2,
  });

  // ── 过程提示的窄出口 ────────────────────────────────────────────────────────
  // 「上游在重试 / 已经等了 N 分钟」原先是 .md 里的 system 旁注,手机那条每几秒重拉一次
  // .md 的轮询顺带就看到了;挪进 trace 之后手机压根读不到 —— 它读不动整份 trace(真实库里
  // 最大一份 8 MB,对应的 .md 只有 8 KB)。所以开了这个窄出口(第 1 轮审查 F3),而它给的
  // 只是「此刻还悬着的那几条」:手机端不画执行过程,没有「排在它发生的那一步下面」这个
  // 位置,给多了就等于又堆回会话结尾 —— 用户要治的正是那个(第 2 轮审查 F1)。
  const turn2 = "2026-08-01T03:00:00.000Z";
  appendSessionTrace(taskId, sessionId, turn2, { kind: "run", model: null, reasoningEffort: null }, turn2);
  appendSessionTrace(taskId, sessionId, turn2, {
    kind: "error",
    message: "真的崩了",
  }, "2026-08-01T03:00:01.000Z");
  const RETRY = "上游返回 502 server_error，正在重试（第 1/10 次，等 0.6 秒）";
  appendSessionTrace(taskId, sessionId, turn2, {
    kind: "error",
    message: RETRY,
    level: "notice",
    affectsTurn: false,
  }, "2026-08-01T03:00:02.000Z");
  // message 不是字符串的「提示」:形状由 parseSessionTrace 验到底,这里钉的是它真被挡住 ——
  // 放过去手机端渲染的就是一个 [object Object](第 2 轮审查 N5)。
  appendFileSync(path, `${JSON.stringify({
    at: "2026-08-01T03:00:03.000Z",
    turnStartedAt: turn2,
    event: { kind: "error", message: { code: 502 }, level: "notice" },
  })}\n`);

  const live = { turnStartedAt: turn2, endedAt: null, exitStatus: null };
  const entries = await readRecentTraceEntries(taskId, sessionId);
  assert.deepEqual(
    pendingSessionNotices(entries, live),
    [{ at: "2026-08-01T03:00:02.000Z", turnStartedAt: turn2, text: RETRY }],
    "还在飞的这一轮:要么漏了那条提示,要么把别的事件(真故障 / 坏形状)也带了出来",
  );
  assert.deepEqual(
    pendingSessionNotices(entries, { ...live, turnStartedAt }),
    [],
    "会话行已经翻到新回合了,上一轮悬着的提示是历史,不该当成此刻状态",
  );
  assert.deepEqual(
    pendingSessionNotices(entries, { turnStartedAt: turn2, endedAt: "2026-08-01T03:10:00.000Z", exitStatus: 0 }),
    [],
    "这一轮跑完且成功了,重试提示却还挂着 —— 那就是用户要删掉的「会话结尾一坨」",
  );
  assert.deepEqual(
    pendingSessionNotices(entries, { turnStartedAt: turn2, endedAt: "2026-08-01T03:10:00.000Z", exitStatus: 1 }),
    [{ at: "2026-08-01T03:00:02.000Z", turnStartedAt: turn2, text: RETRY }],
    "这一轮真的收在失败上,提示就是失败现场,必须照给",
  );

  // 提示之后上游又吐了东西 = 已经恢复,这条就不再是「此刻还在等」。
  appendSessionTrace(taskId, sessionId, turn2, { kind: "text", text: "上游回来了。" }, "2026-08-01T03:00:04.000Z");
  assert.deepEqual(
    pendingSessionNotices(await readRecentTraceEntries(taskId, sessionId), live),
    [],
    "上游已经恢复输出,手机上还写着「正在重试」",
  );

  assert.deepEqual(
    await readRecentTraceEntries(`${taskId}-never-ran`, sessionId),
    [],
    "没有 trace 文件的会话(2026-08-01 之前跑完的那 992 条)必须当成「什么都没有」,不能报错",
  );
  // 文件在、却读不出来是另一回事:咽掉的话一次磁盘故障会被读成「上游没在重试」
  // (第 2 轮审查 N4)。这里在 trace 该在的位置放一个目录 —— stat 过得去、读内容必失败。
  const blocked = "blocked-session";
  mkdirSync(sessionTracePath(taskId, blocked), { recursive: true });
  await assert.rejects(
    () => readRecentTraceEntries(taskId, blocked),
    "trace 读失败被咽成了「没有提示」",
  );

  console.log("会话执行轨迹持久化验证通过");
} finally {
  rmSync(dirname(path), { recursive: true, force: true });
}
