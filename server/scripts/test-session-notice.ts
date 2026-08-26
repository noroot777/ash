// 会话轮换（Codex thread 被判 poisoned）跟**本回合成败正交**：exit 0、正文完整的一轮
// 照样会带一条轮换诊断。以前只有 duet 认这件事，single 与 team 把诊断和轮换说明都当
// `kind:"error"` 落 trace/SSE，于是一次健康产出在时间线上同时显示「本轮执行结束」和两条
// 红色「异常」（自由工作流第 1 轮审查 P2）。
//
// 这条盯行为而不是盯字符串：真的驱动一轮 `consumeSingleRun`，喂一个「诊断 + 正文 +
// exit 0」的假执行器，然后从 SSE、`.md`、trace 三份产物里确认
//   ① 直播里没有任何 error，取而代之的是 system 注记
//   ② trace 里也没有 error（刷新后不会变回红色）
//   ③ `.md` 里留下了持久的 system 回合行，措辞就是那两条说明
//   ④ 退出码、清恢复字段这些既有语义一个都没被改掉
// 加上 team/duet 两条链的静态钉子——三条链必须共用 session-notice.ts 那一个判据。
//
// 跑法：npm -w server run test:session-notice
import assert from "node:assert/strict";
import { createWriteStream, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import type { AgentEvent, ServerEvent } from "@ash/shared";

const root = mkdtempSync(join(tmpdir(), "ash-session-notice-"));
process.env.ASH_DB = join(root, "ash.db");
process.env.ASH_RUNS_DIR = join(root, "runs");
assert.ok(
  process.env.ASH_ALLOW_REAL_AGENT !== "1",
  "结算钩子一旦失手触发续跑，拦截器失效就会拿用户的真额度跑 agent",
);
process.on("exit", () => {
  try {
    rmSync(root, { recursive: true, force: true });
  } catch {}
});

const { db, ensureSchema } = await import("../src/db/index.js");
const { tasks, sessions } = await import("../src/db/schema.js");
const { bus } = await import("../src/bus.js");
const { RUNS_DIR } = await import("../src/paths.js");
const { parseSessionTrace } = await import("../src/transcript.js");
const { consumeSingleRun } = await import("../src/single-run.js");
await ensureSchema();

const ok = (m: string) => console.log("   ✓ " + m);
const AT = "2026-08-25T00:00:00.000Z";
// 真机 Codex 0.147.x 的 poisoned 诊断（executors/codex.ts 打的那条，带 scope:"session"）。
const DIAGNOSIS = "Codex 会话诊断：session=poisoned_session；"
  + "Codex stderr 出现 `dropping turn-scoped item for unknown turn id`，恢复 thread 已无法对应旧回合。";

const taskId = "single-session-notice";
const sessId = "sess-single-session-notice";
await db.insert(tasks).values({
  id: taskId, projectId: "proj", title: "会话轮换", body: "body",
  status: "running", autoTitle: false, createdAt: AT, updatedAt: AT,
});
await db.insert(sessions).values({
  id: sessId, taskId, role: "single", agentType: "codex", executor: "codex@stub",
  cliSessionId: sessId, resumeCommand: `codex exec resume ${sessId}`, resumeEnv: "K=x", resumeArgs: "--json",
  startedAt: AT,
});
mkdirSync(join(RUNS_DIR, taskId), { recursive: true });
const out = createWriteStream(join(RUNS_DIR, taskId, `${sessId}.md`));
const closed = new Promise<void>((resolve) => out.on("close", resolve));

// 诊断先到、正文完整、exit 0 —— 就是审查报告里那个「健康产出被读成失败」的现场。
const steps: AgentEvent[] = [
  { kind: "error", message: DIAGNOSIS, scope: "session" },
  { kind: "text", text: "这一轮正文已经完整产出。\n" },
  { kind: "done", exitStatus: 0 },
];

const live: ServerEvent[] = [];
const unsubscribe = bus.subscribe((event) => live.push(event));
try {
  await consumeSingleRun({
    taskId,
    sessId,
    agentType: "codex",
    ex: { model: null, reasoningEffort: null, resumeFields: () => ({}) } as never,
    cwd: root,
    handle: {
      sessionId: sessId,
      commandLine: "fake",
      kill() {},
      events: (async function* () { for (const step of steps) yield step; })(),
    } as never,
    out,
    turnStart: AT,
    cliSessionId: sessId,
    autoTitle: false,
  });
} finally {
  unsubscribe();
}
await closed;

const agentEvents = live.flatMap((e) => e.type === "agent.event" ? [e.event] : []);
const liveErrors = agentEvents.flatMap((e) => e.kind === "error" ? [e.message] : []);
assert.deepEqual(
  liveErrors.filter((message) => message.includes("poisoned") || message.includes("全新会话")),
  [],
  `轮换信号不该以 error 上 SSE：${JSON.stringify(liveErrors)}`,
);
// 反过来也要成立：真实失败仍走 error。这一轮没调 complete_task，严格完成协议那条
// 结算说明就是现成的对照组 —— 它必须还是红的，否则这次改动等于把 error 通道整条废了。
assert.ok(
  liveErrors.some((message) => message.includes("严格完成协议")),
  `真实失败必须仍以 error 上 SSE：${JSON.stringify(liveErrors)}`,
);
const liveNotes = agentEvents.flatMap((e) => e.kind === "system" ? [e.text] : []);
assert.ok(liveNotes.includes(DIAGNOSIS), `poisoned 诊断没转成 system 注记：${JSON.stringify(liveNotes)}`);
assert.ok(
  liveNotes.some((text) => text.includes("全新会话")),
  `轮换说明没转成 system 注记：${JSON.stringify(liveNotes)}`,
);
ok("直播里轮换只有 system 注记，真实失败仍是 error");

const trace = parseSessionTrace(readFileSync(join(RUNS_DIR, taskId, `${sessId}.trace.jsonl`), "utf8"));
const traceErrors = trace.flatMap(({ event }) => event.kind === "error" ? [event.message] : []);
assert.deepEqual(
  traceErrors.filter((message) => message.includes("poisoned") || message.includes("全新会话")),
  [],
  "轮换信号落进 trace 的 error 折叠块，刷新后又会变回红色异常",
);
ok("trace 里没有轮换 error，刷新后不会翻红");

// 光有直播不够：刷新后要还看得见「为什么下一次是新会话」。system 回合行是 .md 里
// 那套 sentinel（前端 persisted 路把它渲染成 note）。
const md = readFileSync(join(RUNS_DIR, taskId, `${sessId}.md`), "utf8");
const systemTurns = md.split("\n").flatMap((line) => {
  if (!line.startsWith("\x1e")) return [];
  const parsed = JSON.parse(line.slice(1));
  return parsed.t === "system" ? [parsed.text as string] : [];
});
assert.ok(systemTurns.includes(DIAGNOSIS), `.md 里没有诊断的 system 回合行：${JSON.stringify(systemTurns)}`);
assert.ok(
  systemTurns.some((text) => text.includes("全新会话")),
  `.md 里没有轮换说明的 system 回合行：${JSON.stringify(systemTurns)}`,
);
assert.ok(md.includes("这一轮正文已经完整产出。"), "正文本身必须原样落盘");
ok(".md 留下持久 system 注记，刷新后还在");

// 既有语义一个都不能被这次改动动到：exit 0 照记，恢复字段照清。
const row = (await db.select().from(sessions).where(eq(sessions.id, sessId))).at(0)!;
assert.equal(row.exitStatus, 0, "poisoned 判断不能篡改真实 exit 0");
assert.equal(row.cliSessionId, null, "poisoned 会话仍必须清 cli_session_id");
assert.equal(row.resumeCommand, null, "resume_command 没跟着清");
assert.equal(row.resumeEnv, null, "resume_env 没跟着清");
assert.equal(row.resumeArgs, null, "resume_args 没跟着清");
ok("退出码与清恢复字段的既有语义没被动到");

// 三条续跑链共用同一个判据。漏的失败方式跟 test-session-lost 的 CHAIN_OWNER 一模一样：
// 谁都能在自己那条链上再内联写一次 `event.scope === "session"`，然后漏掉其中一处。
const SRC = join(import.meta.dirname, "..", "src");
for (const chain of ["single-run.ts", "team/session-consumer.ts", "duet/turn.ts"]) {
  const code = readFileSync(join(SRC, chain), "utf8");
  assert.ok(code.includes("isSessionScopeNotice"), `${chain} 没走共用的会话轮换判据`);
  assert.doesNotMatch(
    code,
    /scope === "session"/,
    `${chain} 又内联了一份 scope 判据，改一处漏一处就是 P2 的复发方式`,
  );
}
ok("single / team / duet 共用 session-notice.ts 那一个判据");

console.log("session-notice: 全部通过");
