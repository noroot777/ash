#!/usr/bin/env node
// 停掉 :4317 上的 ash 服务端。
//
//   npm run stop              # 或直接 node scripts/stop.mjs
//   node scripts/stop.mjs --wait  # 等会被打断的任务排空再停
//   node scripts/stop.mjs --force # 明知会打断也要停(被打断的任务标为 failed)
//
// 跟 restart.mjs 的第 2 步是同一套安全闸(scripts/server-control.mjs),只是停完不再起新的:
//  - 判据是「停止会**真正打断**几个任务」,不是「有几个在跑」。单飞任务的 agent 输出走
//    文件,进程不随 server 死,下次启动按 pid+offset 接管;团队调度台下次启动自动 --resume
//    接回。真会被判 failed 的只剩接管不了的那些,有就默认中止。
//  - 问不出判据(拒答 / 没按时答)一律中止,不按 0 处理。
//  - 停完必须等到端口**彻底安静**才报成功:查不到监听者、或者它不肯退,都如实失败。
//  - ash MCP 是各会话自己 spawn 的 stdio 子进程,不归这里管;server 起来之前它们的调用会失败。
import { readEnv } from "./env.mjs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { IS_WINDOWS, listenerPids, localJson } from "./platform.mjs";
import { countOf, drainWait, explainNoVerdict, killListeners, isPortQuiet, lockFileFor, noVerdictReason, queryImpact, waitPortQuiet } from "./server-control.mjs";
import { parseStopOptions, stopCommand, STOP_USAGE } from "./stop-options.mjs";

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
const LOCK_FILE = lockFileFor(REPO);
const FORCE = options.force;
const WAIT = options.wait;
const WAIT_TIMEOUT = process.env.WAIT_TIMEOUT ? Number(process.env.WAIT_TIMEOUT) : null;

const say = (line) => process.stdout.write(`${line}\n`);

/** 问一次判据;问不到就中止(FORCE 例外)。每个读判据的地方都走它,理由同 restart.mjs。 */
async function impactOrAbort() {
  const data = await queryImpact(PORT, LOCK_FILE);
  const why = noVerdictReason(data);
  if (why === null || FORCE) return data;
  say(`  ✋ 问不到「停止会打断谁」(${why}) —— 已中止,未停止服务端。`);
  explainNoVerdict(data, { say, lockFile: LOCK_FILE, log: LOG });
  say(`     明知可能打断也要停止:  ${stopCommand("--force")}`);
  process.exit(2);
}

/** 停不下来时的统一出口:说清现状和怎么手工确认。 */
async function failStillUp(old) {
  const answers = Boolean(await localJson(PORT, "/api/health"));
  say(answers
    ? `  ✕ :${PORT} 上仍有一个 Navi 在应答,没能让它下线。`
    : `  ✕ :${PORT} 仍被占着(连得上、但不应答),没能让它下线。`);
  if (old.length) say(`     试过 kill:${old.join(", ")} —— 它没退,或者占着端口的根本是别的进程。`);
  else say("     系统没查到谁在监听这个端口:这台机器上 lsof/ss/fuser 可能都没装。");
  say(`     手工确认它是谁:  cat ${LOCK_FILE}`);
  say("                       ps -ef | grep server/dist/index.js");
  process.exit(1);
}

say(`▶ 停止 :${PORT} 服务端…`);
// 停谁只认系统说的「谁在监听这个端口」,单实例锁里的号码不当线索(理由见 restart.mjs 第 2 步)。
const old = listenerPids(PORT);
if (!old.length) {
  if (await isPortQuiet(PORT)) {
    say(`  · :${PORT} 上没有在跑的服务端,无需停止。`);
    process.exit(0);
  }
  await failStillUp(old);
}

let data = await impactOrAbort();
let busy = countOf(data, "interrupted");
if (busy > 0 && WAIT && !FORCE) {
  await drainWait({ count: async () => countOf(await impactOrAbort(), "interrupted"), waitTimeout: WAIT_TIMEOUT, say, verb: "停止" });
  data = await impactOrAbort();
  busy = countOf(data, "interrupted");
}
if (busy > 0 && !FORCE) {
  say(`  ✋ 停止会打断 ${busy} 个任务(判为 failed) —— 已中止,未停止服务端。`);
  for (const t of data.interrupted.slice(0, 8)) say(`     · ${t.title} —— ${t.reason}`);
  say(`     让脚本替你等它们跑完:  ${stopCommand("--wait")}`);
  say(`     确定要打断:            ${stopCommand("--force")}`);
  process.exit(2);
}
const safe = countOf(data, "survives");
const lead = countOf(data, "resumes");
if (safe > 0 || lead > 0) {
  say(`  ✓ 有任务在跑,但停止不会打断:${safe} 个的进程照常跑、输出照常落盘,${lead} 个调度台下次启动自动接回 —— 再启动时一并接管。`);
}
if (busy > 0) say(`  ⚠ FORCE:打断 ${busy} 个**接管不了**的任务(判为 failed,可重试);会被接管的不受影响。`);

let how = "signal";
try {
  how = killListeners(old, data, { force: FORCE });
} catch (error) {
  say(`  ✋ 无法安全终止 Windows 实例: ${error.message}。已中止,未停止服务端。`);
  say(`     未授权整树强杀;确定接受任务中断才使用 ${stopCommand("--force")}。`);
  process.exit(2);
}
if (IS_WINDOWS && safe > 0 && how !== "selective") {
  say(`  ⚠ 这一刀走的是整树强杀(taskkill /T),${safe} 个本可接管的任务会跟着断 ——`);
  say("     只有问得到判据(survives 名单)时才能点名保住它们。");
}

if (!(await waitPortQuiet(PORT))) await failStillUp(old);
say(`✅ :${PORT} 已停止。再启动:npm run restart`);
