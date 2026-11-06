// claude 单飞接管与连续插话这两条「后台工作生命周期」的回归(自由审查 KqmEd8oQLV5_ 第 1、2 轮)。
//   npm -w server run test:claude-reattach
//
// 接管的不变量是「接回后的状态 = 不间断读完整条输出的状态」(src/executors/claude-recovery.ts),
// 所以 ③ 那组把水位切在各种位置上:通知回合说完话之后、新回合请求中途、打断回执前后,以及
// 前缀读不出来、等后台的期限跨重启。哪个结尾是 ash 打断出来的,按写 stdin 之前落盘的打断记录
// 认(`.steer.json`),不按回执先后猜(自由审查 i8RAcPM3zvgD R1)。
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

/**
 * 假 CLI:先吐 `tail`(接管水位之后的那段),stdin 收到什么记进 stderr,关掉 stdin 就退出。
 * `tail` 里的 `{ __wait: ms }` 是停一会儿、`{ __exit: code }` 是自己退出;`ignoreEof` 模拟
 * 收到输入结束也不走、接着等自己后台的 CLI。
 */
function stubCli(name: string, tail: unknown[], onInput = "", ignoreEof = false) {
  const script = join(root, `${name}.cjs`);
  writeFileSync(script, `
const readline = require("node:readline");
const emit = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
readline.createInterface({ input: process.stdin }).on("line", (raw) => {
  const message = JSON.parse(raw);
  process.stderr.write("INPUT " + message.type + "\\n");
  ${onInput}
}).on("close", () => { process.stderr.write("STDIN_CLOSED\\n"); if (!${ignoreEof}) process.exit(0); });
(async () => {
  for (const value of ${JSON.stringify(tail)}) {
    if (value.__wait) await new Promise((resolve) => setTimeout(resolve, value.__wait));
    else if ("__exit" in value) process.exit(value.__exit);
    else emit(value);
  }
})();
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
  if (child.exitCode === null && child.signalCode === null) await new Promise((resolve) => child.once("close", resolve));
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

// ② 连续插话:第一条送进去之后模型还没开口,第二条照样要打断。两次打断各认领一个结尾,落盘。
{
  const { child, stderr } = stubCli("steer-twice", [{ type: "system", subtype: "status", status: "requesting" }], `
  if (message.type === "control_request") {
    emit({ type: "result", subtype: "error_during_execution" });
    emit({ type: "control_response", response: { subtype: "success", request_id: message.request_id } });
  }`);
  const out = join(root, "steer-twice.jsonl");
  Object.assign(child, { ashPaths: { out } });
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
  assert.deepEqual(JSON.parse(readFileSync(`${out}.steer.json`, "utf8")).entries, [
    { id: "ash_int_1", result: 1, sent: true },
    { id: "ash_int_2", result: 2, sent: true },
  ], "每次打断认领下一个结尾,正文送出前记下");
  handle.kill();
  await consuming.catch(() => {});
  console.log("✓ 连续插话:第二条照样打断第一条开的那一回合,两次打断的身份都落盘");
}

// ②b 打断记录落不了盘:插话直接报错,stdin 一个字都不写(写了接管时就认不出那个结尾)。
{
  const { child, stderr } = stubCli("journal-unwritable", [{ type: "system", subtype: "status", status: "requesting" }]);
  Object.assign(child, { ashPaths: { out: join(root, "no-such-dir", "out.jsonl") } });
  const handle = executor.attach(child, { sessionId: "sess-r", commandLine });
  const consuming = (async () => { for await (const _ of handle.events) { /* 只看对面收到了什么 */ } })();
  await new Promise((resolve) => setTimeout(resolve, 150));
  await assert.rejects(handle.steer!("LOST"));
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.ok(!stderr().includes("INPUT"), "没记下身份就不打断");
  handle.kill();
  await consuming.catch(() => {});
  console.log("✓ 打断记录落不了盘:不打断、不送,如实报错");
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

// ③f 插话打断出来的那个 result 在水位附近:不许拿它收台,插话开的那一回合结尾才收。回执与 result
// 两种先后都有,回执还可能落在水位之后、晚到一秒多、前面插进后台进度 —— 都不影响,身份看打断记录。
const steered = (out: string, sent = true) =>
  writeFileSync(`${out}.steer.json`, JSON.stringify({ entries: [{ id: "ash_int_1", result: 1, sent }] }));
const followUp = [{ type: "system", subtype: "init", session_id: "sess-r" }, ...say("插话之后的答复"), result];
for (const [name, prefix, tail] of [
  ["ack-first", [...launch.slice(0, 2), ack("ash_int_1"), interruptedResult], []],
  ["ack-last", [...launch.slice(0, 2), interruptedResult, ack("ash_int_1")], []],
  ["ack-in-tail", [...launch.slice(0, 2), interruptedResult], [ack("ash_int_1")]],
  ["result-in-tail", [...launch.slice(0, 2), ack("ash_int_1")], [interruptedResult]],
  ["ack-delayed", [...launch.slice(0, 2), interruptedResult], [{ __wait: 1450 }, ack("ash_int_1")]],
  ["progress-before-ack", [...launch.slice(0, 2), interruptedResult], [progress, { __wait: 60 }, ack("ash_int_1")]],
  ["no-ack-yet", [...launch.slice(0, 2)], [interruptedResult, { __wait: 1200 }, ack("ash_int_1")]],
] as const) {
  const out = join(root, `steered-${name}.jsonl`);
  steered(out);
  const { child, stderr, handle } = reattach(`steered-${name}`, [...prefix], [...tail, ...followUp]);
  const { events, consuming } = await drain(handle, 2600);
  const text = events.filter((e) => e.kind === "text").map((e) => e.text).join("");
  assert.ok(text.includes("插话之后的答复"), `${name}: 插话开的那一回合照常跑完`);
  assert.ok(!events.some((e) => e.kind === "error"), `${name}: 打断出来的结尾不是故障`);
  assert.deepEqual(events.at(-1), { kind: "done", exitStatus: 0 }, `${name}: 那一回合结尾收台`);
  await consuming;
  await closed(child);
  assert.ok(stderr().includes("STDIN_CLOSED"), `${name}: 收台是关 stdin`);
}
console.log("✓ 打断出来的结尾在水位附近:回执先到、后到、晚到、被进度插队都不提前收台");

// ③g 上一代发了插话的打断,正文没送进去就重启了:那个结尾按这一回合结束处理(不报故障),
// 并说明插话没送到 —— 不能空等一个永远不会来的插话回合。
for (const [name, prefix, tail] of [
  ["abandoned", [...launch.slice(0, 2), interruptedResult], []],
  ["abandoned-in-tail", [...launch.slice(0, 2)], [interruptedResult]],
] as const) {
  const out = join(root, `${name}.jsonl`);
  steered(out, false);
  const { child, handle } = reattach(name, [...prefix], [...tail]);
  const { events, consuming } = await drain(handle, 1500);
  await consuming;
  assert.ok(!events.some((e) => e.kind === "error"), `${name}: 我们打断的,不是故障`);
  assert.ok(events.some((e) => e.kind === "system" && /没有送到/.test(e.text)), `${name}: 说明插话没送到`);
  assert.deepEqual(events.at(-1), { kind: "done", exitStatus: 0 }, `${name}: 照常收台`);
  await closed(child);
}
console.log("✓ 插话正文没送出去就重启:按回合结束收台,说明要重发");

// ③h 打断记录读不出(残缺):哪个结尾是打断出来的说不准,按状态未知接着等,不当成自然结束。
{
  const out = join(root, "journal-corrupt.jsonl");
  writeFileSync(`${out}.steer.json`, "{");
  const { handle, stderr } = reattach("journal-corrupt", [...launch.slice(0, 2), interruptedResult], []);
  const { events } = await drain(handle, 400);
  assert.ok(!events.some((e) => e.kind === "done"), "状态未知不许收台");
  assert.ok(!stderr().includes("STDIN_CLOSED"));
  handle.kill();
  console.log("✓ 打断记录读不出:按状态未知处理");
}

// ③i 读不出记录、CLI 正闲着等自己的后台(之后可能再没有回合结尾):接回当场就开始等、给说明,
// 到期按核实不了结算 —— 不能等一个可能永远不来的结尾才承担期限。(自由审查 ZbBv9az0Qgtf R1-A)
{
  const out = join(root, "corrupt-at-idle.jsonl");
  writeFileSync(`${out}.steer.json`, "{");
  writeFileSync(`${out}.hold.json`, JSON.stringify({ turn: -1, since: new Date(Date.now() - HOLD_MS + 300).toISOString() }));
  const { child, handle } = reattach("corrupt-at-idle", [...launch, ...heldEnd], [progress]);
  const keepAlive = setInterval(() => {}, 100);
  const { events, consuming } = await drain(handle, 2000);
  clearInterval(keepAlive);
  await consuming;
  assert.ok(events.some((e) => e.kind === "system" && /读不出/.test(e.text)), "当场说明为什么在等");
  assert.ok(events.some((e) => e.kind === "error" && /确认不了后台工作跑没跑完/.test(e.message)), "到期如实报核实不了");
  assert.equal(events.at(-1)?.kind, "done");
  assert.equal(handle.failure?.()?.kind, "background_unverified");
  await closed(child);
  console.log("✓ 读不出记录、CLI 闲着等后台:接回当场开始等,到期按核实不了结算");
}

// ③j 等后台的空档里插话直接送进去了,那一回合还没吐字就重启:接回后会话算在忙,下一条插话照样
// 先打断;旧的等后台结尾不再重发。直播那一侧送消息时就把这件事落盘。(自由审查 ZbBv9az0Qgtf
// 第 1 轮 R1-B、第 2 轮 R1)
{
  const steerAck = `
  if (message.type === "control_request") {
    emit({ type: "result", subtype: "error_during_execution" });
    emit({ type: "control_response", response: { subtype: "success", request_id: message.request_id } });
  }`;
  const liveOut = join(root, "idle-send-live.jsonl");
  const first = stubCli("idle-send-live", [...launch, ...heldEnd], steerAck);
  Object.assign(first.child, { ashPaths: { out: liveOut } });
  const liveHandle = executor.attach(first.child, { sessionId: "sess-r", commandLine });
  const liveConsuming = (async () => { for await (const _ of liveHandle.events) { /* 只看落盘与对面收到了什么 */ } })();
  await new Promise((resolve) => setTimeout(resolve, 150));
  await liveHandle.steer!("FIRST");
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.deepEqual(first.stderr().split("\n").filter((l) => l.startsWith("INPUT ")), ["INPUT user"], "空档里直接送");
  assert.deepEqual(JSON.parse(readFileSync(`${liveOut}.steer.json`, "utf8")).sends, [1], "送之前记下「第 1 个结尾之后送过一条」");
  liveHandle.kill();
  await liveConsuming.catch(() => {});

  // 已消费水位每秒才落一次库,和同步写下的发送记录不是同一时刻:那个结尾可能在水位之前,也可能
  // 还在尾流里(甚至一条都没消费过)。切在哪都得认出来;旧期限在重启期间过了也不能拿它收台。
  const heldText = say("已在后台跑起来");
  const heldResult = { ...result, result: "已在后台跑起来" };
  // 落后不止一个结尾:第 1 个结尾后送了 FIRST,它那一回合说完(后台还在跑,又等),再送了 THEN。
  const twice = [...launch, ...heldText, heldResult, { type: "system", subtype: "init", session_id: "sess-r" },
    ...say("FIRST 的答复"), { ...result, result: "FIRST 的答复" }];
  for (const [name, prefix, tail, expired, sends] of [
    ["sent-on-watermark", [...launch, ...heldText, heldResult], [], false, [1]],
    ["sent-watermark-lagging", [...launch, ...heldText], [heldResult], false, [1]],
    ["sent-watermark-lagging-expired", [...launch, ...heldText], [heldResult], true, [1]],
    ["sent-nothing-consumed", [], [...launch, ...heldText, heldResult], false, [1]],
    ["sent-twice-lagging", launch, twice.slice(launch.length), true, [1, 2]],
  ] as const) {
    const out = join(root, `${name}.jsonl`);
    writeFileSync(`${out}.steer.json`, JSON.stringify({ entries: [], sends }));
    if (expired) writeFileSync(`${out}.hold.json`, JSON.stringify({ turn: 1, since: new Date(Date.now() - HOLD_MS - 1000).toISOString() }));
    const { stderr, handle } = reattach(name, [...prefix], [...tail], steerAck);
    const seen: any[] = [];
    const consuming = (async () => { for await (const event of handle.events) seen.push(event); })();
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.ok(!seen.some((e) => e.kind === "system" && /1 个工作流/.test(e.text)), `${name}: 那个结尾已被送进去的消息取代,不再等后台`);
    assert.ok(!seen.some((e) => e.kind === "error" || e.kind === "done"), `${name}: 不拿旧期限收台`);
    assert.equal(handle.failure?.() ?? null, null, `${name}: 没有失败判决`);
    await handle.steer!("SECOND");
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.deepEqual(stderr().split("\n").filter((l) => l.startsWith("INPUT ")), ["INPUT control_request", "INPUT user"],
      `${name}: 接回后会话在忙:插话先打断`);
    handle.kill();
    await consuming.catch(() => {});
  }
  console.log("✓ 空档直接送的消息还没吐字就重启:水位切在哪都认得出会话在忙,下一条插话先打断,旧期限不收台");
}

// ④ 等后台的收尾(自由审查 c2vZ4d3LmL1q 第 1 轮),都走真实 spawn 出来的流,不经接管。
/** 直接跑一条流(不接管);`hold` 给的话预先记下「第 1 个回合结尾从多久之前开始等」,把期限缩到眼前。 */
function live(name: string, tail: unknown[], ignoreEof = false, heldFor?: number) {
  const out = join(root, `${name}.jsonl`);
  if (heldFor !== undefined) writeFileSync(`${out}.hold.json`, JSON.stringify({ turn: 1, since: new Date(Date.now() - heldFor).toISOString() }));
  const stub = stubCli(name, tail, "", ignoreEof);
  Object.assign(stub.child, { ashPaths: { out } });
  return { ...stub, handle: executor.attach(stub.child, { sessionId: "sess-r", commandLine }) };
}

// ④a 等后台时 CLI 自己以 0 退出、没有完成通知:不是跑完了,按未完成结算。
{
  const { child, handle } = live("exit-while-holding", [...launch, ...heldEnd, { __wait: 100 }, { __exit: 0 }]);
  const { events, consuming } = await drain(handle, 1500);
  await consuming;
  assert.equal(events.at(-1)?.kind, "done");
  assert.ok(events.some((e) => e.kind === "error" && /1 个工作流/.test(e.message) && /还没跑完/.test(e.message)), "报真错误");
  assert.equal(handle.failure?.()?.kind, "background_lost", "退出码 0 也按未完成结算");
  await closed(child);
  console.log("✓ 等后台时进程自己退了:按未完成结算");
}

// ④b 到期了 CLI 收到输入结束却不走:照样杀掉,错误和收尾都在期限之后马上来。
{
  const { child, stderr, handle } = live("eof-ignored", [...launch, ...heldEnd, progress], true, HOLD_MS - 200);
  const keepAlive = setInterval(() => {}, 100);
  const { events, consuming } = await drain(handle, 1200);
  clearInterval(keepAlive);
  assert.ok(events.some((e) => e.kind === "error" && /后台工作等了/.test(e.message)), "到期就报,不等它自己退");
  assert.equal(events.at(-1)?.kind, "done", "事件流在期限之后马上结束");
  assert.equal(handle.failure?.()?.kind, "background_timeout");
  assert.ok(!stderr().includes("STDIN_CLOSED"), "不是靠关 stdin 请它走的");
  await consuming;
  await closed(child);
  console.log("✓ 到期 CLI 不理输入结束:杀进程,错误与收尾按时到");
}

// ④c 后台在期限之前跑完了,主智能体整理结果跨过了原期限:不算后台超时。
{
  const { child, handle } = live("slow-delivery", [
    ...launch, ...heldEnd, { __wait: 100 }, notification,
    { type: "system", subtype: "init", session_id: "sess-r" }, ...say("开始整理结果"),
    { __wait: 600 }, ...say("合成终稿"), { ...result, origin: { kind: "task-notification" }, result: "合成终稿" },
  ], false, HOLD_MS - 300);
  const keepAlive = setInterval(() => {}, 100);
  const { events, consuming } = await drain(handle, 2000);
  clearInterval(keepAlive);
  await consuming;
  assert.ok(!events.some((e) => e.kind === "error"), "整理慢不报后台超时");
  assert.deepEqual(events.at(-1), { kind: "done", exitStatus: 0 });
  assert.equal(handle.failure?.() ?? null, null);
  await closed(child);
  console.log("✓ 后台跑完后主智能体整理得慢:旧期限已撤,不算超时");
}

// ④d 同上,但父回合结尾、完成通知、新回合开头挤在一块 stdout 里一起到(第 2 轮 R2):解析先把
// 新回合认了,那个结尾排着队后到,不能拿它重新建起旧期限。
{
  const { child, handle } = live("burst-delivery", [
    ...launch, ...heldEnd, notification,
    { type: "system", subtype: "init", session_id: "sess-r" }, ...say("开始整理结果"),
    { __wait: 600 }, ...say("合成终稿"), { ...result, origin: { kind: "task-notification" }, result: "合成终稿" },
  ], false, HOLD_MS - 300);
  const keepAlive = setInterval(() => {}, 100);
  const { events, consuming } = await drain(handle, 2000);
  clearInterval(keepAlive);
  await consuming;
  assert.ok(!events.some((e) => e.kind === "error"), "同一块到达也不报后台超时");
  assert.deepEqual(events.at(-1), { kind: "done", exitStatus: 0 });
  assert.equal(handle.failure?.() ?? null, null);
  await closed(child);
  console.log("✓ 结尾、完成通知、新回合挤在一块到:旧期限照样作废");
}

// ④f 后台已经全跑完、CLI 隔了一会儿才开回合收尾,期限恰好落在这段空档里:不算后台超时。
// (自由审查 i8RAcPM3zvgD R2:上一版期限只认「开了新回合」,完成通知到了也照样判超时、硬杀。)
{
  const { child, handle } = live("completed-before-next-turn", [
    ...launch, ...heldEnd, { __wait: 50 }, notification, { __wait: 400 },
    { type: "system", subtype: "init", session_id: "sess-r" }, ...say("合成终稿"),
    { ...result, origin: { kind: "task-notification" }, result: "合成终稿" },
  ], false, HOLD_MS - 200);
  const keepAlive = setInterval(() => {}, 100);
  const { events, consuming } = await drain(handle, 2000);
  clearInterval(keepAlive);
  await consuming;
  assert.ok(!events.some((e) => e.kind === "error"), "后台跑完了就不报后台超时");
  assert.deepEqual(events.at(-1), { kind: "done", exitStatus: 0 });
  assert.equal(handle.failure?.() ?? null, null);
  await closed(child);
  console.log("✓ 后台跑完、下一回合还没开:期限不再算后台的账");
}

// ④g 后台都跑完了,CLI 没开回合收尾就自己退了:按未完成结算,但原因如实说,不说成后台没跑完。
{
  const { child, handle } = live("completed-then-exit", [...launch, ...heldEnd, notification, { __wait: 100 }, { __exit: 0 }]);
  const { events, consuming } = await drain(handle, 1500);
  await consuming;
  assert.equal(events.at(-1)?.kind, "done");
  assert.ok(events.some((e) => e.kind === "error" && /都跑完了/.test(e.message)), "说是没开始整理结果");
  assert.ok(!events.some((e) => e.kind === "error" && /还没跑完/.test(e.message)), "不说成后台没跑完");
  assert.equal(handle.failure?.()?.kind, "wrapup_missing");
  await closed(child);
  console.log("✓ 后台跑完了、没收尾就退了:按未完成结算,原因如实");
}

// ④e 接管时前缀读不出、下一条 result 之前进程就以 0 退了:跑没跑完核实不了,不按完成结算。(R1)
{
  const { child } = stubCli("unknown-exit", [progress, { __wait: 100 }, { __exit: 0 }]);
  const handle = executor.attach(child, {
    sessionId: "sess-r", commandLine, consumed: { outPath: join(root, "missing-exit.jsonl"), offset: 4096 },
  });
  const { events, consuming } = await drain(handle, 1500);
  await consuming;
  assert.equal(events.at(-1)?.kind, "done");
  assert.ok(events.some((e) => e.kind === "error" && /确认不了后台工作跑没跑完/.test(e.message)), "如实报核实不了");
  assert.equal(handle.failure?.()?.kind, "background_unverified");
  await closed(child);
  console.log("✓ 接管状态未知时进程退了:按核实不了结算,不记成完成");
}

dbClient.close();
rmSync(root, { recursive: true, force: true });
console.log("claude 接管与连续插话回归通过");
