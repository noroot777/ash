import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createInterface } from "node:readline";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { AgentEvent } from "@ash/shared";
import { CodexExecutor } from "../src/executors/codex.js";
import { findArchivedRollout, findRollout, readCodexCliVersion } from "../src/executors/codex-rollout.js";
import { spawnAgent, cleanupAfterRun } from "../src/executors/spawn.js";

// 真实 Codex 二进制 + 本地 Responses 替身；不会请求模型服务，用户配置不参与测试。
const root = await realpath(await mkdtemp(join(tmpdir(), "ash-codex-archive-live-")));
const home = join(root, "codex");
const workspace = join(root, "workspace");
const requests: string[] = [];
const server = createServer(async (req, res) => {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  requests.push(Buffer.concat(chunks).toString());
  const item = { type: "message", id: "msg_fixture", role: "assistant", phase: "final_answer",
    content: [{ type: "output_text", text: "Archive fixture completed." }] };
  res.writeHead(200, { "content-type": "text/event-stream" });
  for (const event of [
    { type: "response.created", response: { id: "resp_fixture", status: "in_progress", output: [] } },
    { type: "response.output_item.added", output_index: 0, item: { ...item, content: [] } },
    { type: "response.output_text.delta", output_index: 0, item_id: item.id, content_index: 0, delta: item.content[0]!.text },
    { type: "response.output_item.done", output_index: 0, item },
    { type: "response.completed", response: { id: "resp_fixture", status: "completed", output: [item],
      usage: { input_tokens: 100, output_tokens: 10, total_tokens: 110,
        input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } } } },
  ]) res.write(`data: ${JSON.stringify(event)}\n\n`);
  res.end();
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const address = server.address();
assert.ok(address && typeof address === "object");
const config = `model = "gpt-5.4"
model_provider = "archive_fixture"
check_for_update_on_startup = false
[model_providers.archive_fixture]
name = "Archive fixture"
base_url = "http://127.0.0.1:${address.port}/v1"
wire_api = "responses"
requires_openai_auth = false
[projects.${JSON.stringify(workspace)}]
trust_level = "trusted"
`;
await mkdir(join(home, "skills", "archive-live-marker"), { recursive: true });
await mkdir(workspace);
await writeFile(join(home, "config.toml"), config);
const skill = "---\nname: archive-live-marker\ndescription: Existing installed skill for the archive fixture.\n---\nFixture marker.\n";
await writeFile(join(home, "skills", "archive-live-marker", "SKILL.md"), skill);
const env = { CODEX_HOME: home };
const ex = new CodexExecutor();
await mkdir(join(home, "sqlite"));
const catalogPath = join(home, "sqlite", "codex.db");
const catalog = new DatabaseSync(catalogPath);
catalog.exec(`CREATE TABLE local_thread_catalog (host_id TEXT, thread_id TEXT PRIMARY KEY, missing_candidate INTEGER);
  CREATE TABLE local_thread_catalog_sync_state (host_id TEXT, observation_sequence INTEGER);
  CREATE TABLE local_thread_catalog_metadata (id INTEGER, catalog_revision INTEGER);
  INSERT INTO local_thread_catalog_sync_state VALUES ('local', 1);
  INSERT INTO local_thread_catalog_metadata VALUES (1, 1);`);
catalog.close();

function seedDesktopEntry(id: string) {
  const db = new DatabaseSync(catalogPath);
  try { db.prepare("INSERT OR REPLACE INTO local_thread_catalog VALUES ('local', ?, 0)").run(id); }
  finally { db.close(); }
}

async function run(prompt: string, sessionId?: string, exec = false) {
  if (exec) await ex.prepareResume({ cwd: workspace, sessionId, env });
  if (sessionId) seedDesktopEntry(sessionId);
  const handle = exec ? ex.run({ cwd: workspace, prompt, sessionId, env })
    : ex.runSteerable({ cwd: workspace, prompt, sessionId, env });
  const events: AgentEvent[] = [];
  const deadline = setTimeout(() => handle.kill(), 30_000);
  try {
    for await (const event of handle.events) {
      if (event.kind === "session") seedDesktopEntry(event.cliSessionId);
      events.push(event);
    }
  } finally {
    clearTimeout(deadline);
    await handle.cleanup?.();
  }
  assert.equal(events.find((e) => e.kind === "done")?.exitStatus, 0,
    events.filter((e) => e.kind === "error" || e.kind === "system").map((e) => JSON.stringify(e)).join("\n"));
  assert.ok(!events.some((e) => e.kind === "system" && e.text.includes("自动归档未完成")));
  const reopened = new DatabaseSync(catalogPath, { readOnly: true });
  try { assert.equal(reopened.prepare("SELECT count(*) n FROM local_thread_catalog").get()?.n, 0,
    "真实 Codex 归档后，重开 Desktop 索引也不再包含此会话"); }
  finally { reopened.close(); }
  return events.find((e) => e.kind === "session")?.cliSessionId ?? sessionId!;
}

async function checkListing(id: string) {
  const child = spawnAgent(workspace, "codex", ["app-server", "--stdio"], "", env, { keepStdin: true });
  const pending = new Map<number, { resolve(value: any): void; reject(error: Error): void }>();
  let sequence = 0;
  const lines = createInterface({ input: child.stdout! });
  lines.on("line", (line) => {
    const value = JSON.parse(line);
    const waiter = pending.get(value.id);
    if (!waiter) return;
    pending.delete(value.id);
    if (value.error) waiter.reject(new Error(value.error.message)); else waiter.resolve(value.result);
  });
  child.stderr!.resume();
  const request = (method: string, params: unknown) => new Promise<any>((resolve, reject) => {
    const requestId = ++sequence;
    pending.set(requestId, { resolve, reject });
    child.stdin!.write(JSON.stringify({ id: requestId, method, params }) + "\n");
  });
  const timer = setTimeout(() => {
    for (const waiter of pending.values()) waiter.reject(new Error("listing timeout"));
    child.kill();
  }, 10_000);
  try {
    await request("initialize", { clientInfo: { name: "ash", version: "0.0.0" } });
    child.stdin!.write('{"method":"initialized"}\n');
    const normal = await request("thread/list", { limit: 100 });
    const archived = await request("thread/list", { limit: 100, archived: true });
    assert.ok(!normal.data.some((t: any) => t.id === id));
    assert.ok(archived.data.some((t: any) => t.id === id));
    const history = await request("thread/read", { threadId: id, includeTurns: true });
    assert.equal(history.thread.id, id);
    assert.ok(history.thread.turns.length > 0);
  } finally {
    clearTimeout(timer);
    lines.close();
    child.stdin!.end();
    await cleanupAfterRun(child);
  }
}

try {
  const id = await run("FIRST ARCHIVE LIVE FIXTURE");
  assert.ok(await findArchivedRollout(id, home));
  assert.equal(await findRollout(id, home), await findArchivedRollout(id, home));
  assert.ok(await readCodexCliVersion(id, home), "真实归档仍可识别原 CLI 版本");
  await checkListing(id);
  console.log("✓ 真实 Codex 完成后归档，默认列表隐藏，归档历史仍可读取");
  assert.equal(await run("SECOND ARCHIVE LIVE FIXTURE", id), id);
  await checkListing(id);
  assert.ok(requests.at(-1)?.includes("FIRST ARCHIVE LIVE FIXTURE"));
  assert.ok(requests.at(-1)?.includes("SECOND ARCHIVE LIVE FIXTURE"));
  assert.ok(requests.some((r) => r.includes("archive-live-marker")), "已安装 skill 沿用同一用户目录");
  assert.equal(await readFile(join(home, "config.toml"), "utf8"), config);
  assert.equal(await readFile(join(home, "skills", "archive-live-marker", "SKILL.md"), "utf8"), skill);
  console.log("✓ 真实 Codex 恢复同一 thread，首轮上下文与已有 skill 保留，再次归档");
  assert.equal(await run("EXEC RESUME ARCHIVED FIXTURE", id, true), id);
  await checkListing(id);
  console.log("✓ exec 降级路径也能恢复同一会话并重新归档");
  await ex.prepareResume({ cwd: workspace, sessionId: id, env });
  const resident = ex.openResident({ cwd: workspace, prompt: "RESIDENT FIRST FIXTURE", sessionId: id, env });
  const residentEvents: AgentEvent[] = [];
  const residentDeadline = setTimeout(() => resident.kill(), 30_000);
  try {
    let turns = 0;
    for await (const event of resident.events) {
      residentEvents.push(event);
      if (event.kind === "turnEnd") {
        if (++turns === 1) resident.send("RESIDENT SECOND FIXTURE");
        else resident.close();
      }
    }
    assert.equal(turns, 2);
    assert.equal(resident.sessionId, id);
    assert.ok(!residentEvents.some((event) => event.kind === "error" || event.kind === "system"));
    assert.ok(requests.at(-1)?.includes("FIRST ARCHIVE LIVE FIXTURE"));
    assert.ok(requests.at(-1)?.includes("RESIDENT SECOND FIXTURE"));
    await checkListing(id);
    console.log("✓ 常驻 exec 的连续回合复用历史，关闭常驻后归档");
  } finally { clearTimeout(residentDeadline); resident.kill(); }
  const restore = spawnAgent(workspace, "codex", ["unarchive", id], "", env);
  let output = "";
  restore.stdout?.on("data", (part) => { output += part; });
  restore.stderr?.on("data", (part) => { output += part; });
  const deadline = setTimeout(() => { void cleanupAfterRun(restore); }, 15_000);
  try {
    const code = await new Promise<number | null>((resolve, reject) => {
      restore.on("error", reject);
      restore.on("close", resolve);
    });
    assert.equal(code, 0, output);
    assert.equal(await findArchivedRollout(id, home), null);
    assert.ok(await findRollout(id, home));
    console.log("✓ 终端 codex unarchive 可恢复归档，不启动模型回合");
  } finally { clearTimeout(deadline); await cleanupAfterRun(restore); }
} finally {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
