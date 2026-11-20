import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { withTestResources } from "./test-process-resources.mjs";
import { isPidAlive } from "./platform.mjs";

export async function testRuntimeChannelTasks({ base, data, work, schema, launchTask, request, dbRead, dbWrite, health, waitFor }) {
  const streams = new Map();
  const key = "fixture-runtime-channel-key";
  const chunk = (text) => `data: ${JSON.stringify({ id: "chat-fixture", object: "chat.completion.chunk", created: 1,
    model: "fixture-model", choices: [{ index: 0, delta: { content: text }, finish_reason: null }] })}\n\n`;
  const upstream = createServer(async (incoming, response) => {
    let raw = "";
    for await (const part of incoming) raw += part;
    const body = JSON.parse(raw);
    response.writeHead(200, { "content-type": "text/event-stream" });
    const channel = incoming.url.endsWith("/messages") ? "context-1m" : "convert";
    if (channel === "context-1m") assert.match(incoming.headers["anthropic-beta"], /context-1m/);
    response.write(chunk("first"));
    if (body.model === "short") response.end("data: [DONE]\n\n");
    else streams.set(channel, response);
  });
  upstream.listen(0, "127.0.0.1");
  await once(upstream, "listening");
  const tasks = [];
  await withTestResources(async () => {
    const url = `http://127.0.0.1:${upstream.address().port}`;
    for (const [id, protocol, conversion, models] of [
      ["context-1m", "anthropic", 0, '["fixture-model"]'], ["convert", "openai", 1, "[]"],
    ]) {
      dbWrite("insert into llm_providers(id,name,protocol,base_url,api_key,model,protocol_conversion_enabled,context_1m_models,created_at) values(?,?,?,?,?,?,?,?,?)",
        id, id, protocol, url, key, "fixture-model", conversion, models, new Date().toISOString());
      dbWrite("insert into agents(id,name,type,provider_id,model) values(?,?,?,?,?)", id, id,
        protocol === "anthropic" ? "claude" : "codex", id, "fixture-model");
    }
    for (const [title, type, profile] of [["claude-1m-dependent", "claude", "context-1m"],
      ["codex-convert-dependent", "codex", "convert"], ["claude-hook-dependent", "claude", undefined]]) {
      tasks.push(await launchTask(title, type, profile));
    }
    const current = await health();
    const credentials = JSON.parse(readFileSync(join(data, "navi.db.navi.lock"), "utf8"));
    const headers = { "x-navi-host-token": credentials.token, "x-navi-instance": current.instance.id };
    const checkBlocked = async () => {
      const impact = (await request("/restart-impact")).body.runtimeHandoff;
      for (const [index, pattern] of [[0, /1M/], [0, /Monitor/], [1, /模型协议转换/], [2, /Monitor/]]) {
        assert.match(impact.blocked.find((item) => item.id === tasks[index].id)?.reason ?? "", pattern);
      }
    };
    await checkBlocked();
    const saved = dbRead("select agent_out_path from sessions where id=?", tasks[0].sessionId).agent_out_path;
    assert.doesNotMatch(readFileSync(saved + ".runtime-channels.json", "utf8"), new RegExp(key));
    dbWrite("update agents set provider_id=null where id in ('context-1m','convert')");
    await checkBlocked();
    const open = async (channel, model = "fixture-model") => fetch(`${base}/api/llm-providers/${channel}/${channel}/v1/${channel === "context-1m" ? "messages" : "responses"}`, {
      method: "POST", headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: JSON.stringify(channel === "context-1m" ? { model: model + "[1m]", messages: [], stream: true, max_tokens: 10 }
        : { model, input: "fixture", stream: true }),
    });
    const readers = [];
    for (const channel of ["context-1m", "convert"]) {
      const response = await open(channel);
      assert.equal(response.status, 200, channel);
      const reader = response.body.getReader();
      await reader.read();
      readers.push([channel, reader]);
    }
    const pending = request("/runtime-handoff", "POST", { protocol: 1, schema }, headers);
    await waitFor(async () => (await request("/tasks/channel-probe/run", "POST", {})).status === 503, "handoff starts draining");
    for (const channel of ["context-1m", "convert"]) {
      const continuing = await open(channel, "short");
      assert.equal(continuing.status, 200);
      assert.equal(continuing.headers.get("x-navi-undelivered"), null);
      await continuing.text();
    }
    const hook = await request("/hooks/claude-monitor", "POST", { tool_name: "Monitor", tool_input: {} });
    assert.equal(hook.status, 200);
    assert.equal(hook.body.hookSpecificOutput.permissionDecision, "deny");
    const unauthorized = await fetch(`${base}/api/llm-providers/convert/convert/v1/responses`, { method: "POST" });
    assert.equal(unauthorized.status, 401, "drain exemption does not bypass relay authentication");
    await unauthorized.text();
    const refused = await pending;
    assert.equal(refused.status, 409);
    assert.match(refused.body.error, /仍有请求/);
    assert.equal((await health()).pid, current.pid);
    for (const [channel, reader] of readers) {
      streams.get(channel).end(chunk("second") + "data: [DONE]\n\n");
      let tail = "";
      for (;;) { const value = await reader.read(); if (value.done) break; tail += new TextDecoder().decode(value.value); }
      assert.match(tail, /second/);
    }
    await checkBlocked();
    const idleRefusal = await request("/runtime-handoff", "POST", { protocol: 1, schema }, headers);
    assert.equal(idleRefusal.status, 409, "between model requests a dependent turn must still block takeover");
    for (const pattern of [/1M/, /Monitor/, /模型协议转换/]) assert.match(idleRefusal.body.error, pattern);
    assert.equal((await health()).pid, current.pid);
    for (const task of tasks) {
      assert.ok(isPidAlive(task.rootPid) && isPidAlive(task.pid) && isPidAlive(task.mcp));
      writeFileSync(join(work, task.id + "-finish"), "");
    }
    await waitFor(() => tasks.every((task) => dbRead("select status from tasks where id=?", task.id).status === "done"), "dependent turns finish through their original MCP");
    await waitFor(async () => (await request("/restart-impact")).body.runtimeHandoff.blocked.length === 0, "finished channel dependencies release takeover");
    console.log("✓ real Claude 1M/Codex conversion streams and Monitor hook survive refused takeover; launch-time dependencies persist between requests/profile edits until original agents settle");
  }, [
    () => { for (const response of streams.values()) response.destroy(); upstream.closeAllConnections(); },
    () => new Promise((done) => upstream.close(done)),
    () => { for (const id of ["context-1m", "convert"]) { dbWrite("delete from agents where id=?", id); dbWrite("delete from llm_providers where id=?", id); } },
  ]);
}
