#!/usr/bin/env node
// `nohup ... & disown` 只忽略 SIGHUP，不会脱离调用方的进程组。无人值守执行器在命令
// 结束时会清理整组子进程，导致 restart.mjs 刚确认健康，server 就被一起收走。
// Node 的 detached spawn 会新建 session/process group（Windows 上是新建控制台组）；
// helper 自己退出后 child 归给 init/服务管理器，同时完整继承 restart.mjs 的 cwd 与
// 环境（比 launchctl submit 之类的托管方式更不易丢配置）。
import { spawn } from "node:child_process";
import { closeSync, openSync } from "node:fs";

const [logPath, command, ...args] = process.argv.slice(2);
if (!logPath || !command) {
  console.error("usage: start-detached.mjs <log-path> <command> [args...]");
  process.exit(2);
}

const log = openSync(logPath, "a");
const child = spawn(command, args, {
  cwd: process.cwd(),
  env: process.env,
  detached: true,
  windowsHide: true,
  stdio: ["ignore", log, log],
});
closeSync(log);

await new Promise((resolve, reject) => {
  child.once("spawn", resolve);
  child.once("error", reject);
}).catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});

if (!child.pid) process.exit(1);
child.unref();
process.stdout.write(String(child.pid));
