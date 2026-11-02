import { cleanupTestResources, withTestResources } from "./test-process-resources.mjs";
import assert from "node:assert/strict";
import fs from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { syncBuiltinESMExports } from "node:module";
import { runTestProcess } from "./test-process.mjs";
import { TestProcessScope, delay } from "./test-process-scope.mjs";
import { IS_WINDOWS, isPidAlive } from "./platform.mjs";

const temporary = fs.mkdtempSync(join(tmpdir(), "ash-test-process-failures-"));
const cleanup = fileURLToPath(new URL("test-process-cleanup.mjs", import.meta.url));
await withTestResources(async () => {
  for (const timeout of [false, true]) {
    const marker = join(temporary, `marker-${timeout}`);
    const pid = join(temporary, `pid-${timeout}`);
    const descendant = join(temporary, `exit-${timeout}.cjs`);
    fs.writeFileSync(descendant, `process.on('exit', () => {
      require('node:fs').writeFileSync(${JSON.stringify(pid)}, String(process.pid));
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1800);
      require('node:fs').writeSync(1, 'EXIT_CALLBACK_STDOUT');
      require('node:fs').writeSync(2, 'EXIT_CALLBACK_STDERR');
      require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'written');
    });`);
    const invoke = () => runTestProcess(process.execPath, ["-e", `
      require('node:child_process').spawn(process.execPath, [${JSON.stringify(descendant)}], { detached: true, stdio: 'inherit' }).unref();
      ${timeout ? "setInterval(() => {}, 1000);" : ""}
    `], { timeout: timeout ? 500 : 15_000 });
    if (timeout) {
      await assert.rejects(invoke, /ETIMEDOUT/);
      assert.ok(fs.existsSync(pid), "退出回调已实际开始执行");
      assert.ok(!isPidAlive(Number(fs.readFileSync(pid, "utf8"))));
      await delay(1900);
      assert.equal(fs.existsSync(marker), false);
    } else {
      const output = await invoke();
      assert.match(output.stdout, /EXIT_CALLBACK_STDOUT/);
      assert.match(output.stderr, /EXIT_CALLBACK_STDERR/);
      assert.ok(fs.existsSync(marker), "后续工作在返回之前完成");
      assert.ok(!isPidAlive(Number(fs.readFileSync(pid, "utf8"))));
    }
  }
  console.log("✓ 退出意向不代替实际死亡:正常退出回调双流收齐,超时后无继续写入");

  const first = new TestProcessScope();
  const second = new TestProcessScope();
  const ready = (child) => new Promise((resolveReady, rejectReady) => {
    let diagnostic = "";
    const timer = setTimeout(() => rejectReady(new Error(`fixture 未就绪: ${diagnostic}`)), 15_000);
    child.stderr.on("data", (chunk) => { diagnostic += chunk; });
    child.once("message", (message) => {
      clearTimeout(timer);
      if (message === "ready") resolveReady();
      else rejectReady(new Error(`未知 fixture 就绪消息: ${message}`));
    });
    child.once("exit", (status, signal) => {
      clearTimeout(timer);
      rejectReady(new Error(`fixture 提前退出: ${status}/${signal}\n${diagnostic}`));
    });
    child.once("error", (error) => { clearTimeout(timer); rejectReady(error); });
  });
  const fixture = ["-e", "process.send('ready'); setInterval(() => {}, 1000)"];
  const firstChild = first.spawn(process.execPath, fixture, { stdio: ["ignore", "ignore", "pipe", "ipc"] });
  const firstReady = ready(firstChild);
  const child = second.spawn(process.execPath, fixture, { stdio: ["ignore", "ignore", "pipe", "ipc"] });
  const secondReady = ready(child);
  const hook = join(temporary, "cleanup-fault.cjs");
  fs.writeFileSync(hook, `const fs = require('node:fs'); const write = fs.writeFileSync;
    fs.writeFileSync = function(target, ...args) {
      if (String(target) === ${JSON.stringify(join(first.directory, "stopped"))}) throw Object.assign(new Error('injected stopped EACCES'), { code: 'EACCES' });
      return write.call(this, target, ...args);
    }; require('node:module').syncBuiltinESMExports();`);
  await withTestResources(async () => {
    await Promise.all([firstReady, secondReady]);
    if (!IS_WINDOWS) fs.chmodSync(first.directory, 0o500);
    const output = await runTestProcess(process.execPath, [cleanup, "--scopes", JSON.stringify([first, second].map((scope) => ({ directory: scope.directory, domain: scope.domain, directoryOwnership: scope.directoryOwnership })))], {
      timeout: 30_000,
      env: { ...process.env, NODE_OPTIONS: `--require ${JSON.stringify(hook)} ${process.env.NODE_OPTIONS ?? ""}` },
    }, 1);
    assert.match(output.stderr, /测试执行域清理未全部成功/);
    // **第一域的目录被锁成只读了**,所以连那张「请你自己退」的纸条都写不进去 —— 而清理助手是
    // 另一个进程,这些孩子的句柄从来不在它手上:三条绑定一条都拿不出来(见
    // scripts/test-process-terminate.mjs 文件头)。于是它**一个信号都不发**,如实报出来并点名
    // 号码(第 6 轮审查 F1:绑不住就别拿号码去赌,赌输了关掉的是一个无关程序)。
    if (!IS_WINDOWS) {
    assert.match(output.stderr, /无法安全终止/, "绑不住要如实报,不能静默跳过");
    assert.match(output.stderr, new RegExp(`\\b${firstChild.pid}\\b`), "报告里要点出是哪几个号码");
    assert.ok(isPidAlive(firstChild.pid), "绑不住就不许动手 —— 它必须还在,而不是被按号码杀掉");
    } else assert.equal(isPidAlive(firstChild.pid), false, "目录写入失败不能阻止内核 Job 停止");
    assert.ok(!isPidAlive(child.pid), "第一域失败不能跳过第二域(那一域的纸条递得进去,它自己退)");
    assert.equal(fs.existsSync(second.directory), false);
    assert.equal(fs.existsSync(first.directory), true, "保留失败登记");
    // 能力并没有丢,只是不在助手那边:**创建者手上还握着句柄**,目录一放开,这边一停就真的停掉。
    fs.chmodSync(first.directory, 0o700);
    await first.stop();
    assert.ok(!isPidAlive(firstChild.pid), "创建者手上有句柄,这一停必须真的把它停掉");
  }, [
    () => { if (fs.existsSync(first.directory)) fs.chmodSync(first.directory, 0o700); },
    () => first.stop(), () => first.remove(),
    () => second.stop(), () => second.remove(),
  ]);
  console.log("✓ 单域停止标记失败不短路其他域清理,失败记录保留,绑不住的如实报");

  const originalWrite = fs.writeFileSync;
  let failedDirectory;
  fs.writeFileSync = function (target, ...args) {
    if (String(target).endsWith("stopped")) {
      failedDirectory = dirname(String(target));
      throw Object.assign(new Error("diagnostic cleanup EACCES"), { code: "EACCES" });
    }
    return originalWrite.call(this, target, ...args);
  };
  syncBuiltinESMExports();
  await withTestResources(async () => {
    await assert.rejects(() => runTestProcess(process.execPath, ["-e", "console.log('BUSINESS_STDOUT'); console.error('BUSINESS_STDERR'); setInterval(() => {}, 1000)"], { timeout: 500 }), (error) => {
      assert.equal(error.code, "ETIMEDOUT");
      assert.match(error.stdout, /BUSINESS_STDOUT/);
      assert.match(error.stderr, /BUSINESS_STDERR/);
      assert.ok(error.cause);
      assert.ok(error.cleanupErrors.length);
      assert.ok(error.errors.some(entry => /清理失败/.test(entry.message)));
      return true;
    });
  }, [async () => {
    fs.writeFileSync = originalWrite;
    syncBuiltinESMExports();
    if (failedDirectory && fs.existsSync(failedDirectory)) {
      const scope = new TestProcessScope(failedDirectory);
      await cleanupTestResources([() => scope.stop(), () => scope.remove()]);
    }
  }]);
  console.log("✓ 清理异常保留原超时/原因/诊断双流,并汇总清理失败");
}, [() => fs.rmSync(temporary, { recursive: true, force: true, maxRetries: 50, retryDelay: 20 })]);
