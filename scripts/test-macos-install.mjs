import assert from "node:assert/strict";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { stopIdleServers } from "../desktop/macos/scripts/stop-idle-server.mjs";
import { isPidAlive, localGet, sleep } from "./platform.mjs";
import { runTestProcess } from "./test-process.mjs";
import { spawnTestFixture } from "./test-process-scope.mjs";
import { withTestResources } from "./test-process-resources.mjs";

if (process.platform !== "darwin") {
  console.log("SKIP: macOS installer regression");
} else {
  const root = fileURLToPath(new URL("..", import.meta.url));
  const install = join(root, "desktop/macos/scripts/install-app.sh");
  const empty = { survives: [], resumes: [], interrupted: [], mcpDisrupted: [], shutdown: { version: 1, resources: [] } };

  async function scenario(options, operation) {
    const temporary = mkdtempSync(join(tmpdir(), "navi-install-idle-"));
    const fixtures = [];
    await withTestResources(async () => {
      const apps = join(temporary, "Apps [1]+ $x");
      const alias = join(temporary, "Applications-alias");
      const oldApp = join(apps, "Navi.app");
      const newApp = join(temporary, "build/Navi.app");
      const runtime = join(oldApp, "Contents/Resources/app");
      const data = join(temporary, "data");
      const ready = join(temporary, "ready.json");
      const config = join(temporary, "config.json");
      const requests = join(temporary, "requests.json");
      const opened = join(temporary, "opened.txt");
      const selfResult = join(temporary, "self-install.json");
      const selfOutput = join(temporary, "self-install.log");
      const grandchildReady = join(temporary, "grandchild.json");
      const mocks = join(temporary, "bin");
      mkdirSync(mocks);
      writeFileSync(join(mocks, "open"), '#!/bin/bash\nprintf "%s\\n" "$1" >> "$NAVI_TEST_OPEN_LOG"\n');
      chmodSync(join(mocks, "open"), 0o755);
      if (options.swapFails) {
        writeFileSync(join(mocks, "mv"), '#!/bin/bash\nif [[ "$1" == *".Navi.app.installing-"* ]]; then exit 9; fi\nexec /bin/mv "$@"\n');
        chmodSync(join(mocks, "mv"), 0o755);
      }
      for (const [app, version] of [[oldApp, "old"], [newApp, "new"]]) {
        mkdirSync(join(app, "Contents/Resources/app/shared/src"), { recursive: true });
        writeFileSync(join(app, "Contents/version"), version);
        if (version === "new" || !options.legacy) writeFileSync(join(app, "Contents/Resources/app/.in-use"), "");
      }
      mkdirSync(data);
      mkdirSync(join(runtime, "server/dist"), { recursive: true });
      copyFileSync(join(root, "shared/src/code-lock.ts"), join(runtime, "shared/src/code-lock.ts"));
      symlinkSync(apps, alias);
      writeFileSync(config, JSON.stringify({ impact: empty, ...options }));
      const entry = join(runtime, "server/dist/index.mjs");
      writeFileSync(entry, `
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { closeSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { holdCodeLock } from "../../shared/src/code-lock.ts";
const configPath = ${JSON.stringify(config)};
const dataDir = ${JSON.stringify(data)};
const codeDir = ${JSON.stringify(runtime)};
const overrides = JSON.parse(process.env.NAVI_INSTALL_FIXTURE_OPTIONS || "{}");
const initial = { ...JSON.parse(readFileSync(configPath, "utf8")), ...overrides };
if (!initial.legacy) holdCodeLock();
const dependents = [];
const terminalEntry = ${JSON.stringify(join(temporary, "terminal-child.mjs"))};
function startTerminal(kind) {
  writeFileSync(terminalEntry, kind === "nested"
    ? 'import { spawn } from "node:child_process"; import { writeFileSync } from "node:fs"; const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" }); writeFileSync(' + ${JSON.stringify(JSON.stringify(grandchildReady))} + ', JSON.stringify({ pid: child.pid })); setInterval(() => {}, 1000);'
    : 'setInterval(() => {}, 1000);');
  const child = spawn(process.execPath, [terminalEntry], { cwd: ${JSON.stringify(temporary)}, stdio: "ignore" });
  dependents.push(child);
  return child;
}
const terminal = initial.terminalChild ? startTerminal(initial.terminalChild) : null;
process.once("exit", () => { for (const child of dependents) { try { child.kill("SIGKILL"); } catch {} } });
if (initial.terminalChild || initial.selfInstall || initial.lateTerminal) process.on("SIGTERM", () => process.exit(0));
let healthReads = 0;
let impactReads = 0;
const server = createServer((req, res) => {
  const options = { ...JSON.parse(readFileSync(configPath, "utf8")), ...overrides };
  res.setHeader("content-type", "application/json");
  if (req.url === "/install-from-terminal" && initial.selfInstall) {
    const output = openSync(${JSON.stringify(selfOutput)}, "w");
    const child = spawn("/bin/bash", [${JSON.stringify(install)}, ${JSON.stringify(newApp)}, ${JSON.stringify(apps)}, "--open"], {
      cwd: ${JSON.stringify(root)}, stdio: ["ignore", output, output],
      env: { ...process.env, PATH: ${JSON.stringify(mocks)} + ":" + process.env.PATH,
        NAVI_TEST_OPEN_LOG: ${JSON.stringify(opened)}, NAVI_INSTALL_LOCKS: ${JSON.stringify(join(temporary, "install-locks"))} },
    });
    closeSync(output);
    dependents.push(child);
    child.once("exit", (code, signal) => writeFileSync(${JSON.stringify(selfResult)}, JSON.stringify({ code, signal })));
    res.end(JSON.stringify({ pid: child.pid }));
  } else if (req.url === "/api/health") {
    healthReads++;
    res.end(JSON.stringify({ ok: true, pid: options.wrongPid ? 1 : process.pid,
      instance: { id: options.changedIdentity && healthReads > 1 ? "changed" : "fixture",
        codeDir: options.foreignCode ? dataDir : codeDir, dataDir } }));
  } else if (req.url === "/api/restart-impact?shutdown=1") {
    impactReads++;
    if (options.lateTerminal && impactReads === 2) startTerminal("shell");
    writeFileSync(${JSON.stringify(requests)}, JSON.stringify({ healthReads, impactReads }));
    if (options.timeout) return;
    if (options.auth && req.headers["x-navi-host-token"] !== "fixture-token") res.statusCode = 401;
    else res.statusCode = options.status || 200;
    res.end(JSON.stringify(options.lateShutdown && impactReads > 1
      ? { ...options.impact, shutdown: { version: 1, resources: options.lateShutdown } }
      : options.becomesBusy && impactReads > 1
      ? { ...options.impact, survives: [{ id: "late", title: "late task", pid: process.pid }] }
      : options.impact));
  } else { res.statusCode = 404; res.end("{}"); }
});
if (initial.ignoreTerm) process.on("SIGTERM", () => {});
if (initial.delayedTerm) process.on("SIGTERM", () => setTimeout(() => process.exit(0), 300));
server.listen(0, "127.0.0.1", () => {
  const port = server.address().port;
  if (initial.auth) writeFileSync(dataDir + "/navi.db.navi.lock", JSON.stringify({ port, token: "fixture-token" }));
  writeFileSync(process.env.NAVI_INSTALL_FIXTURE_READY, JSON.stringify({ pid: process.pid, port, childPid: terminal?.pid }));
});
`);
      const waitReady = async (file) => {
        for (let attempt = 0; attempt < 100 && !existsSync(file); attempt++) await sleep(50);
        assert.ok(existsSync(file), "fixture must listen on its isolated ephemeral port");
        return JSON.parse(readFileSync(file, "utf8"));
      };
      const fixture = spawnTestFixture(process.execPath, [options.alias ? join(alias, "Navi.app/Contents/Resources/app/server/dist/index.mjs") : entry],
        { cwd: temporary, stdio: "ignore", env: { ...process.env, NAVI_INSTALL_FIXTURE_OPTIONS: "{}", NAVI_INSTALL_FIXTURE_READY: ready } });
      fixtures.push(fixture);
      const { pid, port, childPid } = await waitReady(ready);
      const runInstallFromServer = async () => {
        const response = await localGet(port, "/install-from-terminal", 2000);
        assert.equal(response.status, 200);
        for (let attempt = 0; attempt < 300 && !existsSync(selfResult); attempt++) await sleep(100);
        assert.ok(existsSync(selfResult), "the self-hosted installer must finish without killing itself or its server");
        assert.deepEqual(JSON.parse(readFileSync(selfResult, "utf8")), { code: 1, signal: null });
        return readFileSync(selfOutput, "utf8");
      };
      const startOtherServer = async (overrides = {}) => {
        const file = join(temporary, `ready-${fixtures.length}.json`);
        const child = spawnTestFixture(process.execPath, [entry], { cwd: temporary, stdio: "ignore",
          env: { ...process.env, NAVI_INSTALL_FIXTURE_OPTIONS: JSON.stringify(overrides), NAVI_INSTALL_FIXTURE_READY: file } });
        fixtures.push(child);
        return waitReady(file);
      };
      const startOtherUser = () => {
        const file = join(temporary, "other-user.mjs");
        writeFileSync(file, 'setInterval(() => {}, 1000);');
        const child = spawnTestFixture(process.execPath, [file], { cwd: runtime, stdio: "ignore" });
        fixtures.push(child);
        return child;
      };
      const installed = () => readFileSync(join(oldApp, "Contents/version"), "utf8");
      const runInstall = async (status) => {
        const result = await runTestProcess("/bin/bash", [install, newApp, options.alias ? alias : apps, ...(options.reopen ? ["--open"] : [])], {
          cwd: root, encoding: "utf8", timeout: 60_000,
          env: { ...process.env, PATH: `${mocks}:${process.env.PATH}`, NAVI_TEST_OPEN_LOG: opened,
            NAVI_INSTALL_LOCKS: join(temporary, "install-locks"),
            NAVI_DATA_DIR: join(temporary, "wrong-data"), NAVI_DB: join(temporary, "wrong.db"),
            HTTP_PROXY: "http://127.0.0.1:1", ALL_PROXY: "socks5://127.0.0.1:1" },
        }, status);
        return result.stdout + result.stderr;
      };
      const startMcp = () => {
        const mcp = join(runtime, "mcp/dist/index.mjs");
        mkdirSync(join(runtime, "mcp/dist"), { recursive: true });
        writeFileSync(mcp, 'import { holdCodeLock } from "../../shared/src/code-lock.ts"; holdCodeLock(); setInterval(() => {}, 1000);');
        const child = spawnTestFixture(process.execPath, [mcp], { cwd: temporary, stdio: "ignore" });
        fixtures.push(child);
        return child;
      };
      await operation({ pid, childPid, oldApp, data, runtime, temporary, runInstall, installed, startMcp, requests,
        opened, startOtherServer, startOtherUser, runInstallFromServer, grandchildReady, apps });
    }, [
      async () => { for (const fixture of fixtures) await fixture.dispose(); },
      () => rmSync(temporary, { recursive: true, force: true }),
    ]);
  }

  for (const options of [{}, { alias: true, auth: true }, { legacy: true }, { delayedTerm: true }]) {
    await scenario(options, async ({ pid, runInstall, installed, requests }) => {
      const output = await runInstall(0);
      assert.match(output, /停止空闲的 Navi 服务/);
      assert.equal(installed(), "new");
      assert.equal(isPidAlive(pid), false, output);
      assert.equal(JSON.parse(readFileSync(requests, "utf8")).impactReads, 2, "check again before signaling");
    });
  }
  console.log("✓ idle servers stop before swapping, including aliases, host credentials, legacy bundles and delayed shutdown");

  for (const group of ["survives", "resumes", "interrupted"]) {
    await scenario({ impact: { ...empty, [group]: [{ id: "busy", title: group, pid: 42 }] } }, async ({ pid, runInstall, installed }) => {
      const output = await runInstall(1);
      assert.match(output, /还有 1 个运行或排队中的任务/);
      assert.ok(isPidAlive(pid), output);
      assert.equal(installed(), "old");
    });
  }
  console.log("✓ all running and queued tasks block shutdown, including reattachable agents");

  for (const options of [{ status: 401 }, { impact: {} }, { impact: null }, { timeout: true }]) {
    await scenario(options, async ({ pid, runInstall, installed }) => {
      const output = await runInstall(1);
      assert.match(output, /任务状态无法确认/);
      assert.ok(isPidAlive(pid), output);
      assert.equal(installed(), "old");
    });
  }
  console.log("✓ refused, missing, malformed and timed-out task verdicts never become idle");

  for (const options of [{ foreignCode: true }, { wrongPid: true }, { changedIdentity: true }, { becomesBusy: true }]) {
    await scenario(options, async ({ pid, runInstall, installed }) => {
      await runInstall(1);
      assert.ok(isPidAlive(pid));
      assert.equal(installed(), "old");
    });
  }
  console.log("✓ mismatched service identity and work arriving during preparation preserve the old service and bundle");

  await scenario({ ignoreTerm: true }, async ({ pid, oldApp, installed }) => {
    await assert.rejects(stopIdleServers(oldApp, { say() {}, timeoutMs: 150 }), /没有强杀/);
    assert.ok(isPidAlive(pid));
    assert.equal(installed(), "old");
  });
  console.log("✓ a server that will not exit is not force-killed");

  await scenario({ reopen: true }, async ({ pid, oldApp, runInstall, installed, startMcp, opened }) => {
    const mcp = startMcp();
    await sleep(300);
    const output = await runInstall(1);
    assert.ok(isPidAlive(mcp.pid), output);
    assert.ok(isPidAlive(pid), "MCP refusal must preserve the previously running service");
    assert.match(output, /mcp\/dist\/index.mjs/);
    assert.doesNotMatch(output, /停止空闲的 Navi 服务/);
    assert.equal(installed(), "old");
    assert.equal(readFileSync(opened, "utf8").trim(), oldApp);
  });
  console.log("✓ active MCP holders prevent replacement without stopping the service; the old app is reopened");

  await scenario({}, async ({ pid, runInstall, installed, startOtherUser }) => {
    const user = startOtherUser();
    await sleep(300);
    const output = await runInstall(1);
    assert.ok(isPidAlive(pid));
    assert.ok(isPidAlive(user.pid));
    assert.doesNotMatch(output, /停止空闲的 Navi 服务/);
    assert.equal(installed(), "old");
  });

  for (const overrides of [
    { impact: { ...empty, survives: [{ id: "busy", title: "second service", pid: 42 }] } },
    { foreignCode: true },
    { becomesBusy: true },
    { changedIdentity: true },
  ]) {
    await scenario({}, async ({ pid, runInstall, installed, startOtherServer }) => {
      const other = await startOtherServer(overrides);
      const output = await runInstall(1);
      assert.ok(isPidAlive(pid), "a later blocking service must not stop the earlier idle one");
      assert.ok(isPidAlive(other.pid));
      assert.doesNotMatch(output, /停止空闲的 Navi 服务/);
      assert.equal(installed(), "old");
    });
  }
  console.log("✓ unrelated bundle users and later busy, unknown or changed services preserve every service");

  await scenario({ reopen: true }, async ({ pid, oldApp, runInstall, installed, startOtherServer, opened }) => {
    const other = await startOtherServer();
    await runInstall(0);
    assert.equal(isPidAlive(pid), false);
    assert.equal(isPidAlive(other.pid), false);
    assert.equal(installed(), "new");
    assert.equal(readFileSync(opened, "utf8").trim(), oldApp);
  });
  console.log("✓ all-idle services pass admission together, then the new app is opened");

  await scenario({ reopen: true, swapFails: true }, async ({ pid, oldApp, runInstall, installed, opened }) => {
    const output = await runInstall(9);
    assert.match(output, /空闲服务 .* 已退出/);
    assert.equal(isPidAlive(pid), false);
    assert.equal(installed(), "old", "failed swap must restore the old bundle");
    assert.equal(readFileSync(opened, "utf8").trim(), oldApp, "reopen the restored app even after shutdown and failed replacement");
  });
  console.log("✓ failed replacement after shutdown restores and reopens the old app, preserving the install failure status");

  for (const terminalChild of ["shell", "nested"]) {
    await scenario({ terminalChild, reopen: true }, async ({ pid, childPid, runInstall, installed, oldApp, opened, grandchildReady }) => {
      if (terminalChild === "nested") {
        for (let attempt = 0; attempt < 100 && !existsSync(grandchildReady); attempt++) await sleep(50);
        assert.ok(existsSync(grandchildReady));
      }
      const output = await runInstall(1);
      assert.match(output, /存活后代/);
      assert.doesNotMatch(output, /停止空闲的 Navi 服务/);
      assert.ok(isPidAlive(pid));
      assert.ok(isPidAlive(childPid));
      if (terminalChild === "nested") assert.ok(isPidAlive(JSON.parse(readFileSync(grandchildReady, "utf8")).pid));
      assert.equal(installed(), "old");
      assert.equal(readFileSync(opened, "utf8").trim(), oldApp);
    });
  }
  console.log("✓ terminal children and nested project processes prevent shutdown even with no running tasks");

  for (const overrides of [{ terminalChild: "shell" }, { lateTerminal: true }]) {
    await scenario({}, async ({ pid, runInstall, installed, startOtherServer }) => {
      const other = await startOtherServer(overrides);
      const output = await runInstall(1);
      assert.match(output, /存活后代/);
      assert.doesNotMatch(output, /停止空闲的 Navi 服务/);
      assert.ok(isPidAlive(pid), "a terminal owned by another service must preserve the entire group");
      assert.ok(isPidAlive(other.pid));
      assert.equal(installed(), "old");
    });
  }
  console.log("✓ existing and late-created terminals on a later service preserve all services");

  await scenario({ selfInstall: true }, async ({ pid, oldApp, runInstallFromServer, installed, opened, apps }) => {
    const output = await runInstallFromServer();
    assert.match(output, /请在 Navi 之外的终端里安装/);
    assert.doesNotMatch(output, /停止空闲的 Navi 服务/);
    assert.ok(isPidAlive(pid));
    assert.equal(installed(), "old");
    assert.equal(readFileSync(opened, "utf8").trim(), oldApp);
    assert.deepEqual(readdirSync(apps), ["Navi.app"], "a refused self-hosted install must leave no staging bundle");
  });
  console.log("✓ an installer descended from its target server refuses safely, cleans staging and reopens the old app");

  for (const shutdown of [undefined, null, {}, { version: 2, resources: [] }, { version: 1, resources: null },
    { version: 1, resources: [null] }, { version: 1, resources: [{ kind: "terminal" }] }]) {
    await scenario({ impact: { ...empty, shutdown } }, async ({ pid, runInstall, installed }) => {
      const output = await runInstall(1);
      assert.match(output, /无法提供完整的退出清场清单/);
      assert.doesNotMatch(output, /停止空闲的 Navi 服务/);
      assert.ok(isPidAlive(pid));
      assert.equal(installed(), "old");
    });
  }
  console.log("✓ missing, legacy and malformed shutdown censuses never authorize automatic shutdown");

  for (const kind of ["terminal", "terminal-start", "preview-trial", "chat"]) {
    const resource = { kind, id: "owned-resource", label: "后台开发服务", ports: [14999] };
    await scenario({ impact: { ...empty, shutdown: { version: 1, resources: [resource] } } }, async ({ pid, runInstall, installed }) => {
      const output = await runInstall(1);
      assert.match(output, /后台开发服务/);
      assert.match(output, /owned-resource/);
      assert.doesNotMatch(output, /停止空闲的 Navi 服务/);
      assert.ok(isPidAlive(pid));
      assert.equal(installed(), "old");
    });
  }
  console.log("✓ server-owned shutdown resources block installation even outside the process tree");

  const resources = [{ kind: "terminal", id: "daemon", label: "守护化项目服务" }];
  for (const overrides of [{ impact: { ...empty, shutdown: { version: 1, resources } } }, { lateShutdown: resources }]) {
    await scenario({}, async ({ pid, startOtherServer, runInstall, installed }) => {
      const other = await startOtherServer(overrides);
      const output = await runInstall(1);
      assert.match(output, /守护化项目服务/);
      assert.doesNotMatch(output, /停止空闲的 Navi 服务/);
      assert.ok(isPidAlive(pid));
      assert.ok(isPidAlive(other.pid));
      assert.equal(installed(), "old");
    });
  }
  console.log("✓ existing and late-arriving shutdown resources on a later service preserve the entire group");
}
