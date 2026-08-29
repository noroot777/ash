// 用真 Claude CLI 打本地假上游，验证 ash 供应商配置不会被用户级 settings / CC Switch 覆盖。
// 假上游只返回固定 SSE，不调用真实模型，也不会产生费用。
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

if (spawnSync("claude", ["--version"], { encoding: "utf8" }).status !== 0) {
  console.log("claude relay settings live: 跳过(本机没装 claude)");
  process.exit(0);
}

const scratch = mkdtempSync(join(tmpdir(), "ash-claude-relay-live-"));
const cwd = join(scratch, "repo");
const configDir = join(scratch, "claude-config");
mkdirSync(cwd, { recursive: true });
mkdirSync(configDir, { recursive: true });
writeFileSync(join(configDir, "settings.json"), JSON.stringify({
  env: {
    ANTHROPIC_BASE_URL: "http://127.0.0.1:59999",
    ANTHROPIC_AUTH_TOKEN: "wrong-user-auth",
    ANTHROPIC_API_KEY: "wrong-user-api-key",
  },
}));

let authorization: string | null = null;
let xApiKey: string | null = null;
const upstream = createServer(async (req, res) => {
  authorization = req.headers.authorization ?? null;
  xApiKey = String(req.headers["x-api-key"] ?? "") || null;
  for await (const _chunk of req) { /* consume request */ }
  res.writeHead(200, { "content-type": "text/event-stream" });
  res.end(
    'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_test","type":"message","role":"assistant","content":[],"model":"claude-sonnet-4-6","stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":1,"output_tokens":1}}}\n\n'
    + 'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n'
    + 'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"OK"}}\n\n'
    + 'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n'
    + 'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"output_tokens":1}}\n\n'
    + 'event: message_stop\ndata: {"type":"message_stop"}\n\n',
  );
});

try {
  upstream.listen(0, "127.0.0.1");
  await once(upstream, "listening");
  const address = upstream.address();
  assert.ok(address && typeof address !== "string");

  process.env.ASH_DB = join(scratch, "relay.db");
  const { ClaudeExecutor } = await import("../src/executors/claude.js");
  const executor = new ClaudeExecutor({
    model: "claude-sonnet-4-6",
    relay: {
      providerId: "provider-live",
      name: "live",
      baseUrl: `http://127.0.0.1:${address.port}`,
      apiKey: "ash-profile-key",
      defaultModel: "claude-sonnet-4-6",
      protocolConversionEnabled: false,
      context1mModels: [],
    },
  });
  const handle = executor.run({ cwd, prompt: "ping", env: { CLAUDE_CONFIG_DIR: configDir } });
  let text = "";
  let error: string | null = null;
  for await (const event of handle.events) {
    if (event.kind === "text") text += event.text;
    if (event.kind === "error") error = event.message;
  }
  await handle.cleanup?.();

  assert.equal(error, null);
  assert.equal(text.trim(), "OK");
  assert.equal(authorization, "Bearer ash-profile-key");
  assert.equal(xApiKey, null);
  assert.match(handle.commandLine, /--setting-sources project,local/);
  assert.doesNotMatch(handle.commandLine, /ash-profile-key|wrong-user/);
  console.log("claude relay settings live: ok");
} finally {
  upstream.close();
  if (upstream.listening) await once(upstream, "close");
  rmSync(scratch, { recursive: true, force: true });
}
