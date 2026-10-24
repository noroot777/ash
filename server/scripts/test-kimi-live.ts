import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentEvent } from "@ash/shared";
import { requireTmpDb, releaseTmpDb } from "./tmp-db.js";

const bin = process.env.KIMI_TEST_BIN || "kimi";
const version = execFileSync(bin, ["--version"], { encoding: "utf8" }).trim();
const directory = mkdtempSync(join(tmpdir(), "ash-kimi-live-"));
process.env.ASH_DB = join(directory, "test.db");
process.env.ASH_RUNS_DIR = join(directory, "runs");
process.env.ASH_ALLOW_REAL_AGENT = "1";
requireTmpDb("test-kimi-live");
const { CLI_SPEC_BY_KEY } = await import("../src/executors/catalog/index.js");
const { GenericCliExecutor } = await import("../src/executors/generic.js");
const { ensureSchema } = await import("../src/db/index.js");
await ensureSchema();
const home = join(directory, "home");
const cwd = join(directory, "workspace");
mkdirSync(home);
mkdirSync(cwd);
const proof = join(directory, "mcp-proof.json");
const fixture = join(directory, "mcp-fixture.mjs");
writeFileSync(fixture, `
import { createInterface } from "node:readline";
import { writeFileSync } from "node:fs";
createInterface({ input: process.stdin }).on("line", line => {
  const request = JSON.parse(line);
  if (request.id === undefined) return;
  let result = {};
  if (request.method === "initialize") result = {
    protocolVersion: request.params.protocolVersion, capabilities: { tools: {} },
    serverInfo: { name: "ash-kimi-fixture", version: "1.0.0" }
  };
  if (request.method === "tools/list") result = { tools: [{
    name: "complete_task", description: "Record a test completion without contacting ash",
    inputSchema: { type: "object", properties: { taskId: { type: "string" }, directionToken: { type: "string" } }, required: ["taskId", "directionToken"] }
  }] };
  if (request.method === "tools/call") {
    writeFileSync(${JSON.stringify(proof)}, JSON.stringify({
      ...request.params, taskId: process.env.ASH_TASK_ID, turnToken: process.env.ASH_TURN_TOKEN
    }));
    result = { content: [{ type: "text", text: "KIMI_MCP_OK" }] };
  }
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }) + "\\n");
});
`);

const requests: any[] = [];
let phase = 0;
let rejectAuth = false;
let mockFailure: unknown;
const server = createServer(async (request, response) => {
  try {
    let raw = "";
    for await (const chunk of request) raw += chunk;
    const body = JSON.parse(raw);
    requests.push(body);
    assert.equal(request.url, "/v1/chat/completions");
    if (rejectAuth) {
      response.writeHead(403, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ error: { message: "subscription required (test fixture)", type: "permission_error" } }));
      return;
    }
    let delta: any;
    const toolCall = (name: string, args: Record<string, string>) => {
      const tool = body.tools.find((entry: any) => name === "Bash"
        ? entry.function.name === "Bash" : entry.function.name.includes("complete_task"));
      assert.ok(tool, `missing ${name}: ${JSON.stringify(body.tools?.map((entry: any) => entry.function.name))}`);
      return { tool_calls: [{ index: 0, id: `call-${phase}`, type: "function", function: { name: tool.function.name, arguments: JSON.stringify(args) } }] };
    };
    if (phase === 0) delta = toolCall("Bash", { command: "printf kimi-ok > hello.txt", description: "Write integration fixture" });
    else if (phase === 1) delta = toolCall("complete_task", { taskId: "kimi-test", directionToken: "direction-test" });
    else if (phase === 2) delta = { content: "KIMI_READY" };
    else if (phase === 3) {
      assert.match(JSON.stringify(body.messages), /KIMI_FIRST_TURN/);
      assert.match(JSON.stringify(body.messages), /KIMI_READY/);
      delta = toolCall("Bash", { command: "cat hello.txt", description: "Read integration fixture" });
    } else {
      assert.equal(phase, 4);
      delta = { content: "KIMI_RESUMED" };
    }
    phase += 1;
    response.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
    const emit = (value: unknown) => response.write(`data: ${JSON.stringify(value)}\n\n`);
    const base = { id: "kimi-local", object: "chat.completion.chunk", created: 1, model: "ash-test" };
    emit({ ...base, choices: [{ index: 0, delta: { role: "assistant", ...delta }, finish_reason: null }] });
    emit({ ...base, choices: [{ index: 0, delta: {}, finish_reason: delta.tool_calls ? "tool_calls" : "stop" }], usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 } });
    response.end("data: [DONE]\n\n");
  } catch (error) {
    mockFailure = error;
    response.writeHead(500, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ error: { message: String(error) } }));
  }
});

try {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  writeFileSync(join(home, "config.toml"), `
default_model = "ash-test"
telemetry = false
[providers.ash-test]
type = "kimi"
base_url = "http://127.0.0.1:${address.port}/v1"
api_key = "local-test-key"
[models.ash-test]
provider = "ash-test"
model = "ash-test"
max_context_size = 262144
capabilities = ["tool_use", "thinking"]
support_efforts = ["low", "high", "max"]
`);
  writeFileSync(join(home, "mcp.json"), JSON.stringify({ mcpServers: { ash: { command: process.execPath, args: [fixture] } } }));
  const executor = new GenericCliExecutor(CLI_SPEC_BY_KEY.kimi, { bin, model: "ash-test", reasoningEffort: "high" });
  const env = {
    KIMI_CODE_HOME: home, KIMI_DISABLE_TELEMETRY: "1", ASH_TASK_ID: "kimi-test", ASH_TURN_TOKEN: "test-turn-token",
    KIMI_MODEL_NAME: undefined, KIMI_MODEL_API_KEY: undefined,
  };
  const modelSpec = CLI_SPEC_BY_KEY.kimi.models!;
  const modelOutput = execFileSync(bin, modelSpec.args, { env: { ...process.env, ...env }, encoding: "utf8" });
  const models = modelSpec.parse(modelOutput, "");
  assert.deepEqual(models.models, ["ash-test"]);
  assert.deepEqual(models.modelEfforts?.["ash-test"], ["low", "high", "max"]);
  async function run(prompt: string, sessionId?: string): Promise<AgentEvent[]> {
    const handle = executor.run({ cwd, prompt, sessionId, env });
    const timer = setTimeout(() => handle.kill(), 60_000);
    const events: AgentEvent[] = [];
    try {
      for await (const event of handle.events) events.push(event);
      if (mockFailure) throw mockFailure;
      return events;
    } finally {
      clearTimeout(timer);
      await handle.cleanup?.();
    }
  }
  const first = await run("KIMI_FIRST_TURN: Write hello.txt with kimi-ok, call complete_task with test taskId/directionToken, and reply KIMI_READY.");
  assert.equal(first.some((event) => event.kind === "error"), false, JSON.stringify(first));
  assert.ok(first.some((event) => event.kind === "text" && event.text.includes("KIMI_READY")), JSON.stringify(first));
  assert.equal(readFileSync(join(cwd, "hello.txt"), "utf8"), "kimi-ok");
  const recorded = JSON.parse(readFileSync(proof, "utf8"));
  assert.equal(recorded.arguments.directionToken, "direction-test");
  assert.equal(recorded.taskId, "kimi-test");
  assert.equal(recorded.turnToken, "test-turn-token");
  assert.equal(requests[0].thinking?.effort, "high", JSON.stringify(requests[0].thinking));
  const session = first.find((event) => event.kind === "session");
  assert.ok(session?.kind === "session" && session.cliSessionId);
  const resumed = await run("KIMI_SECOND_TURN: Read hello.txt and reply KIMI_RESUMED.", session.cliSessionId);
  assert.equal(resumed.some((event) => event.kind === "error"), false, JSON.stringify(resumed));
  assert.ok(resumed.some((event) => event.kind === "text" && event.text.includes("KIMI_RESUMED")));
  assert.ok(resumed.some((event) => event.kind === "session" && event.cliSessionId === session.cliSessionId));
  assert.equal(phase, 5);

  rejectAuth = true;
  const failed = await run("KIMI_AUTH_FAILURE");
  assert.ok(failed.some((event) => event.kind === "error" && /subscription required/.test(event.message)), JSON.stringify(failed));
  assert.ok(failed.some((event) => event.kind === "done" && event.exitStatus !== 0));
  console.log(`kimi ${version} live CLI tests passed: tools, MCP identity, effort, session resume, auth failure`);
} finally {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await releaseTmpDb();
  rmSync(directory, { recursive: true, force: true });
}
