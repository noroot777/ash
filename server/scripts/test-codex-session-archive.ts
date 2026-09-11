import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync, renameSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { AgentEvent } from "@ash/shared";
import { openCodexAppServer, readCodexAppServerState } from "../src/executors/codex-app-server.js";
import { archiveCodexThread } from "../src/executors/codex-session-archive.js";
import { spawnAgent } from "../src/executors/spawn.js";
import { findArchivedRollout, findRollout, readCodexCliVersion, readCodexContext, rolloutExportPath } from "../src/executors/codex-rollout.js";

const root = mkdtempSync(join(tmpdir(), "ash-codex-archive-"));
const home = join(root, "user-codex");
const otherHome = join(root, "other-user-codex");
const id = "archive-fixture-thread";
const name = `rollout-2026-09-11T10-00-00-${id}.jsonl`;
const active = join(home, "sessions", "2026", "09", "11", name);
const archived = join(home, "archived_sessions", name);
const callsFile = join(root, "calls.jsonl");
const fixture = join(root, "codex-fixture.cjs");
const original = JSON.stringify({ type: "session_meta", payload: { id, session_id: id, cli_version: "0.153.4" } }) + "\n"
  + JSON.stringify({ type: "event_msg", timestamp: "2026-09-11T10:00:00Z", payload: {
    type: "token_count", info: { last_token_usage: { input_tokens: 42 }, model_context_window: 1000 },
  } }) + "\n";
mkdirSync(join(home, "skills", "existing-skill"), { recursive: true });
mkdirSync(join(home, "archived_sessions"), { recursive: true });
mkdirSync(join(home, "sessions", "2026", "09", "11"), { recursive: true });
writeFileSync(join(home, "config.toml"), "# Existing user configuration\n");
writeFileSync(join(home, "skills", "existing-skill", "SKILL.md"), "Existing user skill\n");
writeFileSync(join(home, "sessions", "2026", "09", "11", "rollout-2026-09-11T10-00-00-unrelated.jsonl"), "User's unrelated conversation\n");
writeFileSync(fixture, `
const fs = require('node:fs');
const path = require('node:path');
const rl = require('node:readline').createInterface({ input: process.stdin });
const home = process.env.CODEX_HOME;
const id = ${JSON.stringify(id)};
const active = path.join(home, 'sessions', '2026', '09', '11', ${JSON.stringify(name)});
const archived = path.join(home, 'archived_sessions', ${JSON.stringify(name)});
const mode = process.env.ASH_ARCHIVE_FIXTURE_MODE;
const send = (message) => process.stdout.write(JSON.stringify(message) + '\\n');
const complete = (status) => send({ method: 'turn/completed', params: { threadId: id, turn: { id: 'turn', status } } });
rl.on('line', (line) => {
  const m = JSON.parse(line);
  fs.appendFileSync(process.env.ASH_ARCHIVE_FIXTURE_CALLS, JSON.stringify({ method: m.method, params: m.params, home }) + '\\n');
  if (m.id === undefined) return;
  if (m.method === 'initialize') return send({ id: m.id, result: {} });
  if (m.method === 'thread/unarchive') {
    if (mode === 'restore-fail') return send({ id: m.id, error: { message: 'unarchive denied' } });
    if (fs.existsSync(archived)) fs.renameSync(archived, active);
    return send({ id: m.id, result: { thread: { id } } });
  }
  if (m.method === 'thread/start' || m.method === 'thread/resume') {
    if (m.method === 'thread/resume' && !fs.existsSync(active)) return send({ id: m.id, error: { message: 'no active rollout' } });
    if (m.method === 'thread/start') fs.writeFileSync(active, ${JSON.stringify(original)});
    return send({ id: m.id, result: { thread: { id } } });
  }
  if (m.method === 'turn/start') {
    fs.appendFileSync(active, JSON.stringify({ prompt: m.params.input[0].text }) + '\\n');
    send({ id: m.id, result: { turn: { id: 'turn' } } });
    if (mode === 'crash') return process.exit(9);
    if (mode !== 'hold') setTimeout(() => {
      complete(mode === 'failed' ? 'failed' : 'completed');
      if (mode === 'duplicate') complete('completed');
    }, 10);
    return;
  }
  if (m.method === 'turn/interrupt') { send({ id: m.id, result: {} }); complete('interrupted'); return; }
  if (m.method === 'thread/archive') {
    if (mode === 'archive-fail') return send({ id: m.id, error: { message: 'archive denied' } });
    if (mode === 'archive-hang') return;
    if (fs.existsSync(active)) fs.renameSync(active, archived);
    return setTimeout(() => send({ id: m.id, result: {} }), 20);
  }
  send({ id: m.id, error: { message: 'unsupported method: ' + m.method } });
});
rl.on('close', () => process.exit(0));
`);

const calls = () => existsSync(callsFile)
  ? readFileSync(callsFile, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)) : [];
function open(mode = "success", resume = false) {
  return openCodexAppServer({
    bin: process.execPath, args: [fixture], cwd: root, prompt: resume ? "SECOND" : "FIRST",
    sessionId: resume ? id : undefined,
    env: { CODEX_HOME: home, ASH_ARCHIVE_FIXTURE_MODE: mode, ASH_ARCHIVE_FIXTURE_CALLS: callsFile },
  });
}
async function consume(handle: ReturnType<typeof open>) {
  const events: AgentEvent[] = [];
  try {
    for await (const event of handle.events) events.push(event);
  } finally {
    await handle.cleanup?.();
  }
  return events;
}
async function waitFor(predicate: () => boolean) {
  const deadline = Date.now() + 3000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("fixture timeout");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

try {
  mkdirSync(join(home, "sqlite"), { recursive: true });
  const catalog = new DatabaseSync(join(home, "sqlite", "codex.db"));
  catalog.exec(`CREATE TABLE local_thread_catalog (host_id TEXT, thread_id TEXT, missing_candidate INTEGER);
    CREATE TABLE local_thread_catalog_sync_state (host_id TEXT, observation_sequence INTEGER);
    CREATE TABLE local_thread_catalog_metadata (id INTEGER, catalog_revision INTEGER);
    INSERT INTO local_thread_catalog_sync_state VALUES ('local', 1);
    INSERT INTO local_thread_catalog_metadata VALUES (1, 1);`);
  catalog.prepare("INSERT INTO local_thread_catalog VALUES ('local', ?, 0)").run(id);
  catalog.close();
  const first = await consume(open());
  const reopenedCatalog = new DatabaseSync(join(home, "sqlite", "codex.db"), { readOnly: true });
  assert.equal(reopenedCatalog.prepare("SELECT count(*) n FROM local_thread_catalog").get()?.n, 0,
    "app-server 正常结束在 done 前同步清理 Desktop 的持久侧栏");
  reopenedCatalog.close();
  assert.equal(first.at(-1)?.kind, "done");
  assert.equal(first.find((event) => event.kind === "done")?.exitStatus, 0);
  assert.ok(existsSync(archived) && !existsSync(active));
  assert.deepEqual(calls().map((r) => r.method), ["initialize", "initialized", "thread/start", "turn/start", "thread/archive"]);
  assert.ok(calls().every((r) => r.home === home));
  assert.equal(await findRollout(id, home), archived);
  assert.equal(await findArchivedRollout(id, home), archived);
  assert.equal(await findRollout(id, otherHome), null);
  assert.equal(await readCodexCliVersion(id, home), "0.153.4");
  assert.deepEqual(await readCodexContext(id, 0, home), { used: 42, window: 1000, windowEstimated: false });
  assert.equal(rolloutExportPath(archived, home), `2026/09/11/${name}`);
  assert.equal(rolloutExportPath(active, home), `2026/09/11/${name}`);
  assert.throws(() => rolloutExportPath(join(otherHome, "archived_sessions", name), home), /不在指定/);
  console.log("✓ 完成后原生归档；历史、版本、水位、接力路径仍可读取，用户目录不变");

  writeFileSync(callsFile, "");
  await consume(open("success", true));
  assert.deepEqual(calls().map((r) => r.method), ["initialize", "initialized", "thread/unarchive", "thread/resume", "turn/start", "thread/archive"]);
  assert.match(readFileSync(archived, "utf8"), /FIRST/);
  assert.match(readFileSync(archived, "utf8"), /SECOND/);
  assert.ok(!calls().some((r) => r.method === "thread/start"));
  console.log("✓ 续跑先恢复再 resume 同一会话，再次结束后归档，已有上下文保留");

  writeFileSync(callsFile, "");
  const duplicate = await consume(open("duplicate", true));
  assert.equal(duplicate.filter((event) => event.kind === "done").length, 1);
  assert.equal(calls().filter((row) => row.method === "thread/archive").length, 1);

  writeFileSync(callsFile, "");
  const restoreFailed = await consume(open("restore-fail", true));
  assert.equal(restoreFailed.find((e) => e.kind === "done")?.exitStatus, 1);
  assert.ok(!calls().some((r) => r.method === "thread/resume" || r.method === "thread/start" || r.method === "turn/start"));
  assert.ok(existsSync(archived));
  console.log("✓ 恢复失败时不启动新会话、不丢上下文");

  for (const mode of ["failed", "hold", "crash"]) {
    writeFileSync(callsFile, "");
    const handle = open(mode, true);
    const result = consume(handle);
    if (mode === "hold") {
      await waitFor(() => calls().some((r) => r.method === "turn/start"));
      handle.kill();
    }
    const events = await result;
    assert.notEqual(events.find((e) => e.kind === "done")?.exitStatus, 0, mode);
    assert.ok(existsSync(archived) && !existsSync(active), mode);
    if (mode === "crash") {
      assert.equal(calls().filter((r) => r.method === "initialize").length, 2);
      const fallback = calls().slice(calls().findLastIndex((r) => r.method === "initialize"));
      assert.deepEqual(fallback.map((r) => r.method), ["initialize", "initialized", "thread/archive"]);
    }
    console.log(`✓ ${mode} 收尾归档，退出状态保留；异常补归档不启动模型回合`);
  }

  writeFileSync(callsFile, "");
  const brokenPipeOpts = { bin: process.execPath, args: [fixture], cwd: root, prompt: "BROKEN PIPE", sessionId: id,
    env: { CODEX_HOME: home, ASH_ARCHIVE_FIXTURE_MODE: "hold", ASH_ARCHIVE_FIXTURE_CALLS: callsFile } };
  const brokenPipeChild = spawnAgent(root, process.execPath, [fixture], "", brokenPipeOpts.env, { keepStdin: true });
  const brokenPipeResult = consume(openCodexAppServer({ ...brokenPipeOpts, startProcess: () => brokenPipeChild }));
  await waitFor(() => calls().some((row) => row.method === "turn/start"));
  brokenPipeChild.stdin!.destroy(new Error("fixture broken pipe"));
  const brokenPipeEvents = await brokenPipeResult;
  assert.equal(brokenPipeEvents.find((event) => event.kind === "done")?.exitStatus, 1);
  assert.ok(existsSync(archived) && !existsSync(active));
  console.log("✓ stdin 断开有界收尾并补归档，不产生未捕获异常");

  const transcript = join(root, "reconnect.jsonl");
  const history = [
    { method: "thread/started", params: { thread: { id } } },
    { method: "turn/started", params: { threadId: id, turn: { id: "turn" } } },
    { method: "thread/started", params: { thread: { id: "child" } } },
    { method: "turn/completed", params: { threadId: "child", turn: { id: "child-turn", status: "completed" } } },
    { method: "turn/completed", params: { threadId: id, turn: { id: "turn", status: "completed" } } },
  ];
  writeFileSync(transcript, history.map((row) => JSON.stringify(row)).join("\n"));
  const recovered = readCodexAppServerState(transcript, id);
  assert.equal(recovered.threadId, id);
  assert.deepEqual(recovered.completedTurn, { id: "turn", status: "completed" });
  renameSync(archived, active);
  writeFileSync(callsFile, "");
  const reattached = await consume(openCodexAppServer({
    bin: process.execPath, args: [fixture], cwd: root, prompt: "", sessionId: id,
    env: { CODEX_HOME: home, ASH_ARCHIVE_FIXTURE_CALLS: callsFile },
    reattach: { threadId: id, turnId: "turn", completedTurn: recovered.completedTurn },
  }));
  assert.deepEqual(calls().map((row) => row.method), ["thread/archive"]);
  assert.equal(reattached.filter((event) => event.kind === "done").length, 1);
  assert.equal(reattached.find((event) => event.kind === "done")?.exitStatus, 0);
  assert.ok(existsSync(archived));
  history.push({ method: "turn/started", params: { threadId: id, turn: { id: "next-turn" } } });
  history.push({ method: "turn/completed", params: { threadId: id, turn: { id: "turn", status: "completed" } } });
  writeFileSync(transcript, history.map((row) => JSON.stringify(row)).join("\n"));
  assert.equal(readCodexAppServerState(transcript, id).completedTurn, undefined);
  console.log("✓ 重启接管已完成回合只补归档，不重跑；忽略子线程和旧回合完成事件");

  const failedArchive = await consume(open("archive-fail", true));
  assert.equal(failedArchive.find((e) => e.kind === "done")?.exitStatus, 0);
  assert.ok(failedArchive.some((e) => e.kind === "system" && e.text.includes("自动归档未完成")));
  assert.ok(existsSync(active));
  console.log("✓ 归档失败保留执行成功与会话文件，并产生持久可见的系统提示");

  const started = Date.now();
  const timeout = await consume(open("archive-hang", true));
  assert.ok(Date.now() - started < 16_000, "归档超时不能永久卡住任务");
  assert.equal(timeout.find((e) => e.kind === "done")?.exitStatus, 0);
  assert.ok(timeout.some((e) => e.kind === "system" && e.text.includes("超时")));
  console.log("✓ 归档连接无响应时有界退出，保留成功状态");

  await archiveCodexThread({ bin: process.execPath, args: [fixture], cwd: root,
    env: { CODEX_HOME: home, ASH_ARCHIVE_FIXTURE_CALLS: callsFile } }, id);
  const nested = join(home, "archived_sessions", "2026", "09", "11", name);
  mkdirSync(join(home, "archived_sessions", "2026", "09", "11"), { recursive: true });
  renameSync(archived, nested);
  assert.equal(await findRollout(id, home), nested);
  assert.equal(rolloutExportPath(nested, home), `2026/09/11/${name}`);
  assert.equal(readFileSync(join(home, "config.toml"), "utf8"), "# Existing user configuration\n");
  assert.equal(readFileSync(join(home, "skills", "existing-skill", "SKILL.md"), "utf8"), "Existing user skill\n");
  assert.equal(readFileSync(join(home, "sessions", "2026", "09", "11", "rollout-2026-09-11T10-00-00-unrelated.jsonl"), "utf8"), "User's unrelated conversation\n");
  console.log("✓ 兼容归档日期子目录；配置、skills 和其他用户会话逐字节未变");
} finally {
  rmSync(root, { recursive: true, force: true });
}
