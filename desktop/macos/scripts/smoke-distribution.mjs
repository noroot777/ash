import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { ARCHITECTURES, assertArchitecture, buildArchitecture } from "./architecture.mjs";
import { appInfo } from "./release-artifacts.mjs";

export function verifyNativeArchitecture(app, architecture) {
  const target = ARCHITECTURES[assertArchitecture(architecture)].swift;
  const runtime = join(app, "Contents/Resources/app");
  const native = [];
  const walk = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const filename = join(directory, entry.name);
      if (entry.isDirectory()) walk(filename);
      else if (entry.isFile() && (entry.name.endsWith(".node") || entry.name === "spawn-helper")) native.push(filename);
    }
  };
  walk(join(runtime, "node_modules"));
  assert.ok(native.some((filename) => filename.endsWith("pty.node")), "安装包缺少原生 node-pty");
  for (const filename of [join(app, "Contents/MacOS/Navi"), join(runtime, "node/bin/node"), ...native]) {
    const result = spawnSync("lipo", ["-archs", filename], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    assert.ok(result.stdout.trim().split(/\s+/).includes(target), `${filename} 不支持 ${target}`);
  }
  return runtime;
}

export async function smokeDistribution(app, architecture = process.env.NAVI_MAC_ARCH || process.arch) {
  buildArchitecture({ NAVI_MAC_ARCH: architecture });
  assert.equal(appInfo(app).NaviArchitecture, architecture);
  const runtime = verifyNativeArchitecture(app, architecture);
  const node = join(runtime, "node/bin/node");
  const probe = spawnSync(node, ["--input-type=module", "-e", `
    import assert from "node:assert/strict";
    import { DatabaseSync } from "node:sqlite";
    import pty from "node-pty";
    assert.equal(process.arch, ${JSON.stringify(architecture)});
    const db = new DatabaseSync(":memory:");
    assert.equal(db.prepare("select 42 as value").get().value, 42);
    db.close();
    await new Promise((resolve, reject) => {
      let output = "";
      const child = pty.spawn("/bin/sh", ["-c", "printf NAVI_PTY_OK"], { name: "xterm", cols: 80, rows: 24, cwd: process.cwd(), env: process.env });
      const timer = setTimeout(() => { child.kill(); reject(new Error("pty timeout")); }, 10000);
      child.onData((data) => { output += data; });
      child.onExit(({ exitCode }) => { clearTimeout(timer); exitCode === 0 && output.includes("NAVI_PTY_OK") ? resolve() : reject(new Error(output)); });
    });
    console.log("SQLITE_PTY_OK", process.arch);
  `], { cwd: join(runtime, "server"), encoding: "utf8", timeout: 20_000 });
  assert.equal(probe.status, 0, `${probe.error ?? ""}\n${probe.stdout}${probe.stderr}`);
  const directory = mkdtempSync(join(tmpdir(), "navi-distribution-smoke-"));
  let child;
  let output = "";
  try {
    const socket = createServer();
    socket.listen(0, "127.0.0.1");
    await once(socket, "listening");
    const port = socket.address().port;
    await new Promise((done) => socket.close(done));
    const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^(?:NAVI_|ASH_|PORT$|GH_TOKEN$|GITHUB_TOKEN$|MAC_RELEASE_TOKEN$|MAC_SPARKLE_PRIVATE_KEY$)/.test(name)));
    child = spawn(node, [join(runtime, "server/dist/index.js")], { cwd: runtime, env: {
      ...env, NAVI_DATA_DIR: directory, PORT: String(port), NAVI_LOCAL_ONLY: "1",
    }, stdio: ["ignore", "pipe", "pipe"] });
    child.stdout.on("data", (bytes) => { output += bytes; });
    child.stderr.on("data", (bytes) => { output += bytes; });
    let failure;
    child.on("error", (error) => { failure = error; });
    const deadline = Date.now() + 60_000;
    let healthy = false;
    while (Date.now() < deadline && child.exitCode === null && !failure) {
      try {
        const response = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(1000) });
        const body = await response.json();
        healthy = response.ok && body.pid === child.pid;
        if (healthy) break;
      } catch {}
      await delay(200);
    }
    assert.ok(healthy, `独立服务未就绪：${failure ?? ""}\n${output}`);
    console.log(`DISTRIBUTION_SMOKE_OK ${architecture}: native binaries, sqlite, pty, server health`);
  } finally {
    if (child?.pid && child.exitCode === null && child.signalCode === null) {
      const exited = once(child, "exit");
      child.kill("SIGTERM");
      const timer = setTimeout(() => child.kill("SIGKILL"), 5000);
      try { await exited; } finally { clearTimeout(timer); }
    }
    rmSync(directory, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  smokeDistribution(resolve(process.argv[2] ?? "desktop/macos/build/Navi.app")).catch((error) => { console.error(error); process.exitCode = 1; });
}
