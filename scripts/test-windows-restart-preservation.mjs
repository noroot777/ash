import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isPidAlive, killServerProcess, sleep } from "./platform.mjs";

const stage = mkdtempSync(join(tmpdir(), "ash-restart-preservation-"));
const statePath = join(stage, "root.json");
const unknownPath = join(stage, "unknown.json");
const heartbeatPath = join(stage, "heartbeat");
const unknownFile = join(stage, "unknown.cjs");
const wrapperFile = join(stage, "fixture.ash-agent-wrap.cjs");
const serviceFile = join(stage, "service.cjs");
const original = childProcess.execFileSync;
let service;
let state;
let unknown;
try {
  writeFileSync(unknownFile, `const {spawn}=require('node:child_process');
const {writeFileSync}=require('node:fs');
const descendant=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{detached:true,stdio:'ignore'});
descendant.unref();
writeFileSync(${JSON.stringify(unknownPath)},JSON.stringify({pid:process.pid,descendant:descendant.pid}));
setInterval(()=>{},1000);`);
  writeFileSync(wrapperFile, `const {appendFileSync}=require('node:fs');
setInterval(()=>appendFileSync(${JSON.stringify(heartbeatPath)},'x'),100);`);
  writeFileSync(serviceFile, `const {spawn}=require('node:child_process');
const {writeFileSync}=require('node:fs');
const unknown=spawn(process.execPath,[${JSON.stringify(unknownFile)}],{detached:true,stdio:'ignore'});
const wrapper=spawn(process.execPath,[${JSON.stringify(wrapperFile)}],{detached:true,stdio:'ignore'});
const ordinary=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});
unknown.unref();wrapper.unref();
writeFileSync(${JSON.stringify(statePath)},JSON.stringify({pid:process.pid,unknown:unknown.pid,wrapper:wrapper.pid,ordinary:ordinary.pid}));
setInterval(()=>{},1000);`);
  service = childProcess.spawn(process.execPath, [serviceFile], { stdio: "ignore" });
  await new Promise((resolve, reject) => { service.once("spawn", resolve); service.once("error", reject); });
  const deadline = Date.now() + 15000;
  while ((!existsSync(statePath) || !existsSync(unknownPath) || !existsSync(heartbeatPath)) && Date.now() < deadline) await sleep(100);
  state = JSON.parse(readFileSync(statePath, "utf8"));
  unknown = JSON.parse(readFileSync(unknownPath, "utf8"));
  let hiddenPid = service.pid;
  let treeKills = 0;
  childProcess.execFileSync = (file, args, options) => {
    if (String(file).toLowerCase().includes("taskkill")) treeKills++;
    const output = original(file, args, options);
    const index = args?.indexOf("-EncodedCommand") ?? -1;
    const script = index >= 0 ? Buffer.from(args[index + 1], "base64").toString("utf16le") : "";
    if (!script.includes("Get-CimInstance Win32_Process")) return output;
    const snapshot = JSON.parse(output);
    for (const entry of snapshot) if (entry.pid === hiddenPid) entry.command = "";
    return JSON.stringify(snapshot);
  };
  syncBuiltinESMExports();
  assert.throws(() => killServerProcess(service.pid), /身份不完整/);
  assert.equal(isPidAlive(service.pid), true);
  assert.equal(isPidAlive(state.wrapper), true);
  hiddenPid = unknown.pid;
  const before = readFileSync(heartbeatPath, "utf8").length;
  assert.equal(killServerProcess(service.pid), "selective");
  for (let attempt = 0; attempt < 50 && (isPidAlive(service.pid) || isPidAlive(state.ordinary)); attempt++) await sleep(100);
  assert.equal(isPidAlive(service.pid), false, "旧服务已终止");
  assert.equal(isPidAlive(state.ordinary), false, "普通后代已清理");
  assert.equal(isPidAlive(unknown.pid), true, "命令行不可读的后代保留");
  assert.equal(isPidAlive(unknown.descendant), true, "不可读后代的整棵子树保留");
  assert.equal(isPidAlive(state.wrapper), true, "名单外的 detached agent 壳保留");
  await sleep(350);
  assert.ok(readFileSync(heartbeatPath, "utf8").length > before, "agent 在旧服务退出后继续产出");
  assert.equal(treeKills, 0, "不退化成整树强杀");
  console.log("✓ 原生 Windows:未知后代不阻塞重启,整棵保留,agent 持续输出,服务端身份仍拒杀");
} finally {
  childProcess.execFileSync = original;
  syncBuiltinESMExports();
  try { state ??= JSON.parse(readFileSync(statePath, "utf8")); } catch {}
  try { unknown ??= JSON.parse(readFileSync(unknownPath, "utf8")); } catch {}
  for (const pid of new Set([service?.pid, state?.unknown, state?.wrapper, state?.ordinary, unknown?.descendant])) {
    if (!pid || !isPidAlive(pid)) continue;
    childProcess.spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
  }
  rmSync(stage, { recursive: true, force: true });
}
