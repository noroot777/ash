import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { dirname } from "node:path";
import {
  appendSessionTrace,
  parseSessionTrace,
  readRecentTraceEntries,
  sessionTracePath,
} from "../src/transcript.js";
import { failedTurnNotices } from "../src/session-waiting.js";

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

  // ── 窄出口读到的是什么 ──────────────────────────────────────────────────────
  // 「上游在重试 / 已经等了 N 分钟」原先是 .md 里的 system 旁注,手机那条每几秒重拉一次
  // .md 的轮询顺带就看到了;挪进 trace 之后手机压根读不到 —— 它读不动整份 trace(真实库里
  // 最大一份 8 MB,对应的 .md 只有 8 KB)。这里只钉**读取**这一层:尾巴读得到、形状验得住、
  // 文件不在与读不动分得开。给不给、给哪几条由 session-waiting.ts 判(见 test:session-waiting)。
  const turn2 = "2026-08-01T03:00:00.000Z";
  appendSessionTrace(taskId, sessionId, turn2, { kind: "run", model: null, reasoningEffort: null }, turn2);
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

  const recent = await readRecentTraceEntries(taskId, sessionId);
  assert.deepEqual(
    recent.filter((item) => item.turnStartedAt === turn2).map((item) => item.event.kind),
    ["run", "error"],
    "窄出口的尾巴读漏了这一轮的条目,或者把坏形状的那一行也放了进来",
  );
  assert.deepEqual(
    failedTurnNotices(recent, { turnStartedAt: turn2, exitStatus: 1, stoppedAs: null }),
    [{ at: "2026-08-01T03:00:02.000Z", turnStartedAt: turn2, text: RETRY }],
    "从落盘 trace 回放失败现场这条路断了",
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
