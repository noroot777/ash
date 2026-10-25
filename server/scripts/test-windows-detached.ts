import assert from "node:assert/strict";
import { once } from "node:events";
import type { ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "ash-windows-detached-"));
process.env.ASH_DB = join(root, "test.db");
process.env.ASH_ALLOW_REAL_AGENT = "1";
process.env.ASH_KERNEL_CONFINE = "0";
const { detachedPathsFor, spawnForRun, spawnControllableForRun, reattachDetachedAgent } = await import("../src/executors/detached.js");
const { windowsWrapPaths } = await import("../src/executors/detached-win-wrap.js");
const { registerWindowsOwnership, windowsExecutionRoot } = await import("../src/executors/windows-run-evidence.js");
const { tableFromRows } = await import("../src/process-generation.js");
const { reopenWindowsControlStdin } = await import("../src/executors/windows-control-stdin.js");
const sleep = (duration: number) => new Promise((resolve) => setTimeout(resolve, duration));
const wait = async (predicate: () => boolean) => {
  const deadline = Date.now() + 40_000;
  while (!predicate()) { assert.ok(Date.now() < deadline, "等待条件超时"); await sleep(50); }
};
const fixtures: ChildProcess[] = [];
const writers: Array<{ pid: number; startedAt: string | null }> = [];
const keepAlive = setInterval(() => {}, 1000);

try {
  const paths = detachedPathsFor(root, "evidence", "T0");
  const wrap = windowsWrapPaths(paths);
  const child = { pid: 100 } as ChildProcess;
  writeFileSync(wrap.ownership, JSON.stringify({ wrapperPid: 100, pid: 101, from: 1000, bornBefore: 1010, exitedAt: 2000 }));
  registerWindowsOwnership(child, paths);
  const table = tableFromRows({ rows: [], unnamed: 0 });
  assert.equal(windowsExecutionRoot(child, table).root?.pid, 101);
  writeFileSync(wrap.ownership, JSON.stringify({ wrapperPid: 100, pid: 101, from: 1000, bornBefore: 1010, exitedAt: null }));
  const liveTable = tableFromRows({ rows: [{ pid: 101, ppid: 100, command: "fixture", startedAt: new Date(1005).toISOString() }], unnamed: 0 });
  assert.equal(windowsExecutionRoot(child, liveTable).root?.stand.state, "live");
  const replacedTable = tableFromRows({ rows: [{ pid: 101, ppid: 100, command: "stranger", startedAt: new Date(3000).toISOString() }], unnamed: 0 });
  assert.ok(windowsExecutionRoot(child, replacedTable).fault);
  writeFileSync(wrap.ownership, JSON.stringify({ wrapperPid: 200, pid: 101, from: 1000, bornBefore: 1010, exitedAt: 2000 }));
  assert.ok(windowsExecutionRoot(child, table).fault);
  writeFileSync(wrap.state, JSON.stringify({ supported: false, status: "pending" }));
  assert.equal(reopenWindowsControlStdin(paths, () => true), null);
  rmSync(wrap.ownership);
  const missing = { pid: 200 } as ChildProcess;
  registerWindowsOwnership(missing, paths);
  assert.ok(windowsExecutionRoot(missing, table).fault);
  writeFileSync(wrap.state, JSON.stringify({ supported: true, status: "pending" }));
  const unavailable = reopenWindowsControlStdin(paths, () => false);
  assert.ok(unavailable);
  await new Promise<void>((resolve) => unavailable.write("message", (error) => {
    assert.match(error?.message ?? "", /退出或换代/); resolve();
  }));
  unavailable.destroy();
  writeFileSync(wrap.state, JSON.stringify({ supported: true, status: "failed", error: "listener failed" }));
  const failed = reopenWindowsControlStdin(paths, () => true);
  assert.ok(failed);
  await new Promise<void>((resolve) => failed.write("message", (error) => {
    assert.equal(error?.message, "listener failed"); resolve();
  }));
  failed.destroy();
  console.log("✓ 持久归属证据核对外壳身份,普通回合不伪造输入能力");

  if (process.platform === "win32") {
    const { cleanupAfterRun } = await import("../src/executors/kill.js");
    const { inspectProcess } = await import("../src/proc.js");
    const { dbClient, ensureSchema } = await import("../src/db/index.js");
    await ensureSchema();
    try {
      for (const controllable of [false, true]) {
        const prefix = controllable ? "controlled" : "ordinary";
        const pidPath = join(root, `${prefix}.pid`);
        const exitPath = join(root, `${prefix}.exit`);
        const beatPath = join(root, `${prefix}.beat`);
        const writer = `setInterval(()=>require('node:fs').appendFileSync(${JSON.stringify(beatPath)},'.'),50)`;
        const program = `const fs=require('node:fs');const writer=require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(writer)}],{stdio:'ignore',detached:true});writer.unref();fs.writeFileSync(${JSON.stringify(pidPath)},String(writer.pid));setInterval(()=>{if(fs.existsSync(${JSON.stringify(exitPath)}))process.exit(0)},50);`;
        const paths = detachedPathsFor(root, prefix, "T0");
        const spawnRun = controllable ? spawnControllableForRun : spawnForRun;
        const child = spawnRun(root, process.execPath, ["-e", program], "", undefined, paths);
        fixtures.push(child);
        child.stdout?.resume(); child.stderr?.resume();
        await wait(() => existsSync(pidPath) && existsSync(beatPath));
        const writerPid = Number(readFileSync(pidPath, "utf8"));
        writers.push({ pid: writerPid, startedAt: inspectProcess(writerPid)?.startedAt ?? null });
        const info = inspectProcess(child.pid!);
        const adopted = reattachDetachedAgent({ pid: child.pid!, startedAt: info?.startedAt ?? null, paths, offset: 0 });
        assert.ok(adopted);
        adopted.stdout?.resume(); adopted.stderr?.resume();
        const exited = once(adopted, "close");
        writeFileSync(exitPath, "go");
        await exited;
        const result = await cleanupAfterRun(adopted);
        assert.equal(result.kind, "empty", JSON.stringify(result));
        assert.throws(() => process.kill(writerPid, 0), "接管后自然结束也必须清掉 CLI 的后台孩子");
        console.log(`✓ Windows ${prefix}:接管后保留真实 CLI 生命周期,清掉后台后代`);
      }

      const preload = join(root, "slow.cjs");
      writeFileSync(preload, 'if(process.argv[1]?.endsWith(".ash-agent-wrap.cjs")) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,12000);');
      const paths = detachedPathsFor(root, "early", "T0");
      const child = spawnControllableForRun(root, process.execPath, ["-e", 'process.stdin.on("data",data=>console.log(data.toString().trim()));'], "initial\n", { NODE_OPTIONS: `--require "${preload.replace(/\\/g, "/")}"` }, paths);
      fixtures.push(child);
      child.stdout?.resume(); child.stderr?.resume();
      const info = inspectProcess(child.pid!);
      child.stdin?.end();
      assert.equal(existsSync(windowsWrapPaths(paths).pipeMarker), false);
      const adopted = reattachDetachedAgent({ pid: child.pid!, startedAt: info?.startedAt ?? null, paths, offset: 0 });
      assert.ok(adopted?.stdin, "marker 未就绪不能永久判定无输入能力");
      adopted.stdout?.resume(); adopted.stderr?.resume();
      await new Promise<void>((resolve, reject) => adopted.stdin!.write("after-restart\n", (error) => error ? reject(error) : resolve()));
      await wait(() => readFileSync(paths.out, "utf8").includes("after-restart"));
      adopted.stdin.destroy();
      console.log("✓ Windows:外壳延迟 12 秒,首次接管的同一个 stdin 等就绪后完成写入");
    } finally { await dbClient.close(); }
  }
} finally {
  const { killByPid } = await import("../src/executors/kill.js");
  for (const child of fixtures) { child.stdin?.destroy(); if (child.exitCode === null) child.kill(); }
  for (const writer of writers) killByPid(writer.pid, writer.startedAt);
  await sleep(500);
  clearInterval(keepAlive);
  rmSync(root, { recursive: true, force: true });
}
