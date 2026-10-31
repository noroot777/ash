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
console.log("test:claude-retry-stall ok：真 parser 的 error+session 序列不再自我解除,子线程重试也报得出来");
