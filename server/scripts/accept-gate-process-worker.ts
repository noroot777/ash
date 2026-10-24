import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { gateTreeAlive, spawnAcceptGate, stopAcceptGate } from "../src/accept-gate-process.js";
import { readGateLaunch } from "../src/accept-gate-launch.js";

const mode = process.argv[2]!;
const directory = process.argv[3]!;
const sleep = (milliseconds: number) => new Promise(resolve => setTimeout(resolve, milliseconds));

if (mode === "recover-legacy") {
  console.log(JSON.stringify({ stopped: await stopAcceptGate("process-test", null, null, directory) }));
} else if (mode === "recover") {
  const started = JSON.parse(readFileSync(`${directory}.controller.json`, "utf8"));
  const logPath = `${directory}.log`;
  const aliveBefore = gateTreeAlive(started.pid, started.startedAt, logPath);
  const stopped = await stopAcceptGate("process-test", started.pid, started.startedAt, logPath);
  console.log(JSON.stringify({ aliveBefore, stopped, aliveAfter: gateTreeAlive(started.pid, started.startedAt, logPath) }));
} else if (mode === "macos-flow") {
  const { testMacGateFlow } = await import("./accept-gate-macos-flow.js");
  console.log(JSON.stringify(await testMacGateFlow(directory)));
} else {
  const script = `${directory}.cjs`;
  writeFileSync(script, `
const { spawn } = require("node:child_process");
const fs = require("node:fs");
if (process.argv[2] === "child") {
  fs.writeFileSync(${JSON.stringify(`${directory}.pid`)}, String(process.pid));
  setInterval(() => {
    if (fs.existsSync(${JSON.stringify(`${directory}.finish`)})) process.exit(0);
    fs.appendFileSync(${JSON.stringify(`${directory}.pulse`)}, "pulse\\n");
  }, 40);
} else {
  const child = spawn(process.execPath, [__filename, "child"], {
    stdio: "ignore", detached: true, windowsHide: true,
  });
  child.unref();
  ${mode === "controller-normal" ? "setInterval(() => {}, 1000);" : `setInterval(() => {
    if (fs.existsSync(${JSON.stringify(`${directory}.pulse`)})) process.exit(0);
  }, 10);`}
}
`);
  let settled!: (value: { code: number | null; stopped: boolean }) => void;
  const settlement = new Promise<{ code: number | null; stopped: boolean }>(resolve => { settled = resolve; });
  const keepAlive = mode === "settle" ? setInterval(() => undefined, 1000) : null;
  if (mode === "controller-preload") {
    const preload = `${directory}.preload.cjs`;
    writeFileSync(preload, `require('node:fs').appendFileSync(${JSON.stringify(`${directory}.preload`)}, String(process.pid)+'\\n');`);
    process.env.NODE_OPTIONS = `--require=${JSON.stringify(preload)}`;
  }
  const started = await spawnAcceptGate({ command: `"${process.execPath}" "${script}"`,
    cwd: process.cwd(), logPath: `${directory}.log`, hold: mode === "controller-preload", onExit: exit => {
      if (mode === "settle") void stopAcceptGate("process-test", null, null, `${directory}.log`)
        .then(stopped => settled({ code: exit.code, stopped }));
    } });
  if (mode === "controller-preload") {
    await sleep(200);
    assert.equal(existsSync(`${directory}.preload`), false, "用户 preload 不能在内核圈定前运行");
    assert.equal(await started.authorize(), true);
  }
  const deadline = Date.now() + 20_000;
  while (!existsSync(`${directory}.pulse`)) {
    if (Date.now() > deadline) throw new Error(`controller failed: ${readFileSync(`${directory}.log`, "utf8")}`);
    await sleep(25);
  }
  writeFileSync(`${directory}.controller.json`, JSON.stringify({ controllerPid: process.pid,
    pid: started.pid, startedAt: started.startedAt,
    launch: readGateLaunch(`${directory}.log`) }));
  if (mode === "settle") {
    console.log(JSON.stringify(await settlement));
    if (keepAlive) clearInterval(keepAlive);
  }
  if (mode === "controller-crash") process.kill(process.pid, "SIGKILL");
  process.exit(0);
}
import assert from "node:assert/strict";
