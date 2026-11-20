import assert from "node:assert/strict";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { stopIdleServers } from "../desktop/macos/scripts/stop-idle-server.mjs";
import { isPidAlive, sleep } from "./platform.mjs";
import { runTestProcess } from "./test-process.mjs";
import { spawnTestFixture } from "./test-process-scope.mjs";
import { withTestResources } from "./test-process-resources.mjs";

if (process.platform !== "darwin") {
  console.log("SKIP: macOS installer regression");
} else {
  const root = fileURLToPath(new URL("..", import.meta.url));
  const install = join(root, "desktop/macos/scripts/install-app.sh");
  const empty = { survives: [], resumes: [], interrupted: [], mcpDisrupted: [] };

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
import { readFileSync, writeFileSync } from "node:fs";
import { holdCodeLock } from "../../shared/src/code-lock.ts";
const configPath = ${JSON.stringify(config)};
const dataDir = ${JSON.stringify(data)};
const codeDir = ${JSON.stringify(runtime)};
const initial = JSON.parse(readFileSync(configPath, "utf8"));
if (!initial.legacy) holdCodeLock();
let healthReads = 0;
let impactReads = 0;
const server = createServer((req, res) => {
  const options = JSON.parse(readFileSync(configPath, "utf8"));
  res.setHeader("content-type", "application/json");
  if (req.url === "/api/health") {
    healthReads++;
    res.end(JSON.stringify({ ok: true, pid: options.wrongPid ? 1 : process.pid,
      instance: { id: options.changedIdentity && healthReads > 1 ? "changed" : "fixture",
        codeDir: options.foreignCode ? dataDir : codeDir, dataDir } }));
  } else if (req.url === "/api/restart-impact") {
    impactReads++;
    writeFileSync(${JSON.stringify(requests)}, JSON.stringify({ healthReads, impactReads }));
    if (options.timeout) return;
    if (options.auth && req.headers["x-navi-host-token"] !== "fixture-token") res.statusCode = 401;
    else res.statusCode = options.status || 200;
    res.end(JSON.stringify(options.becomesBusy && impactReads > 1
      ? { ...options.impact, survives: [{ id: "late", title: "late task", pid: process.pid }] }
      : options.impact));
  } else { res.statusCode = 404; res.end("{}"); }
});
if (initial.ignoreTerm) process.on("SIGTERM", () => {});
if (initial.delayedTerm) process.on("SIGTERM", () => setTimeout(() => process.exit(0), 300));
server.listen(0, "127.0.0.1", () => {
  const port = server.address().port;
  if (initial.auth) writeFileSync(dataDir + "/navi.db.navi.lock", JSON.stringify({ port, token: "fixture-token" }));
  writeFileSync(${JSON.stringify(ready)}, JSON.stringify({ pid: process.pid, port }));
});
`);
      const fixture = spawnTestFixture(process.execPath, [options.alias ? join(alias, "Navi.app/Contents/Resources/app/server/dist/index.mjs") : entry],
        { cwd: temporary, stdio: "ignore" });
      fixtures.push(fixture);
      for (let attempt = 0; attempt < 100 && !existsSync(ready); attempt++) await sleep(50);
      assert.ok(existsSync(ready), "fixture must listen on its isolated ephemeral port");
      const { pid } = JSON.parse(readFileSync(ready, "utf8"));
      const installed = () => readFileSync(join(oldApp, "Contents/version"), "utf8");
      const runInstall = async (status) => {
        const result = await runTestProcess("/bin/bash", [install, newApp, options.alias ? alias : apps], {
          cwd: root, encoding: "utf8", timeout: 60_000,
          env: { ...process.env, NAVI_INSTALL_LOCKS: join(temporary, "install-locks"),
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
      await operation({ pid, oldApp, data, runtime, temporary, runInstall, installed, startMcp, requests });
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

  await scenario({}, async ({ runInstall, installed, startMcp }) => {
    const mcp = startMcp();
    await sleep(300);
    const output = await runInstall(1);
    assert.ok(isPidAlive(mcp.pid), output);
    assert.match(output, /mcp\/dist\/index.mjs/);
    assert.equal(installed(), "old");
  });
  console.log("✓ active MCP holders are never killed and still prevent bundle replacement");
}
