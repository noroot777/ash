// Claude 的重试走**真实 parser**出来之后,停滞看门狗还认不认。
// 跑:npm -w server run test:claude-retry-stall
//
// 起因(第 2 轮审查 F1,已实测):看门狗自己内联了一句「不是错误就是有进展」,而 Claude 的一次
// 重试在原始流里是**两条** —— 先一条 notice error,紧跟一条 `session`(把 CLI 会话 id 报一遍)。
// 于是每条重试都被自己后面那句身份通知当场解除:8 次重试、远超阈值,页面上只有八条普通提示,
// 任务一直显示运行中,既不报警也不熔断。那句话压根不是上游回话 —— 判据共用
// `@ash/shared/waiting` 的 `resumesWaiting`(session/context/system 都不算),落点在 turn-stall.ts。
//
// 同一条意见的另一半:**子线程里的重试压根没转换成事件**。带 `parent_tool_use_id` 的事件在
// claude-stream 那边提前 return,不走它的 `system` 分支,所以子智能体连不上上游时 ash 全程静默
// (codex 那一侧的同一个洞是第 1 轮第 1 条)。现在由 `ClaudeChildActivity` 补出来,包装成
// `kind:"tool"` 的子活动 —— 看门狗穿过包装认里面那条(errorFacts)。
//
// **用真 parser,不用手搓的裸错误数组**:这条意见的要害恰恰在「adapter 实际吐出来的那串序列」,
// 自己拼事件就把要测的东西测没了。所以这里 spawn 一个真进程往 stdout 打原始行,让
// `parseClaudeStream` 自己解析。不连模型、不起 CLI。
//
// 库用临时文件(**绝不碰生产库**),所以 env 必须在 import 那条链**之前**设好 —— adapter 那边
// 会连带拉起摸库的常驻定时器(claude-monitors),所以也得先把表建出来,否则日志里一片 SQL 噪音。
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
// 纯类型,静态引进来不碰库(类型擦除,不会在设 env 之前加载那条链)。
import type { AgentEvent } from "@ash/shared";
import type { StallActions, StallFacts } from "../src/turn-stall.js";

const stage = mkdtempSync(join(tmpdir(), "ash-claude-retry-"));
process.env.ASH_DB = join(stage, "t.db");
process.env.HARNESS_DB = process.env.ASH_DB;

const { ensureSchema } = await import("../src/db/index.js");
await ensureSchema();
const { parseClaudeStream } = await import("../src/executors/claude-stream.js");
const { __resetStallFailures } = await import("../src/turn-stall-verdict.js");
const { __resetTurnStalls, trackTurnStall } = await import("../src/turn-stall.js");

const TURN = "2026-10-30T07:36:21.000Z";
const retry = (attempt: number, extra: Record<string, unknown> = {}) => JSON.stringify({
  type: "system", subtype: "api_retry", attempt, max_retries: 8,
  error: "unknown", retry_delay_ms: 1000, session_id: "sess-claude", ...extra,
});
// 原始流:init → 4 条主线程重试 → 1 条子线程重试。每条主线程重试后面都跟着 parser 自己补的
// `session`(那正是 F1 的触发物),所以这 5 条错误之间夹着 4 条身份通知。
const lines = [
  JSON.stringify({ type: "system", subtype: "init", session_id: "sess-claude" }),
  retry(1), retry(2), retry(3), retry(4),
  retry(5, { parent_tool_use_id: "toolu_child" }),
];
const script = `for (const l of ${JSON.stringify(lines)}) console.log(l);`;
const child = spawn(process.execPath, ["-e", script], { stdio: ["ignore", "pipe", "pipe"] });

process.env.ASH_STALL_WARN_ERRORS = "5";
process.env.ASH_STALL_WARN_MS = "0";
process.env.ASH_STALL_TRIP_MS = "0"; // 这一段只验报警:熔断有自己的钉子(test-turn-stall.ts)
process.env.ASH_STALL_TRIP_GRACE_MS = "0";
process.env.ASH_STALL_POLL_MS = "20";
__resetTurnStalls();
__resetStallFailures();

const warns: { text: string; facts: StallFacts }[] = [];
const actions: StallActions = {
  taskId: "task-claude-retry",
  warn: (text, facts) => warns.push({ text, facts }),
  trip: () => assert.fail("这一段把熔断档关了,却熔断了"),
  resolve: () => { /* 这一段不该有解除,下面按 warns 判 */ },
};

const kinds: string[] = [];
for await (const event of parseClaudeStream(child as never, undefined, "claude")) {
  kinds.push(event.kind === "tool" && event.nativeWork?.type === "activity"
    ? `tool:${event.nativeWork.event.kind}`
    : event.kind);
  trackTurnStall("sess-claude", child, TURN, event, actions);
}

// ① parser 的真实输出形状:主线程每条重试后面紧跟一条 session;子线程那条是包装过的活动。
const errors = kinds.filter((kind) => kind === "error").length;
assert.equal(errors, 4, `主线程 4 条重试没有都转换成 error(实际 ${JSON.stringify(kinds)})`);
assert.ok(
  kinds.filter((kind) => kind === "session").length >= 4,
  `夹具不对:那几条身份通知没出现,F1 的触发物就不在了(${JSON.stringify(kinds)})`,
);
assert.equal(
  kinds.filter((kind) => kind === "tool:error").length,
  1,
  `子线程里的重试没被报出来 —— 子智能体连不上上游时 ash 全程静默(${JSON.stringify(kinds)})`,
);

// ② 看门狗:5 条错误(4 主 + 1 子)凑够阈值就该报警,中间那几条身份通知撤不动它。
assert.equal(warns.length, 1, "整条真实流喂进去之后一声不响 —— 身份通知把每条重试都当场解除了");
assert.equal(warns[0]!.facts.errors, 5, "错误条数不对:夹着的身份通知把计数清零过");
assert.equal(warns[0]!.facts.retries, 5, "重试条数不对:有的重试没算成 notice");
assert.equal(warns[0]!.facts.childErrors, 1, "子线程那条没算进来");
assert.match(warns[0]!.text, /上游停滞/);

__resetTurnStalls();

// ── ③ 子智能体的「仍在运行」心跳不许解除停滞(审查 F1,已实测) ───────────────────
// 现场形状:子线程一直连不上上游(`api_retry`),与 `task_progress` 心跳交替到达。心跳的包装
// 是 `type:"agent"`,外层恒为 `kind:"tool"` —— 上一版只穿透 `activity` 一种包装,心跳从默认
// 分支漏过去被当成进展,每一条都把前一条重试建立的停滞 close 掉:实测 3654 条重试、3655 条
// 心跳、正文 0 条、369 秒,警告 0、熔断 0,任务全程显示运行中。
//
// 这里刻意让心跳**带 `last_tool_name`**(真实 claude 心跳就带):那样它的 `message` 非空,
// 「没有正文就不算产出」这种结构判据挡不住它 —— 只有生产点标的 `heartbeat` 位能分清
// 「重复报告当前这一步」和「子线程真说了话」。另一种(message 为空的)一并钉在下面。
{
  const beat = (n: number, extra: Record<string, unknown>) => JSON.stringify({
    type: "system", subtype: "task_progress", task_type: "local_agent",
    task_id: "task-child-1", tool_use_id: "toolu_child", session_id: "sess-beat", seq: n, ...extra,
  });
  const lines3 = [
    JSON.stringify({ type: "system", subtype: "init", session_id: "sess-beat" }),
    retry(1, { parent_tool_use_id: "toolu_child", session_id: "sess-beat" }),
    beat(1, { last_tool_name: "Bash", description: "仍在运行" }), // message 非空:只有 heartbeat 位挡得住
    retry(2, { parent_tool_use_id: "toolu_child", session_id: "sess-beat" }),
    beat(2, {}),                                                  // message 为空:结构判据也挡得住
    retry(3, { parent_tool_use_id: "toolu_child", session_id: "sess-beat" }),
    beat(3, { last_tool_name: "Bash" }),
  ];
  const child3 = spawn(process.execPath, ["-e", `for (const l of ${JSON.stringify(lines3)}) console.log(l);`],
    { stdio: ["ignore", "pipe", "pipe"] });

  process.env.ASH_STALL_WARN_ERRORS = "3";
  process.env.ASH_STALL_TRIP_MS = "60";   // 熔断档也要真落下来:报告实测那一例是「警告 0、熔断 0」
  process.env.ASH_STALL_POLL_MS = "20";
  __resetTurnStalls();
  __resetStallFailures();

  const warns3: StallFacts[] = [];
  const trips3: StallFacts[] = [];
  const actions3: StallActions = {
    taskId: "task-heartbeat",
    warn: (_text, facts) => warns3.push(facts),
    trip: (_text, facts) => trips3.push(facts),
    resolve: () => { /* 心跳不该触发解除,下面按 warns/trips 判 */ },
  };

  // 真 parser 收全,再**按真实时序**喂:熔断发生在流**还在进行**的时候(进程活着、心跳不断)。
  // 流末尾那条 `done` 是进程真的结束了 —— 它算上游回话、会解除停滞,所以单独留到最后喂,
  // 否则这一段测的就不是「心跳期间会不会熔断」而是「进程退出后还熔不熔断」。
  const streamed: AgentEvent[] = [];
  for await (const event of parseClaudeStream(child3 as never, undefined, "claude")) streamed.push(event);
  const beats = streamed
    .filter((e) => e.kind === "tool" && e.nativeWork?.type === "agent")
    .map((e) => (e.kind === "tool" && e.nativeWork?.type === "agent" ? e.nativeWork.status : ""));
  for (const event of streamed.filter((e) => e.kind !== "done")) {
    trackTurnStall("sess-beat", child3, TURN, event, actions3);
  }
  // 夹具自检:心跳真的被 parser 生产出来了,否则这一段什么都没测到。
  assert.ok(beats.length >= 3, `夹具不对:task_progress 没被转成 agent 包装(${JSON.stringify(beats)})`);
  assert.ok(beats.every((status) => status === "running"), `心跳的状态不是 running(${JSON.stringify(beats)})`);

  assert.equal(warns3.length, 1, "心跳把每条子线程重试建立的停滞都解除了 —— 远超阈值也一声不响");
  assert.equal(warns3[0]!.errors, 3, "错误条数不对:心跳把计数清零过");
  assert.equal(warns3[0]!.childErrors, 3, "子线程那几条没算进来");
  assert.equal(
    warns3[0]!.lastProgressKind,
    null,
    "诊断把「卡在哪一步」说成了那条心跳 —— 这一轮一条正常产出都没有过",
  );
  await new Promise((done) => setTimeout(done, 300));
  assert.equal(trips3.length, 1, "心跳一直到达,熔断档永远等不到 —— 任务会一直显示运行中");
  // 流随后结束(进程退出):熔断已经作出,这条 `done` 不许把它撤回去(第 2 轮审查的终止义务)。
  for (const event of streamed.filter((e) => e.kind === "done")) {
    trackTurnStall("sess-beat", child3, TURN, event, actions3);
  }
  assert.equal(trips3.length, 1, "流结束又触发了一次熔断");
  __resetTurnStalls();
  __resetStallFailures();
}

console.log("test:claude-retry-stall ok：真 parser 的 error+session 不自我解除,子线程重试报得出来,「仍在运行」心跳解除不掉停滞");
