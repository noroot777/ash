import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentEvent } from "@ash/shared";
import { validateCliCommand } from "@ash/shared/cli-commands";

const root = await realpath(await mkdtemp(join(tmpdir(), "ash-claude-goal-live-")));
process.env.ASH_DB = join(root, "ash.db");
process.env.ASH_RUNS_DIR = join(root, "runs");
process.env.ASH_ALLOW_REAL_AGENT = "1";
const { ClaudeExecutor } = await import("../src/executors/claude.js");
const home = join(root, "claude");
const workspace = join(root, "workspace");
const requests: any[] = [];
let workingTurns = 0;
const server = createServer(async (request, response) => {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  if (!request.url?.includes("/messages")) { response.writeHead(200); response.end("{}"); return; }
  const body = JSON.parse(Buffer.concat(chunks).toString());
  requests.push(body);
  const working = body.model.includes("sonnet");
  if (working) workingTurns++;
  const text = working ? `Fixture step ${workingTurns} completed.` : JSON.stringify({ ok: workingTurns >= 3, reason: workingTurns >= 3 ? "Three fixture steps completed." : "More fixture steps remain." });
  const message = { id: `msg_${requests.length}`, type: "message", role: "assistant", model: body.model, content: [{ type: "text", text }], stop_reason: "end_turn", stop_sequence: null, usage: { input_tokens: 40, output_tokens: 20 } };
  if (!body.stream) { response.writeHead(200, { "content-type": "application/json" }); response.end(JSON.stringify(message)); return; }
  response.writeHead(200, { "content-type": "text/event-stream" });
  for (const event of [
    { type: "message_start", message: { ...message, content: [], stop_reason: null } },
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } },
    { type: "content_block_stop", index: 0 },
    { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 20 } },
    { type: "message_stop" },
  ]) response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
  response.end();
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const address = server.address();
assert.ok(address && typeof address === "object");
try {
  await mkdir(home);
  await mkdir(workspace);
  await writeFile(join(home, ".claude.json"), JSON.stringify({ hasCompletedOnboarding: true }));
  const executor = new ClaudeExecutor({ model: "claude-sonnet-4-6", extraArgs: ["--max-turns", "5"] });
  const handle = executor.runSteerable({ cwd: workspace, prompt: "ash-native-goal-context-direction:fixture-only; verify the native goal keeps running", cliCommand: validateCliCommand("claude", "/goal perform at least three fixture steps")!, env: { CLAUDE_CONFIG_DIR: home, ANTHROPIC_API_KEY: "local-fixture-key", ANTHROPIC_BASE_URL: `http://127.0.0.1:${address.port}`, ANTHROPIC_DEFAULT_HAIKU_MODEL: "claude-haiku-4-5", CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1" } });
  const events: AgentEvent[] = [];
  const deadline = setTimeout(() => handle.kill(), 45_000);
  try { for await (const event of handle.events) events.push(event); }
  finally { clearTimeout(deadline); await handle.cleanup?.(); }
  assert.ok(!handle.commandLine.includes("ash-native-goal-context-direction"));
  assert.ok(requests.length >= 3, JSON.stringify({ requests: requests.length, events: events.filter((event) => event.kind === "error" || event.kind === "text" || event.kind === "done") }));
  const working = requests.filter((request) => request.model.includes("sonnet"));
  assert.equal(working.length, 3, JSON.stringify(requests.map((request) => request.model)));
  assert.ok(requests.some((request) => request.model.includes("haiku")));
  assert.equal(events.find((event) => event.kind === "done")?.exitStatus, 0, JSON.stringify(events.filter((event) => event.kind === "error")));
  assert.equal(handle.goalStarted?.(), true);
  assert.ok(working.every((request) => JSON.stringify(request.system).includes("ash-native-goal-context-direction")));
  const contextPath = /<ash-goal-context:("(?:[^"\\]|\\.)*")>/.exec(handle.commandLine)?.[1];
  assert.ok(contextPath);
  await assert.rejects(readFile(JSON.parse(contextPath), "utf8"), /ENOENT/);
  const sessionId = events.find((event) => event.kind === "session")?.cliSessionId ?? handle.sessionId;
  assert.ok(sessionId);
  const beforeClear = requests.length;
  const cleared = executor.runSteerable({ cwd: workspace, prompt: "/goal clear", cliCommand: validateCliCommand("claude", "/goal clear")!, sessionId, env: { CLAUDE_CONFIG_DIR: home, ANTHROPIC_API_KEY: "local-fixture-key", ANTHROPIC_BASE_URL: `http://127.0.0.1:${address.port}`, ANTHROPIC_DEFAULT_HAIKU_MODEL: "claude-haiku-4-5", CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1" } });
  const clearEvents: AgentEvent[] = [];
  const clearDeadline = setTimeout(() => cleared.kill(), 15_000);
  try { for await (const event of cleared.events) clearEvents.push(event); }
  finally { clearTimeout(clearDeadline); await cleared.cleanup?.(); }
  assert.equal(requests.length, beforeClear, "清除必须是原生命令，不得启动一个名为 clear 的目标");
  assert.equal(clearEvents.find((event) => event.kind === "done")?.exitStatus, 0);
  console.log(`real Claude /goal stayed connected through ${working.length} locally mocked working turns; private context cleaned`);
} finally {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  const { dbClient } = await import("../src/db/index.js");
  dbClient.close();
  await rm(root, { recursive: true, force: true });
}
