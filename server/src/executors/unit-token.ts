// **agent 这一侧的「资源记号」** —— 生成、种进环境、登记到句柄、查回来。判定层不在这里。
//
// 为什么 agent 也要记号,而不是继续靠继承的追踪 fd:**漏停的从来不是根**。agent 起的长跑
// 程序(dev server、`--watch`)挂在 `sh → node → node` 这条链的末端,根一死它就被系统改挂到
// 1 号名下,从进程树上消失;而追踪 fd 接不住它 —— libuv 起子进程时丢掉 ≥3 号 fd。实测
// (`sh` 那一层握着追踪文件、它再起的 node 孙子不在 lsof 名单里,而环境记号两层都在):
//
//   | 凭证            | sh←node | node←node(孙子) |
//   |-----------------|---------|------------------|
//   | 追踪 fd(lsof)  | 持有    | **不在名单**     |
//   | 环境记号        | 带着    | **带着**         |
//
// 所以这两条是**互补**的,不是替换关系:fd 那条在 `sh` 这一层给出独立的第二份证据(它不随
// 环境被改写而消失),记号那条才跨得过 exec 与根死亡。两条都保留,判定层各取所需。
//
// ── 记号用的是哨兵那一份,不是另造一个 ─────────────────────────────────────────
//
// 变量名、扫描、四档判定全部复用 `monitor-unit-scan.ts` / `proc.ts`:那一套经过十九轮审查
// 打磨(平台证据等级、代次与记号同源、`unattributed` 按记号单列…),再抄一份只会漂。名字里
// 带 `MONITOR` 是历史,机制本身与哨兵无关 —— 扫描按记号归堆,全仓唯一的读法是
// `proc.ts` 的 `scan.marks.get(token)`(精确查),没有任何地方遍历全部记号做清扫,所以两边
// 共用一个变量名不会让 agent 的进程被哨兵的回收碰到。
//
// **平台边界如实说**:win32 读不到别的进程的环境块(`monitorUnitProofGrade()` 返回 null),
// 那边种了也查不回来,归属只能靠 pid + ppid 树那条路。种仍然要种 —— 将来拿得到就能用,
// 而且 `taskkill /T` 那条路不受影响。
import { randomBytes } from "node:crypto";
import type { ChildProcess } from "node:child_process";
import { MONITOR_UNIT_ENV, invalidateMonitorUnitScan } from "../monitor-unit-scan.js";

/**
 * 这一次运行独有的记号。
 *
 * 为什么是随机的,而不是 `sessionId + 回合起点` 那种可重算的派生值:同一条会话的同一个回合
 * **可以合法地跑两次**(失败重试、引导打断后再起),派生值撞上就把两次运行混成同一项资源 ——
 * 那正是哨兵第 12 轮审查踩过的坑(「同一条命令可以合法地被创建两次」)。随机值撞不上,代价
 * 是它必须落库才能跨重启认回来(`sessions.agent_unit_token`)。
 */
export function mintUnitToken(): string {
  return `ash-agent-${process.pid.toString(36)}-${Date.now().toString(36)}-${randomBytes(6).toString("hex")}`;
}

/**
 * 生成记号并种进这一份 env,返回记号本身。
 *
 * **调用方拿到之后要做两件事**:`registerUnitToken(child, token)`(让击杀路径查得到),以及
 * 落库(让重启后的接回路径查得到)。两件都做不到的话,这一次运行的后代就只剩 pid 那条粗线索。
 *
 * 落库**晚于** spawn 这一点是如实接受的:要做到「起进程之前就落库」得改穿六层签名
 * (spawnAgent / spawnDetachedAgent / spawnForRun / spawnControllableForRun / 各执行器的
 * start / opts 类型),而这个窗口是毫秒级,失败模式也只是**降级**:库里有 pid 没记号的那一行,
 * 读侧退回 `unprovable` ⇒ 保留证据、不下刀、记责任,不会误杀。`agent_pid` 本来也是 spawn
 * 之后才写的,所以这不是新增的脆弱点。
 */
export function seedUnitToken(env: NodeJS.ProcessEnv): string {
  const token = mintUnitToken();
  env[MONITOR_UNIT_ENV] = token;
  return token;
}

const unitTokens = new WeakMap<ChildProcess, string>();

/**
 * 起完进程登记记号。**同时把上一次扫描作废** —— 缓存只会朝一个方向出错,而那个方向是致命的:
 * 一次比这个进程还老的扫描里当然没有它的记号,于是「线索已追空」被当场判成立(理由与作废点
 * 见 monitor-unit-scan.ts 的 `invalidateMonitorUnitScan`)。
 */
export function registerUnitToken(child: ChildProcess, token: string | null): void {
  if (token) unitTokens.set(child, token);
  invalidateMonitorUnitScan();
}

/** 合成句柄与真进程成对出厂时调用:两者是同一个进程,记号也是同一个。 */
export function shareUnitToken(source: ChildProcess, target: ChildProcess): void {
  const token = unitTokens.get(source);
  if (token) unitTokens.set(target, token);
}

/** 重启后接回一个号时调用:记号从库里读回来,此后它与这个合成句柄同生命周期。 */
export function adoptUnitToken(child: ChildProcess, token: string | null | undefined): void {
  if (token) unitTokens.set(child, token);
}

/** `null` = 这个句柄没有记号(老会话行、种失败、或者 Windows 上问不回来)⇒ 退回粗判据。 */
export function unitTokenOf(child: ChildProcess): string | null {
  return unitTokens.get(child) ?? null;
}
