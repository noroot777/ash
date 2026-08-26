import assert from "node:assert/strict";
import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { chmodSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, Writable } from "node:stream";
import type { AgentEvent } from "@ash/shared";
import { ClaudeExecutor, singleRunFromResident } from "../src/executors/claude.js";
import { openCodexAppServer } from "../src/executors/codex-app-server.js";
import { CodexExecutor } from "../src/executors/codex.js";
import { detachedPathsFor } from "../src/executors/detached.js";
import type { ResidentHandle } from "../src/executors/types.js";
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
const resident: ResidentHandle = {
  sessionId: "claude-thread",
  commandLine: "claude resident",
  events: claudeEvents.stream,
  interrupt: () => { claudeCalls.push("interrupt"); },
  send: (text) => { claudeCalls.push(`send:${text}`); },
  close: () => { claudeCalls.push("close"); claudeEvents.end(); },
  kill: () => { claudeCalls.push("kill"); claudeEvents.end(); },
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
console.log("✓ Claude 原生引导保持同一进程，中间 turnEnd 不结算");

const partialEvents = eventQueue();
const partialCalls: string[] = [];
let partialAttempt = 0;
const partialResident: ResidentHandle = {
  sessionId: "claude-partial-thread",
  commandLine: "claude partial resident",
  events: partialEvents.stream,
  interrupt: () => { throw new Error("checked steer path should be used"); },
  send: () => { throw new Error("checked steer path should be used"); },
  steer: async (text, onInterrupted) => {
    partialAttempt += 1;
    partialCalls.push(`interrupt:${text}`);
    onInterrupted?.();
    partialEvents.push({ kind: "turnEnd" });
    await new Promise<void>((resolve) => setImmediate(resolve));
    if (partialAttempt === 1) throw new Error("Claude 当前回合 stdin 已关闭");
    partialCalls.push(`send:${text}`);
    partialEvents.push({ kind: "text", text });
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
await partialClaude.steer!("RETRY");
partialEvents.push({ kind: "turnEnd" });
await Promise.race([
  partialConsuming,
  new Promise((_, reject) => setTimeout(() => reject(new Error("partial steer stream did not finish")), 1_000)),
]);
assert.deepEqual(
  partialSeen.map((event) => event.kind === "text" ? `text:${event.text}` : event.kind),
  ["text:OLD", "text:RETRY", "done"],
  "第一次 interrupt 的 turnEnd 已被消费后，失败回滚不得把计数减成负数",
);
assert.deepEqual(partialCalls, ["interrupt:FIRST", "interrupt:RETRY", "send:RETRY", "close"],
  "重试时必须先送入新消息，最终 turnEnd 才允许关闭连接");
console.log("✓ Claude 部分写失败不会让 intermediateEnds 下溢或提前关闭连接");

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

  constructor() {
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

const detachedRoot = mkdtempSync(join(tmpdir(), "ash-native-steer-detached-"));
const detachedPids: number[] = [];
try {
  const fakeBin = join(detachedRoot, "fake-agent.mjs");
  writeFileSync(fakeBin, `#!/usr/bin/env node
process.stdin.resume();
setInterval(() => {}, 1000);
`);
  chmodSync(fakeBin, 0o755);

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
  assert.ok(claudeHandle.detached?.pid, "Claude runSteerable(detach) 必须留下可接管 pid");
  detachedPids.push(claudeHandle.detached!.pid);
  claudeHandle.kill();

  const codexDir = join(detachedRoot, "codex");
  mkdirSync(codexDir);
  const codexHandle = new CodexExecutor({ bin: fakeBin }).runSteerable({
    cwd: detachedRoot,
    prompt: "OLD",
    detach: detachedPathsFor(codexDir, "codex-session", "T0"),
  });
  assert.ok(codexHandle.detached?.pid, "Codex runSteerable(detach) 必须留下可接管 pid");
  detachedPids.push(codexHandle.detached!.pid);
  codexHandle.kill();
  await new Promise((resolve) => setTimeout(resolve, 150));
  console.log("✓ Claude/Codex 新生产路径都保留 detached 接管信息");
} finally {
  for (const pid of detachedPids) {
    try { process.kill(-pid, "SIGKILL"); } catch { /* 已退出 */ }
  }
  rmSync(detachedRoot, { recursive: true, force: true });
}
process.exit(0);
