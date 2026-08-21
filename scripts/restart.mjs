#!/usr/bin/env node
// 一条龙:重建全部 → 重启 :4317 服务端 → 刷新 ash MCP。
//
//   npm run restart            # 或直接 node scripts/restart.mjs
//   FORCE=1 npm run restart    # 即使有任务在跑也强制重启(会把它们判为 failed)
//   WAIT=1 npm run restart     # 有任务在跑就【等】它们排空再重启,而不是中止
//   SKIP_MCP=1 npm run restart # 只重建+重启 :4317,不刷新 MCP(不打断正在用 ash MCP 的会话)
//   FORCE_MCP=1 npm run restart # 明知有 agent 正握着 MCP 通道,也照样刷新(会掐断它们的交卷)
//
// 跑法说明:
//  - :4317 跑的是编译后的 dist,所以改完源码必须先 build 再重启,本脚本一并做掉。
//  - 安全闸的判据是「重启会**真正打断**几个任务」，不是「有几个在跑」：agent 的
//    输出走文件之后（server/src/executors/detached.ts），单飞任务的进程不随 server
//    死，重启后按 pid+offset 接管、全程无感；团队调度台进程会断但自动 --resume
//    接回。真会被判 failed 的只剩：旧代码起的（没 agent_pid）、queued 还没起进程
//    的、进程已经不在的。所以「有 3 个任务在跑」现在完全可能是可以随意重启的。
//    判据单点在 server 的 /api/restart-impact,跟真正接管时用同一条口径。
//  - 确定要打断再加 FORCE=1。build 已完成不会丢，只是先不动服务端。
//  - WAIT=1 把「人守着等排空」换成「脚本替你等」:先等空再 build,build 期间若又
//    有任务起跑就再等一轮,然后重启。WAIT_TIMEOUT=<秒> 可设上限(默认无限等),
//    等待期间 Ctrl-C 随时可退。FORCE 优先于 WAIT(既然要强杀就不必等)。
//    注意残留竞态:检查与 kill 之间仍可能有 queued 任务抢跑 —— 真正关死这个窗口
//    需要服务端的 drain 模式(停止启动新任务并如实报告已排空),这里够不着。
//  - ash MCP 是每个 Codex/Claude 会话各自 spawn 的 stdio 子进程(node mcp/dist/index.js),
//    不是常驻端口。第 3 步杀掉这些"旧代码"子进程;客户端下次用到时会用新的 mcp/dist 重新拉起。
//    **这一刀是本脚本唯一真能伤到正在干活的 agent 的地方**(重启 :4317 它们无感,见上一条):
//    通道一断,它那轮的 report_stage/complete_task 就撞 `Transport closed`。所以第 3 步之前
//    再问一次服务端「谁手里还握着 MCP」(restart-impact 的 mcpDisrupted),有人握着就**默认
//    跳过刷新**并说明——改了 mcp/ 非要立刻生效再 FORCE_MCP=1 跑一遍。
//    (兜底另有一层:ash 会在回合结算时补录那些"确定没送达"的交卷调用,见
//     server/src/mcp-handoff.ts;但白名单只有三个工具,能不掐断还是不掐断。)
//
// 2026-08-14 从 restart.sh 改写成 .mjs:Windows 上没有 bash/lsof/pkill,而这条命令是
// 「改完代码怎么让它生效」的唯一入口,不能只有一半机器跑得动。平台差异集中在
// scripts/platform.mjs。
import "./env.mjs";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, resolve } from "node:path";
import { NPM, NPM_SPAWN_OPTS } from "./npm.mjs";
import { IS_WINDOWS, isPidAlive, killPid, listenerPids, localJson, pidsRunningScript, sleep } from "./platform.mjs";
import { WORKSPACE_FAIL_HINT, inspectNpmConfig, inspectWorkspaces } from "./workspace-check.mjs";

const REPO = fileURLToPath(new URL("..", import.meta.url));
process.chdir(REPO);

const PORT = Number(process.env.PORT || 4317);
const LOG = process.env.ASH_LOG || join(IS_WINDOWS ? (process.env.TEMP || ".") : "/tmp", `ash-${PORT}.log`);
const START_TIMEOUT = Number(process.env.START_TIMEOUT || 30);
const SERVER_NODE = process.env.SERVER_NODE || process.execPath;
// 起哪个入口。默认就是编译产物;留一个口子是为了 test-restart.mjs 能拿一个假 server
// 跑完整条流程(否则那条回归只能靠 stub 掉半个脚本,测的就不是真路径了)。
const SERVER_ENTRY = process.env.SERVER_ENTRY || "server/dist/index.js";
const FORCE = !!process.env.FORCE;
const WAIT = !!process.env.WAIT;
const WAIT_TIMEOUT = process.env.WAIT_TIMEOUT ? Number(process.env.WAIT_TIMEOUT) : null;

const say = (line) => process.stdout.write(`${line}\n`);

// 单实例锁:server 自己写的「谁占着这个 DB」,字段见 server/src/singleton.ts。
// 路径口径要跟 server 一致(ASH_DB 覆盖,默认 data/ash.db),否则找错文件。
const LOCK_FILE = `${process.env.ASH_DB ? resolve(process.env.ASH_DB) : join(REPO, "data", "ash.db")}.ash.lock`;

/**
 * 现在是哪个 pid 占着这个 DB。**端口探测只是旁证**:容器里 lsof/ss/fuser 可能一个
 * 都没有(2026-08-21 的 Rocky 容器就是),listenerPids 返回空,旧进程于是被整个放过。
 * 锁文件是 server 自己写的权威记录,跟它拒绝第二个实例启动时用的是同一份判据,拿它
 * 兜底既零依赖又不会看走眼。
 *
 * **只认端口对得上的那把锁**:同一台机器上完全可能有别的 ash 守着别的 DB/端口
 * (test-restart 就起在 14317),不加这道判据就会去杀不相干的进程。
 */
function lockOwnerPid() {
  try {
    const lock = JSON.parse(readFileSync(LOCK_FILE, "utf8"));
    if (lock?.port !== PORT) return null;
    return Number.isInteger(lock.pid) && lock.pid > 1 && isPidAlive(lock.pid) ? lock.pid : null;
  } catch {
    return null; // 没有锁文件 = 没有在跑的 ash,或者旧版本还不写锁
  }
}

/**
 * 「现在重启会真正打断几个任务」。**不是** running/queued 的个数 —— agent 的输出
 * 走文件之后（server/src/executors/detached.ts），单飞任务的进程压根不随 server 死，
 * 重启后按 pid+offset 接管，全程无感；团队调度台进程会断但会自动 --resume 接回。
 * 判据单点在 server 的 /api/restart-impact，跟真正接管时用同一条口径，免得这边说能
 * 接、那边又不认。server 没起来/查不到 → 各类算 0，照旧重启。
 */
async function impact() {
  return (await localJson(PORT, "/api/restart-impact")) ?? {};
}

function countOf(data, field) {
  return Array.isArray(data[field]) ? data[field].length : 0;
}

async function interruptCount() {
  return countOf(await impact(), "interrupted");
}

/** WAIT=1 用:轮询到「不再有会被打断的任务」为止,把「人守着等」换成「脚本替你等」。 */
async function drainWait() {
  let n = await interruptCount();
  if (!n) return;
  say(`  ⏳ WAIT:还有 ${n} 个任务重启会被打断,等它们跑完(Ctrl-C 可随时放弃)…`);
  let elapsed = 0;
  const step = 5;
  while (n > 0) {
    if (WAIT_TIMEOUT !== null && elapsed >= WAIT_TIMEOUT) {
      say(`  ✕ WAIT 超时(${WAIT_TIMEOUT}s),仍有 ${n} 个会被打断 —— 已中止,未重启服务端。`);
      process.exit(3);
    }
    await sleep(step * 1000);
    elapsed += step;
    n = await interruptCount();
    if (elapsed % 60 === 0 && n > 0) say(`  ⏳ 已等 ${elapsed / 60}min,还有 ${n} 个会被打断…`);
  }
  say("  ✓ 已经没有会被打断的任务了,继续。");
}

function npm(args, failMessage) {
  const res = spawnSync(NPM, args, { stdio: "inherit", ...NPM_SPAWN_OPTS });
  if (res.status !== 0) {
    say(failMessage);
    process.exit(1);
  }
}

// 先等空再 build:反过来的话,等待期间合进来的提交不会进 dist。
// FORCE 优先 —— 既然打算强杀,等就没有意义了。
if (WAIT && !FORCE) await drainWait();

say("▶ 依赖同步…");
// 跟 setup.mjs 同一道闸:workspace 缺一块的话,npm 会拿本地包名去公共 registry 上找,
// 报一条读起来像断网的 404。`git pull` 之后少了个目录也会走到这儿。
const ws = inspectWorkspaces(REPO);
if (!ws.ok) {
  for (const p of ws.problems) say(`  ✕ ${p}`);
  for (const line of WORKSPACE_FAIL_HINT) say(`     ${line}`);
  for (const line of ws.fix) say(`     ${line}`);
  say("✕ workspace 不完整,依赖同步一定失败,已中止——服务端未重启,跑的还是旧代码。");
  process.exit(1);
}
// npm 配置闸也要过:老机器撞上 workspaces=false 时,这里会先「装好」一个只有根依赖的
// node_modules,再让人去看 build 阶段那条跟病因毫无关系的报错。
const npmCfg = inspectNpmConfig();
for (const w of npmCfg.warnings) say(`  ⚠ ${w}`);
if (npmCfg.blockers.length) {
  for (const b of npmCfg.blockers) say(`  ✕ ${b}`);
  say("✕ npm 配置会让 workspace 装不对,已中止——服务端未重启,跑的还是旧代码。");
  process.exit(1);
}
npm(["install", "--no-audit", "--no-fund"], "✕ 依赖同步失败,已中止——服务端未重启。");

say("▶ 1/3 构建 (shared → web → server → mcp)…");
npm(["run", "build"], "✕ 构建失败,已中止——服务端未重启,跑的还是旧代码。");

say(`▶ 2/3 重启 :${PORT} 服务端…`);
// 端口 ∪ 锁文件:两条线索都用上,少一条就可能漏掉旧进程(见 lockOwnerPid 的注释)。
const owner = lockOwnerPid();
const old = [...new Set([...listenerPids(PORT), ...(owner ? [owner] : [])])];
if (old.length) {
  // 别盲目打断会被打断的任务。判据是「重启会**真断**几个」而不是「有几个在跑」。
  let data = await impact();
  let busy = countOf(data, "interrupted");
  // build 少说几十秒,这期间完全可能又有任务起跑 —— WAIT 模式再排一轮。
  if (busy > 0 && WAIT && !FORCE) {
    await drainWait();
    data = await impact();
    busy = countOf(data, "interrupted");
  }
  if (busy > 0 && !FORCE) {
    say(`  ✋ 重启会打断 ${busy} 个任务(判为 failed) —— 已中止,未重启服务端。`);
    for (const t of data.interrupted.slice(0, 8)) say(`     · ${t.title} —— ${t.reason}`);
    say("     让脚本替你等它们跑完:  WAIT=1 npm run restart");
    say("     确定要打断:            FORCE=1 npm run restart");
    say(`     (新代码已 build 进 dist,不会丢;只是暂不重启 :${PORT}。MCP 也未动。)`);
    process.exit(2);
  }
  // 走到这里 = 没有会被打断的任务。可能仍有任务在跑,但它们要么会被接管、要么会
  // 自动 --resume 接回 —— 如实说一句,别让用户以为闸失灵了。
  const safe = countOf(data, "survives");
  const lead = countOf(data, "resumes");
  if (safe > 0 || lead > 0) {
    say(`  ✓ 有任务在跑,但重启不会打断:${safe} 个会被接管(继续跑,无感)、${lead} 个调度台会自动接回。`);
  }
  if (busy > 0) say(`  ⚠ FORCE:打断 ${busy} 个**接管不了**的任务(判为 failed,可重试);会被接管的不受影响。`);
  for (const pid of old) killPid(pid);
}

// 不管上面找没找到旧进程,端口都必须**彻底安静**才能起新的。这是全脚本唯一不依赖
// 任何系统命令的判据,也是「谎报成功」的最后一道闸 ——
// 2026-08-21 那台 Rocky 容器里 lsof/ss/fuser 一个都没有,`old` 是空的,旧进程原封
// 不动;新进程起来撞上单实例锁当场退出,而 /api/health 由**老进程**照常回 200,脚本
// 于是打印「✓ 已就绪」。用户看到的是成功,机器上跑的是三小时前的代码。
for (let i = 0; i < 75 && (await localJson(PORT, "/api/health")); i++) await sleep(200);
if (await localJson(PORT, "/api/health")) {
  say(`  ✕ :${PORT} 上仍有一个 ash 在应答,没能让它下线 —— 已中止,未重启服务端。`);
  say(`     (新代码已 build 进 dist,不会丢;继续跑的是旧代码。)`);
  if (old.length) say(`     试过 kill:${old.join(", ")} —— 它没退,或者应答的根本是别的进程。`);
  else say("     一个候选 pid 都没找到:这台机器上 lsof/ss/fuser 可能都没装,锁文件也没读到。");
  say(`     手工确认它是谁:  cat ${LOCK_FILE}`);
  say("                       ps -ef | grep server/dist/index.js");
  say("     然后 kill 掉它,再重跑一次 npm run restart。");
  process.exit(1);
}

// 起一个脱离本进程的 server:helper 自己退出后 child 归给 init/服务管理器,
// 跟着完整继承这里的 cwd 与环境(理由见 start-detached.mjs 顶部)。
const started = spawnSync(process.execPath, ["scripts/start-detached.mjs", LOG, SERVER_NODE, SERVER_ENTRY], {
  encoding: "utf8",
  stdio: ["ignore", "pipe", "inherit"],
});
const serverPid = Number((started.stdout || "").trim());
if (started.status !== 0 || !Number.isInteger(serverPid) || serverPid <= 0) {
  say(`  ✕ :${PORT} 启动命令拉起失败,看 ${LOG}`);
  process.exit(1);
}

let ready = false;
let impostor = 0;
const deadline = Date.now() + START_TIMEOUT * 1000;
while (Date.now() < deadline) {
  const health = await localJson(PORT, "/api/health");
  // 认「就绪」之前先认人:health 带 pid 是为了让这里能分辨「新进程起来了」和「端口
  // 上还坐着另一个 ash」。旧版本 server 没有这个字段(undefined),那就退回只看通不通
  // —— 上面那道「必须先安静」的闸已经保证了此刻端口上不会有别人。
  if (health && (!health.pid || health.pid === serverPid)) {
    ready = true;
    break;
  }
  if (health?.pid) impostor = health.pid;
  // 启动进程已经退出就别傻等满超时；反之给迁移/重启接管留足时间。
  if (!isPidAlive(serverPid)) break;
  await sleep(200);
}
if (ready) {
  say(`  ✓ :${PORT} 已就绪(pid ${serverPid},日志 ${LOG})`);
} else if (impostor) {
  say(`  ✕ :${PORT} 上应答的是 pid ${impostor},不是刚起的 ${serverPid} —— 重启没生效,跑的还是旧代码。看 ${LOG}`);
  process.exit(1);
} else {
  say(isPidAlive(serverPid)
    ? `  ✕ :${PORT} 等待 ${START_TIMEOUT}s 仍未就绪,但启动进程还在运行;看 ${LOG}`
    : `  ✕ :${PORT} 启动进程已退出,看 ${LOG}`);
  process.exit(1);
}

say("▶ 3/3 刷新 ash MCP…");
// 谁手里还握着 MCP 通道。**在服务端重启完之后才问**:此刻接管已经做完,答案是最新的。
// 拿不到(server 没起来/老版本没这个字段)算 0,退回原来的行为。
const after = await impact();
const holders = countOf(after, "mcpDisrupted");
if (process.env.SKIP_MCP) {
  say("  ⏭ SKIP_MCP:跳过——不动 MCP 子进程,正在用 ash MCP 的会话不会被打断。");
  say("     (代价:这些会话仍跑旧 mcp/dist;只有改了 mcp/ 才需去掉 SKIP_MCP 再跑一次。)");
} else if (holders > 0 && !process.env.FORCE_MCP && !FORCE) {
  // 默认不掐断正在干活的 agent:刷新 MCP 的收益只是"旧会话用上新 mcp 代码",
  // 代价却是它这一轮的交卷调用当场失败(2026-08-06 验证白跑)。收益远小于代价,
  // 所以默认让路,并把出路说清楚。
  say(`  ⏭ 有 ${holders} 个正在干活的 agent 手里握着 ash MCP 通道,已跳过刷新以免掐断它们的交卷。`);
  for (const t of after.mcpDisrupted.slice(0, 8)) say(`     · ${t.title} (pid ${t.pid})`);
  say(`     (:${PORT} 已经是新代码;这些会话仍跑旧 mcp/dist。)`);
  say("     改了 mcp/ 需要立刻生效:  FORCE_MCP=1 npm run restart");
} else {
  const stale = pidsRunningScript(join(REPO, "mcp", "dist", "index.js"));
  if (stale.length) {
    if (holders > 0) say(`  ⚠ 强制刷新:${holders} 个在跑的 agent 手里的 MCP 通道会被掐断,它们这一轮的交卷调用会失败。`);
    for (const pid of stale) killPid(pid);
    say(`  ✓ 清掉 ${stale.length} 个旧 MCP 进程,下次会话/调用即用新代码`);
  } else {
    say("  (没有在跑的旧 MCP 进程;新会话会直接用新 mcp/dist)");
  }
}

say("✅ 完成。提示:已经开着的 Codex/Claude 会话要重连或重开,才会用上新的 ash MCP。");
