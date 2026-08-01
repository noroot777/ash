import assert from "node:assert/strict";
import { createServer } from "node:http";
import { rmSync } from "node:fs";
import { once } from "node:events";

const dbPath = `/tmp/harness-openai-converter-${process.pid}.db`;
process.env.HARNESS_DB = dbPath;
process.env.PORT = "54321";

const {
  responsesToChatRequest,
  chatToResponsesRequest,
} = await import("../src/openai-converter/request.js");
const {
  responsesToChatResponse,
  chatToResponsesResponse,
} = await import("../src/openai-converter/response.js");
const { chatStreamToResponses } = await import("../src/openai-converter/stream.js");
const { protocolConverterBaseUrl } = await import("../src/openai-converter/common.js");

const convertedRequest = responsesToChatRequest({
  model: "demo-model",
  instructions: "You are concise.",
  input: [
    { role: "user", content: [{ type: "input_text", text: "hello" }, { type: "input_image", image_url: "data:image/png;base64,AA==", detail: "low" }] },
    { type: "function_call", call_id: "call_1", name: "lookup", arguments: "{\"q\":\"x\"}" },
    { type: "function_call_output", call_id: "call_1", output: "ok" },
  ],
  tools: [{ type: "function", name: "lookup", description: "Lookup", parameters: { type: "object" }, strict: true }],
  tool_choice: { type: "function", name: "lookup" },
  reasoning: { effort: "high" },
  text: { format: { type: "json_schema", name: "answer", schema: { type: "object" }, strict: true } },
  max_output_tokens: 120,
  stream: true,
});
assert.equal(convertedRequest.max_completion_tokens, 120);
assert.equal(convertedRequest.reasoning_effort, "high");
assert.deepEqual(convertedRequest.tool_choice, { type: "function", function: { name: "lookup" } });
assert.deepEqual((convertedRequest.messages as any[])[0], { role: "system", content: "You are concise." });
assert.deepEqual((convertedRequest.messages as any[])[2].tool_calls[0].function, { name: "lookup", arguments: "{\"q\":\"x\"}" });
assert.equal((convertedRequest.messages as any[])[3].role, "tool");
assert.deepEqual(convertedRequest.stream_options, { include_usage: true });

const reverseRequest = chatToResponsesRequest({
  model: "demo-model",
  messages: [
    { role: "system", content: "one" },
    { role: "developer", content: "two" },
    { role: "assistant", content: null, tool_calls: [{ id: "call_2", type: "function", function: { name: "run", arguments: "{}" } }] },
    { role: "tool", tool_call_id: "call_2", content: "done" },
  ],
  response_format: { type: "json_schema", json_schema: { name: "result", schema: { type: "object" } } },
});
assert.equal(reverseRequest.instructions, "one\n\ntwo");
assert.equal((reverseRequest.input as any[])[0].type, "function_call");
assert.equal((reverseRequest.input as any[])[1].type, "function_call_output");

const response = chatToResponsesResponse({
  id: "chatcmpl-test",
  created: 123,
  model: "demo-model",
  choices: [{
    finish_reason: "tool_calls",
    message: {
      role: "assistant",
      content: "hello",
      reasoning_content: "think",
      tool_calls: [{ id: "call_3", type: "function", function: { name: "run", arguments: "{\"x\":1}" } }],
    },
  }],
  usage: {
    prompt_tokens: 2,
    completion_tokens: 3,
    total_tokens: 5,
    prompt_tokens_details: { cached_tokens: 1 },
    completion_tokens_details: { reasoning_tokens: 2 },
  },
});
assert.equal(response.id, "resp_test");
assert.deepEqual((response.output as any[]).map((item) => item.type), ["reasoning", "message", "function_call"]);
assert.equal((response.usage as any).input_tokens_details.cached_tokens, 1);

const reverseResponse = responsesToChatResponse(response);
assert.equal((reverseResponse.choices as any[])[0].message.content, "hello");
assert.equal((reverseResponse.choices as any[])[0].message.reasoning_content, "think");
assert.equal((reverseResponse.choices as any[])[0].finish_reason, "tool_calls");

const streamBody = new ReadableStream<Uint8Array>({
  start(controller) {
    const enc = new TextEncoder();
    controller.enqueue(enc.encode('data: {"id":"chatcmpl-s","object":"chat.completion.chunk","created":123,"model":"demo-model","choices":[{"index":0,"delta":{"role":"assistant","reasoning_content":"why "},"finish_reason":null}]}\n\n'));
    controller.enqueue(enc.encode('data: {"id":"chatcmpl-s","object":"chat.completion.chunk","created":123,"model":"demo-model","choices":[{"index":0,"delta":{"content":"hello"},"finish_reason":null}]}\n\n'));
    controller.enqueue(enc.encode('data: {"id":"chatcmpl-s","object":"chat.completion.chunk","created":123,"model":"demo-model","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_s","type":"function","function":{"name":"run","arguments":"{\\\"x\\\":"}}]},"finish_reason":null}]}\n\n'));
    controller.enqueue(enc.encode('data: {"id":"chatcmpl-s","object":"chat.completion.chunk","created":123,"model":"demo-model","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"1}"}}]},"finish_reason":"tool_calls"}],"usage":{"prompt_tokens":4,"completion_tokens":5,"total_tokens":9}}\n\n'));
    controller.enqueue(enc.encode("data: [DONE]\n\n"));
    controller.close();
  },
});
const streamedText = await new Response(chatStreamToResponses(streamBody, "demo-model")).text();
assert.match(streamedText, /response\.reasoning_summary_text\.delta/);
assert.match(streamedText, /response\.output_text\.delta/);
assert.match(streamedText, /response\.function_call_arguments\.done/);
assert.match(streamedText, /"arguments":"\{\\"x\\":1\}"/);
assert.match(streamedText, /"input_tokens":4/);
assert.match(streamedText, /response\.completed/);

let lastPath = "";
let lastAuthorization = "";
let lastBody: any = null;
const upstream = createServer(async (req, res) => {
  lastPath = req.url ?? "";
  lastAuthorization = req.headers.authorization ?? "";
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  const raw = Buffer.concat(chunks).toString("utf8");
  lastBody = raw ? JSON.parse(raw) : null;
  if (req.url === "/v1/models") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end('{"data":[{"id":"demo-model"}]}');
    return;
  }
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({
    id: "chatcmpl-upstream",
    object: "chat.completion",
    created: 456,
    model: "demo-model",
    choices: [{ index: 0, message: { role: "assistant", content: "converted" }, finish_reason: "stop" }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  }));
});
upstream.listen(0, "127.0.0.1");
await once(upstream, "listening");
const address = upstream.address();
if (!address || typeof address === "string") throw new Error("fake upstream failed to listen");

const { db, ensureSchema } = await import("../src/db/index.js");
const { llmProviders } = await import("../src/db/schema.js");
const { mountOpenAiConverterRoutes } = await import("../src/openai-converter/routes.js");
const { Hono } = await import("hono");
await ensureSchema();
await db.insert(llmProviders).values({
  id: "provider-1",
  name: "test",
  protocol: "openai",
  baseUrl: `http://127.0.0.1:${address.port}`,
  apiKey: "secret-key",
  model: "demo-model",
  protocolConversionEnabled: true,
  createdAt: new Date().toISOString(),
});
const app = new Hono();
mountOpenAiConverterRoutes(app);

const unauthorized = await app.request("/llm-providers/provider-1/convert/v1/responses", {
  method: "POST",
  headers: { authorization: "Bearer wrong", "content-type": "application/json" },
  body: JSON.stringify({ model: "demo-model", input: "hello" }),
});
assert.equal(unauthorized.status, 401);

const converted = await app.request("/llm-providers/provider-1/convert/v1/responses", {
  method: "POST",
  headers: { authorization: "Bearer secret-key", "content-type": "application/json" },
  body: JSON.stringify({ model: "demo-model", input: "hello" }),
});
assert.equal(converted.status, 200);
assert.equal(lastPath, "/v1/chat/completions");
assert.equal(lastAuthorization, "Bearer secret-key");
assert.equal(lastBody.messages[0].content, "hello");
assert.equal(((await converted.json()) as any).output[0].content[0].text, "converted");

const models = await app.request("/llm-providers/provider-1/convert/v1/models", {
  headers: { authorization: "Bearer secret-key" },
});
assert.equal(models.status, 200);
assert.equal(lastPath, "/v1/models");
assert.deepEqual(await models.json(), { data: [{ id: "demo-model" }] });

assert.equal(protocolConverterBaseUrl("provider/1"), "http://127.0.0.1:54321/api/llm-providers/provider%2F1/convert");

const relay = {
  providerId: "provider-1",
  name: "test",
  baseUrl: "https://upstream.example.com",
  apiKey: "secret-key",
  protocolConversionEnabled: true,
};
const { codexSpec } = await import("../src/executors/catalog/codex.js");
const { qwenSpec } = await import("../src/executors/catalog/qwen.js");
const codexWiring = codexSpec.exec.relay?.(relay);
assert.ok(codexWiring?.args?.some((arg) => arg.includes("/llm-providers/provider-1/convert/v1")), "Codex 应改走转换端点");
const qwenWiring = qwenSpec.exec.relay?.(relay);
assert.equal(qwenWiring?.env?.OPENAI_BASE_URL, "https://upstream.example.com/v1", "Qwen 原生 Chat 请求应继续直连上游");

upstream.close();
await once(upstream, "close");
for (const suffix of ["", "-shm", "-wal"]) rmSync(dbPath + suffix, { force: true });
console.log("openai converter tests passed");
