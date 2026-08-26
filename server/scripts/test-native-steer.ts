import assert from "node:assert/strict";
import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, Writable } from "node:stream";
import type { AgentEvent } from "@ash/shared";
import { ClaudeExecutor, singleRunFromResident } from "../src/executors/claude.js";
import { openCodexAppServer } from "../src/executors/codex-app-server.js";
import { CodexExecutor } from "../src/executors/codex.js";
import { detachedPathsFor } from "../src/executors/detached.js";
import type { ResidentHandle } from "../src/executors/types.js";
import { IS_WINDOWS, isPidAlive } from "../src/platform.js";
import * as runs from "../src/runs.js";

function eventQueue() {
  const events: AgentEvent[] = [];
  let wake: (() => void) | null = null;
  let ended = false;
  return {
    push(event: AgentEvent) { events.push(event); wake?.(); wake = null; },
    end() { ended = true; wake?.(); wake = null; },
    stream: (async function* () {
      while (true) {
        if (events.length) { yield events.shift()!; continue; }
        if (ended) return;
        await new Promise<void>((resolve) => { wake = resolve; });
      }
    })(),
  };
}

const claudeEvents = eventQueue();
const claudeCalls: string[] = [];
let claudeCleanupCalls = 0;
const resident: ResidentHandle = {
  sessionId: "claude-thread",
  commandLine: "claude resident",
  events: claudeEvents.stream,
  interrupt: () => { claudeCalls.push("interrupt"); },
  send: (text) => { claudeCalls.push(`send:${text}`); return true; },
  close: () => { claudeCalls.push("close"); claudeEvents.end(); },
  kill: () => { claudeCalls.push("kill"); claudeEvents.end(); },
  cleanup: async () => { claudeCleanupCalls += 1; },
};
const claude = singleRunFromResident(resident);
const claudeIterator = claude.events[Symbol.asyncIterator]();
claudeEvents.push({ kind: "text", text: "OLD" });
assert.deepEqual(await claudeIterator.next(), { value: { kind: "text", text: "OLD" }, done: false });
await claude.steer!("NEW");
assert.deepEqual(claudeCalls, ["interrupt", "send:NEW"], "Claude 必须先 interrupt 再向同一 stdin send");
claudeEvents.push({ kind: "turnEnd" });
claudeEvents.push({ kind: "text", text: "NEW" });
assert.deepEqual(await claudeIterator.next(), { value: { kind: "text", text: "NEW" }, done: false },
  "interrupt 产生的中间 turnEnd 不得结算任务");
claudeEvents.push({ kind: "turnEnd" });
assert.deepEqual(await claudeIterator.next(), { value: { kind: "done", exitStatus: 0 }, done: false });
assert.equal(claudeCalls.at(-1), "close", "最终 turnEnd 才关闭当前单飞连接");
await claude.cleanup?.();
assert.equal(claudeCleanupCalls, 1, "单飞适配器必须保留底层进程的 cleanup");
console.log("✓ Claude 原生引导保持同一进程，中间 turnEnd 不结算");

const partialEvents = eventQueue();
const partialCalls: string[] = [];
const partialResident: ResidentHandle = {
  sessionId: "claude-partial-thread",
  commandLine: "claude partial resident",
  events: partialEvents.stream,
  interrupt: () => { throw new Error("checked steer path should be used"); },
  send: () => { throw new Error("checked steer path should be used"); },
  steer: async (text, onInterrupted) => {
    partialCalls.push(`interrupt:${text}`);
    onInterrupted?.();
    partialEvents.push({ kind: "turnEnd" });
    await new Promise<void>((resolve) => setImmediate(resolve));
    throw new Error("Claude 当前回合 stdin 已关闭");
  },
  close: () => { partialCalls.push("close"); partialEvents.end(); },
  kill: () => { partialCalls.push("kill"); partialEvents.end(); },
};
const partialClaude = singleRunFromResident(partialResident);
const partialSeen: AgentEvent[] = [];
const partialConsuming = (async () => {
  for await (const event of partialClaude.events) partialSeen.push(event);
})();
partialEvents.push({ kind: "text", text: "OLD" });
await new Promise<void>((resolve) => setImmediate(resolve));
await assert.rejects(partialClaude.steer!("FIRST"), /stdin 已关闭/,
  "interrupt 已写出而新消息写失败时，引导应如实失败");
await Promise.race([
  partialConsuming,
  new Promise((_, reject) => setTimeout(() => reject(new Error("partial steer stream did not finish")), 1_000)),
]);
assert.deepEqual(
  partialSeen.map((event) => event.kind === "text" ? `text:${event.text}` : event.kind),
  ["text:OLD"],
  "新消息未写入时必须停止残缺的常驻流，不能永久吞住中间 turnEnd",
);
assert.deepEqual(partialCalls, ["interrupt:FIRST", "kill"], "部分写失败必须立即停止当前 resident");
await assert.rejects(partialClaude.steer!("RETRY"), /已经结束/,
  "已被停止的残缺 resident 不得在同一 handle 上重试");
console.log("✓ Claude 部分写失败会停止残缺 resident，不再让任务永久 running");

const deliveryOrder: string[] = [];
const orderedHandle = {
  kill: () => {},
  steer: async (text: string) => { deliveryOrder.push(`steer:${text}`); },
};
runs.trackRun("native-delivery-order", orderedHandle);
runs.bindNativeSteer("native-delivery-order", orderedHandle, {
  agentType: "codex",
  prepare: (text) => `prepared:${text}`,
  beforeDeliver: () => { deliveryOrder.push("before"); },
  record: () => { deliveryOrder.push("record"); },
});
const ordered = runs.reserveNativeSteerTask("native-delivery-order");
assert.equal(ordered.kind, "native");
if (ordered.kind === "native") await ordered.deliver("NEW", new Date().toISOString());
assert.deepEqual(deliveryOrder, ["before", "steer:prepared:NEW", "record"],
  "旧方向 trace 必须在 provider 收到新方向、用户边界落盘之前先 flush");
runs.untrackRun("native-delivery-order", orderedHandle);
console.log("✓ 原生引导按 trace flush → provider steer → 用户边界的顺序投递");

let nativeKills = 0;
let nativeRecords = 0;
const stopFirstHandle = {
  kill: () => { nativeKills += 1; },
  steer: async () => { throw new Error("停止后不应送达"); },
};
runs.trackRun("native-stop-first", stopFirstHandle);
runs.bindNativeSteer("native-stop-first", stopFirstHandle, {
  agentType: "claude",
  record: () => { nativeRecords += 1; },
});
const stopFirst = runs.reserveNativeSteerTask("native-stop-first");
assert.equal(stopFirst.kind, "native");
assert.equal(runs.stopTask("native-stop-first"), true);
if (stopFirst.kind === "native") await assert.rejects(stopFirst.deliver("NEW", new Date().toISOString()), /停止|暂停/);
assert.equal(nativeKills, 1, "停止必须先杀当前原生回合");
assert.equal(nativeRecords, 0, "停止优先时不得把消息记成已送达");
assert.equal(runs.takeStopped("native-stop-first"), "canceled");
runs.untrackRun("native-stop-first", stopFirstHandle);
console.log("✓ 停止优先于尚未送达的原生引导");

type WireMessage = { id?: number; method: string; params?: any };
class FakeAppServer extends EventEmitter {
  stdout = new PassThrough();
  stderr = new PassThrough();
  stdin: Writable;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  requests: WireMessage[] = [];
  private input = "";

  constructor(private readonly mode: "success" | "poison" = "success") {
    super();
    this.stdin = new Writable({
      write: (chunk, _encoding, done) => {
        this.input += chunk.toString();
        for (;;) {
          const newline = this.input.indexOf("\n");
          if (newline < 0) break;
          const line = this.input.slice(0, newline);
          this.input = this.input.slice(newline + 1);
          if (line) this.receive(JSON.parse(line));
        }
        done();
      },
      final: (done) => {
        this.exitCode = 0;
        queueMicrotask(() => { this.emit("exit", 0, null); this.emit("close", 0, null); });
        done();
      },
    });
  }

  kill() {
    this.exitCode = 1;
    queueMicrotask(() => { this.emit("exit", 1, "SIGTERM"); this.emit("close", 1, "SIGTERM"); });
    return true;
  }

  private send(message: unknown) {
    this.stdout.write(`${JSON.stringify(message)}\n`);
  }

  private receive(message: WireMessage) {
    this.requests.push(message);
    if (message.id === undefined) return;
    if (message.method === "initialize") this.send({ id: message.id, result: { userAgent: "test" } });
    else if (message.method === "thread/start") {
      this.send({ id: message.id, result: { thread: { id: "codex-thread" } } });
    } else if (message.method === "turn/start") {
      this.send({ id: message.id, result: { turn: { id: "codex-turn" } } });
      if (this.mode === "poison") queueMicrotask(() => {
        this.stderr.write("dropping turn-scoped item for unknown turn id codex-turn\n");
        this.send({ method: "turn/completed", params: {
          threadId: "codex-thread",
          turn: { id: "codex-turn", status: "failed", error: { message: "upstream 503" } },
        } });
      });
    } else if (message.method === "turn/steer") {
      this.send({ id: message.id, result: { turnId: "codex-turn" } });
      queueMicrotask(() => {
        this.send({ method: "item/agentMessage/delta", params: {
          threadId: "codex-thread", turnId: "codex-turn", itemId: "message-1", delta: "NEW",
        } });
        this.send({ method: "item/completed", params: {
          threadId: "codex-thread", turnId: "codex-turn",
          item: { type: "agentMessage", id: "message-1", text: "NEW" }, completedAtMs: Date.now(),
        } });
        this.send({ method: "thread/tokenUsage/updated", params: {
          threadId: "codex-thread", turnId: "codex-turn",
          tokenUsage: {
            total: { totalTokens: 30, inputTokens: 20, cachedInputTokens: 5, outputTokens: 10, reasoningOutputTokens: 2 },
            last: { totalTokens: 12, inputTokens: 8, cachedInputTokens: 3, outputTokens: 4, reasoningOutputTokens: 1 },
            modelContextWindow: 1000,
          },
        } });
        this.send({ method: "turn/completed", params: {
          threadId: "codex-thread", turn: { id: "codex-turn", status: "completed", error: null },
        } });
      });
    }
  }
}

const fake = new FakeAppServer();
const codex = openCodexAppServer({
  bin: "codex",
  args: ["app-server", "--stdio"],
  cwd: process.cwd(),
  prompt: "OLD",
  model: "gpt-test",
  reasoningEffort: "high",
  startProcess: () => fake as unknown as ChildProcess,
});
const codexEvents: AgentEvent[] = [];
const consuming = (async () => { for await (const event of codex.events) codexEvents.push(event); })();
for (let i = 0; !fake.requests.some((request) => request.method === "turn/start") && i < 100; i += 1) {
  await new Promise((resolve) => setTimeout(resolve, 1));
}
await codex.steer!("NEW");
await consuming;
const steer = fake.requests.find((request) => request.method === "turn/steer")!;
assert.equal(fake.requests.filter((request) => request.method === "thread/start").length, 1,
  "Codex 引导不得启动第二个 App Server/thread");
assert.equal(steer.params.threadId, "codex-thread");
assert.equal(steer.params.expectedTurnId, "codex-turn");
assert.equal(steer.params.input[0].text, "NEW");
assert.equal(codexEvents.filter((event) => event.kind === "done").length, 1);
assert.equal(codexEvents.find((event) => event.kind === "done")?.exitStatus, 0);
assert.equal(codexEvents.filter((event) => event.kind === "text").map((event) => event.text).join(""), "NEW\n\n");
assert.ok(codexEvents.some((event) => event.kind === "session" && event.cliSessionId === "codex-thread"));
console.log("✓ Codex App Server 使用同一 threadId/expectedTurnId 执行 turn/steer");

const poisonedFake = new FakeAppServer("poison");
const poisonedCodex = openCodexAppServer({
  bin: "codex",
  args: ["app-server", "--stdio"],
  cwd: process.cwd(),
  prompt: "FAIL",
  startProcess: () => poisonedFake as unknown as ChildProcess,
});
const poisonedEvents: AgentEvent[] = [];
for await (const event of poisonedCodex.events) poisonedEvents.push(event);
assert.ok(poisonedEvents.some((event) => event.kind === "error" && event.scope === "session"),
  "App Server stderr 中毒指纹必须作废恢复 thread");
const zeroContext = poisonedEvents.find((event) => event.kind === "context");
assert.deepEqual(zeroContext, {
  kind: "context",
  context: { used: 0, window: null, windowEstimated: false },
}, "没有 usage 的失败回合也必须清零旧 context 水位");
assert.ok(
  poisonedEvents.findIndex((event) => event.kind === "context")
    < poisonedEvents.findIndex((event) => event.kind === "done"),
  "context 哨兵必须先于 done",
);
console.log("✓ Codex App Server 失败收尾会发 session poison 与 context 清零哨兵");

const detachedRoot = mkdtempSync(join(tmpdir(), "ash-native-steer-detached-"));
const detachedPids: number[] = [];
let stickyPid: number | null = null;
try {
  const fakeBin = join(detachedRoot, "fake-agent.mjs");
  writeFileSync(fakeBin, `#!/usr/bin/env node
process.stdin.resume();
setInterval(() => {}, 1000);
`);
  chmodSync(fakeBin, 0o755);

  const stickyPidPath = join(detachedRoot, "sticky.pid");
  const stickyScript = join(detachedRoot, "sticky-claude.mjs");
  const stickyBin = IS_WINDOWS ? join(detachedRoot, "sticky-claude.cmd") : stickyScript;
  writeFileSync(stickyScript, `#!/usr/bin/env node
import { writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(stickyPidPath)}, String(process.pid));
let replied = false;
process.stdin.on("data", () => {
  if (replied) return;
  replied = true;
  process.stdout.write(JSON.stringify({ type: "system", session_id: "sticky-session" }) + "\\n");
  process.stdout.write(JSON.stringify({ type: "result", subtype: "success", session_id: "sticky-session" }) + "\\n");
});
setInterval(() => {}, 1000);
`);
  if (IS_WINDOWS) writeFileSync(stickyBin, `@node "%~dp0sticky-claude.mjs" %*\r\n`);
  else chmodSync(stickyBin, 0o755);
  const stickyClaude = new ClaudeExecutor({ bin: stickyBin }).runSteerable({ cwd: detachedRoot, prompt: "OLD" });
  assert.ok(stickyClaude.cleanup, "Claude runSteerable 必须暴露 cleanup");
  for await (const event of stickyClaude.events) {
    if (event.kind === "done") break;
  }
  stickyPid = Number(readFileSync(stickyPidPath, "utf8"));
  await stickyClaude.cleanup?.();
  assert.equal(isPidAlive(stickyPid), false,
    "最终 result 后即使 CLI 忽略 stdin EOF，单飞收尾也必须杀掉根进程");
  console.log("✓ Claude 单飞最终 result 会 kill 并 cleanup，不在 Windows/POSIX 留常驻根进程");

  const deadBin = join(detachedRoot, "dead-agent.mjs");
  writeFileSync(deadBin, "#!/usr/bin/env node\nsetTimeout(() => process.exit(0), 20);\n");
  chmodSync(deadBin, 0o755);
  const deadClaude = new ClaudeExecutor({ bin: deadBin }).runSteerable({
    cwd: detachedRoot,
    prompt: "OLD",
  });
  await new Promise((resolve) => setTimeout(resolve, 100));
  await assert.rejects(deadClaude.steer!("NEW"), /stdin 已关闭|stream|write/i,
    "agent 已退出但 done 尚未消费时，Claude 引导必须报投递失败，不能把消息记成 sent");
  console.log("✓ Claude 原生引导会观察 stdin 写失败，不把死进程当成已送达");

  const claudeDir = join(detachedRoot, "claude");
  mkdirSync(claudeDir);
  const claudeHandle = new ClaudeExecutor({ bin: fakeBin }).runSteerable({
    cwd: detachedRoot,
    prompt: "OLD",
    detach: detachedPathsFor(claudeDir, "claude-session", "T0"),
  });
  if (IS_WINDOWS) assert.equal(claudeHandle.detached, undefined, "Windows Claude 应降级为普通管道，不伪造 detached pid");
  else {
    assert.ok(claudeHandle.detached?.pid, "Claude runSteerable(detach) 必须留下可接管 pid");
    detachedPids.push(claudeHandle.detached!.pid);
  }
  claudeHandle.kill();

  const codexDir = join(detachedRoot, "codex");
  mkdirSync(codexDir);
  const codexHandle = new CodexExecutor({ bin: fakeBin }).runSteerable({
    cwd: detachedRoot,
    prompt: "OLD",
    detach: detachedPathsFor(codexDir, "codex-session", "T0"),
  });
  if (IS_WINDOWS) assert.equal(codexHandle.detached, undefined, "Windows Codex 应降级为普通管道，不伪造 detached pid");
  else {
    assert.ok(codexHandle.detached?.pid, "Codex runSteerable(detach) 必须留下可接管 pid");
    detachedPids.push(codexHandle.detached!.pid);
  }
  codexHandle.kill();
  await new Promise((resolve) => setTimeout(resolve, 150));
  console.log(IS_WINDOWS
    ? "✓ Windows Claude/Codex 新生产路径按设计降级为普通管道"
    : "✓ Claude/Codex 新生产路径都保留 detached 接管信息");
} finally {
  if (stickyPid && isPidAlive(stickyPid)) {
    try { process.kill(stickyPid, "SIGKILL"); } catch { /* 已退出 */ }
  }
  if (!IS_WINDOWS) {
    for (const pid of detachedPids) {
      try { process.kill(-pid, "SIGKILL"); } catch { /* 已退出 */ }
    }
  }
  rmSync(detachedRoot, { recursive: true, force: true });
}
process.exit(0);
