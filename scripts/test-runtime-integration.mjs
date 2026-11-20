import assert from "node:assert/strict";
import { createHash, generateKeyPairSync } from "node:crypto";
import { createServer } from "node:http";
import { createServer as netServer } from "node:net";
import { once } from "node:events";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { Agent, fetch as directFetch } from "undici";
import { sealRuntime } from "../desktop/macos/scripts/runtime-store.mjs";
import { ensureSparkle } from "../desktop/macos/scripts/sparkle.mjs";
import { seedSource, agentSource, codexSource } from "./macos-runtime-fixture.mjs";
import { runTestProcess } from "./test-process.mjs";
import { spawnTestFixture } from "./test-process-scope.mjs";
import { withTestResources } from "./test-process-resources.mjs";
import { isPidAlive, sleep } from "./platform.mjs";
import { queryImpact, noVerdictReason } from "./server-control.mjs";
import { testRuntimeChannelTasks } from "./test-runtime-channel-tasks.mjs";
import { gatewayRequest } from "../server/dist/runtime-channel-gateway.js";

if (process.platform !== "darwin") {
  console.log("SKIP: macOS immutable runtime regression");
} else {
  const root = fileURLToPath(new URL("..", import.meta.url));
  const mac = join(root, "desktop/macos");
  const temporary = realpathSync(mkdtempSync(join(tmpdir(), "navi-runtime-live-")));
  const fixtures = [];
  const direct = new Agent();
  const fetch = (url, options) => directFetch(url, { ...options, dispatcher: direct });
  const servers = [];
  const environment = { ...process.env, HOME: join(temporary, "home"), NAVI_INSTALL_LOCKS: join(temporary, "locks") };
  for (const name of Object.keys(environment)) if (/^(ASH_|HARNESS_|NAVI_)/.test(name) && !["NAVI_INSTALL_LOCKS"].includes(name)) delete environment[name];
  const work = join(environment.HOME, "work");
  let data = join(temporary, "data");
  const applications = join(temporary, "Applications");
  const installed = join(applications, "Navi.app");
  const binary = join(temporary, "runtime-probe");
  let schema;
  mkdirSync(work, { recursive: true });
  mkdirSync(data);
  mkdirSync(join(environment.HOME, ".local/bin"), { recursive: true });
  function isolateAgents() {
    environment.PATH = `${environment.HOME}/.local/bin:/usr/bin:/bin:/usr/sbin:/sbin`;
    environment.NAVI_TEST_AGENT_BIN = join(environment.HOME, ".local/bin");
    environment.NAVI_RUNS_DIR = join(data, "runs");
    const shellEnv = Object.entries({ PATH: environment.PATH, NAVI_TEST_AGENT_BIN: environment.NAVI_TEST_AGENT_BIN,
      NAVI_RUNS_DIR: environment.NAVI_RUNS_DIR, FIXTURE_HOME: work }).map(([key, value]) => `export ${key}='${value}'`).join("\n") + "\n";
    for (const name of [".zshenv", ".zprofile", ".zshrc"]) writeFileSync(join(environment.HOME, name), shellEnv);
  }
  isolateAgents();
  const pathNode = join(environment.HOME, ".local/bin/node");
  writeFileSync(pathNode, `#!/bin/sh\nexec '${process.execPath}' "$@"\n`);
  chmodSync(pathNode, 0o755);

  const cli = join(environment.HOME, ".local/bin/claude");
  const cliScript = join(environment.HOME, "cli.mjs");
  writeFileSync(cli, `#!/bin/sh\nexec '${process.execPath}' '${cliScript}' "$@"\n`);
  chmodSync(cli, 0o755);
  const codex = join(environment.HOME, ".local/bin/codex");
  const codexScript = join(environment.HOME, "codex.mjs");
  writeFileSync(codex, `#!/bin/sh\nexec '${process.execPath}' '${codexScript}' "$@"\n`);
  chmodSync(codex, 0o755);
  writeFileSync(codexScript, `process.env.FIXTURE_HOME=${JSON.stringify(work)};\n` + codexSource);
  writeFileSync(cliScript, `import {appendFileSync,readFileSync} from 'node:fs'; import {dirname} from 'node:path';
appendFileSync(${JSON.stringify(join(work, "cli-invocations.jsonl"))},JSON.stringify({args:process.argv,task:process.env.NAVI_TASK_ID})+'\\n');
if(process.argv.includes('--version')){console.log('claude fixture 1');process.exit(0)}
if(process.argv.includes('--help')){console.log('--mcp-config --effort --settings');process.exit(0)}
const at=process.argv.lastIndexOf('--mcp-config');
if(at<0){console.log(JSON.stringify({type:'result',subtype:'success',result:'fixture probe'}));process.exit(0)}
const config=JSON.parse(readFileSync(process.argv[at+1],'utf8')).mcpServers.navi;
Object.assign(process.env,config.env);process.env.FIXTURE_ROOT=dirname(dirname(dirname(config.args[0])));
process.env.FIXTURE_TASK=process.env.NAVI_TASK_ID;process.env.FIXTURE_HOME=${JSON.stringify(work)};
await import(process.env.FIXTURE_ROOT+'/agent-fixture.mjs');`);

  async function waitFor(check, label, timeout = 30_000) {
    const deadline = Date.now() + timeout;
    let transient;
    while (Date.now() < deadline) {
      try { const value = await check(); if (value) return value; }
      catch (error) { if (![5, 6].includes(error.errcode)) throw error; transient = error; }
      await sleep(75);
    }
    const log = join(data, "logs/server.log");
    const diagnostics = transient ? [transient.message] : [];
    if (existsSync(join(data, "navi.db"))) {
      const connection = new DatabaseSync(join(data, "navi.db"), { timeout: 1000 });
      try {
        diagnostics.push(JSON.stringify(connection.prepare("select id,status,title from tasks").all()));
        for (const session of connection.prepare("select * from sessions order by started_at desc limit 3").all()) {
          diagnostics.push(JSON.stringify(session));
          for (const path of [session.agent_err_path, session.agent_out_path]) {
            if (path && existsSync(path)) diagnostics.push(`${path}\n${readFileSync(path, "utf8").slice(-4000)}`);
          }
        }
      } catch (error) { diagnostics.push(`DB diagnostic: ${error.message}`); }
      finally { connection.close(); }
    }
    const runs = join(data, "runs");
    if (existsSync(runs)) for (const name of readdirSync(runs, { recursive: true })) {
      if (/\.(err|md|stderr|out)$/.test(name)) diagnostics.push(`${name}\n${readFileSync(join(runs, name), "utf8").slice(-4000)}`);
    }
    const cliLog = join(work, "cli-invocations.jsonl");
    if (existsSync(cliLog)) diagnostics.push(readFileSync(cliLog, "utf8"));
    const sparkleLog = join(temporary, "sparkle.log");
    if (existsSync(sparkleLog)) diagnostics.push(readFileSync(sparkleLog, "utf8"));
    throw new Error(`等待超时：${label}\n${diagnostics.join("\n")}\n${existsSync(log) ? readFileSync(log, "utf8").slice(-6000) : ""}`);
  }
  async function port() {
    const listener = netServer();
    listener.listen(0, "127.0.0.1"); await once(listener, "listening");
    const value = listener.address().port;
    await new Promise((done) => listener.close(done));
    return value;
  }
  let base, windowPort;
  const envFor = (app, extra = {}) => ({ ...environment, NAVI_MAC_RUNTIME: join(app, "Contents/Resources/app"),
    NAVI_DATA_DIR: data, NAVI_URL: base, NAVI_MAC_WINDOW_PORT: String(windowPort), ...extra });
  const run = (command, args, options = {}, status = 0) => runTestProcess(command, args, { cwd: root, env: environment, encoding: "utf8", ...options }, status);
  async function probe(mode, app = installed, extra = {}, status = 0) {
    return run(binary, [mode], { env: envFor(app, extra), timeout: 90_000 }, status);
  }
  async function fixture(command, args, options = {}) {
    const child = spawnTestFixture(command, args, { cwd: root, env: environment, stdio: ["ignore", "pipe", "pipe"], ...options });
    fixtures.push(child);
    let output = "";
    child.stdout?.on("data", (chunk) => { output += chunk; });
    child.stderr?.on("data", (chunk) => { output += chunk; });
    child.output = () => output;
    return child;
  }
  async function finish(child, status = 0) {
    if (child.exitCode === null && child.signalCode === null) await once(child, "exit");
    assert.equal(child.exitCode, status, child.output());
    return child.output();
  }
  async function prepare(app) { return realpathSync((await probe("prepare", app)).stdout.match(/RUNTIME (.+)/)[1]); }
  async function health() {
    try { const result = await fetch(`${base}/api/health`); return result.ok ? await result.json() : null; } catch { return null; }
  }
  async function request(path, method = "GET", body, headers = {}) {
    const response = await fetch(`${base}/api${path}`, { method, headers: { "content-type": "application/json", ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, headers: response.headers, body: await response.json() };
  }
  function dbRead(sql, ...args) {
    const connection = new DatabaseSync(join(data, "navi.db"), { timeout: 5000 });
    try { return connection.prepare(sql).get(...args); } finally { connection.close(); }
  }
  function dbWrite(sql, ...args) {
    const connection = new DatabaseSync(join(data, "navi.db"), { timeout: 5000 });
    try { connection.prepare(sql).run(...args); } finally { connection.close(); }
  }
  async function seed(runtime, task = "continuous") {
    const child = await fixture(join(runtime, "node/bin/node"), [join(runtime, "seed-fixture.mjs")], {
      cwd: runtime, env: { ...environment, NAVI_DATA_DIR: data, FIXTURE_HOME: work, FIXTURE_TASK: task, FIXTURE_URL: base } });
    await finish(child);
    await waitFor(() => existsSync(join(work, task + "-agent.json")), "agent and MCP started");
    const seeded = JSON.parse(readFileSync(join(work, task + "-seed.json"), "utf8"));
    return { ...seeded, rootPid: seeded.pid,
      ...JSON.parse(readFileSync(join(work, task + "-agent.json"), "utf8")) };
  }
  async function launchTask(title, agentType = "claude", executorId) {
    const project = await request("/projects", "POST", { name: title, repoPath: work });
    assert.equal(project.status, 201, JSON.stringify(project));
    const created = await request("/tasks", "POST", { projectId: project.body.id, title, body: "fixture", agentType, executorId, useWorktree: false });
    assert.equal(created.status, 201, JSON.stringify(created));
    const started = await request(`/tasks/${created.body.id}/run`, "POST", {});
    assert.ok(started.status < 300, JSON.stringify(started));
    const file = join(work, created.body.id + "-agent.json");
    await waitFor(() => existsSync(file), "new task uses injected runtime");
    const session = await waitFor(() => {
      const value = dbRead("select id,agent_pid,agent_offset from sessions where task_id=? and ended_at is null", created.body.id);
      return value?.agent_offset > 0 && value;
    }, "new task output is consumed");
    return { id: created.body.id, sessionId: session.id, rootPid: session.agent_pid, ...JSON.parse(readFileSync(file, "utf8")) };
  }
  async function checkHooks(task) {
    const file = join(work, task.id + "-hooks.jsonl");
    const records = () => existsSync(file) ? readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)) : [];
    const before = records().length;
    await waitFor(() => records().length >= before + 2, "original Claude process receives Monitor decisions after service replacement");
    for (const record of records()) assert.deepEqual(record, { status: 200, decision: "deny" });
  }
  async function switchRuntime(app = installed, status = 0) {
    const child = await fixture(binary, ["switch"], { env: envFor(app) });
    try {
      const output = await finish(child, status);
      if (output.includes("START failed")) throw new Error(output);
      return output;
    }
    catch (error) {
      let diagnostic;
      try { diagnostic = `restart-impact: ${JSON.stringify((await request("/restart-impact")).body)}`; }
      catch (failure) { diagnostic = `restart-impact unavailable: ${failure.message}`; }
      throw new Error(`${error.message}\n${diagnostic}`, { cause: error });
    }
  }
  function manifest(runtime, epoch = schema) {
    sealRuntime(runtime);
  }
  async function copyApp(app, version, from = installed) {
    await run("ditto", [from, app]);
    const runtime = join(app, "Contents/Resources/app");
    writeFileSync(join(app, "Contents/Resources/fixture-version"), version);
    writeFileSync(join(runtime, "version.txt"), version);
    manifest(runtime);
    return app;
  }

  await withTestResources(async () => {
    base = `http://127.0.0.1:${await port()}`;
    windowPort = await port();
    const common = (await run("git", ["rev-parse", "--git-common-dir"])).stdout.trim();
    const mainRepo = dirname(realpathSync(common));
    const cache = join(mainRepo, "desktop/macos/build/cache");
    const sparkle = await ensureSparkle(cache);
    const sources = ["NaviConfig", "NaviHealth", "DatabaseBackup", "LegacyIdentity", "LoginService", "RestartImpact", "ServerControl", "ServerLauncher", "ServerStartLock", "UpdateGate", "Updater", "RuntimeRecovery", "BundleRuntimeUse"];
    await run("swiftc", ["-swift-version", "5", "-F", sparkle, "-framework", "Sparkle", "-Xlinker", "-rpath", "-Xlinker", sparkle,
      ...sources.map((name) => join(mac, `Sources/${name}.swift`)), join(mac, "Tests/RuntimeIntegration/main.swift"), "-o", binary]);
    const runtime = join(installed, "Contents/Resources/app");
    await run(process.execPath, [join(mac, "scripts/bundle-runtime.mjs"), join(installed, "Contents/Resources")], {
      env: { ...environment, NAVI_MAC_CACHE: cache, NAVI_MAC_SKIP_BUILD: "1" }, timeout: 240_000 });
    writeFileSync(join(runtime, "web/dist/index.html"), "<html>Navi isolated runtime probe</html>");
    writeFileSync(join(runtime, ".in-use"), "");
    writeFileSync(join(runtime, "seed-fixture.mjs"), seedSource);
    writeFileSync(join(runtime, "agent-fixture.mjs"), agentSource);
    writeFileSync(join(runtime, "version.txt"), "old");
    writeFileSync(join(installed, "Contents/Resources/fixture-version"), "old");
    copyFileSync(join(mac, "scripts/bundle-users.sh"), join(installed, "Contents/Resources/bundle-users.sh"));
    manifest(runtime);
    schema = JSON.parse(readFileSync(join(runtime, ".handover.json"), "utf8")).schema;
    const old = await prepare(installed);
    assert.ok(old.startsWith(join(data, ".mac-runtimes/")));
    assert.match((await probe("unfinalized-recovery")).stdout, /REFUSED online snapshot/);
    const malformedData = join(temporary, "malformed-journal-data");
    mkdirSync(malformedData);
    writeFileSync(join(malformedData, ".mac-runtime-recovery.json"), "{broken journal");
    const malformedPort = await port();
    const malformedServer = await fixture(join(old, "node/bin/node"), [join(old, "server/dist/index.js")], {
      env: { ...environment, NAVI_DATA_DIR: malformedData, NAVI_LOCAL_ONLY: "1", PORT: String(malformedPort) } });
    await waitFor(async () => {
      try { return (await fetch(`http://127.0.0.1:${malformedPort}/api/health`)).ok; } catch { return false; }
    }, "malformed recovery journal cannot brick a later server");
    assert.equal(readFileSync(join(malformedData, ".mac-runtime-recovery.json"), "utf8"), "{broken journal");
    malformedServer.kill("SIGTERM"); await once(malformedServer, "exit");
    const agent = await seed(old);
    const recovery = join(data, ".mac-runtime-recovery.json");
    writeFileSync(recovery, JSON.stringify({ previous: old, next: "/unrelated/runtime", adopting: true }));
    const server = await fixture(join(old, "node/bin/node"), [join(old, "server/dist/index.js")], {
      env: { ...environment, NAVI_DATA_DIR: data, NAVI_MAC_SOURCE_RUNTIME: runtime, NAVI_LOCAL_ONLY: "1", NAVI_DESKTOP_APP: "1", NAVI_WINDOW_PORT: String(windowPort), PORT: new URL(base).port } });
    await waitFor(async () => (await health())?.pid === server.pid, "initial real server");
    await probe("start");
    assert.ok(existsSync(recovery), "an unrelated journal is not consumed or rolled back");
    writeFileSync(recovery, JSON.stringify({ previous: old, next: old, adopting: true }));
    await probe("start");
    assert.equal(existsSync(recovery), false, "observing an already serving instance confirms adoption");
    await testRuntimeChannelTasks({ base, data, work, schema, launchTask, request, dbRead, dbWrite, health, waitFor });
    const claudeTask = await launchTask("claude-default-hook");
    const codexTask = await launchTask("codex-continuous", "codex");
    await waitFor(async () => (await request("/restart-impact")).body.runtimeHandover.blocked.length === 0,
      "Claude and Codex both advertise real handoff capability");
    const originalExecutor = dbRead("select executor from sessions where id=?", codexTask.sessionId).executor;
    dbWrite("insert into agents(id,name,type,model,reasoning_effort) values(?,?,?,?,?)",
      "invalid-runtime-profile", "invalid-runtime-profile", "codex", "gpt-5", "unsupported-fixture-effort");
    dbWrite("update sessions set executor=? where id=?", "invalid-runtime-profile", codexTask.sessionId);
    try {
      const invalid = await request("/restart-impact");
      assert.equal(invalid.status, 200, JSON.stringify(invalid.body));
      assert.ok(invalid.body.survives.some((task) => task.id === codexTask.id));
      assert.ok(invalid.body.runtimeHandover.blocked.some((task) => task.id === codexTask.id
        && /无法确认接管能力.*unsupported-fixture-effort/.test(task.reason)));
      assert.ok(invalid.body.runtimeHandover.sessions.includes("s-continuous"), "other tasks retain their own capability");
      const cliImpact = await queryImpact(Number(new URL(base).port), join(data, "navi.db.navi.lock"));
      assert.equal(noVerdictReason(cliImpact), null);
      assert.ok(cliImpact.mcpDisrupted.some((task) => task.id === codexTask.id), "CLI restart retains the MCP-disruption warning");
      const current = await health();
      const credentials = JSON.parse(readFileSync(join(data, "navi.db.navi.lock"), "utf8"));
      const rejected = await request("/runtime-handover", "POST", { protocol: 1, schema }, {
        "x-navi-host-token": credentials.token, "x-navi-instance": current.instance.id });
      assert.equal(rejected.status, 409);
      assert.match(rejected.body.error, /unsupported-fixture-effort/);
      assert.equal((await health()).pid, server.pid);
    } finally {
      dbWrite("update sessions set executor=? where id=?", originalExecutor, codexTask.sessionId);
      dbWrite("delete from agents where id=?", "invalid-runtime-profile");
    }
    const codexErrorFile = dbRead("select agent_err_path from sessions where id=?", codexTask.sessionId).agent_err_path;
    dbWrite("update sessions set agent_err_path=null where id=?", codexTask.sessionId);
    const unavailable = (await request("/restart-impact")).body.runtimeHandover.blocked;
    assert.ok(unavailable.some((item) => item.id === codexTask.id && /信息不完整/.test(item.reason)));
    dbWrite("update sessions set agent_err_path=? where id=?", codexErrorFile, codexTask.sessionId);
    writeFileSync(join(data, ".mac-server.json"), JSON.stringify({ pid: server.pid, bundleVersion: "old", confirmedAt: 0 }));
    const transcript = join(data, "runs/continuous/s-continuous.md");
    await waitFor(() => existsSync(transcript) && readFileSync(transcript, "utf8").includes("continuous-segment-"), "old output consumption");
    const before = dbRead("select agent_offset from sessions where id='s-continuous'").agent_offset;
    const orphan = await fixture(process.execPath, ["-e", `require('node:fs').openSync(${JSON.stringify(join(runtime, ".in-use"))},0x10);console.log('LOCKED');setInterval(()=>{},1000)`]);
    await waitFor(() => orphan.output().includes("LOCKED"), "legacy bundle holder");
    assert.match((await probe("sparkle-relaunch", installed, {}, 2)).stdout, /REFUSED/);
    assert.equal((await health()).pid, server.pid);
    orphan.kill("SIGTERM");
    await once(orphan, "exit");
    const pretender = await fixture(process.execPath, ["-e", "console.log('FORGED');setInterval(()=>{},1000)",
      join(installed, "Contents/Frameworks/Sparkle.framework/Versions/Current/Autoupdate")]);
    await waitFor(() => pretender.output().includes("FORGED"), "forged installer argument");
    assert.match((await probe("sparkle-relaunch", installed, {}, 2)).stdout, /REFUSED/);
    pretender.kill("SIGTERM");
    await once(pretender, "exit");
    for (const mode of ["sparkle-relaunch", "sparkle-quit", "sparkle-abort"]) {
      const result = await probe(mode);
      assert.match(result.stdout, /PROCEED/);
      assert.equal((await health()).pid, server.pid);
      if (mode === "sparkle-abort") assert.match(result.stdout, /ABORT idle none/);
    }
    console.log("✓ real Sparkle delegate entrypoints leave the old immutable service and MCP alive; abort releases the gate");

    const nextApp = await copyApp(join(temporary, "next/Navi.app"), "next");
    await run("/bin/bash", [join(mac, "scripts/install-app.sh"), nextApp, applications]);
    assert.equal((await health()).pid, server.pid);
    assert.equal(readFileSync(join(old, "version.txt"), "utf8"), "old");
    const next = await prepare(installed);
    assert.notEqual(next, old);
    const firstHealth = await health();
    const firstLock = JSON.parse(readFileSync(join(data, "navi.db.navi.lock"), "utf8"));
    assert.equal((await request("/runtime-handover", "POST", { protocol: 1, schema: "incompatible" }, {
      "x-navi-host-token": firstLock.token, "x-navi-instance": firstHealth.instance.id })).status, 409);
    assert.equal((await health()).pid, server.pid);
    const output = await switchRuntime();
    assert.match(output, /START ready/);
    const newHealth = await health();
    assert.notEqual(newHealth.pid, server.pid);
    assert.equal(realpathSync(newHealth.instance.codeDir), next);
    assert.ok(isPidAlive(agent.rootPid) && isPidAlive(agent.pid) && isPidAlive(agent.mcp));
    assert.ok(isPidAlive(codexTask.rootPid) && isPidAlive(codexTask.pid) && isPidAlive(codexTask.mcp));
    assert.ok(isPidAlive(claudeTask.rootPid) && isPidAlive(claudeTask.pid) && isPidAlive(claudeTask.mcp));
    await checkHooks(claudeTask);
    await probe("collect");
    assert.ok(existsSync(old), "agent/MCP leases retain all old files");
    await waitFor(() => dbRead("select agent_offset from sessions where id='s-continuous'").agent_offset > before, "new consumer advances old offset");
    writeFileSync(join(work, "continuous-finish"), "");
    await waitFor(() => dbRead("select status from tasks where id='continuous'").status === "done", "old MCP submission and settlement");
    writeFileSync(join(work, codexTask.id + "-finish"), "");
    await waitFor(() => dbRead("select status from tasks where id=?", codexTask.id).status === "done", "Codex App Server reattaches and submits through its old MCP");
    writeFileSync(join(work, claudeTask.id + "-finish"), "");
    await waitFor(() => dbRead("select status from tasks where id=?", claudeTask.id).status === "done", "Claude with default HTTP hook completes through its original MCP after manual install");
    const codexTranscript = readFileSync(join(data, "runs", codexTask.id, codexTask.sessionId + ".md"), "utf8");
    const codexSegments = [...codexTranscript.matchAll(new RegExp(codexTask.id + "-segment-(\\d+)", "g"))].map((item) => Number(item[1]));
    assert.ok(codexSegments.length > 3);
    assert.deepEqual(codexSegments, Array.from({ length: codexSegments.length }, (_, index) => index + 1));
    assert.ok(JSON.parse(readFileSync(join(work, "continuous-mcp.json"), "utf8")).result.isError !== true);
    const segments = [...readFileSync(transcript, "utf8").matchAll(/continuous-segment-(\d+)/g)].map((match) => Number(match[1]));
    assert.deepEqual(segments, [...new Set(segments)]);
    assert.deepEqual(segments, Array.from({ length: segments.length }, (_, index) => index + 1));
    assert.ok(segments.length > 3);
    console.log("✓ manual install swaps the app while the same agent/MCP survive; offsets, transcript and strict completion continue");

    const created = await launchTask("new-version-task");
    assert.equal(created.root, next);
    writeFileSync(join(work, created.id + "-finish"), "");
    await waitFor(() => dbRead("select status from tasks where id=?", created.id).status === "done", "new task done");
    await waitFor(() => !isPidAlive(agent.pid) && !isPidAlive(agent.mcp), "old agent and MCP exit");
    await probe("collect");
    assert.equal(existsSync(old), false, "unused runtime reclaimed only after old holders exit");
    console.log("✓ newly started tasks use the new MCP/runtime, and the old runtime is reclaimed after its last user exits");

    const impactHealth = await health();
    const lock = JSON.parse(readFileSync(join(data, "navi.db.navi.lock"), "utf8"));
    const headers = { "x-navi-host-token": lock.token, "x-navi-instance": impactHealth.instance.id };
    assert.equal((await request("/runtime-handover", "POST", { protocol: 1, schema }, {})).status, 403);
    dbWrite("update tasks set status='queued' where id=?", created.id);
    const blockedImpact = (await request("/restart-impact")).body;
    assert.ok(blockedImpact.runtimeHandover.blocked.some((task) => task.id === created.id));
    assert.equal((await request("/runtime-handover", "POST", { protocol: 1, schema }, headers)).status, 409);
    dbWrite("update tasks set status='done' where id=?", created.id);
    const acquired = await request("/runtime-handover", "POST", { protocol: 1, schema }, headers);
    assert.equal(acquired.status, 200);
    const refused = await request("/projects", "POST", { name: "never-created", repoPath: work });
    assert.equal(refused.status, 503);
    assert.equal(refused.headers.get("x-navi-undelivered"), "runtime-handoff-v1");
    assert.equal((await request("/runtime-handover", "POST", { release: acquired.body.lease }, headers)).status, 200);
    assert.equal(dbRead("select count(*) as total from projects where name='never-created'").total, 0);
    console.log("✓ identity/authentication, queued-work refusal and definite-undelivered drain responses are enforced by the real server");

    const broken = await copyApp(join(temporary, "broken/Navi.app"), "broken");
    const brokenRoot = join(broken, "Contents/Resources/app");
    writeFileSync(join(brokenRoot, "server/dist/main.js"), `import {DatabaseSync} from 'node:sqlite'; import {writeFileSync} from 'node:fs'; import {DATA_DIR} from './paths.js'; const db=new DatabaseSync(DATA_DIR+'/navi.db'); db.exec('CREATE TABLE partial_migration(value TEXT)'); db.close(); writeFileSync(DATA_DIR+'/fixture-migration-ran', 'partial_migration'); throw new Error('fixture migration failed');`);
    manifest(brokenRoot);
    const rollback = await switchRuntime(broken);
    assert.match(rollback, /START ready/);
    assert.equal(readFileSync(join(data, "fixture-migration-ran"), "utf8"), "partial_migration");
    assert.equal(realpathSync((await health()).instance.codeDir), next);
    assert.equal(dbRead("select count(*) as total from sqlite_master where name='partial_migration'").total, 0);
    assert.ok(readdirSync(join(data, "backups")).some((name) => name.endsWith(".db")));
    console.log("✓ a real failed migration restores the pinned database snapshot and restarts the previous immutable runtime");

    const poisoned = await copyApp(join(temporary, "poisoned/Navi.app"), "poisoned");
    writeFileSync(join(poisoned, "Contents/Resources/app/version.txt"), "changed after signing");
    assert.match((await probe("prepare", poisoned, {}, 1)).stdout, /校验失败/);
    assert.equal(realpathSync((await health()).instance.codeDir), next);
    console.log("✓ tampered/partial runtime publication is rejected without disturbing the active service");

    await runSparkle(sparkle, sources);
  }, [
    async () => {
      for (const name of ["data", "malformed-journal-data", "legacy-data"]) {
        const digest = createHash("sha256").update(join(temporary, name)).digest("hex").slice(0, 24);
        const socket = join(tmpdir(), `navi-channel-${process.getuid()}-${digest}.sock`);
        if (!existsSync(socket)) continue;
        try {
          const state = await gatewayRequest(socket, "/status");
          await waitFor(async () => {
            try { await gatewayRequest(socket, "/retire", { owner: state.owner }); return true; }
            catch (error) { if (error.message.includes("409")) return false; throw error; }
          }, "independent channel gateway retires through its own control socket");
          await waitFor(() => !existsSync(socket), "gateway closes its control socket before fixture cleanup");
        } catch (error) { if (!["ECONNREFUSED", "ENOENT"].includes(error.code)) throw error; }
      }
    },
    async () => { for (const child of fixtures) await child.dispose(); },
    () => direct.destroy(),
    async () => { for (const server of servers) await new Promise((done) => server.close(done)); },
    () => {
      for (const name of ["data", "malformed-journal-data", "legacy-data"]) {
        const digest = createHash("sha256").update(join(temporary, name)).digest("hex").slice(0, 24);
        try { unlinkSync(join(tmpdir(), `navi-channel-${process.getuid()}-${digest}.sock`)); }
        catch (error) { if (error.code !== "ENOENT") throw error; }
      }
    },
    () => rmSync(temporary, { recursive: true, force: true }),
  ]);

  async function runSparkle(sparkle, sources) {
    const { privateKey } = generateKeyPairSync("ed25519");
    const jwk = privateKey.export({ format: "jwk" });
    const keyFile = join(temporary, "signing.key");
    writeFileSync(keyFile, Buffer.from(jwk.d, "base64url").toString("base64"));
    const publicKey = Buffer.from(jwk.x, "base64url").toString("base64");
    const log = join(temporary, "sparkle.log");
    const feed = join(temporary, "feed");
    mkdirSync(feed);
    const http = createServer((request, response) => {
      const name = new URL(request.url, "http://local").pathname;
      if (!["/appcast.xml", "/update.zip"].includes(name)) { response.writeHead(404); response.end(); return; }
      response.end(readFileSync(join(feed, name.slice(1))));
    });
    servers.push(http);
    http.listen(0, "127.0.0.1"); await once(http, "listening");
    const url = `http://127.0.0.1:${http.address().port}`;
    const bundleID = `dev.navi.runtime-probe.${process.pid}`;
    const main = join(temporary, "sparkle-source/main.swift");
    mkdirSync(dirname(main));
    let source = readFileSync(join(mac, "Tests/SparkleDmg/main.swift"), "utf8");
    source = source.replace('let version = info["CFBundleVersion"] as? String ?? "?"', `let version = info["CFBundleVersion"] as? String ?? "?"
setenv("NAVI_DATA_DIR", ${JSON.stringify(data)}, 1)
setenv("NAVI_URL", ${JSON.stringify(base)}, 1)
setenv("NAVI_MAC_WINDOW_PORT", ${JSON.stringify(String(windowPort))}, 1)
UpdateGate.shared.ask = { _ in emit("UNEXPECTED-PROMPT"); return .cancel }
UpdateGate.shared.report = { emit("GATE-ERROR \\($0)") }`);
    source = source.replace('guard info["ProbeCheck"] as? Bool == true else { exit(0) }', `guard info["ProbeCheck"] as? Bool == true else {
  do { try RuntimeStore.prepare() } catch { emit("PREPARE-FAILED \\(error)"); exit(1) }
  var switched = false
  UpdateGate.shared.request(.staleServer(from: "old")) { switched = true }
  let deadline = Date().addingTimeInterval(30)
  while !switched && Date() < deadline { RunLoop.main.run(until: Date().addingTimeInterval(0.02)) }
  guard switched else { emit("SWITCH-FAILED"); exit(1) }
  emit("NEW-SERVER \\(ServerLauncher.shared.ensureRunningSync(timeout: 25))")
  exit(0)
}`);
    source = source.replace("userDriver: driver, delegate: nil", "userDriver: driver, delegate: AppUpdater.shared");
    writeFileSync(main, source);
    const appBinary = join(temporary, "sparkle-host");
    await run("swiftc", ["-swift-version", "5", "-F", sparkle, "-framework", "Sparkle", "-Xlinker", "-rpath", "-Xlinker", "@executable_path/../Frameworks",
      ...sources.map((name) => join(mac, `Sources/${name}.swift`)), main, "-o", appBinary]);
    const sparkleInstalled = await copyApp(join(temporary, "Sparkle/Navi.app"), "sparkle-old");
    const sparkleNext = await copyApp(join(temporary, "SparkleNew/Navi.app"), "sparkle-next");
    for (const [app, version] of [[sparkleInstalled, "1"], [sparkleNext, "2"]]) {
      mkdirSync(join(app, "Contents/MacOS"), { recursive: true });
      copyFileSync(appBinary, join(app, "Contents/MacOS/Navi"));
      await run("ditto", [join(sparkle, "Sparkle.framework"), join(app, "Contents/Frameworks/Sparkle.framework")]);
      writeFileSync(join(app, "Contents/Info.plist"), `<?xml version="1.0"?><plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>${bundleID}</string><key>CFBundleExecutable</key><string>Navi</string>
<key>CFBundlePackageType</key><string>APPL</string><key>CFBundleVersion</key><string>${version}</string>
<key>CFBundleShortVersionString</key><string>${version}</string><key>LSUIElement</key><true/>
<key>SUFeedURL</key><string>${url}/appcast.xml</string><key>SUPublicEDKey</key><string>${publicKey}</string>
<key>SUEnableAutomaticChecks</key><false/><key>SUVerifyUpdateBeforeExtraction</key><true/>
<key>SURequireSignedFeed</key><true/>
<key>NSAppTransportSecurity</key><dict><key>NSAllowsLocalNetworking</key><true/></dict>
<key>ProbeLog</key><string>${log}</string>${version === "1" ? "<key>ProbeCheck</key><true/>" : ""}</dict></plist>`);
      await run("codesign", ["--force", "--sign", "-", app]);
      await run("codesign", ["--verify", "--deep", "--strict", app]);
    }
    const archive = join(feed, "update.zip");
    await run("ditto", ["-c", "-k", "--sequesterRsrc", "--keepParent", sparkleNext, archive]);
    const signed = await run(join(sparkle, "bin/sign_update"), ["--ed-key-file", keyFile, archive]);
    writeFileSync(join(feed, "appcast.xml"), `<?xml version="1.0"?><rss version="2.0" xmlns:sparkle="http://www.andymatuschak.org/xml-namespaces/sparkle"><channel><title>Isolated Navi runtime</title><item><title>2</title><sparkle:version>2</sparkle:version><enclosure url="${url}/update.zip" ${signed.stdout.trim()} type="application/octet-stream"/></item></channel></rss>`);
    await run(join(sparkle, "bin/sign_update"), ["--ed-key-file", keyFile, join(feed, "appcast.xml")]);
    const oldHealth = await health();
    await switchRuntime(sparkleInstalled);
    const continuous = await launchTask("sparkle-continuous", "claude");
    const before = await health();
    await fixture(join(sparkleInstalled, "Contents/MacOS/Navi"), [], { env: environment });
    await waitFor(() => existsSync(log) && /NEW-SERVER ready/.test(readFileSync(log, "utf8")), "real signed Sparkle swap and relaunch", 180_000);
    const lines = readFileSync(log, "utf8");
    assert.doesNotMatch(lines, /ERROR|FAILED|UNEXPECTED-PROMPT/);
    assert.notEqual((await health()).pid, before.pid);
    assert.ok(isPidAlive(continuous.rootPid) && isPidAlive(continuous.pid) && isPidAlive(continuous.mcp));
    await checkHooks(continuous);
    writeFileSync(join(work, continuous.id + "-finish"), "");
    await waitFor(() => dbRead("select status from tasks where id=?", continuous.id).status === "done", "completion after actual Sparkle relaunch");
    const transcript = readFileSync(join(data, "runs", continuous.id, continuous.sessionId + ".md"), "utf8");
    const segments = [...transcript.matchAll(new RegExp(continuous.id + "-segment-(\\d+)", "g"))].map((match) => Number(match[1]));
    assert.ok(segments.length > 3);
    assert.deepEqual(segments, Array.from({ length: segments.length }, (_, index) => index + 1));
    assert.notEqual(oldHealth.pid, (await health()).pid);
    console.log("✓ actual EdDSA-signed Sparkle download, bundle replacement and relaunch preserve the same agent/MCP through server takeover");
  }
}
