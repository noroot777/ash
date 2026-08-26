import assert from "node:assert/strict";
import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import type { AgentEvent } from "@ash/shared";
import { singleRunFromResident } from "../src/executors/claude.js";
import { openCodexAppServer } from "../src/executors/codex-app-server.js";
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
