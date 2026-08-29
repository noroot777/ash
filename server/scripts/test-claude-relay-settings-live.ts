// 用真 Claude CLI 打本地假上游，验证 ash 供应商配置不会被用户级 settings / CC Switch 覆盖。
// 假上游只返回固定 SSE，不调用真实模型，也不会产生费用。
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { platform, tmpdir } from "node:os";
import { join } from "node:path";

if (spawnSync("claude", ["--version"], { encoding: "utf8" }).status !== 0) {
  console.log("claude relay settings live: 跳过(本机没装 claude)");
  process.exit(0);
}

const scratch = mkdtempSync(join(tmpdir(), "ash-claude-relay-live-"));
const staleSettings = join(tmpdir(), "ash-claude-settings-2147483647-00000000-0000-0000-0000-000000000000.json");
writeFileSync(staleSettings, "stale");
const cwd = join(scratch, "repo");
const configDir = join(scratch, "claude-config");
const hookFile = join(scratch, "hook.json");
mkdirSync(cwd, { recursive: true });
mkdirSync(configDir, { recursive: true });
mkdirSync(join(cwd, ".claude"), { recursive: true });
writeFileSync(join(configDir, "settings.json"), JSON.stringify({
  env: {
    ANTHROPIC_BASE_URL: "http://127.0.0.1:59999",
    ANTHROPIC_AUTH_TOKEN: "wrong-user-auth",
    ANTHROPIC_API_KEY: "wrong-user-api-key",
    CLAUDE_CODE_OAUTH_TOKEN: "wrong-user-oauth",
    API_TIMEOUT_MS: "3000000",
  },
  hooks: {
    SessionStart: [{ hooks: [{ type: "command", command: `printf '{\"timeout\":\"%s\"}' \"$API_TIMEOUT_MS\" > ${JSON.stringify(hookFile)}` }] }],
  },
}));
writeFileSync(join(cwd, ".claude", "settings.json"), JSON.stringify({
  env: {
    ANTHROPIC_AUTH_TOKEN: "wrong-project-auth",
    ANTHROPIC_API_KEY: "wrong-project-api-key",
    CLAUDE_CODE_OAUTH_TOKEN: "wrong-project-oauth",
  },
}));

let authorization: string | null = null;
let xApiKey: string | null = null;
let beta = "";
let cacheControls: unknown[] = [];
const upstream = createServer(async (req, res) => {
  authorization = req.headers.authorization ?? null;
  xApiKey = String(req.headers["x-api-key"] ?? "") || null;
  beta = String(req.headers["anthropic-beta"] ?? "");
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { system?: Array<{ cache_control?: unknown }> };
  cacheControls = (body.system ?? []).map((item) => item.cache_control).filter(Boolean);
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
  assert.equal(existsSync(staleSettings), false, "导入执行器时应清理已死亡 pid 的残留 settings");
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
  const settingsPath = handle.commandLine.match(/--settings (.*?ash-claude-settings-\d+-[0-9a-f-]+\.json)(?:\s|$)/i)?.[1];
  assert.ok(settingsPath && existsSync(settingsPath), "运行期 settings 文件应在 spawn 前准备好");
  if (platform() !== "win32") assert.equal(statSync(settingsPath).mode & 0o777, 0o600);
  const runtimeSettings = readFileSync(settingsPath, "utf8");
  assert.match(runtimeSettings, /ash-profile-key/);
  assert.doesNotMatch(handle.commandLine, /ash-profile-key/);
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
  assert.doesNotMatch(beta, /oauth-2025-04-20|extended-cache-ttl-2025-04-11/);
  assert.ok(cacheControls.every((value) => !value || typeof value !== "object" || !("ttl" in value)), "AUTH_TOKEN 通道不应请求 1h cache ttl");
  assert.doesNotMatch(handle.commandLine, /--setting-sources/);
  assert.doesNotMatch(handle.commandLine, /ash-profile-key|wrong-user/);
  assert.equal(existsSync(settingsPath), false, "Claude init 后应删除临时 settings 文件");
  assert.ok(existsSync(hookFile), "用户级 SessionStart hook 应继续加载");
  assert.deepEqual(JSON.parse(readFileSync(hookFile, "utf8")), { timeout: "3000000" });

  for (const [label, failed] of [
    ["run", executor.run({ cwd: join(scratch, "missing-run"), prompt: "ping", env: { CLAUDE_CONFIG_DIR: configDir } })],
    ["runSteerable", executor.runSteerable({ cwd: join(scratch, "missing-steerable"), prompt: "ping", env: { CLAUDE_CONFIG_DIR: configDir } })],
    ["openResident", executor.openResident({ cwd: join(scratch, "missing-resident"), prompt: "ping", env: { CLAUDE_CONFIG_DIR: configDir } })],
  ] as const) {
    const failedSettingsPath = failed.commandLine.match(/--settings (.*?ash-claude-settings-\d+-[0-9a-f-]+\.json)(?:\s|$)/i)?.[1];
    assert.ok(failedSettingsPath && existsSync(failedSettingsPath), `${label}:预检前应已准备 settings`);
    for await (const _event of failed.events) { /* consume failedChild error/done */ }
    assert.equal(existsSync(failedSettingsPath), false, `${label}:调用方不调 cleanup 时也必须删除 settings`);
  }

  const startupFailed = new ClaudeExecutor({
    relay: {
      providerId: "provider-live",
      name: "live",
      baseUrl: `http://127.0.0.1:${address.port}`,
      apiKey: "ash-profile-key",
      defaultModel: "claude-sonnet-4-6",
      protocolConversionEnabled: false,
      context1mModels: [],
    },
    startupError: "test startup error",
  }).run({ cwd, prompt: "ping" });
  assert.doesNotMatch(startupFailed.commandLine, /ash-claude-settings-/);
  for await (const _event of startupFailed.events) { /* consume startup error */ }
  console.log("claude relay settings live: ok");
} finally {
  rmSync(staleSettings, { force: true });
  upstream.close();
  if (upstream.listening) await once(upstream, "close");
  rmSync(scratch, { recursive: true, force: true });
}
