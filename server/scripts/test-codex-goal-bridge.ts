import assert from "node:assert/strict";
import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, Writable } from "node:stream";
import type { AgentEvent } from "@ash/shared";
import { validateCliCommand, type CliGoal } from "@ash/shared/cli-commands";
import { openCodexAppServer, readCodexAppServerState } from "../src/executors/codex-app-server.js";

const root = mkdtempSync(join(tmpdir(), "ash-goal-bridge-"));
process.env.ASH_DB = join(root, "ash.db");
type Message = { id?: number; method: string; params: any };
class GoalServer extends EventEmitter {
  stdout = new PassThrough();
  stderr = new PassThrough();
  stdin: Writable;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  requests: Message[] = [];
  goal: CliGoal | null = null;
  private input = "";
  constructor(readonly mode: "normal" | "fast" | "failure" = "normal") {
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
      final: (done) => { this.exitCode = 0; queueMicrotask(() => { this.emit("exit", 0, null); this.emit("close", 0, null); }); done(); },
    });
  }
  kill() { this.exitCode = 1; this.emit("exit", 1, "SIGTERM"); this.emit("close", 1, "SIGTERM"); return true; }
  send(message: unknown) { this.stdout.write(`${JSON.stringify(message)}\n`); }
  turn(id: string, status = "completed") { this.send({ method: "turn/completed", params: { threadId: "thread", turn: { id, status } } }); }
  startTurn(id: string) { this.send({ method: "turn/started", params: { threadId: "thread", turn: { id } } }); }
  update(status: CliGoal["status"]) { this.goal = { ...this.goal!, status }; this.send({ method: "thread/goal/updated", params: { threadId: "thread", goal: this.goal } }); }
  receive(message: Message) {
    this.requests.push(message);
    if (message.id === undefined) return;
    if (message.method === "thread/goal/set" && this.mode === "failure") {
      this.send({ id: message.id, error: { code: -1, message: "unsupported native goal" } }); return;
    }
    let result: unknown = {};
    if (["thread/start", "thread/resume", "thread/fork"].includes(message.method)) result = { model: "model", thread: { id: "thread" } };
    if (message.method === "thread/goal/get") result = { goal: this.goal };
    if (message.method === "thread/goal/set") { this.goal = { ...(this.goal ?? { objective: "", status: "paused" }), ...message.params } as CliGoal; result = { goal: this.goal }; }
    if (message.method === "turn/start") result = { turn: { id: "first" } };
    if (message.method === "review/start") result = { turn: { id: "review-result" }, reviewThreadId: "thread" };
    this.send({ id: message.id, result });
    if (message.method === "turn/start") {
      this.startTurn("first");
      if (this.mode === "fast") { this.turn("first"); this.startTurn("second"); }
    }
    if (message.method === "turn/interrupt") this.turn(message.params.turnId, "interrupted");
    if (message.method === "review/start") { this.startTurn("review-announcement"); this.turn("unrelated"); this.turn("review-result"); this.turn("review-result"); }
  }
}

async function waitFor(predicate: () => boolean) {
  const deadline = Date.now() + 3000;
  while (!predicate()) { assert.ok(Date.now() < deadline, "fixture timeout"); await new Promise((resolve) => setTimeout(resolve, 5)); }
}
function run(fake: GoalServer, text = "/goal 通过测试 --budget 400", state = {}) {
  const handle = openCodexAppServer({ bin: "codex", args: ["app-server", "--stdio"], cwd: root, prompt: "本轮 ash 完成协议 direction-token", cliCommand: validateCliCommand("codex", text)!, cliState: { goal: { objective: "通过测试", status: "active" }, ...state }, startProcess: () => fake as unknown as ChildProcess });
  const events: AgentEvent[] = [];
  const consumed = (async () => { for await (const event of handle.events) events.push(event); })();
  return { handle, events, consumed };
}

try {
  const fake = new GoalServer();
  const current = run(fake);
  await waitFor(() => fake.goal?.status === "active");
  fake.turn("first");
  await waitFor(() => fake.requests.filter((request) => request.method === "thread/goal/get").length >= 2);
  assert.equal(current.events.filter((event) => event.kind === "done").length, 0);
  fake.startTurn("second");
  fake.turn("first");
  fake.update("complete");
  assert.equal(current.events.filter((event) => event.kind === "done").length, 0);
  fake.turn("second");
  await current.consumed;
  assert.equal(current.events.filter((event) => event.kind === "done").length, 1);
  assert.equal(current.handle.goal?.()?.status, "complete");
  assert.equal(fake.requests.filter((request) => request.method === "thread/archive").length, 1);
  assert.equal(fake.requests.find((request) => request.method === "turn/start")!.params.input[0].text, "本轮 ash 完成协议 direction-token");

  const quick = new GoalServer("fast");
  const fast = run(quick);
  await waitFor(() => quick.goal?.status === "active");
  assert.equal(fast.events.filter((event) => event.kind === "done").length, 0);
  quick.update("complete");
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(fast.events.filter((event) => event.kind === "done").length, 0);
  quick.turn("second");
  await fast.consumed;
  assert.equal(fast.events.find((event) => event.kind === "done")?.exitStatus, 0);

  const late = new GoalServer();
  const delayed = run(late);
  await waitFor(() => late.goal?.status === "active");
  late.turn("first");
  await waitFor(() => late.requests.filter((request) => request.method === "thread/goal/get").length >= 2);
  late.update("budgetLimited");
  await delayed.consumed;
  assert.equal(delayed.handle.goal?.()?.status, "budgetLimited");
  assert.ok(delayed.events.some((event) => event.kind === "system" && event.level === "notice" && /预算已耗尽/.test(event.text)));

  const failed = new GoalServer("failure");
  failed.goal = { objective: "陈旧目标", status: "complete" };
  const broken = run(failed);
  await broken.consumed;
  assert.equal(broken.handle.goal?.()?.objective, "通过测试");
  assert.equal(broken.handle.goal?.()?.status, "blocked");
  assert.equal(broken.events.find((event) => event.kind === "done")?.exitStatus, 1);
  assert.equal(broken.handle.goalStarted?.(), false);

  const failure = new GoalServer();
  const stoppedFailure = run(failure);
  await waitFor(() => failure.goal?.status === "active");
  failure.turn("first", "failed");
  await waitFor(() => failure.requests.filter((request) => request.method === "thread/goal/get").length >= 2);
  failure.update("blocked");
  await stoppedFailure.consumed;
  assert.equal(stoppedFailure.events.find((event) => event.kind === "done")?.exitStatus, 1);
  assert.equal(stoppedFailure.handle.goalStarted?.(), true);

  const stopping = new GoalServer();
  const stopped = run(stopping);
  await waitFor(() => stopping.goal?.status === "active");
  stopped.handle.kill();
  await stopped.consumed;
  const pause = stopping.requests.findIndex((request) => request.method === "thread/goal/set" && request.params.status === "paused" && !request.params.objective);
  const interruption = stopping.requests.findIndex((request) => request.method === "turn/interrupt");
  assert.ok(pause >= 0 && interruption > pause);
  assert.equal(stopped.handle.goal?.()?.status, "paused");

  const fork = new GoalServer();
  const forked = openCodexAppServer({ bin: "codex", args: [], cwd: root, prompt: "/fork", sessionId: "source", serviceTier: "priority", cliState: { serviceTier: "default" }, cliCommand: validateCliCommand("codex", "/fork")!, startProcess: () => fork as unknown as ChildProcess });
  for await (const _event of forked.events) {}
  assert.equal(fork.requests.find((request) => request.method === "thread/fork")!.params.threadId, "source");
  assert.equal(fork.requests.find((request) => request.method === "thread/fork")!.params.serviceTier, "default");
  assert.ok(!fork.requests.some((request) => request.method === "turn/start"));
  const inspecting = new GoalServer();
  const inspected = run(inspecting, "/status");
  await inspected.consumed;
  assert.equal(inspected.events.some((event) => event.kind === "context"), false);
  assert.equal(inspected.events.some((event) => event.kind === "error"), false);
  assert.equal(inspected.events.some((event) => event.kind === "session"), false);
  const snapshot: CliGoal = { objective: "保存的旧目标", status: "budgetLimited", tokenBudget: 150, tokensUsed: 150 };
  for (const nativeGoal of [null, { ...snapshot, objective: "其他目标", status: "active" as const }]) for (const text of ["/goal", "/goal pause"]) {
    const observing = new GoalServer();
    observing.goal = nativeGoal;
    const observed = run(observing, text, { profileId: "old-profile", ownerUserId: null, goal: snapshot, goalHold: true });
    await observed.consumed;
    assert.equal(observed.events.some((event) => event.kind === "error"), false);
    assert.equal(observed.events.find((event) => event.kind === "done")?.exitStatus, 0);
    assert.match(observed.events.filter((event) => event.kind === "text").map((event) => event.text).join(""), /保存的旧目标[\s\S]*150 \/ 150[\s\S]*原生会话里/);
    assert.deepEqual(observed.handle.goal?.(), snapshot);
    assert.equal(observed.handle.goalStarted?.(), false);
    assert.equal(observing.requests.some((request) => ["thread/goal/set", "thread/goal/clear", "turn/start", "turn/interrupt"].includes(request.method)), false);
    assert.deepEqual(observing.goal, nativeGoal);
  }
  for (const name of ["new", "clear"]) {
    const resetting = new GoalServer();
    const reset = openCodexAppServer({ bin: "codex", args: [], cwd: root, prompt: `/${name}`, sessionId: "source", cliCommand: validateCliCommand("codex", `/${name}`)!, startProcess: () => resetting as unknown as ChildProcess });
    assert.equal(reset.sessionId, "");
    for await (const event of reset.events) assert.notEqual(event.kind, "session");
    assert.ok(resetting.requests.some((request) => request.method === "thread/start"));
    assert.ok(!resetting.requests.some((request) => request.method === "thread/resume" || request.method === "thread/unarchive" || request.method === "thread/archive"));
  }
  const reviewing = new GoalServer();
  const reviewed = run(reviewing, "/review");
  await reviewed.consumed;
  assert.equal(reviewed.events.filter((event) => event.kind === "done").length, 1);
  assert.equal(reviewed.events.find((event) => event.kind === "done")?.exitStatus, 0);
  assert.equal(reviewing.requests.filter((request) => request.method === "thread/archive").length, 1);
  const reviewLog = join(root, "review.jsonl");
  writeFileSync(reviewLog, [
    { id: 10, result: { turn: { id: "review-result" }, reviewThreadId: "thread" } },
    { method: "turn/started", params: { threadId: "thread", turn: { id: "review-announcement" } } },
    { method: "turn/completed", params: { threadId: "thread", turn: { id: "review-result", status: "completed" } } },
  ].map((message) => JSON.stringify(message)).join("\n"));
  assert.equal(readCodexAppServerState(reviewLog, "thread").completedTurn?.id, "review-result");
  writeFileSync(reviewLog, [
    { id: 10, result: { turn: { id: "review-result" }, reviewThreadId: "thread" } },
    { method: "turn/started", params: { threadId: "thread", turn: { id: "review-announcement" } } },
  ].map((message) => JSON.stringify(message)).join("\n"));
  const recoveredReview = readCodexAppServerState(reviewLog, "thread");
  assert.equal(recoveredReview.reviewTurnId, "review-result");
  const recovering = new GoalServer();
  const recovered = openCodexAppServer({ bin: "codex", args: [], cwd: root, prompt: "", sessionId: "thread", reattach: { threadId: "thread", turnId: recoveredReview.turnId!, reviewTurnId: recoveredReview.reviewTurnId }, startProcess: () => recovering as unknown as ChildProcess });
  const recoveredEvents: AgentEvent[] = [];
  const recoveredConsumed = (async () => { for await (const event of recovered.events) recoveredEvents.push(event); })();
  recovering.startTurn("review-announcement");
  recovering.turn("unrelated");
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(recoveredEvents.filter((event) => event.kind === "done").length, 0);
  recovering.turn("review-result");
  await recoveredConsumed;
  assert.equal(recoveredEvents.filter((event) => event.kind === "done").length, 1);
  console.log("Codex multi-turn goal, early completion, late verdict, startup failure, review lifecycle, fork, fast override: passed");
} finally {
  const { dbClient } = await import("../src/db/index.js");
  dbClient.close();
  rmSync(root, { recursive: true, force: true });
}
