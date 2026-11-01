import assert from "node:assert/strict";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import childProcess, { spawnSync } from "node:child_process";
import { TestProcessScope, delay, preservedPids, spawnTestFixture } from "./test-process-scope.mjs";
import { runTestProcess } from "./test-process.mjs";
import { isPidAlive } from "./platform.mjs";
import native from "./test-process-native.cjs";

const temporary = fs.mkdtempSync(join(tmpdir(), "ash-test-ownership-"));
const original = { mkdtempSync: fs.mkdtempSync, writeFileSync: fs.writeFileSync, readFileSync: fs.readFileSync };
try {
  for (const code of ["ENOSPC", "EACCES"]) {
    const created = [];
    fs.mkdtempSync = (...args) => { const directory = original.mkdtempSync(...args); created.push(directory); return directory; };
    fs.writeFileSync = (target, ...args) => {
      if (String(target).endsWith("started")) throw Object.assign(new Error(`injected ${code}`), { code });
      return original.writeFileSync(target, ...args);
    };
    syncBuiltinESMExports();
    try { await assert.rejects(() => runTestProcess(process.execPath, ["-e", "throw Error('must not start')"]), { code }); }
    finally { Object.assign(fs, original); syncBuiltinESMExports(); }
    assert.equal(created.length, 2);
    assert.deepEqual(created.filter((directory) => fs.existsSync(directory)), []);
  }
  const existing = fs.mkdtempSync(join(temporary, "existing-"));
  fs.writeFileSync(join(existing, "started"), "12345");
  fs.readFileSync = (target, ...args) => {
    if (target === join(existing, "started")) throw Object.assign(new Error("injected read EACCES"), { code: "EACCES" });
    return original.readFileSync(target, ...args);
  };
  syncBuiltinESMExports();
  try { assert.throws(() => new TestProcessScope(existing), { code: "EACCES" }); }
  finally { Object.assign(fs, original); syncBuiltinESMExports(); }
  assert.equal(fs.readFileSync(join(existing, "started"), "utf8"), "12345");
  assert.equal(fs.existsSync(existing), true);
  console.log("✓ 初始化 ENOSPC/EACCES 回滚自有两目录,恢复失败不删除或改写已有域");

  for (const phase of ["output", "scope"]) {
    const created = [];
    fs.mkdtempSync = (...args) => {
      if (String(args[0]).includes(phase === "output" ? "ash-test-process-" : "ash-test-scope-")) {
        throw Object.assign(new Error(`injected ${phase} EACCES`), { code: "EACCES" });
      }
      const directory = original.mkdtempSync(...args); created.push(directory); return directory;
    };
    syncBuiltinESMExports();
    try { await assert.rejects(() => runTestProcess(process.execPath, ["-e", "process.exit()"]), { code: "EACCES" }); }
    finally { Object.assign(fs, original); syncBuiltinESMExports(); }
    assert.deepEqual(created.filter((directory) => fs.existsSync(directory)), []);
  }
  console.log("✓ 输出目录/域目录创建失败均无初始化遗留");

  if (process.platform !== "win32") {
    const marker = join(temporary, "native-started");
    for (const command of [process.execPath, "/usr/bin/python3", "/bin/sh"]) {
      const created = [];
      fs.mkdtempSync = (...args) => { const directory = original.mkdtempSync(...args); created.push(directory); return directory; };
      syncBuiltinESMExports();
      try {
        await assert.rejects(() => runTestProcess(command, ["-e", `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'started')`]), { code: "EOWNERSHIP" });
        assert.deepEqual(created.filter((directory) => fs.existsSync(directory)), []);
        assert.equal(fs.existsSync(marker), false);
      } finally { Object.assign(fs, original); syncBuiltinESMExports(); }
    }
    const before = fs.readdirSync(tmpdir()).filter((name) => name.startsWith("ash-test-scope-"));
    assert.throws(() => spawnTestFixture(process.execPath, ["-e", "process.exit()"]), { code: "EOWNERSHIP" });
    assert.deepEqual(fs.readdirSync(tmpdir()).filter((name) => name.startsWith("ash-test-scope-")), before);
    console.log(`✓ ${process.platform}: 无原生所有权后端时启动前明确失败,不生成子进程或遗留目录`);
  } else {
    const created = [];
    const originalSpawnSync = childProcess.spawnSync;
    fs.mkdtempSync = (...args) => { const directory = original.mkdtempSync(...args); created.push(directory); return directory; };
    childProcess.spawnSync = () => ({ status: 1, signal: null, stdout: "", stderr: "injected compiler failure" });
    try { assert.throws(() => native.executable(), /injected compiler failure/); }
    finally { fs.mkdtempSync = original.mkdtempSync; childProcess.spawnSync = originalSpawnSync; }
    assert.deepEqual(created.filter((directory) => fs.existsSync(directory)), []);
    for (const code of ["ENOSPC", "EACCES"]) {
      const directories = [];
      fs.mkdtempSync = (...args) => { const directory = original.mkdtempSync(...args); directories.push(directory); return directory; };
      fs.writeFileSync = (target, ...args) => {
        if (String(target).endsWith("domain.json")) throw Object.assign(new Error(`injected domain ${code}`), { code });
        return original.writeFileSync(target, ...args);
      };
      syncBuiltinESMExports();
      try { await assert.rejects(() => runTestProcess(process.execPath, ["-e", "process.exit()"]), { code }); }
      finally { Object.assign(fs, original); syncBuiltinESMExports(); }
      assert.deepEqual(directories.filter((directory) => !directory.includes("ash-test-native-") && fs.existsSync(directory)), []);
    }
    console.log("✓ 原生编译失败回滚产物目录,域描述发布失败回滚输出/执行域目录");
    const environment = { ...process.env };
    const outputDirectories = [];
    fs.mkdtempSync = (...args) => {
      const directory = original.mkdtempSync(...args);
      outputDirectories.push(directory);
      if (String(args[0]).includes("ash-test-process-")) environment.CAPTURED_STDOUT = join(directory, "stdout.log");
      return directory;
    };
    syncBuiltinESMExports();
    try {
      await assert.rejects(() => runTestProcess(process.execPath, ["-e", "require('node:fs').unlinkSync(process.env.CAPTURED_STDOUT)"], { env: environment }), (error) => {
        assert.equal(error.code, "ENOENT");
        assert.ok(error.cleanupErrors.some((entry) => entry.code === "ENOENT"));
        return true;
      });
    } finally { Object.assign(fs, original); syncBuiltinESMExports(); }
    assert.deepEqual(outputDirectories.filter((directory) => fs.existsSync(directory)), []);
    console.log("✓ 捕获文件缺失明确失败,不以空双流冒充收集成功,输出/域目录仍回收");
    const concurrent = new TestProcessScope();
    try {
      const child = concurrent.spawn(process.execPath, ["-e", `
        const cp = require('node:child_process');
        for (let index = 0; index < 24; index++) cp.spawn(process.execPath, ['-e', 'setTimeout(() => {}, 100)'], { stdio: 'inherit' });
      `], { stdio: "ignore" });
      let finished = false;
      const exit = new Promise((resolveExit, rejectExit) => {
        child.once("exit", (status) => { finished = true; status === 0 ? resolveExit() : rejectExit(new Error(`concurrent root ${status}`)); });
        child.once("error", rejectExit);
      });
      while (!finished) {
        for (const record of concurrent.records()) {
          assert.equal(record.kind, "process");
          assert.match(record.born, /^\d+$/);
          assert.equal(record.streams.length, 2);
        }
        await delay(5);
      }
      await exit;
      assert.equal(concurrent.records().length, 25);
      assert.deepEqual(await concurrent.active(), []);
      assert.equal(fs.readdirSync(concurrent.directory).some((name) => name.endsWith(".pending")), false);
    } finally { await concurrent.stop(); concurrent.remove(); }
    console.log("✓ Windows 25 进程并发不可变登记,只读取完整记录,无覆盖发布或占位协议");

    const ipcScope = new TestProcessScope();
    try {
      const ipc = ipcScope.spawn(process.execPath, ["-e", "process.send('ready'); process.disconnect()"], { stdio: ["ignore", "ignore", "pipe", "ipc"] });
      await new Promise((resolveReady, rejectReady) => {
        const timer = setTimeout(() => rejectReady(new Error("IPC fixture not ready")), 10_000);
        ipc.once("message", (message) => { clearTimeout(timer); try { assert.equal(message, "ready"); resolveReady(); } catch (error) { rejectReady(error); } });
        ipc.once("error", (error) => { clearTimeout(timer); rejectReady(error); });
        ipc.once("exit", (status) => { clearTimeout(timer); rejectReady(new Error(`IPC fixture exited before ready: ${status}`)); });
      });
    } finally { await ipcScope.stop(); ipcScope.remove(); }
    console.log("✓ 原生根启动保持 Node IPC 消息通道");

    const crashed = new TestProcessScope();
    const crashReady = join(temporary, "crash-ready");
    const crashMarker = join(temporary, "crash-late");
    try {
      crashed.spawn(process.execPath, ["-e", `
        const env = { ...process.env }; delete env.NODE_OPTIONS; delete env.ASH_TEST_PROCESS_SCOPE;
        require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(`
          const fs = require('node:fs');
          fs.writeFileSync(${JSON.stringify(crashReady)}, 'ready');
          setTimeout(() => fs.writeFileSync(${JSON.stringify(crashMarker)}, 'late'), 2000);
        `)}], { env, detached: true, stdio: 'ignore' }).unref();
        setInterval(() => {}, 1000);
      `], { stdio: "ignore" });
      const deadline = Date.now() + 10_000;
      while (!fs.existsSync(crashReady)) {
        assert.ok(Date.now() < deadline, "崩溃测试后代未就绪");
        await delay(10);
      }
      const holderExited = new Promise((resolveExit) => crashed.holder.once("exit", resolveExit));
      assert.equal(crashed.holder.kill("SIGKILL"), true);
      await holderExited;
      let timeout;
      try {
        await Promise.race([crashed.children[0].closed, new Promise((_, reject) => {
          timeout = setTimeout(() => reject(new Error("监督进程崩溃后执行域仍存活")), 5000);
        })]);
      } finally { clearTimeout(timeout); }
      await assert.rejects(() => crashed.active(), { code: "EOWNERSHIP" });
      await assert.rejects(() => crashed.stop(), /测试执行域清理失败/);
      await delay(2200);
      assert.equal(fs.existsSync(crashMarker), false);
    } finally {
      if (crashed.holder?.exitCode === null && crashed.holder?.signalCode === null) await crashed.stop();
      crashed.domain = undefined;
      crashed.remove();
    }
    console.log("✓ 监督进程崩溃时启动器不延长 Job 句柄寿命,内核终止未登记后代且清理明确失败");

    const fixtureSource = fileURLToPath(new URL("test-process-native-fixture.cs", import.meta.url));
    const fixtureExe = join(temporary, "native-fixture.exe");
    const quote = (value) => "'" + value.replaceAll("'", "''") + "'";
    const compilation = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(
      `$ErrorActionPreference='Stop'; Add-Type -Path ${quote(fixtureSource)} -OutputAssembly ${quote(fixtureExe)} -OutputType ConsoleApplication`, "utf16le").toString("base64")], { encoding: "utf8", timeout: 30_000 });
    assert.ifError(compilation.error);
    assert.equal(compilation.status, 0, compilation.stderr);
    for (const mode of ["normal", "timeout", "chain"]) {
      const marker = join(temporary, `${mode}.marker`);
      const pidFile = join(temporary, `${mode}.pid`);
      const invoke = () => runTestProcess(fixtureExe, [mode, marker, pidFile], { timeout: mode === "timeout" ? 600 : 15_000 });
      if (mode === "timeout") {
        await assert.rejects(invoke, (error) => {
          assert.equal(error.code, "ETIMEDOUT");
          assert.match(error.stdout, /NATIVE_ROOT/);
          return true;
        });
        assert.ok(!isPidAlive(Number(fs.readFileSync(pidFile, "utf8"))));
        await delay(1800);
        assert.equal(fs.existsSync(marker), false);
      } else {
        const result = await invoke();
        assert.match(result.stdout, /NATIVE_TAIL/);
        assert.match(result.stderr, /NATIVE_ERROR_TAIL/);
        assert.equal(fs.readFileSync(marker, "utf8"), "complete");
        assert.ok(!isPidAlive(Number(fs.readFileSync(pidFile, "utf8"))));
      }
    }
    console.log("✓ 原生后代正常/超时/连续出生退出:整域零活动证明,晚写双流收齐或已禁止继续写入");

    const isolated = await runTestProcess(process.execPath, ["-e", `
      const env = { ...process.env }; delete env.NODE_OPTIONS; delete env.ASH_TEST_PROCESS_SCOPE;
      require('node:child_process').spawn(process.execPath, ['-e', "setTimeout(() => console.log('UNREGISTERED_TAIL'), 700)"], { env, detached: true, stdio: 'inherit' }).unref();
    `]);
    assert.match(isolated.stdout, /UNREGISTERED_TAIL/);
    console.log("✓ 清空 preload/登记环境仍由内核持有所有后代");

    const sentinel = spawnTestFixture(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
    const stale = new TestProcessScope();
    try {
      const root = stale.spawn(process.execPath, ["-e", "process.exit(0)"], { stdio: "ignore" });
      await new Promise((resolveExit, rejectExit) => { root.once("exit", resolveExit); root.once("error", rejectExit); });
      fs.writeFileSync(join(stale.directory, "stale.json"), JSON.stringify({ kind: "process", domain: stale.domain.name,
        pid: sentinel.pid, born: "1", script: "stale.cjs", streams: ["outside:1", "outside:2"] }));
      const active = await stale.active();
      assert.deepEqual(active, []);
      assert.equal(preservedPids(stale, ["stale.cjs"], [], [{ pid: sentinel.pid, born: "2" }]).size, 0);
      await stale.stop(); stale.remove();
      assert.ok(isPidAlive(sentinel.pid));
      assert.equal(fs.existsSync(stale.directory), false);
    } finally {
      if (fs.existsSync(stale.directory)) { await stale.stop(); stale.remove(); }
      await sentinel.dispose();
    }
    console.log("✓ 陈旧 PID/错误出生代次登记不恢复归属,整域终止不触碰另一实例域,完成后立即退役");
  }
} finally {
  Object.assign(fs, original);
  syncBuiltinESMExports();
  fs.rmSync(temporary, { recursive: true, force: true, maxRetries: 50, retryDelay: 20 });
}
