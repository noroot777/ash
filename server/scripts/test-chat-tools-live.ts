import assert from "node:assert/strict";
import { once } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

const scratch = mkdtempSync(join(tmpdir(), "ash-chat-tools-"));
process.env.ASH_DB = join(scratch, "test.db");
process.env.ASH_RUNS_DIR = join(scratch, "runs");
process.env.ASH_ALLOW_REAL_AGENT = "1";
const configDir = join(scratch, "config");
mkdirSync(configDir);
const toolFile = join(scratch, "tool-ran");
const hookFile = join(scratch, "hook-ran");
const mcpFile = join(scratch, "mcp-ran");
const command = (path: string) => `touch ${JSON.stringify(path)}`;
writeFileSync(join(configDir, "settings.json"), JSON.stringify({
  hooks: { SessionStart: [{ hooks: [{ type: "command", command: command(hookFile) }] }] },
}));
writeFileSync(join(scratch, ".mcp.json"), JSON.stringify({
  mcpServers: { dangerous: { command: "sh", args: ["-c", command(mcpFile)] } },
}));
let requests = 0;
const offeredTools: unknown[] = [];
const authorizations: unknown[] = [];
const upstream = createServer(async (request, response) => {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  const body = JSON.parse(Buffer.concat(chunks).toString());
  offeredTools.push(body.tools ?? []);
  authorizations.push(request.headers.authorization);
  requests++;
  const attack = requests === 1;
  const content = attack
    ? { type: "tool_use", id: "forbidden-tool", name: "Bash", input: {} }
    : { type: "text", text: "" };
  const events = [
    { type: "message_start", message: { id: `msg_${requests}`, type: "message", role: "assistant", content: [], model: "claude-sonnet-4-6", stop_reason: null, usage: { input_tokens: 1, output_tokens: 1 } } },
    { type: "content_block_start", index: 0, content_block: content },
    { type: "content_block_delta", index: 0, delta: attack
      ? { type: "input_json_delta", partial_json: JSON.stringify({ command: command(toolFile) }) }
      : { type: "text_delta", text: '{"reply":"工具不可用","task":null}' } },
    { type: "content_block_stop", index: 0 },
    { type: "message_delta", delta: { stop_reason: attack ? "tool_use" : "end_turn", stop_sequence: null }, usage: { output_tokens: 1 } },
    { type: "message_stop" },
  ];
  response.writeHead(200, { "content-type": "text/event-stream" });
  response.end(events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""));
});
let handle: import("../src/executors/types.js").RunHandle | undefined;
try {
  upstream.listen(0, "127.0.0.1");
  await once(upstream, "listening");
  const address = upstream.address();
  assert.ok(address && typeof address !== "string");
  const { ClaudeExecutor } = await import("../src/executors/claude.js");
  const executor = new ClaudeExecutor({
    model: "claude-sonnet-4-6",
    extraArgs: ["--tools", "default", "--settings", JSON.stringify({ disableAllHooks: false })],
    relay: { providerId: "fixture", name: "fixture", baseUrl: `http://127.0.0.1:${address.port}`, apiKey: "fixture-key", defaultModel: "claude-sonnet-4-6", protocolConversionEnabled: false, context1mModels: [] },
  });
  handle = executor.runChat({ cwd: scratch, prompt: "请执行 Bash 写入文件。", env: { CLAUDE_CONFIG_DIR: configDir }, extraArgs: ["--tools", "Bash"] });
  assert.doesNotMatch(handle.commandLine, /--tools (default|Bash)|--dangerously-skip-permissions/);
  const timer = setTimeout(() => handle?.kill(), 60000);
  let exitStatus: number | undefined;
  let text = "";
  try {
    for await (const event of handle.events) {
      if (event.kind === "done") exitStatus = event.exitStatus;
      if (event.kind === "text") text += event.text;
      if (event.kind === "error") console.log(event.message);
    }
  } finally { clearTimeout(timer); }
  assert.equal(exitStatus, 0);
  assert.equal(requests, 2);
  for (const tools of offeredTools) assert.deepEqual(tools, [], "聊天请求不应提供任何工具");
  for (const authorization of authorizations) assert.equal(authorization, "Bearer fixture-key");
  assert.match(text, /工具不可用/);
  for (const path of [toolFile, hookFile, mcpFile]) assert.equal(existsSync(path), false, path);
  console.log("chat tools live: 真 CLI 无工具声明；恶意上游 Bash 被拒；hooks/MCP/extraArgs 均未执行；供应商鉴权保留");
} finally {
  handle?.kill();
  await handle?.cleanup?.();
  upstream.closeAllConnections();
  await new Promise<void>((resolve) => upstream.close(() => resolve()));
  rmSync(scratch, { recursive: true, force: true });
}
