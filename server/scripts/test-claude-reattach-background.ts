// claude 单飞接管与连续插话这两条「后台工作生命周期」的回归(自由审查 KqmEd8oQLV5_ 第 1 轮)。
//   npm -w server run test:claude-reattach
//
// 两件事都走真实的 `ClaudeExecutor.attach → residentFromChild → parseClaudeStream →
// singleRunFromResident`,对面是一个按 stream-json 协议说话的假 CLI 子进程:
//   ① 重启接管:`task_started` 在已消费水位之前,接回后的账本必须从那段输出重建 —— 否则
//      主回合一结尾就把还在跑的工作流收掉;接回时正停在「等后台」的空档,要接着等。
//   ② 连续插话:第一次插话打断并送进新消息之后、模型还没开口之前,第二次插话必须照样打断,
//      不能因为「没收到输出」就当成空闲直接排进去。
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "ash-claude-reattach-"));
process.env.ASH_DB = join(root, "ash.db");
process.env.ASH_RUNS_DIR = join(root, "runs");
const [{ ensureSchema, dbClient }, { ClaudeExecutor }] = await Promise.all([
  import("../src/db/index.js"),
  import("../src/executors/claude.js"),
]);
await ensureSchema();

const line = (value: unknown) => JSON.stringify(value) + "\n";

/** 假 CLI:先吐 `tail`(接管水位之后的那段),stdin 收到什么记进 `inputs`,关掉 stdin 就退出。 */
function stubCli(name: string, tail: unknown[], onInput = "") {
  const script = join(root, `${name}.cjs`);
  writeFileSync(script, `
const readline = require("node:readline");
const emit = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
readline.createInterface({ input: process.stdin }).on("line", (raw) => {
  const message = JSON.parse(raw);
  process.stderr.write("INPUT " + message.type + "\\n");
  ${onInput}
}).on("close", () => { process.stderr.write("STDIN_CLOSED\\n"); process.exit(0); });
for (const value of ${JSON.stringify(tail)}) emit(value);
setTimeout(() => process.exit(0), 3000);
`);
  const child = spawn(process.execPath, [script], { stdio: ["pipe", "pipe", "pipe"] });
  let stderr = "";
  child.stderr.on("data", (data) => { stderr += data.toString(); });
  return { child, stderr: () => stderr };
}

const launch = [
  { type: "system", subtype: "init", session_id: "sess-r" },
  { type: "assistant", message: { model: "claude-opus-5", content: [{ type: "tool_use", id: "wf-call", name: "Workflow", input: { script: "export const meta = {}" } }] } },
  { type: "system", subtype: "task_started", task_id: "wf", tool_use_id: "wf-call", task_type: "local_workflow", description: "合稿" },
  { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "wf-call", content: "Workflow launched in background" }] } },
];
const progress = { type: "system", subtype: "task_progress", task_id: "wf", tool_use_id: "wf-call", task_type: "local_workflow",
  workflow_progress: [{ type: "workflow_agent", index: 0, label: "仍在执行", state: "progress", agentId: "child-1" }] };
const say = (text: string) => [
  { type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: text + "\n" } } },
  { type: "assistant", message: { model: "claude-opus-5", content: [{ type: "text", text }] } },
];
const result = { type: "result", subtype: "success", num_turns: 1, result: "", session_id: "sess-r" };

async function drain(handle: { events: AsyncIterable<any> }, ms: number) {
  const events: any[] = [];
  const consuming = (async () => { for await (const event of handle.events) events.push(event); })();
  await Promise.race([consuming, new Promise((resolve) => setTimeout(resolve, ms))]);
  return { events, consuming };
}

const executor = new ClaudeExecutor();
const commandLine = "claude -p --input-format stream-json";

// ①a 接管点在回合中途:水位之前起了工作流,水位之后主回合说完就结尾 —— 不许收台。
{
  const consumedPath = join(root, "consumed-a.jsonl");
  const prefix = launch.map(line).join("");
  writeFileSync(consumedPath, prefix);
  const { child, stderr } = stubCli("reattach-mid", [progress, ...say("工作流还在跑，等它完成后合稿"), result]);
  const handle = executor.attach(child, {
    sessionId: "sess-r", commandLine, consumed: { outPath: consumedPath, offset: Buffer.byteLength(prefix) },
  });
  const { events } = await drain(handle, 400);
  assert.ok(!events.some((e) => e.kind === "done"), "后台工作流还在跑,主回合结尾不许收台");
  assert.ok(!stderr().includes("STDIN_CLOSED"), "不许关 stdin");
  assert.ok(events.some((e) => e.kind === "system" && /1 个工作流/.test(e.text)), "说明在等后台工作流");
  assert.ok(!events.some((e) => e.kind === "tool" && e.nativeWork?.type === "agent" && e.nativeWork.status === "stopped"),
    "子智能体不许被记停");
  handle.kill();
  console.log("✓ 接管点在回合中途:水位之前起的工作流照样等它跑完");
}

// ①b 接管点在「等后台」的空档(那个回合结尾在水位之前):接着等;完成通知开的那一回合结尾才收台。
{
  const consumedPath = join(root, "consumed-b.jsonl");
  const prefix = [...launch, ...say("已在后台跑起来"), { ...result, result: "已在后台跑起来" }].map(line).join("");
  writeFileSync(consumedPath, prefix);
  const { child, stderr } = stubCli("reattach-idle", [
    progress,
    { type: "system", subtype: "task_notification", task_id: "wf", tool_use_id: "wf-call", status: "completed", summary: "done" },
    { type: "system", subtype: "init", session_id: "sess-r" },
    ...say("合成终稿"),
    { ...result, origin: { kind: "task-notification" }, result: "合成终稿" },
  ]);
  const handle = executor.attach(child, {
    sessionId: "sess-r", commandLine, consumed: { outPath: consumedPath, offset: Buffer.byteLength(prefix) },
  });
  const { events, consuming } = await drain(handle, 2000);
  await consuming;
  const text = events.filter((e) => e.kind === "text").map((e) => e.text).join("");
  assert.ok(text.includes("合成终稿"), "完成通知开的那一回合照常跑完");
  assert.deepEqual(events.at(-1), { kind: "done", exitStatus: 0 }, "那一回合结尾才收台");
  if (child.exitCode === null) await new Promise((resolve) => child.once("close", resolve));
  assert.ok(stderr().includes("STDIN_CLOSED"), "收台是关 stdin");
  assert.equal(handle.failure?.() ?? null, null);
  console.log("✓ 接管点在等后台的空档:接着等,完成通知那一回合结尾才收台");
}

// ①c 没有水位之前的输出(老会话行 / 读不出):行为与之前一致,不凭空等。
{
  const { child } = stubCli("reattach-none", [...say("说完了"), result]);
  const handle = executor.attach(child, { sessionId: "sess-r", commandLine });
  const { events, consuming } = await drain(handle, 2000);
  await consuming;
  assert.deepEqual(events.at(-1), { kind: "done", exitStatus: 0 });
  console.log("✓ 没有可重放的输出时照常收台");
}

// ② 连续插话:第一条送进去之后模型还没开口,第二条照样要打断。
{
  const { child, stderr } = stubCli("steer-twice", [{ type: "system", subtype: "status", status: "requesting" }], `
  if (message.type === "control_request") {
    emit({ type: "result", subtype: "error_during_execution" });
    emit({ type: "control_response", response: { subtype: "success", request_id: message.request_id } });
  }`);
  const handle = executor.attach(child, { sessionId: "sess-r", commandLine });
  const consuming = (async () => { for await (const _ of handle.events) { /* 只看对面收到了什么 */ } })();
  await new Promise((resolve) => setTimeout(resolve, 150));
  await handle.steer!("FIRST");
  await new Promise((resolve) => setTimeout(resolve, 25));
  await handle.steer!("SECOND");
  await new Promise((resolve) => setTimeout(resolve, 150));
  const inputs = stderr().split("\n").filter((l) => l.startsWith("INPUT "));
  assert.deepEqual(inputs, ["INPUT control_request", "INPUT user", "INPUT control_request", "INPUT user"],
    "第二次插话也要先打断第一条开的那一回合");
  handle.kill();
  await consuming.catch(() => {});
  console.log("✓ 连续插话:第二条照样打断第一条开的那一回合");
}

dbClient.close();
rmSync(root, { recursive: true, force: true });
console.log("claude 接管与连续插话回归通过");
