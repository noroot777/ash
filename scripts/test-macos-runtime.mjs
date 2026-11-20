import assert from "node:assert/strict";
import { constants, copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { sealRuntime, installRuntime, verifyRuntime } from "../desktop/macos/scripts/runtime-store.mjs";
import { runTestProcess } from "./test-process.mjs";
import { spawnTestFixture } from "./test-process-scope.mjs";
import { withTestResources } from "./test-process-resources.mjs";

if (process.platform !== "darwin") {
  console.log("SKIP: macOS immutable runtime regression");
} else {
  const root = fileURLToPath(new URL("..", import.meta.url));
  const temporary = mkdtempSync(join(tmpdir(), "navi-macos-runtime-"));
  const fixtures = [];
  await withTestResources(async () => {
    const data = join(temporary, "data");
    const store = join(data, ".mac-runtimes");
    const app = join(temporary, "Applications/Navi.app");
    const payload = join(app, "Contents/Resources/app");
    const next = join(temporary, "build/Navi.app");
    const nextPayload = join(next, "Contents/Resources/app");
    const runtimeTool = join(root, "desktop/macos/scripts/runtime-store.mjs");
    const binary = join(temporary, "runtime-driver");
    const ready = join(temporary, "ready.json");
    const activity = join(temporary, "activity");
    const requests = join(temporary, "requests");
    const options = join(temporary, "options.json");
    mkdirSync(data, { recursive: true });
    function makePayload(directory, version) {
      for (const relative of ["node/bin", "scripts", "server/dist", "mcp/dist"]) mkdirSync(join(directory, relative), { recursive: true });
      copyFileSync(process.execPath, join(directory, "node/bin/node"), constants.COPYFILE_FICLONE);
      const libraries = join(dirname(process.execPath), "../lib");
      if (existsSync(libraries)) {
        for (const name of readdirSync(libraries).filter((entry) => /^libnode.*\.dylib$/.test(entry))) {
          mkdirSync(join(directory, "node/lib"), { recursive: true });
          copyFileSync(join(libraries, name), join(directory, "node/lib", name), constants.COPYFILE_FICLONE);
        }
      }
      copyFileSync(runtimeTool, join(directory, "scripts/runtime-store.mjs"));
      writeFileSync(join(directory, ".in-use"), "");
      writeFileSync(join(directory, "version"), version);
      writeFileSync(join(directory, "mcp/dist/index.js"), `setInterval(() => {}, 1000);`);
      writeFileSync(join(directory, "server/dist/index.js"), `
const http = require('node:http'); const fs = require('node:fs');
const codeDir = fs.realpathSync(__dirname + '/../..');
const settings = () => JSON.parse(fs.readFileSync(${JSON.stringify(options)}, 'utf8'));
http.createServer((req, res) => {
  res.setHeader('content-type', 'application/json');
  if (req.url === '/api/health') return res.end(JSON.stringify({ ok: true, pid: process.pid,
    instance: { id: 'runtime-fixture', codeDir, dataDir: ${JSON.stringify(data)}, desktop: true, windowPort: 45555 } }));
  if (req.url === '/api/restart-impact') return res.end(JSON.stringify(settings().impact));
  if (req.url === '/api/runtime-handover') {
    if (req.headers['x-navi-host-token'] !== 'fixture-token' || req.headers['x-navi-instance'] !== 'runtime-fixture') {
      res.statusCode = 403; return res.end('{}');
    }
    let body = ''; req.on('data', chunk => body += chunk); req.on('end', () => {
      const request = JSON.parse(body); fs.appendFileSync(${JSON.stringify(requests)}, body + '\\n');
      const opts = settings();
      if (!request.check && !request.release && opts.rejectLease) { res.statusCode = 409; return res.end('{}'); }
      res.end(JSON.stringify(request.check ? { valid: !opts.expired } : request.release ? { released: true } : { lease: 'lease' }));
    }); return;
  }
  res.statusCode = 404; res.end('{}');
}).listen(0, '127.0.0.1', function () {
  fs.writeFileSync(${JSON.stringify(ready)}, JSON.stringify({ pid: process.pid, port: this.address().port }));
});
setInterval(() => fs.writeFileSync(${JSON.stringify(activity)}, fs.readFileSync(codeDir + '/version')), 30);
`);
      return sealRuntime(directory);
    }
    const oldManifest = makePayload(payload, "old");
    const oldRuntime = installRuntime(payload, store);
    assert.equal(installRuntime(payload, store), oldRuntime);
    makePayload(nextPayload, "new");
    const newRuntime = installRuntime(nextPayload, store);
    assert.notEqual(newRuntime, oldRuntime);
    assert.equal(readFileSync(join(oldRuntime, "version"), "utf8"), "old");
    assert.equal(readdirSync(store).some((name) => name.startsWith(".installing-")), false);
    console.log("✓ 内容寻址、幂等发布、新旧运行时并存与暂存清理");

    const bad = join(temporary, "bad");
    cpSync(nextPayload, bad, { recursive: true, verbatimSymlinks: true });
    writeFileSync(join(bad, "version"), "tampered");
    assert.throws(() => installRuntime(bad, store), /校验失败/);
    const escaped = join(temporary, "escaped");
    mkdirSync(escaped);
    symlinkSync("/tmp", join(escaped, "outside"));
    assert.throws(() => sealRuntime(escaped), /链接越界/);
    assert.equal(verifyRuntime(oldRuntime).id, oldManifest.id);
    console.log("✓ 损坏内容与越界链接拒绝发布，旧运行时不受影响");

    const mac = join(root, "desktop/macos");
    await runTestProcess("swiftc", ["-swift-version", "5",
      ...["NaviConfig", "NaviHealth", "DataImport", "DatabaseBackup", "LegacyIdentity", "LoginService", "RestartImpact", "ServerControl", "ServerLauncher", "ServerStartLock", "UpdateGate"]
        .map((name) => join(mac, `Sources/${name}.swift`)),
      join(mac, "Tests/Runtime/main.swift"), "-o", binary], { cwd: root, encoding: "utf8", timeout: 120_000 });
    const baseEnv = Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^(NAVI|ASH|HARNESS)_/.test(name)));
    const env = { ...baseEnv, NAVI_MAC_RUNTIME: nextPayload, NAVI_DATA_DIR: data, NAVI_MAC_WINDOW_PORT: "45555" };
    const drive = async (mode, extra = {}) => (await runTestProcess(binary, [mode], {
      cwd: root, encoding: "utf8", timeout: 20_000, env: { ...env, ...extra },
    })).stdout;
    assert.equal(realpathSync((await drive("prepare")).trim().slice("READY ".length)), newRuntime);
    assert.match(await drive("abort"), /PROCEED[\s\S]*ABANDONED true/);
    console.log("✓ Swift 启动路径使用独立版本，Sparkle 安装及中止不停止旧服务");

    const empty = { survives: [], resumes: [], interrupted: [], mcpDisrupted: [] };
    const survivor = { id: "single", title: "still working", pid: process.pid };
    const setOptions = (value) => writeFileSync(options, JSON.stringify({ impact: { ...empty, survives: [survivor], mcpDisrupted: [survivor] }, ...value }));
    const waitFor = async (predicate) => {
      for (let attempt = 0; attempt < 200; attempt++) {
        if (predicate()) return;
        await new Promise((done) => setTimeout(done, 25));
      }
      assert.fail("fixture did not become ready");
    };
    const start = async () => {
      rmSync(ready, { force: true });
      const fixture = spawnTestFixture(join(oldRuntime, "node/bin/node"), [join(oldRuntime, "server/dist/index.js")], { cwd: data, stdio: "ignore" });
      fixtures.push(fixture);
      await waitFor(() => existsSync(ready));
      const identity = JSON.parse(readFileSync(ready, "utf8"));
      writeFileSync(join(data, "navi.db.navi.lock"), JSON.stringify({ ...identity, token: "fixture-token" }));
      return identity;
    };
    setOptions({});
    let service = await start();
    const mcp = spawnTestFixture(join(oldRuntime, "node/bin/node"), [join(oldRuntime, "mcp/dist/index.js")], { cwd: data, stdio: "ignore" });
    fixtures.push(mcp);
    await runTestProcess("/bin/bash", [join(mac, "scripts/install-app.sh"), next, join(temporary, "Applications")], {
      cwd: root, encoding: "utf8", timeout: 60_000,
    });
    await waitFor(() => existsSync(activity) && readFileSync(activity, "utf8") === "old");
    process.kill(service.pid, 0);
    process.kill(mcp.pid, 0);
    assert.equal(readFileSync(join(payload, "version"), "utf8"), "new");
    console.log("✓ 真实安装器在服务和 MCP 运行中换 app，旧进程持续读取旧版本");

    const url = () => ({ NAVI_URL: `http://127.0.0.1:${service.port}`, NAVI_MAC_RUNTIME: payload });
    setOptions({ impact: { ...empty, resumes: [{ id: "team", title: "active team" }] } });
    assert.match(await drive("update", url()), /PROCEED/);
    process.kill(service.pid, 0);
    assert.match(await drive("stale", url()), /WAITING 切换新版服务/);
    process.kill(service.pid, 0);
    console.log("✓ 团队回合不阻止 Sparkle 换 app，服务接管延后且不弹强制中断选项");

    const lockReady = join(temporary, "legacy-ready");
    const legacy = spawnTestFixture(process.execPath, ["-e", `
      const fs = require('node:fs');
      fs.openSync(${JSON.stringify(join(payload, ".in-use"))}, fs.constants.O_RDONLY | 0x10);
      fs.writeFileSync(${JSON.stringify(lockReady)}, 'ready'); setInterval(() => {}, 1000);
    `], { cwd: data, stdio: "ignore" });
    fixtures.push(legacy);
    await waitFor(() => existsSync(lockReady));
    assert.match(await drive("update", url()), /FAILED[\s\S]*首次迁移/);
    process.kill(service.pid, 0);
    await legacy.dispose();
    console.log("✓ 首次迁移仍有旧布局 MCP 持锁时拒绝换包，不误停外置服务");

    setOptions({ rejectLease: true });
    assert.match(await drive("stale", url()), /WAITING/);
    process.kill(service.pid, 0);
    setOptions({ expired: true });
    assert.match(await drive("stale", url()), /WAITING/);
    process.kill(service.pid, 0);
    console.log("✓ 接管被拒或许可过期时旧服务继续运行");

    const database = new DatabaseSync(join(data, "navi.db"));
    database.exec("CREATE TABLE fixture(value TEXT); INSERT INTO fixture VALUES ('before migration')");
    database.close();
    writeFileSync(join(data, "backups"), "cannot create backups directory");
    setOptions({});
    assert.match(await drive("stale", url()), /FAILED[\s\S]*旧服务未停止/);
    process.kill(service.pid, 0);
    rmSync(join(data, "backups"));
    console.log("✓ 备份失败不停止旧服务，也不开始迁移");

    setOptions({});
    assert.match(await drive("stale", url()), /PROCEED/);
    await waitFor(() => { try { process.kill(service.pid, 0); return false; } catch { return true; } });
    process.kill(mcp.pid, 0);
    assert.ok(readdirSync(join(data, "backups")).some((name) => name.endsWith(".db")));
    assert.match(readFileSync(requests, "utf8"), /"check":"lease"/);
    assert.equal(readFileSync(join(oldRuntime, "version"), "utf8"), "old");
    console.log("✓ detached/MCP 回合取得许可后服务下线，旧 MCP 与旧运行时保留");
  }, [
    async () => { for (const fixture of fixtures) await fixture.dispose(); },
    () => rmSync(temporary, { recursive: true, force: true }),
  ]);
}
