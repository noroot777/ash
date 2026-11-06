// claude 单飞接管与连续插话这两条「后台工作生命周期」的回归(自由审查 KqmEd8oQLV5_ 第 1、2 轮)。
//   npm -w server run test:claude-reattach
//
// 接管的不变量是「接回后的状态 = 不间断读完整条输出的状态」(src/executors/claude-recovery.ts),
// 所以 ③ 那组把水位切在各种位置上:通知回合说完话之后、新回合请求中途、打断回执前后,以及
// 前缀读不出来、等后台的期限跨重启。
//
// 都走真实的 `ClaudeExecutor.attach → residentFromChild → parseClaudeStream →
// singleRunFromResident`,对面是一个按 stream-json 协议说话的假 CLI 子进程:
//   ① 重启接管:`task_started` 在已消费水位之前,接回后的账本必须从那段输出重建 —— 否则
//      主回合一结尾就把还在跑的工作流收掉;接回时正停在「等后台」的空档,要接着等。
//   ② 连续插话:第一次插话打断并送进新消息之后、模型还没开口之前,第二次插话必须照样打断,
//      不能因为「没收到输出」就当成空闲直接排进去。
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "ash-claude-reattach-"));
process.env.ASH_DB = join(root, "ash.db");
process.env.ASH_RUNS_DIR = join(root, "runs");
const HOLD_MS = 60_000;
process.env.ASH_BACKGROUND_HOLD_MS = String(HOLD_MS);
const [{ ensureSchema, dbClient }, { ClaudeExecutor }, { consumedEvents }] = await Promise.all([
  import("../src/db/index.js"),
  import("../src/executors/claude.js"),
  import("../src/executors/claude-recovery.js"),
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

/** 水位之前那段落盘,假 CLI 吐水位之后那段;`out` 给 child 挂上输出路径(detached 才有),等后台的起点记在它旁边。 */
function reattach(name: string, prefixEvents: unknown[], tail: unknown[], onInput = "") {
  const consumedPath = join(root, `${name}.jsonl`);
  const prefix = prefixEvents.map(line).join("");
  writeFileSync(consumedPath, prefix);
  const stub = stubCli(name, tail, onInput);
  Object.assign(stub.child, { ashPaths: { out: consumedPath } });
  const handle = executor.attach(stub.child, {
    sessionId: "sess-r", commandLine, consumed: { outPath: consumedPath, offset: Buffer.byteLength(prefix) },
  });
  return { ...stub, handle, consumedPath };
}
const closed = async (child: ReturnType<typeof spawn>) => {
  if (child.exitCode === null) await new Promise((resolve) => child.once("close", resolve));
};
const notification = { type: "system", subtype: "task_notification", task_id: "wf", tool_use_id: "wf-call", status: "completed", summary: "done" };
const heldEnd = [...say("已在后台跑起来"), { ...result, result: "已在后台跑起来" }];
const ack = (id: string) => ({ type: "control_response", response: { subtype: "success", request_id: id } });
const interruptedResult = { type: "result", subtype: "error_during_execution", is_error: false, session_id: "sess-r" };

// ①a 接管点在回合中途:水位之前起了工作流,水位之后主回合说完就结尾 —— 不许收台。
{
  const consumedPath = join(root, "consumed-a.jsonl");
  const prefix = launch.map(line).join("");
  writeFileSync(consumedPath, prefix);
  const { child, stderr } = stubCli("reattach-mid", [progress, ...say("工作流还在跑，等它完成后合稿"), result]);
  Object.assign(child, { ashPaths: { out: consumedPath } });
  const handle = executor.attach(child, {
    sessionId: "sess-r", commandLine, consumed: { outPath: consumedPath, offset: Buffer.byteLength(prefix) },
  });
  const { events } = await drain(handle, 400);
  assert.ok(!events.some((e) => e.kind === "done"), "后台工作流还在跑,主回合结尾不许收台");
  assert.ok(!stderr().includes("STDIN_CLOSED"), "不许关 stdin");
  assert.ok(events.some((e) => e.kind === "system" && /1 个工作流/.test(e.text)), "说明在等后台工作流");
  assert.ok(!events.some((e) => e.kind === "tool" && e.nativeWork?.type === "agent" && e.nativeWork.status === "stopped"),
    "子智能体不许被记停");
  const hold = JSON.parse(readFileSync(`${consumedPath}.hold.json`, "utf8"));
  assert.equal(hold.turn, 1, "开始等后台的那一刻按第几个回合结尾落盘");
  const turnEnd = events.find((e) => e.kind === "turnEnd");
  assert.equal(turnEnd, undefined, "等后台的结尾由单飞吞掉,不往外漏");
  handle.kill();
  console.log("✓ 接管点在回合中途:水位之前起的工作流照样等它跑完,开始等的时刻落盘");
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
  assert.ok(events.some((e) => e.kind === "system" && /1 个工作流/.test(e.text)), "接回时重发等后台的说明");
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

// ③a 通知回合已经说完话(assistant 在水位之前),只剩它的 result 在水位之后:那是真回合的结尾,
// 不是孤儿回执 —— 照常收台。(第 2 轮 R1-A:上一版这里一个事件都不发、进程一直挂着。)
{
  const { child, stderr, handle } = reattach("notify-spoke",
    [...launch, ...heldEnd, notification, { type: "system", subtype: "init", session_id: "sess-r" }, ...say("合成终稿")],
    [{ ...result, origin: { kind: "task-notification" }, result: "合成终稿" }]);
  const { events, consuming } = await drain(handle, 1500);
  assert.deepEqual(events.at(-1), { kind: "done", exitStatus: 0 }, "通知回合的结尾收台(赶在假 CLI 自己退出之前)");
  await consuming;
  await closed(child);
  assert.ok(stderr().includes("STDIN_CLOSED"));
  console.log("✓ 水位切在通知回合说完话之后:它的 result 照样是回合结尾");
}

// ③b 前缀读不出来(正水位、文件不在):后台状态未知,回合结尾不许当「没有后台」收台。(R1-B)
{
  const { child, stderr } = stubCli("unreadable", [progress, ...say("后台仍未结束，等待合稿"), result]);
  const handle = executor.attach(child, {
    sessionId: "sess-r", commandLine, consumed: { outPath: join(root, "missing.jsonl"), offset: 4096 },
  });
  const { events } = await drain(handle, 400);
  assert.ok(!events.some((e) => e.kind === "done"), "状态未知不许收台");
  assert.ok(!stderr().includes("STDIN_CLOSED"));
  assert.ok(events.some((e) => e.kind === "system" && /读不出/.test(e.text)), "说明为什么还在等");
  assert.ok(!events.some((e) => e.kind === "tool" && e.nativeWork?.status === "stopped"), "不许把子智能体记停");
  handle.kill();
  console.log("✓ 前缀读不出:按状态未知接着等,不当成没有后台工作");
}

// ③c 水位没落在换行上、跨块的长行:按块读到水位为止,契约坏了就抛(调用方按未知处理)。
{
  const big = { type: "assistant", message: { content: [{ type: "text", text: "x".repeat(200_000) }] } };
  const path = join(root, "chunks.jsonl");
  const text = [launch[0], big, launch[1]].map(line).join("");
  writeFileSync(path, text + line({ type: "result" }));
  const read = [...consumedEvents({ outPath: path, offset: Buffer.byteLength(text) })] as any[];
  assert.equal(read.length, 3, "只读到水位为止");
  assert.equal(read[1].message.content[0].text.length, 200_000, "跨块的长行完整拼回");
  assert.throws(() => [...consumedEvents({ outPath: path, offset: Buffer.byteLength(text) - 3 })], /换行边界/);
  assert.throws(() => [...consumedEvents({ outPath: path, offset: Buffer.byteLength(text) * 2 })], /不到已消费水位/);
  console.log("✓ 前缀按块读到水位,半行与短文件都按读不出处理");
}

// ③d 水位切在新回合的请求中途(init/status 在水位之前,还没有 assistant):插话要先打断。(R1-C)
{
  const { stderr, handle } = reattach("requesting",
    [...launch, ...heldEnd, notification, { type: "system", subtype: "init", session_id: "sess-r" },
      { type: "system", subtype: "status", status: "requesting", session_id: "sess-r" }],
    [], `
  if (message.type === "control_request") {
    emit({ type: "result", subtype: "error_during_execution" });
    emit({ type: "control_response", response: { subtype: "success", request_id: message.request_id } });
  }`);
  const consuming = (async () => { for await (const _ of handle.events) { /* 只看对面收到了什么 */ } })();
  await new Promise((resolve) => setTimeout(resolve, 150));
  await handle.steer!("NOW");
  await new Promise((resolve) => setTimeout(resolve, 150));
  const inputs = stderr().split("\n").filter((l) => l.startsWith("INPUT "));
  assert.deepEqual(inputs, ["INPUT control_request", "INPUT user"], "请求中途接回的插话照样先打断");
  handle.kill();
  await consuming.catch(() => {});
  console.log("✓ 水位切在请求中途:接回后插话照样打断");
}

// ③e 等后台的期限跨重启接着算,不重新给满。
{
  const { child, handle, consumedPath } = reattach("deadline", [...launch, ...heldEnd], [progress]);
  writeFileSync(`${consumedPath}.hold.json`, JSON.stringify({ turn: 1, since: new Date(Date.now() - HOLD_MS + 300).toISOString() }));
  const keepAlive = setInterval(() => {}, 100);
  const { events, consuming } = await drain(handle, 3000);
  await consuming;
  clearInterval(keepAlive);
  assert.ok(events.some((e) => e.kind === "error" && /后台工作等了/.test(e.message)), "期限按原起点到点");
  assert.equal(events.at(-1)?.kind, "done");
  assert.equal(handle.failure?.()?.kind, "background_timeout", "到点按未完成结算");
  await closed(child);
  console.log("✓ 等后台的期限从原起点算,重启不重新给满");
}

// ③f 插话打断出来的那个 result 在水位之前:不许拿它收台,插话开的那一回合结尾才收。回执与 result
// 两种先后都有,回执还可能落在水位之后。
for (const [name, prefix, tail] of [
  ["ack-first", [...launch.slice(0, 2), ack("ash_int_1"), interruptedResult], []],
  ["ack-last", [...launch.slice(0, 2), interruptedResult, ack("ash_int_1")], []],
  ["ack-in-tail", [...launch.slice(0, 2), interruptedResult], [ack("ash_int_1")]],
  ["result-in-tail", [...launch.slice(0, 2), ack("ash_int_1")], [interruptedResult]],
] as const) {
  const { child, handle } = reattach(`steered-${name}`, [...prefix], [
    ...tail, { type: "system", subtype: "init", session_id: "sess-r" }, ...say("插话之后的答复"), result,
  ]);
  const { events, consuming } = await drain(handle, 1500);
  const text = events.filter((e) => e.kind === "text").map((e) => e.text).join("");
  assert.ok(text.includes("插话之后的答复"), `${name}: 插话开的那一回合照常跑完`);
  assert.ok(!events.some((e) => e.kind === "error"), `${name}: 打断出来的结尾不是故障`);
  assert.deepEqual(events.at(-1), { kind: "done", exitStatus: 0 }, `${name}: 那一回合结尾收台`);
  await consuming;
  await closed(child);
}
console.log("✓ 打断出来的结尾在水位附近:回执先到、后到、落在水位之后都不收台");

dbClient.close();
rmSync(root, { recursive: true, force: true });
console.log("claude 接管与连续插话回归通过");
