import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { spawnWindowsPty } from "../src/terminal-pty.js";

const temporary = mkdtempSync(join(tmpdir(), "navi-terminal-pty-"));
const worker = join(temporary, "worker.mjs");
const marker = join(temporary, "worker.pid");
const options = { cwd: temporary, env: process.env as Record<string, string> };

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

// 机器忙时 worker 可能还没跑到「写下自己 pid」那一行就被启动超时收掉了，标记文件就不存在。那时按命令行
// 找它：脚本路径在本测试自己的临时目录里，认不错。Windows 上没有 ps，照旧只认标记文件。
function workerPids(): number[] {
  if (process.platform === "win32") return [Number(readFileSync(marker, "utf8"))];
  const written = existsSync(marker) ? Number(readFileSync(marker, "utf8")) : 0; // 刚建出来还没写进去的是空文件
  if (written > 0) return [written];
  return execFileSync("ps", ["-axo", "pid=,command="], { encoding: "utf8" }).split("\n")
    .filter((line) => line.includes(worker)).map((line) => Number(line.trim().split(/\s+/)[0]));
}

async function stopped(): Promise<void> {
  for (let attempt = 0; attempt < 100 && workerPids().some(alive); attempt++) await delay(50);
  assert.deepEqual(workerPids().filter(alive), [], "isolated worker leaked");
}

try {
  writeFileSync(worker, `import {writeFileSync} from 'node:fs';
process.on('message', () => { writeFileSync(${JSON.stringify(marker)},String(process.pid)); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0); });`);
  let ticks = 0;
  const heartbeat = setInterval(() => ticks++, 20);
  try {
    await assert.rejects(spawnWindowsPty("unused", [], options, {
      worker: pathToFileURL(worker), timeoutMs: 1200,
    }), /启动超时/);
    assert.ok(ticks >= 10, `event loop blocked: ${ticks} ticks`);
  } finally { clearInterval(heartbeat); }
  await stopped();

  writeFileSync(worker, `process.on('message',()=>{process.send({type:'error',error:'missing conout worker'});process.exit(1);});`);
  await assert.rejects(spawnWindowsPty("unused", [], options, {
    worker: pathToFileURL(worker), timeoutMs: 3000,
  }), /missing conout worker/);

  writeFileSync(worker, `process.on('message',message=>{
if(message.type==='start')process.send({type:'ready',pid:process.pid});
if(message.type==='write')process.send({type:'data',data:message.data});
if(message.type==='resize')process.send({type:'data',data:message.cols+'x'+message.rows});
if(message.type==='kill')process.send({type:'exit',exitCode:7},()=>process.exit(0));});`);
  const terminal = await spawnWindowsPty("unused", [], options, { worker: pathToFileURL(worker) });
  const output: string[] = [];
  terminal.onData((data) => output.push(data));
  let exits = 0;
  const ended = new Promise<void>((resolve) => terminal.onExit(({ exitCode }) => {
    exits++;
    assert.equal(exitCode, 7);
    resolve();
  }));
  terminal.write("echo");
  terminal.resize(120, 40);
  for (let attempt = 0; attempt < 60 && output.length < 2; attempt++) await delay(50);
  assert.deepEqual(output, ["echo", "120x40"]);
  terminal.kill();
  await Promise.race([ended, delay(4000).then(() => { throw new Error("terminal exit timed out"); })]);
  await delay(100);
  assert.equal(exits, 1);

  if (process.platform === "win32") {
    const require = createRequire(import.meta.url);
    const packageRoot = dirname(dirname(require.resolve("node-pty")));
    const damaged = join(temporary, "damaged-pty");
    mkdirSync(damaged);
    cpSync(packageRoot, damaged, { recursive: true });
    const conout = join(damaged, "lib", "worker", "conoutSocketWorker.js");
    assert.ok(existsSync(conout));
    rmSync(conout);
    writeFileSync(worker, `import {createRequire} from 'node:module';import{writeFileSync}from'node:fs';
const require=createRequire(import.meta.url);const pty=require(${JSON.stringify(damaged)});
process.on('message',()=>{writeFileSync(${JSON.stringify(marker)},String(process.pid));pty.spawn('cmd.exe',[],{cwd:${JSON.stringify(temporary)},env:process.env});});`);
    await assert.rejects(spawnWindowsPty("unused", [], options, {
      worker: pathToFileURL(worker), timeoutMs: 2000,
    }), /启动超时/);
    await stopped();
    console.log("✓ Windows native ConnectNamedPipe hang from missing conout worker is contained and reaped");
  }
  console.log("✓ isolated PTY: bounded startup, responsive event loop, error propagation, input, resize, single exit, cleanup");
} finally {
  rmSync(temporary, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
