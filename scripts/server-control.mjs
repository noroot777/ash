// restart.mjs 与 stop.mjs 共用的「让 :PORT 上的 ash 下线」那半截:问判据、等排空、
// 认准监听者下刀、等端口彻底安静。两个入口只在「下线之后做什么」上不同,安全闸必须是
// 同一份 —— 停止命令要是另写一套,「问不出来就当 0」那类旧错就会在新入口上重演一遍。
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { isNotListening, killServerProcesses, localGet, sleep } from "./platform.mjs";

/** 单实例锁:server 自己写的「谁占着这个 DB」,路径口径跟 server/src/singleton.ts 一致。 */
export function lockFileFor(repo, env = process.env) {
  return `${env.ASH_DB ? resolve(env.ASH_DB) : join(repo, "data", "ash.db")}.ash.lock`;
}

/**
 * 宿主机运维者的凭证:锁文件里那串 token(server 自己写的,文件 0600)。
 *
 * 多人模式下 `/api/restart-impact` 会挡住未登录请求 —— 而跑脚本的人手上没有任何网页
 * 登录态。读得到这个 token = 读得到 ash 的数据目录 = 本来就能直接读库,所以拿它当
 * 「我就是这台机器的运维者」的证明既够用也不额外扩大暴露面(server/src/singleton.ts
 * `liveLockToken`)。
 */
function hostToken(lockFile, port) {
  try {
    const lock = JSON.parse(readFileSync(lockFile, "utf8"));
    return lock?.port === port && typeof lock.token === "string" ? lock.token : null;
  } catch {
    return null;
  }
}

/**
 * 「现在让 server 下线会真正打断几个任务」。**不是** running/queued 的个数 —— agent 的
 * 输出走文件之后（server/src/executors/detached.ts），单飞任务的进程压根不随 server 死，
 * 下次起来按 pid+offset 接管；团队调度台进程会断但会自动 --resume 接回。判据单点在
 * server 的 /api/restart-impact，跟真正接管时用同一条口径。
 *
 * 回答分**三档**,而不是「拿到 / 没拿到」两档:
 *  · 拿到判据          → 原样返回
 *  · `refused`         服务端答了、但不给判据(多人模式要凭证,见 hostToken)
 *  · `unknown`         **问不出来**:超时、连接被重置
 *  · `{}`              端口上压根没人在听 = server 没在跑 = 本来就没有任务会被打断
 *
 * 后两者过去被压成同一个 `{}`,于是 ash 响应慢的时候安全闸静默变成 0(第 1 轮审查 F1 / P1)。
 * **「问不出来」不等于「没有」**,所以这里把它单独报出来,由调用方 fail closed。
 */
export async function queryImpact(port, lockFile) {
  const token = hostToken(lockFile, port);
  const ask = (timeoutMs) => localGet(
    port,
    "/api/restart-impact",
    timeoutMs,
    token ? { "x-ash-host-token": token } : undefined,
  );
  let probe = await ask(2000);
  // 慢一次不代表问不出来(这台机器往往正忙):再给一次、时限放宽。两次都没拿到仍然算 unknown。
  if (!probe.json && probe.status === null && !isNotListening(probe.error)) probe = await ask(6000);
  if (probe.json) return probe.json;
  if (probe.status !== null) return { refused: probe.status };
  if (isNotListening(probe.error)) return {};
  return { unknown: probe.error || "unknown" };
}

export function countOf(data, field) {
  return Array.isArray(data[field]) ? data[field].length : 0;
}

/** 服务端答了、但没给出判据。 */
export function refusedStatus(data) {
  return typeof data.refused === "number" ? data.refused : null;
}

/** 「判据问不到」时给人看的那半句话；拿到了判据就返回 null。 */
export function noVerdictReason(data) {
  const refused = refusedStatus(data);
  if (refused !== null) return `服务端回 ${refused}`;
  const unknown = typeof data.unknown === "string" ? data.unknown : null;
  return unknown === null ? null : `服务端在端口上，但没答复这条判据（${unknown}）`;
}

/** 问不到判据时,解释成因的那几行(中止与否、出路命令由调用方说)。 */
export function explainNoVerdict(data, { say, lockFile, log }) {
  if (refusedStatus(data) !== null) {
    say(`     多人模式下这条判据要宿主机凭证:确认 ${lockFile} 读得到`);
    say("     (它由 server 自己写、权限 0600;换个用户跑这个脚本就读不到了)。");
    return;
  }
  // 这一档是「它在,只是没答上来」:ash 正忙,或者真卡住了。两种都不该让脚本自己拍板下刀
  // —— 问不出保护名单的那一刀,等于拿正在跑的任务赌一把(第 1 轮审查 F1)。
  say("     它还在端口上,只是没按时答复 —— ash 正忙,或者卡住了。");
  say("     「问不出来」不等于「没有任务会被打断」,所以这里不下刀。稍后重试;");
  say(`     真卡住了就先看日志 ${log},必要时手工 kill 掉它再重跑。`);
}

/**
 * --wait 用:轮询到「不再有会被打断的任务」为止,把「人守着等」换成「脚本替你等」。
 * `count` 每次都得走调用方的 fail-closed 判据(中途凭证失效同样会把 busy 读成 0)。
 */
export async function drainWait({ count, waitTimeout, say, verb }) {
  let n = await count();
  if (!n) return;
  say(`  ⏳ WAIT:还有 ${n} 个任务${verb}会被打断,等它们跑完(Ctrl-C 可随时放弃)…`);
  let elapsed = 0;
  const step = 5;
  while (n > 0) {
    if (waitTimeout !== null && elapsed >= waitTimeout) {
      say(`  ✕ WAIT 超时(${waitTimeout}s),仍有 ${n} 个会被打断 —— 已中止,未${verb}服务端。`);
      process.exit(3);
    }
    await sleep(step * 1000);
    elapsed += step;
    n = await count();
    if (elapsed % 60 === 0 && n > 0) say(`  ⏳ 已等 ${elapsed / 60}min,还有 ${n} 个会被打断…`);
  }
  say("  ✓ 已经没有会被打断的任务了,继续。");
}

/**
 * 对监听者下刀,保住活得过下线的 agent。
 *
 * 「会被接管的不受影响」在 Windows 上得自己兑现:那边没有信号,整树 `taskkill /T` 会把
 * agent 一起带走,所以把 survives 的那几棵子树点名保住(判据见 platform.mjs 的
 * killServerProcess)。这份名单是**上一时刻**的快照,只是个额外输入:真正的不变量在
 * killServerProcess 那边按进程表里的壳记号认人(第 1 轮审查 F2)。POSIX 上 SIGTERM 不级联。
 * Windows 上无法安全认人时抛错,由调用方中止。
 */
export function killListeners(pids, data, { force }) {
  const spare = Array.isArray(data.survives) ? data.survives.map((t) => t.pid) : [];
  return killServerProcesses(pids, spare, { force });
}

/**
 * 端口是否**彻底安静**。「安静」只认连接被明确拒绝:超时、连接被重置都只是「问不出来」,
 * 一个卡死的旧进程照样占着端口、照样不答(第 3 轮审查实测 EADDRINUSE)。
 * 这是唯一不依赖任何系统命令的判据 —— lsof/ss/fuser 都没装的机器上 listenerPids 是空的,
 * 旧进程原封不动,只有它能把「谎报成功」拦下来(2026-08-21 Rocky 容器)。
 */
export async function isPortQuiet(port) {
  return isNotListening((await localGet(port, "/api/health", 1000)).error);
}

export async function waitPortQuiet(port, timeoutMs = 15_000) {
  const by = Date.now() + timeoutMs;
  while (Date.now() < by && !(await isPortQuiet(port))) await sleep(200);
  return isPortQuiet(port);
}
