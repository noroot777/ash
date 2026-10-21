import assert from "node:assert/strict";
import { readFileSync, rmSync } from "node:fs";
import { dirname } from "node:path";
import {
  appendSessionTrace,
  parseSessionTrace,
  readSessionNotices,
  sessionTracePath,
} from "../src/transcript.js";

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

  // 过程提示的窄出口(第 1 轮审查 F3)。「上游在重试 / 已经等了 N 分钟」原先是 .md 里的
  // system 旁注,手机那条每几秒重拉一次 .md 的轮询顺带就看到了;挪进 trace 之后手机压根
  // 读不到 —— 它读不动整份 trace(真实库里最大一份 8 MB,对应的 .md 只有 8 KB)。所以这
  // 个出口必须只挑提示、把别的事件一个都不带出来。
  appendSessionTrace(taskId, sessionId, turnStartedAt, {
    kind: "error",
    message: "上游返回 502 server_error，正在重试（第 1/10 次，等 0.6 秒）",
    level: "notice",
    affectsTurn: false,
  }, "2026-08-01T03:00:00.000Z");
  appendSessionTrace(taskId, sessionId, turnStartedAt, {
    kind: "error",
    message: "真的崩了",
  }, "2026-08-01T03:00:01.000Z");
  const notices = await readSessionNotices(taskId, sessionId);
  assert.deepEqual(notices, [
    { at: "2026-08-01T03:00:00.000Z", text: "上游返回 502 server_error，正在重试（第 1/10 次，等 0.6 秒）" },
  ], "过程提示的窄出口要么漏了提示,要么把别的事件(含真故障)也带了出来");
  assert.deepEqual(
    await readSessionNotices(`${taskId}-never-ran`, sessionId),
    [],
    "没有 trace 文件的会话(2026-08-01 之前跑完的那 992 条)必须当成「没有提示」,不能报错",
  );

  console.log("会话执行轨迹持久化验证通过");
} finally {
  rmSync(dirname(path), { recursive: true, force: true });
}
