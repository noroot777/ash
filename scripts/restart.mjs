#!/usr/bin/env node
// 一条龙:重建全部 → 重启 :4317 服务端 → 刷新 ash MCP。
//
//   npm run restart            # 或直接 node scripts/restart.mjs
//   node scripts/restart.mjs --force # 强制重启并刷新 MCP(被打断的任务标为 failed)
//   node scripts/restart.mjs --wait  # 等会被打断的任务排空再重启,而不是中止
//   node scripts/restart.mjs --skip-mcp # 只重建+重启 :4317,不刷新 MCP(不打断正在用 ash MCP 的会话)
//   node scripts/restart.mjs --force-mcp # 明知有 agent 正握着 MCP 通道,也照样刷新(会掐断它们的交卷)
//
// 跑法说明:
//  - :4317 跑的是编译后的 dist,所以改完源码必须先 build 再重启,本脚本一并做掉。
//  - 安全闸的判据是「重启会**真正打断**几个任务」，不是「有几个在跑」：agent 的
//    输出走文件之后（server/src/executors/detached.ts），单飞任务的进程不随 server
//    死，重启后按 pid+offset 接管、全程无感；团队调度台进程会断但自动 --resume
//    接回。真会被判 failed 的只剩：旧代码起的（没 agent_pid）、queued 还没起进程
//    的、进程已经不在的。所以「有 3 个任务在跑」现在完全可能是可以随意重启的。
//    判据单点在 server 的 /api/restart-impact,跟真正接管时用同一条口径。
//  - --force 表示确定要打断。build 已完成不会丢，只是先不动服务端。
//  - --wait 把「人守着等排空」换成「脚本替你等」:先等空再 build,build 期间若又
//    有任务起跑就再等一轮,然后重启。WAIT_TIMEOUT=<秒> 可设上限(默认无限等),
//    等待期间 Ctrl-C 随时可退。FORCE 优先于 WAIT(既然要强杀就不必等)。
//    注意残留竞态:检查与 kill 之间仍可能有 queued 任务抢跑,于是它**没被等到**——
//    真正关死这个窗口需要服务端的 drain 模式(停止启动新任务并如实报告已排空),这里
//    够不着。但那只影响「等没等干净」这个账:抢跑的那个 agent **不会被这一刀杀掉**
//    (Windows 那边按壳记号认人,见 platform.mjs 的 killServerProcess)。
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
import { IS_WINDOWS, isNotListening, isPidAlive, killPid, killServerProcesses, listenerPids, localGet, localJson, pidsRunningScript, sleep } from "./platform.mjs";
import { WORKSPACE_FAIL_HINT, inspectNpmConfig, inspectWorkspaces } from "./workspace-check.mjs";
import { repairEmptyWorkspaces } from "./workspace-repair.mjs";
import { parseRestartOptions, restartCommand, RESTART_USAGE } from "./restart-options.mjs";

let options;
try {
  options = parseRestartOptions();
} catch (error) {
  process.stderr.write(`✕ ${error.message}\n运行 ${restartCommand("--help")} 查看用法。\n`);
  process.exit(2);
}
if (options.help) {
  process.stdout.write(`${RESTART_USAGE}\n`);
  process.exit(0);
}

const REPO = fileURLToPath(new URL("..", import.meta.url));
process.chdir(REPO);

const PORT = Number(process.env.PORT || 4317);
const LOG = process.env.ASH_LOG || join(IS_WINDOWS ? (process.env.TEMP || ".") : "/tmp", `ash-${PORT}.log`);
const START_TIMEOUT = Number(process.env.START_TIMEOUT || 30);
const SERVER_NODE = process.env.SERVER_NODE || process.execPath;
// 起哪个入口。默认就是编译产物;留一个口子是为了 test-restart.mjs 能拿一个假 server
// 跑完整条流程(否则那条回归只能靠 stub 掉半个脚本,测的就不是真路径了)。
const SERVER_ENTRY = process.env.SERVER_ENTRY || "server/dist/index.js";
const FORCE = options.force;
const WAIT = options.wait;
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
 * 宿主机运维者的凭证:锁文件里那串 token(server 自己写的,文件 0600)。
 *
 * 多人模式下 `/api/restart-impact` 会挡住未登录请求 —— 而跑这个脚本的人手上没有任何
 * 网页登录态。读得到这个 token = 读得到 ash 的数据目录 = 本来就能直接读库,所以拿它
 * 当「我就是这台机器的运维者」的证明既够用也不额外扩大暴露面(server/src/singleton.ts
 * `liveLockToken`)。
 */
function hostToken() {
  try {
    const lock = JSON.parse(readFileSync(LOCK_FILE, "utf8"));
    return lock?.port === PORT && typeof lock.token === "string" ? lock.token : null;
  } catch {
    return null;
  }
}

/**
 * 「现在重启会真正打断几个任务」。**不是** running/queued 的个数 —— agent 的输出
 * 走文件之后（server/src/executors/detached.ts），单飞任务的进程压根不随 server 死，
 * 重启后按 pid+offset 接管，全程无感；团队调度台进程会断但会自动 --resume 接回。
 * 判据单点在 server 的 /api/restart-impact，跟真正接管时用同一条口径，免得这边说能
 * 接、那边又不认。
 *
 * 回答分**三档**,而不是「拿到 / 没拿到」两档:
 *  · 拿到判据          → 原样返回
 *  · `refused`         服务端答了、但不给判据(多人模式要凭证,见 hostToken)
 *  · `unknown`         **问不出来**:超时、连接被重置
 *  · `{}`              端口上压根没人在听 = server 没在跑 = 本来就没有任务会被打断
 *
 * 后两者过去被压成同一个 `{}`,于是 ash 响应慢的时候安全闸静默变成 0:不加 FORCE 的重启
 * 照样下刀,保护名单还跟着变成空数组(第 1 轮审查 F1 / P1 是同一类错)。
 * **「问不出来」不等于「没有」**,所以这里把它单独报出来,由 impactOrAbort 去 fail closed。
 */
async function impact() {
  const token = hostToken();
  const ask = (timeoutMs) => localGet(
    PORT,
    "/api/restart-impact",
    timeoutMs,
    token ? { "x-ash-host-token": token } : undefined,
  );
  let probe = await ask(2000);
  // 慢一次不代表问不出来(重启前这台机器往往正忙):再给一次、时限放宽。注意这**不是**
  // 修 F1 的办法 —— 两次都没拿到仍然算 unknown,下面照样中止。加这一次只是少一点误拦。
  if (!probe.json && probe.status === null && !isNotListening(probe.error)) probe = await ask(6000);
  if (probe.json) return probe.json;
  if (probe.status !== null) return { refused: probe.status };
  if (isNotListening(probe.error)) return {};
  return { unknown: probe.error || "unknown" };
}

function countOf(data, field) {
  return Array.isArray(data[field]) ? data[field].length : 0;
}

/** 服务端答了、但没给出判据。 */
function refusedStatus(data) {
  return typeof data.refused === "number" ? data.refused : null;
}

/** 连上了却没拿到答复(超时 / 被重置)。 */
function unknownReason(data) {
  return typeof data.unknown === "string" ? data.unknown : null;
}

/** 「判据问不到」时给人看的那半句话；拿到了判据就返回 null。 */
function noVerdictReason(data) {
  const refused = refusedStatus(data);
  if (refused !== null) return `服务端回 ${refused}`;
  const unknown = unknownReason(data);
  return unknown === null ? null : `服务端在端口上，但没答复这条判据（${unknown}）`;
}

/** build 那一步跑过没有 —— 只用来让中止提示说得准（见 impactOrAbort）。 */
let built = false;

/**
 * 问一次判据；服务端拒答就当场中止（FORCE 例外）。
 *
 * 每个读判据的地方都得走它 —— WAIT 轮询中途凭证失效(比如 server 换了锁)同样会让
 * 下游把 busy 读成 0，「只在第一处判一次」漏得掉这条路。
 */
async function impactOrAbort() {
  const data = await impact();
  const why = noVerdictReason(data);
  if (why === null || FORCE) return data;
  say(`  ✋ 问不到「重启会打断谁」(${why}) —— 已中止,未重启服务端。`);
  if (refusedStatus(data) !== null) {
    say(`     多人模式下这条判据要宿主机凭证:确认 ${LOCK_FILE} 读得到`);
    say("     (它由 server 自己写、权限 0600;换个用户跑这个脚本就读不到了)。");
  } else {
    // 这一档是「它在,只是没答上来」:ash 正忙,或者真卡住了。两种都不该让脚本自己拍板下刀
    // —— 问不出保护名单的那一刀,等于拿正在跑的任务赌一把(第 1 轮审查 F1)。
    say("     它还在端口上,只是没按时答复 —— ash 正忙,或者卡住了。");
    say("     「问不出来」不等于「没有任务会被打断」,所以这里不下刀。稍后重试;");
    say(`     真卡住了就先看日志 ${LOG},必要时手工 kill 掉它再重跑。`);
  }
  say(`     明知可能打断也要重启:  ${restartCommand("--force")}`);
  // WAIT 那一档在 build 之前就问,所以这句必须按实际走到哪儿说 —— 说反了会让人
  // 以为新代码已经落盘。
  say(built
    ? `     (新代码已 build 进 dist,不会丢;只是暂不重启 :${PORT}。MCP 也未动。)`
    : "     (什么都没动:没 build、没重启,跑的还是旧代码。)");
  process.exit(2);
}

async function interruptCount() {
  return countOf(await impactOrAbort(), "interrupted");
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
let ws = inspectWorkspaces(REPO);
if (!ws.ok) {
  const repair = repairEmptyWorkspaces(REPO);
  for (const warning of repair.warnings) say(`  ⚠ ${warning}`);
  if (repair.restored.length) {
    say(`  ✓ 已从 HEAD 恢复空 workspace:${repair.restored.join("、")}(未改暂存区,未覆盖已有文件)`);
    ws = inspectWorkspaces(REPO);
  }
}
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
built = true;

say(`▶ 2/3 重启 :${PORT} 服务端…`);
// 端口 ∪ 锁文件:两条线索都用上,少一条就可能漏掉旧进程(见 lockOwnerPid 的注释)。
const owner = lockOwnerPid();
const old = [...new Set([...listenerPids(PORT), ...(owner ? [owner] : [])])];
if (old.length) {
  // 别盲目打断会被打断的任务。判据是「重启会**真断**几个」而不是「有几个在跑」。
  // 问不出判据就中止(impactOrAbort):静默按 0 继续正是这条闸失效的样子。
  let data = await impactOrAbort();
  let busy = countOf(data, "interrupted");
  // build 少说几十秒,这期间完全可能又有任务起跑 —— WAIT 模式再排一轮。
  if (busy > 0 && WAIT && !FORCE) {
    await drainWait();
    data = await impactOrAbort();
    busy = countOf(data, "interrupted");
  }
  if (busy > 0 && !FORCE) {
    say(`  ✋ 重启会打断 ${busy} 个任务(判为 failed) —— 已中止,未重启服务端。`);
    for (const t of data.interrupted.slice(0, 8)) say(`     · ${t.title} —— ${t.reason}`);
    say(`     让脚本替你等它们跑完:  ${restartCommand("--wait")}`);
    say(`     确定要打断:            ${restartCommand("--force")}`);
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
  // 「会被接管的不受影响」在 Windows 上得自己兑现:那边没有信号,旧版这一刀是
  // `taskkill /T /F`,/T 按父子关系把整棵树一起杀 —— agent 的输出早就落盘了,是这一刀
  // 把它们带走的。所以把 survives 的那几棵子树点名保住(判据见 platform.mjs 的
  // killServerProcess)。POSIX 上这个参数没有作用:SIGTERM 从来不级联。
  //
  // 这份名单是**上一时刻**的快照,所以它只是个额外输入:真正的不变量在
  // killServerProcess 那边 —— 它按进程表里的壳记号认人,名单漏了的新 agent 也保得住
  // (第 1 轮审查 F2)。走到这儿时判据一定是问到了的(问不到 impactOrAbort 已经中止)。
  const spare = Array.isArray(data.survives) ? data.survives.map((t) => t.pid) : [];
  let how = "signal";
  try {
    how = killServerProcesses(old, spare, { force: FORCE });
  } catch (error) {
    say(`  ✋ 无法安全终止 Windows 旧实例: ${error.message}。已中止重启。`);
    say(`     未授权整树强杀;确定接受任务中断才使用 ${restartCommand("--force")}。`);
    process.exit(2);
  }
  if (IS_WINDOWS && safe > 0 && how !== "selective") {
    say(`  ⚠ 这一刀走的是整树强杀(taskkill /T),${safe} 个本可接管的任务会跟着断 ——`);
    say("     只有问得到判据(survives 名单)时才能点名保住它们。");
  }
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
let readyHealth = null;
const deadline = Date.now() + START_TIMEOUT * 1000;
while (Date.now() < deadline) {
  const health = await localJson(PORT, "/api/health");
  // 认「就绪」之前先认人:health 带 pid 是为了让这里能分辨「新进程起来了」和「端口
  // 上还坐着另一个 ash」。旧版本 server 没有这个字段(undefined),那就退回只看通不通
  // —— 上面那道「必须先安静」的闸已经保证了此刻端口上不会有别人。
  if (health && (!health.pid || health.pid === serverPid)) {
    ready = true;
    readyHealth = health;
    break;
  }
  if (health?.pid) impostor = health.pid;
  // 启动进程已经退出就别傻等满超时；反之给迁移/重启接管留足时间。
  if (!isPidAlive(serverPid)) break;
  await sleep(200);
}
if (ready) {
  say(`  ✓ :${PORT} 已就绪(pid ${serverPid},日志 ${LOG})`);
  // 「上一次服务是怎么停的」只有在这一刻说才有人读。新 server 启动时如果发现上一轮的
  // 单例锁还在,它会报**证据等级**:账本里有那一轮的退出意向,还是连记录都没有。
  //
  // **两档都不许说成死因**。锁还在只证明那一轮的清理没完成:删锁本身会失败(数据目录
  // 只读就 EACCES),而「记完账、释放锁的路上又被强杀」留下的是同一个现场 —— 第 2 轮
  // 审查实测过。所以这里不说「是正常停的」,也不说「是被强杀的」。
  const residual = readyHealth?.previousResidualLock;
  const ledgerPath = LOCK_FILE.replace(/\.ash\.lock$/, ".exits.jsonl");
  if (residual?.evidence === "exit_intent") {
    const intent = residual.observedIntent;
    const how = intent?.signal ? `收到 ${intent.signal}` : `退出码 ${intent?.code ?? "未知"}`;
    say(`  ⚠ 上一实例(pid ${residual.pid})留下了单例锁,账本里有它的退出意向(${how})—— 它进入过退出流程,但清理没完成。`);
    say("     最终死因仍然未知:删锁失败(数据目录不可写)和「记完账之后又被强杀」是同一个现场。");
    say(`     先看数据目录权限;要分辨是不是被强杀,只能查系统日志。账本:${ledgerPath}`);
  } else if (residual) {
    const alive = residual.lastHeartbeatAt
      ? `最后已知存活 ${residual.lastHeartbeatAt}`
      : "连最后存活时刻都没有(上一实例是旧版本,锁里没心跳)";
    say(`  ⚠ 上一实例(pid ${residual.pid})留下了单例锁,账本里没有它的任何记录 —— 最终死因未知:${alive}。`);
    say("     可能是强杀/内核击杀,也可能是退出时连账本都没写进去。这不是重启失败,服务已经起来了。");
    say(`     账本:${ledgerPath}`);
  }
  if (residual && process.platform === "darwin") {
    // 系统日志那条命令只有 macOS 有,而且 zsh 里 `log` 被遮蔽,必须写全路径。
    say(`     /usr/bin/log show --last 1h --predicate 'eventMessage CONTAINS "${residual.pid}"'`);
  } else if (residual && !IS_WINDOWS) {
    say(`     查内核日志:journalctl -k --since -1h | grep -i -e oom -e kill`);
  }
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
// server 没起来/老版本没这个字段算 0,退回原来的行为;**服务端拒答则当作「有人握着」**
// —— 掐断在跑的 agent 是不可逆的,不知道就别掐(第 1 轮审查 P1 的同一条判据)。
const after = await impact();
// 「不知道」两档都算(拒答 / 没答上来):掐断在跑的 agent 是不可逆的,不知道就别掐。
const mcpWhy = noVerdictReason(after);
const mcpUnknown = mcpWhy !== null;
const holders = countOf(after, "mcpDisrupted");
if (options.skipMcp) {
  say("  ⏭ SKIP_MCP:跳过——不动 MCP 子进程,正在用 ash MCP 的会话不会被打断。");
  say("     (代价:这些会话仍跑旧 mcp/dist;只有改了 mcp/ 才需去掉 --skip-mcp / SKIP_MCP 再跑一次。)");
} else if (mcpUnknown && !options.forceMcp && !FORCE) {
  say(`  ⏭ 问不到「谁还握着 MCP 通道」(${mcpWhy}),已跳过刷新 —— 宁可让旧会话跑旧 mcp,也不冒险掐断在跑的 agent。`);
  say(`     确定要刷新:  ${restartCommand("--force-mcp")}`);
} else if (holders > 0 && !options.forceMcp && !FORCE) {
  // 默认不掐断正在干活的 agent:刷新 MCP 的收益只是"旧会话用上新 mcp 代码",
  // 代价却是它这一轮的交卷调用当场失败(2026-08-06 验证白跑)。收益远小于代价,
  // 所以默认让路,并把出路说清楚。
  say(`  ⏭ 有 ${holders} 个正在干活的 agent 手里握着 ash MCP 通道,已跳过刷新以免掐断它们的交卷。`);
  for (const t of after.mcpDisrupted.slice(0, 8)) say(`     · ${t.title} (pid ${t.pid})`);
  say(`     (:${PORT} 已经是新代码;这些会话仍跑旧 mcp/dist。)`);
  say(`     改了 mcp/ 需要立刻生效:  ${restartCommand("--force-mcp")}`);
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
