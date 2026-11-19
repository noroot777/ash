#!/usr/bin/env node
// 停掉 :4317 上的 navi 服务端。
//
//   npm run stop              # 或直接 node scripts/stop.mjs
//   node scripts/stop.mjs --wait  # 等会被打断的任务排空再停
//   node scripts/stop.mjs --force # 明知会打断也要停(被打断的任务标为 failed)
//   node scripts/stop.mjs --pid N # 只结束一个没在应答的服务进程并等它退出(升级的退回命令用,stop-pid.mjs)
//
// 跟 restart.mjs 的第 2 步是同一套安全闸(scripts/server-control.mjs),只是停完不再起新的:
//  - 判据是「停止会**真正打断**几个任务」,不是「有几个在跑」。单飞任务的 agent 输出走
//    文件,进程不随 server 死,下次启动按 pid+offset 接管;团队调度台下次启动自动 --resume
//    接回。真会被判 failed 的只剩接管不了的那些,有就默认中止。
//  - 问不出判据(拒答 / 没按时答)一律中止,不按 0 处理。
//  - 停完必须等到端口**彻底安静**才报成功:查不到监听者、或者它不肯退,都如实失败。
//  - navi MCP 是各会话自己 spawn 的 stdio 子进程,不归这里管;server 起来之前它们的调用会失败。
import { readEnv } from "./env.mjs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { IS_WINDOWS } from "./platform.mjs";
import { lockFileFor, takeDown } from "./server-control.mjs";
import { parseStopOptions, stopCommand, STOP_USAGE } from "./stop-options.mjs";
import { stopPid } from "./stop-pid.mjs";

let options;
try {
  options = parseStopOptions();
} catch (error) {
  process.stderr.write(`✕ ${error.message}\n运行 ${stopCommand("--help")} 查看用法。\n`);
  process.exit(2);
}
if (options.help) {
  process.stdout.write(`${STOP_USAGE}\n`);
  process.exit(0);
}

const REPO = fileURLToPath(new URL("..", import.meta.url));
process.chdir(REPO);

const PORT = Number(process.env.PORT || 4317);
const LOG = readEnv(process.env, "NAVI_LOG") || join(IS_WINDOWS ? (process.env.TEMP || ".") : "/tmp", `navi-${PORT}.log`);
const WAIT_TIMEOUT = process.env.WAIT_TIMEOUT ? Number(process.env.WAIT_TIMEOUT) : null;

const say = (line) => process.stdout.write(`${line}\n`);

if (options.pid) {
  process.exit(await stopPid({
    pid: options.pid, entry: process.env.SERVER_ENTRY || "server/dist/index.js", force: options.force,
    timeoutSec: Number(process.env.STOP_PID_TIMEOUT || 60), say,
  }));
}

say(`▶ 停止 :${PORT} 服务端…`);
const { running } = await takeDown({
  port: PORT, lockFile: lockFileFor(REPO), log: LOG, force: options.force, wait: options.wait, waitTimeout: WAIT_TIMEOUT, say,
  gate: {
    verb: "停止",
    held: (data) => (Array.isArray(data.interrupted) ? data.interrupted : []),
    heldLine: (n) => `停止会打断 ${n} 个任务(判为 failed)`,
    tail: "未停止服务端。",
    command: stopCommand,
    passLine: (safe, lead) => `  ✓ 有任务在跑,但停止不会打断:${safe} 个的进程照常跑、输出照常落盘,${lead} 个调度台下次启动自动接回 —— 再启动时一并接管。`,
  },
});
if (!running) {
  say(`  · :${PORT} 上没有在跑的服务端,无需停止。`);
  process.exit(0);
}
say(`✅ :${PORT} 已停止。再启动:npm run restart`);
