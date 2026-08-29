import assert from "node:assert/strict";
import { once } from "node:events";
import { rmSync } from "node:fs";
import { createServer } from "node:http";

const dbPath = `/tmp/ash-anthropic-context-1m-${process.pid}.db`;
process.env.ASH_DB = dbPath;
process.env.PORT = "54322";

const {
  anthropicContext1mBaseUrl,
  modelUsesContext1m,
  mountAnthropicContext1mRoutes,
  stripContext1mSuffix,
  withContext1mSuffix,
} = await import("../src/anthropic-context-1m.js");

assert.equal(stripContext1mSuffix("claude-opus-5[1M]"), "claude-opus-5");
assert.equal(stripContext1mSuffix("claude-opus-5"), "claude-opus-5");
assert.equal(modelUsesContext1m("claude-opus-5", ["claude-opus-5"]), true);
assert.equal(modelUsesContext1m("claude-sonnet-5", ["claude-opus-5"]), false);
assert.equal(withContext1mSuffix("claude-opus-5", ["claude-opus-5"]), "claude-opus-5[1m]");
assert.equal(withContext1mSuffix("claude-opus-5[1m]", ["claude-opus-5"]), "claude-opus-5[1m]");
assert.equal(
  anthropicContext1mBaseUrl("provider/1"),
  "http://127.0.0.1:54322/api/llm-providers/provider%2F1/context-1m",
);

let lastBody: any = null;
let lastAuthorization = "";
let lastBeta = "";
const upstream = createServer(async (req, res) => {
  lastAuthorization = req.headers.authorization ?? "";
  lastBeta = String(req.headers["anthropic-beta"] ?? "");
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  const raw = Buffer.concat(chunks).toString("utf8");
  lastBody = raw ? JSON.parse(raw) : null;
  if (lastBody?.stream) {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end('event: message_stop\ndata: {"type":"message_stop"}\n\n');
    return;
  }
  res.writeHead(200, { "content-type": "application/json" });
  res.end('{"content":[{"type":"text","text":"OK"}]}');
});
upstream.listen(0, "127.0.0.1");
await once(upstream, "listening");
const address = upstream.address();
if (!address || typeof address === "string") throw new Error("fake upstream failed to listen");

const { db, ensureSchema } = await import("../src/db/index.js");
const { agents, llmProviders } = await import("../src/db/schema.js");
const { Hono } = await import("hono");
await ensureSchema();
await db.insert(llmProviders).values({
  id: "provider-1",
  name: "test",
  protocol: "anthropic",
  baseUrl: `http://127.0.0.1:${address.port}`,
  apiKey: "secret-key",
  model: "claude-opus-5",
  context1mModels: '["claude-opus-5"]',
  createdAt: new Date().toISOString(),
});
await db.insert(agents).values({
  id: "agent-1",
  name: "claude@test",
  type: "claude",
  model: null,
  providerId: "provider-1",
  isDefault: true,
});

const app = new Hono();
mountAnthropicContext1mRoutes(app);

const unauthorized = await app.request("/llm-providers/provider-1/context-1m/v1/messages", {
  method: "POST",
  headers: { authorization: "Bearer wrong", "content-type": "application/json" },
  body: JSON.stringify({ model: "claude-opus-5[1m]", messages: [] }),
});
assert.equal(unauthorized.status, 401);

const response = await app.request("/llm-providers/provider-1/context-1m/v1/messages", {
  method: "POST",
  headers: {
    authorization: "Bearer secret-key",
    "anthropic-beta": "claude-code-20250219",
    "content-type": "application/json",
  },
  body: JSON.stringify({ model: "claude-opus-5[1m]", messages: [], stream: true }),
});
assert.equal(response.status, 200);
assert.equal(response.headers.get("content-type"), "text/event-stream");
assert.match(await response.text(), /message_stop/);
assert.equal(lastAuthorization, "Bearer secret-key");
assert.equal(lastBody.model, "claude-opus-5");
assert.match(lastBeta, /claude-code-20250219/);
assert.match(lastBeta, /context-1m-2025-08-07/);

const directShape = await app.request("/llm-providers/provider-1/context-1m/v1/messages", {
  method: "POST",
  headers: { authorization: "Bearer secret-key", "content-type": "application/json" },
  body: JSON.stringify({ model: "claude-haiku-4-5", messages: [] }),
});
assert.equal(directShape.status, 200);
assert.equal(lastBody.model, "claude-haiku-4-5");
assert.equal(lastBeta, "");

const { testProviderModel } = await import("../src/provider-test.js");
const tested = await testProviderModel({
  protocol: "anthropic",
  baseUrl: `http://127.0.0.1:${address.port}`,
  apiKey: "secret-key",
  model: "claude-opus-5",
  protocolConversionEnabled: false,
  context1m: true,
});
assert.equal(tested.endpoint, "Anthropic Messages API · 1M");
assert.match(lastBeta, /context-1m-2025-08-07/);

const { ClaudeExecutor } = await import("../src/executors/claude.js");
const { resolveExecutorWithProfile } = await import("../src/executors/index.js");
const resolved = await resolveExecutorWithProfile({ executorId: "agent-1", type: "claude" });
assert.equal((resolved.executor as InstanceType<typeof ClaudeExecutor>).model, "claude-opus-5");
const relay = {
  providerId: "provider-1",
  name: "test",
  baseUrl: `http://127.0.0.1:${address.port}`,
  apiKey: "secret-key",
  defaultModel: "claude-opus-5",
  protocolConversionEnabled: false,
  context1mModels: ["claude-opus-5"],
};
// 1M 只改变模型能力和请求路由，不能把执行器独立配置的自动压缩丢掉。
// 用真实任务采用的 400k / 80% 组合钉住两条路径：运行命令与恢复命令都必须带着它。
const configOverrides = { autoCompactWindow: 400_000, autoCompactPercent: 80 };
const oneMExecutor = new ClaudeExecutor({
  model: "claude-opus-5",
  relay,
  configOverrides,
  startupError: "test only",
});
const oneMRun = oneMExecutor.run({ cwd: "/tmp", prompt: "test" });
assert.match(oneMRun.commandLine, /--model claude-opus-5\[1m\]/);
assert.match(oneMRun.commandLine, /"autoCompactEnabled":true/);
assert.match(oneMRun.commandLine, /"CLAUDE_CODE_AUTO_COMPACT_WINDOW":"400000"/);
assert.match(oneMRun.commandLine, /"CLAUDE_AUTOCOMPACT_PCT_OVERRIDE":"84\.21"/);
assert.match(oneMRun.commandLine, /--setting-sources project,local/);
assert.match(oneMRun.commandLine, /"ANTHROPIC_BASE_URL":"http:\/\/127\.0\.0\.1:54322\/api\/llm-providers\/provider-1\/context-1m"/);
assert.doesNotMatch(oneMRun.commandLine, /"ANTHROPIC_(?:AUTH_TOKEN|API_KEY)"/);
assert.doesNotMatch(oneMRun.commandLine, /secret-key/);
const oneMResume = oneMExecutor.resumeFields("/tmp", oneMRun.sessionId);
assert.match(oneMResume.resumeEnv ?? "", /ANTHROPIC_AUTH_TOKEN=<你的key>/);
assert.doesNotMatch(oneMResume.resumeEnv ?? "", /ANTHROPIC_API_KEY/);
assert.match(oneMResume.resumeArgs ?? "", /--setting-sources project,local/);
assert.match(oneMResume.resumeArgs ?? "", /"CLAUDE_CODE_AUTO_COMPACT_WINDOW":"400000"/);
assert.match(oneMResume.resumeArgs ?? "", /"CLAUDE_AUTOCOMPACT_PCT_OVERRIDE":"84\.21"/);
assert.match(oneMResume.resumeArgs ?? "", /context-1m/);
assert.doesNotMatch(oneMResume.resumeArgs ?? "", /secret-key/);

const directExecutor = new ClaudeExecutor({
  model: "claude-haiku-4-5",
  relay,
  configOverrides,
  startupError: "test only",
});
const directRun = directExecutor.run({ cwd: "/tmp", prompt: "test" });
assert.match(directRun.commandLine, /--model claude-haiku-4-5/);
assert.doesNotMatch(directRun.commandLine, /\[1m\]/);
assert.match(directRun.commandLine, /--setting-sources project,local/);
assert.match(directRun.commandLine, /"CLAUDE_CODE_AUTO_COMPACT_WINDOW":"400000"/);
assert.match(directRun.commandLine, new RegExp(`"ANTHROPIC_BASE_URL":"http:\\\/\\\/127\\.0\\.0\\.1:${address.port}"`));
const directResume = directExecutor.resumeFields("/tmp", directRun.sessionId);
assert.match(directResume.resumeEnv ?? "", /ANTHROPIC_AUTH_TOKEN=<你的key>/);
assert.match(directResume.resumeArgs ?? "", /--setting-sources project,local/);
assert.match(directResume.resumeArgs ?? "", new RegExp(String(address.port)));
assert.doesNotMatch(directResume.resumeArgs ?? "", /context-1m/);
assert.doesNotMatch(directRun.commandLine, /secret-key/);

upstream.close();
await once(upstream, "close");
for (const suffix of ["", "-shm", "-wal"]) rmSync(dbPath + suffix, { force: true });
console.log("anthropic context 1m tests passed");
