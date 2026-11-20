import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Agent, fetch as directFetch } from "undici";
import { withTestResources } from "./test-process-resources.mjs";
import { isPidAlive } from "./platform.mjs";
import { gatewayRequest } from "../server/dist/runtime-channel-controller.js";

export async function testRuntimeChannelTasks({ base, data, work, schema, launchTask, request, dbRead, dbWrite, health, waitFor }) {
  const direct = new Agent();
  const fetch = (url, options) => directFetch(url, { ...options, dispatcher: direct });
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
    const checkEligible = async () => {
      const impact = (await request("/restart-impact")).body.runtimeHandover;
      for (const task of tasks) {
        assert.equal(impact.blocked.some((item) => item.id === task.id), false);
        assert.ok(impact.sessions.includes(task.sessionId));
      }
    };
    await checkEligible();
    const saved = dbRead("select agent_out_path from sessions where id=?", tasks[0].sessionId).agent_out_path;
    assert.doesNotMatch(readFileSync(saved + ".runtime-channels.json", "utf8"), new RegExp(key));
    dbWrite("update agents set provider_id=null where id in ('context-1m','convert')");
    await checkEligible();
    const stable = new URL(tasks[0].monitorUrl).origin;
    assert.notEqual(stable, base, "real ClaudeExecutor HTTP hook points at the independent listener");
    const open = async (channel, model = "fixture-model") => fetch(`${stable}/api/llm-providers/${channel}/${channel}/v1/${channel === "context-1m" ? "messages" : "responses"}`, {
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
    const pending = request("/runtime-handover", "POST", { protocol: 1, schema }, headers);
    await waitFor(async () => (await request("/tasks/channel-probe/run", "POST", {})).status === 503, "handoff starts draining");
    const endpoint = JSON.parse(readFileSync(join(data, ".agent-channel-v1/endpoint.json"), "utf8"));
    await waitFor(async () => (await gatewayRequest(endpoint.socket, "/status")).paused, "stable listener acknowledges the admission seal");
    const continuing = [open("context-1m", "short"), open("convert", "short")];
    const hook = await fetch(stable + "/api/hooks/claude-monitor", { method: "POST", body: JSON.stringify({ tool_name: "Monitor", tool_input: {} }) });
    assert.equal(hook.status, 200);
    assert.equal((await hook.json()).hookSpecificOutput.permissionDecision, "deny");
    const unauthorized = await fetch(`${base}/api/llm-providers/convert/convert/v1/responses`, { method: "POST" });
    assert.equal(unauthorized.status, 503, "sealed backend refuses before execution or authentication");
    await unauthorized.text();
    const refused = await pending;
    assert.equal(refused.status, 409);
    assert.match(refused.body.error, /仍有请求/);
    for (const response of await Promise.all(continuing)) { const body = await response.text(); assert.equal(response.status, 200, body); }
    assert.equal((await health()).pid, current.pid);
    for (const [channel, reader] of readers) {
      streams.get(channel).end(chunk("second") + "data: [DONE]\n\n");
      let tail = "";
      for (;;) { const value = await reader.read(); if (value.done) break; tail += new TextDecoder().decode(value.value); }
      assert.match(tail, /second/);
    }
    await checkEligible();
    const prepared = await request("/runtime-handover", "POST", { protocol: 1, schema }, headers);
    assert.equal(prepared.status, 200, "channel-dependent turns can switch between requests");
    let settled = false;
    const waiting = open("convert", "short").then((response) => { settled = true; return response; });
    await new Promise((done) => setTimeout(done, 100));
    assert.equal(settled, false, "requests after the final handoff check stay at the stable listener");
    const sealed = await fetch(`${base}/api/llm-providers/convert/convert/v1/responses`, { method: "POST" });
    assert.equal(sealed.status, 503);
    assert.equal(sealed.headers.get("x-navi-undelivered"), "runtime-handoff-v1");
    await sealed.text();
    assert.equal((await request("/runtime-handover", "POST", { release: prepared.body.lease }, headers)).status, 200);
    const recovered = await waiting;
    assert.equal(recovered.status, 200);
    await recovered.text();
    assert.equal((await health()).pid, current.pid);
    for (const task of tasks) {
      assert.ok(isPidAlive(task.rootPid) && isPidAlive(task.pid) && isPidAlive(task.mcp));
      writeFileSync(join(work, task.id + "-finish"), "");
    }
    await waitFor(() => tasks.every((task) => dbRead("select status from tasks where id=?", task.id).status === "done"), "dependent turns finish through their original MCP");
    await waitFor(async () => (await request("/restart-impact")).body.runtimeHandover.blocked.length === 0, "finished channel dependencies release takeover");
    console.log("✓ real ClaudeExecutor HTTP hooks and 1M/Codex conversion use stable channels; in-flight streams block, idle turns switch, final-check requests queue and cancellation resumes safely");
  }, [
    () => direct.destroy(),
    () => { for (const response of streams.values()) response.destroy(); upstream.closeAllConnections(); },
    () => new Promise((done) => upstream.close(done)),
    () => { for (const id of ["context-1m", "convert"]) { dbWrite("delete from agents where id=?", id); dbWrite("delete from llm_providers where id=?", id); } },
  ]);
}
