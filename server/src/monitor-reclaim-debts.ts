// 停不掉的那个进程:**回收责任**,以及「到底收干净了没有」这一问。
//
// 「生命周期已撤销 ⇒ 不许再有它的资源在跑」这条不变量有两半(第 3 轮审查 F1):不许再创建
// (资格闸,见 monitor-session.ts 的 `isTaskRevoked` 那一处),以及**现有资源要么已确认退出、
// 要么回收责任已经可靠落盘**。这个文件是后半,外加判「确认退出」的那把尺子。
//
// ── 为什么「停止函数正常返回」不算确认退出(第 4 轮审查 F1)──────────────────────
//
// `finish` 发完信号就写停止态返回:`killByPid` 是 SIGTERM + 两秒后补一刀 SIGKILL,而那把
// 补刀是个 `unref` 的定时器 —— **server 在这两秒里退出,它就永远不会落下**。于是「装了
// TERM 处理器的命令 + 删除后立刻重启」这条路上:任务行、哨兵行都没了(删除紧接着就删),
// 进程还在后台跑着,接回只枚举 running 行、债表里又一笔都没有,谁都再找不到它
// (审查实测 `F1_AFTER_RECOVERY_STILL_ALIVE`)。
//
// 所以责任**在发信号之前**就落盘(第一次写),确认退出之后才销账 —— 任何一步之后 server 挂
// 掉,这一笔都还在;而销账的唯一依据是「确认它不在了」,查不到、问不出一律不算。
//
// ── 退出确认要覆盖整个进程组 ───────────────────────────────────────────────────
//
// 组长死了不等于这一组空了(spawn.ts 的补刀注释说的是同一件事:外层 shell 老老实实退了,
// 它派生的那个忽略 TERM 的东西还留在组里)。POSIX 上唯一能覆盖后代的判据是
// `kill(-pgid, 0)`,所以这里用 `isProcessGroupAlive`;pid 复用的风险仍由 `processIdentity`
// 挡在**杀**那一侧(问得出身份才敢杀)。
//
// ── 这一圈归谁走:运行时收尾层(第 5 轮审查 F1)─────────────────────────────────
//
// 第 4 轮把这一圈装在了**回收层的包装函数**里(删除/审查收尾那两个入口),于是「不走那两个
// 入口的停止」全都绕过了记账:用户点停、到期、推满上限、启动接回判无出口、创建后登记失败
// —— 它们都直接调 `finish`,发完信号就写非运行态返回。审查实测两条:先点停再删除、以及任务
// 已终态时启动接回判无出口,都留下 `debtRows=0` 而命令仍活,重启后再也找不回它。
//
// 所以这一圈的唯一归宿是**真正拥有这个进程、并且会把它写成非运行态的那一层** ——
// `monitors.ts` 的 `finish`,它调 `reclaimMonitorProcess` + `settleReclaim`(见下)。回收层
// 只剩两件事:判资格,以及**销毁持久身份之前按责任核对一遍**(不看卡片状态,见
// monitor-reclaim.ts 的 `accountForLiveProcesses`)。
//
// ── 「问不出来」不是「已经退了」(第 6 轮审查 F1)────────────────────────────────
//
// 第 5 轮把「身份对不上」和「这一问本身失败了」挤进同一个 `unknown`,又让非运行态的那条路
// **不记责任直接返回 null** —— 于是 `ps` 短暂不可用的那几秒里:启动接回把行写成 `lost` 并
// 声称「这个进程已经不在了」,紧接着的删除拿到同一个 null、核对直接放行,任务行、哨兵行、
// 债表三处同时为空,而那个命令还在后台跑着,之后谁也找不回它(审查用「PATH 前置一个退出码
// 1 的 ps」实测:`AFTER_REATTACH_OUTAGE debtRows=0` → `BEFORE_SERVER_EXIT taskRows=0` →
// `AFTER_RECOVERY alive=true`)。
//
// 两条修法,都在这一层:
//
// ① **状态分四档可判 + 两档不可判**(见 `ReclaimState`)。`gone` 用 `kill(-pgid,0)` 判、
//    「组长还在吗」用 `kill(pid,0)` 判、身份用 ps 判 —— 哪一问失败就只污染它自己那一档,
//    不再冒充别的结论。
// ② **返回值必须是全的**(见 `ReclaimOutcome`):`settled`(确认退出)/`owed`(责任已落盘)/
//    `unaccounted`(该留责任却没留下来)三者互斥,空值不再同时表示「没什么可收」和
//    「不敢判断」。每个调用点都得把第三种当失败处理 —— 销毁身份那条路整笔中止,其余至少
//    出声并继续重试落盘。
import { eq, inArray } from "drizzle-orm";
import { db, dbClient } from "./db/index.js";
import { monitorReclaimDebts } from "./db/schema.js";
import { killByPid } from "./executors/spawn.js";
import { IS_WINDOWS, isPidAlive, isProcessGroupAlive, killTree } from "./platform.js";
import { processIdentity } from "./proc.js";
import { now } from "./util.js";

/**
 * 这一条此刻处在哪一档。**每一档只声称那一问真的答出来的东西。**
 *
 * **五档,每一档对应一个真的问出了结果的问题**(整组还有人吗 / 组长还在吗 / 这个号上是谁):
 * - `gone` = 确认收干净了(POSIX:整组已空)。**只有这一档能销账。**
 * - `ours-alive` = 还在,而且组长身份对得上 —— 可以接着杀。
 * - `ours-orphans` = **组长已经不在了,组里还有人**。那几个只可能是我们的后代:组长这个 pid
 *   现在是空的(`kill(pid,0)` 报 ESRCH),没有别人能当这一组的组长;而外人要加进来得
 *   `setpgid` 到同一个会话里去,那个会话的头正是这条哨兵自己。所以这一档**在刚刚还拥有它的
 *   那一层**可以放心杀(`finish`),隔了一次重启就不行了 —— 见 `reclaimMonitorProcess` 的
 *   `fresh`。
 * - `not-ours` = 这个号现在是**另一个**进程(ps 答出来了,启动时刻**确实**对不上;locale 不同
 *   由 `processIdentity` 在同一份快照上的时间戳比较兜住,不会被误报成这一档)。不许杀 —— 那是别人的进程。
 *
 * 剩下这三档**都不许据此销账**(也都不许下刀):
 * - `unknown` = **身份这一问自己失败了**:`kill(pid,0)` 说它活着,ps 却什么都答不出来
 *   (`inspectProcess` 把「不存在」和「ps 不可用」都返回 null)。拿它当「已经退了」就是把
 *   最后那一份责任丢掉(第 4 轮审查 F1),拿它当「不是我们的」就是在界面上撒谎
 *   (第 6 轮审查 F1)。
 * - `unverifiable` = **当初没记下启动时刻**,所以这一问**无从比对**:能证明的只有「这个号
 *   上现在有进程」。这一档必须跟 `ours-alive` 分开 —— 第 9 轮审查 F3:存量行(或任何一条
 *   `pid_started_at` 为空的行)原来会走到 `same` → `ours-alive` → **发击杀信号**,而那条
 *   路上「看见一个进程活着」被当成了「已证明有权回收它」。原命令早已跑完、号被系统复用时,
 *   下刀打的就是别人的进程(接回、清扫、重复停止三条路都消费这一档)。
 * - `not-ours` 同样不销账:我们能证明的只有「这个号上现在是别人」,证明不了**原来那个**
 *   已经退出 —— 它可能带着后代留在这一组里,只是组长的号被别人占了。三档的区别只在于
 *   **记下来的理由**和日志措辞,不在于要不要负责(`settleDebt` 会按档说清楚)。
 */
export type ReclaimState =
  | "gone" | "ours-alive" | "ours-orphans" | "not-ours" | "unverifiable" | "unknown";

/** 这一档是「确认收干净了」吗 —— **只有它能销账**。 */
const isReclaimedState = (state: ReclaimState): boolean => state === "gone";

/**
 * 身份这一问的三种答案 —— **判定本体不在这里,在 `proc.ts` 的 `processIdentity`**:
 * 一次 ps 快照、纯比较、三档结果。这一层只把它的三档换成这一摊的说法。
 *
 * **不许在这一层再问一次**。上一版这里是「原文不等就再调一次 `isSameProcess` 兼容
 * locale」:第一次查成功、第二次查失败时,那个 false 被读成确证的「是别人」,于是
 * `unqueryable` 这一档被悄悄吃掉 —— 一条还在跑的哨兵因此被接回判成 `lost`,随后被按债
 * 杀掉(第 7 轮审查 F1)。「问不出来」必须一路保留到调用方,消费者各补一次重试只会把
 * 同一个错换个地方犯。
 *
 * **只在 `kill(pid,0)` 已经说它活着时调**,所以 `unqueryable` 只剩一种解释:ps
 * (或 Windows 上那段 PowerShell)自己没答出来。
 *
 * `unverifiable`(当初没记启动时刻)**单独传上去**,不许折进 `ours`:见 `ReclaimState` 那一档。
 */
function identityOf(
  pid: number, recorded: string | null,
): "ours" | "theirs" | "unverifiable" | "unqueryable" {
  const verdict = processIdentity(pid, recorded);
  if (verdict === "same") return "ours";
  if (verdict === "different") return "theirs";
  return verdict === "unverifiable" ? "unverifiable" : "unqueryable";
}

/** 身份那一问的四档 → 这一摊的档位。**只有 `ours` 这一档敢下刀。** */
const stateOfIdentity = (who: ReturnType<typeof identityOf>): ReclaimState =>
  who === "ours" ? "ours-alive"
    : who === "theirs" ? "not-ours"
      : who === "unverifiable" ? "unverifiable" : "unknown";

export function reclaimState(pid: number, pidStartedAt: string | null): ReclaimState {
  if (!IS_WINDOWS) {
    if (!isProcessGroupAlive(pid)) return "gone";
    // 组里有人。组长还在吗 —— 这一问要用 `kill(pid,0)` 而不是 ps:ps 失败时 null 会被
    // 当成「组长已退」,于是一整组陌生进程被说成我们的后代。
    if (!isPidAlive(pid)) return "ours-orphans";
    return stateOfIdentity(identityOf(pid, pidStartedAt));
  }
  // win32 没有进程组这回事,`killTree` 打的是 `taskkill /T` 那棵树,能问的只有这个 pid 本身。
  // 用的还是原来那两个原语(pid 存活 + 身份),只是把「问不出来」从「身份对不上」里拆了出来
  // —— **这里不新增任何跨平台断言**(没有 Windows 真机实证之前不冒充;约定见根 AGENTS.md)。
  if (!isPidAlive(pid)) return "gone";
  return stateOfIdentity(identityOf(pid, pidStartedAt));
}

/**
 * 有界地等它退出。`killByPid` 的补刀在 +2 秒,所以默认等到 3 秒 —— 覆盖「优雅退出 + 补刀
 * 生效」,又不会把任务结算无限期吊在这里。
 *
 * 返回 false 不是失败,是「这一刻还确认不了」:责任已经落盘,接着由梯子和启动期清扫推。
 */
export async function confirmReclaimed(
  pid: number, pidStartedAt: string | null, deadlineMs = 3_000,
): Promise<boolean> {
  const until = Date.now() + deadlineMs;
  for (;;) {
    if (isReclaimedState(reclaimState(pid, pidStartedAt))) return true;
    if (Date.now() >= until) return false;
    // **这一发不能 unref**:我们正在 await 它。unref 掉的话,当它是事件循环里唯一的待办时
    // 进程会直接退出 —— 等待本身就没了(实测:测试进程报 unsettled top-level await)。
    // 梯子那一侧相反,那是后台重试,必须 unref。
    await new Promise((r) => setTimeout(r, 50));
  }
}

/** 进程内的重试梯子。跟 claude 投影那边的补偿清理同一个形状(claude-monitor-revoked.ts)。 */
const LADDER_MS = [1_000, 5_000, 20_000];
const pending = new Set<string>();

/**
 * 记一笔:这个进程该停,**而且现在还不能证明它停了**。
 *
 * 调用点在回收层每一条「要去停它」的分支上,**排在发信号之前**(见文件头)。
 *
 * 返回 `false` = 连责任都没能落盘。调用方必须把它当「回收资格不明」往上传:销毁身份那条
 * 路(删除)要据此整笔中止,不能吞掉错误继续删行(第 4 轮审查 F1 的并条之一)。
 */
export async function noteReclaimDebt(debt: {
  monitorId: string; taskId: string; pid: number; pidStartedAt: string | null;
  command: string; reason: string; error?: unknown;
}): Promise<boolean> {
  if (dbClient.closed) return false;
  const detail = debt.error === undefined ? null
    : (debt.error instanceof Error ? debt.error.message : String(debt.error ?? "")) || null;
  try {
    // 同一条反复欠账只占一行:覆盖的是「最近一次为什么还没收掉」,attempts 由清扫侧累加。
    await db.insert(monitorReclaimDebts).values({
      monitorId: debt.monitorId, taskId: debt.taskId, pid: debt.pid,
      pidStartedAt: debt.pidStartedAt, command: debt.command, reason: debt.reason,
      lastError: detail, attempts: 0, createdAt: now(), lastAttemptAt: null,
    }).onConflictDoUpdate({
      target: monitorReclaimDebts.monitorId,
      set: { lastError: detail, reason: debt.reason },
    });
    return true;
  } catch (error) {
    // 连责任都记不下来:那就只剩日志了,但至少把 pid 打全,人工还能收。
    console.error(`[ash] 回收责任落库失败 monitor=${debt.monitorId} pid=${debt.pid}:`, error);
    return false;
  }
}

/** 销账:**只有确认它不在了**才调这里(见 `reclaimState`)。 */
export async function clearReclaimDebt(monitorId: string): Promise<void> {
  if (dbClient.closed) return;
  await db.delete(monitorReclaimDebts).where(eq(monitorReclaimDebts.monitorId, monitorId))
    .catch((err) => console.error(`[ash] 回收责任销账失败 ${monitorId}:`, err));
}

/** 落了账就把梯子挂上:多数残留是「补刀还没到」,一秒后再看一眼就销了。 */
export function scheduleReclaimRetry(monitorId: string, step = 0): void {
  if (step >= LADDER_MS.length || pending.has(monitorId)) return;
  pending.add(monitorId);
  const timer = setTimeout(() => {
    pending.delete(monitorId);
    void settleDebt(monitorId).then((done) => {
      if (!done) scheduleReclaimRetry(monitorId, step + 1);
    }).catch(() => scheduleReclaimRetry(monitorId, step + 1));
  }, LADDER_MS[step]);
  // 不许因为一笔欠账把进程吊着不退(测试套件逐条跑完就结束)。
  (timer as { unref?: () => void }).unref?.();
}

/** 一笔已经落盘的回收责任:谁的、朝哪个 pid 发的刀。 */
export type ReclaimTicket = {
  monitorId: string;
  pid: number;
  pidStartedAt: string | null;
};

/** 需要补记的那一笔(落盘失败时原样带着,供重试)。 */
type DebtInput = {
  monitorId: string; taskId: string; pid: number; pidStartedAt: string | null;
  command: string; reason: string;
};

/**
 * 回收这一刀的结果。**三者互斥、没有第四种**(第 6 轮审查 F1:空值不许同时表示「没什么可收」
 * 和「不敢判断」):
 *
 * - `settled` = 这一刻确认它不在了(或压根没有进程:claude 投影行)。没有责任要留。
 * - `owed` = 还在 / 判不出来,**责任已经可靠落盘**。之后由确认阶段销账,或留给梯子与开机清扫。
 * - `unaccounted` = **该留责任、却没留下来**(库写不进去)。调用方必须当失败处理:销毁持久
 *   身份那条路整笔中止,其余路径至少出声 + 继续重试落盘。
 */
export type ReclaimOutcome =
  | { state: "settled" }
  | { state: "owed"; ticket: ReclaimTicket }
  | { state: "unaccounted"; debt: DebtInput };

/**
 * **落责任 → 发信号**:一条哨兵的回收只能从这里开始。
 *
 * 调用点是**运行时收尾层**(`monitors.ts` 的 `finish`、创建后登记失败、启动接回认不出身份
 * 那几支),外加删除/审查收尾之前按责任核对的那一遍。顺序只有这一个对:`killByPid` 是
 * SIGTERM + 两秒后一把 `unref` 的补刀,server 在这两秒里退出它就永远不会落下 —— 责任先
 * 落盘,那一笔才活得过进程退出。
 *
 * `fresh` 答的是**「这个进程组刚刚还在我们手上吗」**,它**只**决定 `ours-orphans` 这一档敢不敢
 * 下刀。证据是「这一行此刻还是 running」:单实例锁保证同时只有一个 server 在写这张表,所以
 * 还没被写成终态的行要么是本进程正拿着的,要么是上一个 server 崩在那儿的 —— 而开机时
 * `reattachMonitors` / `reclaimUnconfirmedStops` 都排在任何删除之前,会先把后者重判一遍。
 *
 * | 档 | fresh=true(运行时收尾) | fresh=false(删除核对、启动扫描) |
 * |---|---|---|
 * | `gone` | 销掉旧账 → `settled` | 同左 |
 * | `ours-alive` | 记责任 + 杀 | 记责任 + 杀(身份对得上,隔多久都是我们的) |
 * | `ours-orphans` | 记责任 + 杀(组长刚死,组里剩的只能是它的后代) | 记责任、**不杀**(隔了一次重启,pid 可能已经被别人当组长用过) |
 * | `not-ours` | 记责任、不杀(那是别人的进程) | 同左 |
 * | `unverifiable` | 记责任、不杀(没记启动时刻,证不出代次) | 同左 —— **第 9 轮加的就是这一格**:原来它折进 `ours-alive` 就杀 |
 * | `unknown` | 记责任、不杀(身份问不出来) | 同左 —— **第 6 轮改的就是这一格**:原来它在这一列直接返回空 |
 */
export async function reclaimMonitorProcess(
  m: { id: string; taskId: string; pid: number | null; pidStartedAt: string | null; command: string },
  reason: string,
  opts: { fresh: boolean },
): Promise<ReclaimOutcome> {
  if (m.pid === null) return { state: "settled" }; // claude 投影行:没有进程,也没有责任
  const state = reclaimState(m.pid, m.pidStartedAt);
  if (isReclaimedState(state)) {
    // 顺手把上辈子留下的那笔销掉:这是唯一能确认「它真的不在了」的时刻。
    await clearReclaimDebt(m.id);
    return { state: "settled" };
  }
  const debt: DebtInput = {
    monitorId: m.id, taskId: m.taskId, pid: m.pid, pidStartedAt: m.pidStartedAt,
    command: m.command, reason: `${reason}（${stateNote(state)}）`,
  };
  const accounted = await noteReclaimDebt(debt);
  if (state === "ours-alive" || (state === "ours-orphans" && opts.fresh)) killByPid(m.pid);
  if (!accounted) return { state: "unaccounted", debt };
  return { state: "owed", ticket: { monitorId: m.id, pid: m.pid, pidStartedAt: m.pidStartedAt } };
}

/** 落在账本上的那句「为什么还没收掉」。按档说清楚,别让人事后分不出是哪一种不确定。 */
function stateNote(state: ReclaimState): string {
  if (state === "ours-alive") return "还活着";
  if (state === "ours-orphans") return "组长已退、组里还有后代";
  if (state === "not-ours") return "这个号现在是另一个进程，原进程退出无法确认";
  if (state === "unverifiable")
    return "这个号上有进程，但当初没记下启动时刻，证不出是不是原来那个（不敢下刀）";
  return "进程查询不可用，判不出身份";
}

/** 这一轮回收到底落到哪一档。调用方**必须**把 `unaccounted` 当失败处理。 */
export type ReclaimVerdict = "reclaimed" | "owed" | "unaccounted";

/**
 * **确认退出 → 销账**:确认不了就把责任留在表上并挂梯子 —— 那正是不变量允许的另一半。
 *
 * 跟 `reclaimMonitorProcess` 成对使用,中间可以插别的事(`finish` 就把状态落库、时间线、
 * 回推事件排在这两步之间:记账和状态要先落定,确认退出是慢的那一步)。
 *
 * `unaccounted` 这一支**不许挂销账梯子**:那条梯子读的是债表,读到空就当「别人已经销了」
 * 返回成功 —— 一笔从没落盘的责任正好会被它静静吃掉(第 6 轮审查 F1 的并条之一)。它要挂的
 * 是**补记梯子**。
 */
export async function settleReclaim(outcome: ReclaimOutcome, deadlineMs = 3_000): Promise<ReclaimVerdict> {
  if (outcome.state === "settled") return "reclaimed";
  if (outcome.state === "unaccounted") {
    const { debt } = outcome;
    // 库可能只是忙了一下:再确认一遍退出,没退就立刻重试落盘,仍然不行才往上报。
    if (await confirmReclaimed(debt.pid, debt.pidStartedAt, deadlineMs)) return "reclaimed";
    if (await noteReclaimDebt(debt)) {
      scheduleReclaimRetry(debt.monitorId);
      return "owed";
    }
    console.error(
      `[ash] **回收责任落不下来、退出也确认不了** monitor=${debt.monitorId} pid=${debt.pid}`
      + ` 命令：${debt.command}（${debt.reason}）—— 继续重试落盘`,
    );
    scheduleReclaimPersist(debt);
    return "unaccounted";
  }
  const { ticket } = outcome;
  if (await confirmReclaimed(ticket.pid, ticket.pidStartedAt, deadlineMs)) {
    await clearReclaimDebt(ticket.monitorId);
    return "reclaimed";
  }
  console.error(
    `[ash] 哨兵进程还没确认退出,回收责任留在表上 monitor=${ticket.monitorId} pid=${ticket.pid}`,
  );
  scheduleReclaimRetry(ticket.monitorId);
  return "owed";
}

/**
 * 补记梯子:责任**连盘都没落上**时唯一还能做的事。
 *
 * 跟销账梯子分开是因为两者的判据相反:那条问「它退了吗」,这条问「这一笔记下来了吗」。
 * 进程内重试当然活不过退出 —— 所以调用方该失败的照样要失败(删除整笔中止);这条只是给
 * 「库忙了一下」留一条自愈的路。
 */
function scheduleReclaimPersist(debt: DebtInput, step = 0): void {
  if (step >= LADDER_MS.length) return;
  const timer = setTimeout(() => {
    void (async () => {
      if (isReclaimedState(reclaimState(debt.pid, debt.pidStartedAt))) return;
      if (await noteReclaimDebt(debt)) {
        console.error(`[ash] 回收责任补记成功 monitor=${debt.monitorId} pid=${debt.pid}`);
        scheduleReclaimRetry(debt.monitorId);
        return;
      }
      scheduleReclaimPersist(debt, step + 1);
    })();
  }, LADDER_MS[step]);
  (timer as { unref?: () => void }).unref?.();
}

/** 这几条里，**此刻已经有人在账本上负责**的是哪些。 */
export async function heldReclaimDebts(monitorIds: string[]): Promise<Set<string>> {
  if (!monitorIds.length || dbClient.closed) return new Set();
  const rows = await db.select({ monitorId: monitorReclaimDebts.monitorId })
    .from(monitorReclaimDebts)
    .where(inArray(monitorReclaimDebts.monitorId, monitorIds));
  return new Set(rows.map((r) => r.monitorId));
}

/** 推一笔。true = 这一笔结了(确认不在了,或者再也认不出它);false = 还欠着。 */
async function settleDebt(monitorId: string): Promise<boolean> {
  if (dbClient.closed) return false;
  const debt = (await db.select().from(monitorReclaimDebts)
    .where(eq(monitorReclaimDebts.monitorId, monitorId))).at(0);
  // 读到空只有一种正当解释:**确认退出之后有人销了它**。一笔从没落盘的责任绝不能走到
  // 这条梯子上来 —— 那会被这一句当成「结了」(所以落盘失败走的是补记梯子,见 settleReclaim)。
  if (!debt) return true;
  const state = reclaimState(debt.pid, debt.pidStartedAt);
  if (isReclaimedState(state)) {
    await clearReclaimDebt(monitorId);
    return true;
  }
  if (state === "ours-alive") {
    // 第一刀由落账那一侧的 `killByPid` 发过了(TERM + 两秒后 KILL)。还在就说明那条路没走完
    // (多半是 server 在补刀之前退了),所以这里直接上 SIGKILL,不再等第二个两秒。
    //
    // **只认 `ours-alive`**:账本里的行随时可能是上辈子留下的,而 `ours-orphans`(组长已死、
    // 组里有人)在隔了一次重启之后跟「别人拿这个号当过组长」长得一模一样。那一档留着每次
    // 开机再问一遍,不下刀 —— 杀错人不可逆(同一个判据见 `reclaimMonitorProcess` 的 `fresh`)。
    killTree(debt.pid, "SIGKILL");
    if (await confirmReclaimed(debt.pid, debt.pidStartedAt, 1_000)) {
      await clearReclaimDebt(monitorId);
      console.error(`[ash] 回收责任已销账 monitor=${monitorId} pid=${debt.pid}（补杀成功）`);
      return true;
    }
  }
  // 剩下四档都是**不敢杀、也不敢销账**:
  //  · `ours-orphans` —— 组长已死、组里还有人,但隔了一次重启就跟「别人拿这个号当过组长」
  //    分不开(同一个判据见 `reclaimMonitorProcess` 的 `fresh`);
  //  · `not-ours` —— 这个号现在是别人的,而**原来那个**退没退证明不了(它可能带着后代还在
  //    这一组里,只是组长的号被占了);
  //  · `unverifiable` —— 当初没记启动时刻,这个号上现在有人也证不出是不是它(第 9 轮 F3);
  //  · `unknown` —— ps 自己没答出来,什么都不许声称。
  // 杀错人不可逆,而丢掉这一笔就等于再也没人知道这件事。留着,每次开机再问一遍 —— 账上
  // 写清楚是哪一种不确定,别让人事后分不出来。
  await db.update(monitorReclaimDebts)
    .set({ attempts: debt.attempts + 1, lastAttemptAt: now(), lastError: `回收未确认：${stateNote(state)}` })
    .where(eq(monitorReclaimDebts.monitorId, monitorId))
    .catch(() => {});
  return false;
}

/**
 * 启动期清扫:上一个 server 没能收掉的那几个进程,**现在就是最后一次机会**。
 *
 * 排在 `reattachMonitors` 之后:接回那一步只认 `monitors` 里还在 running 的行,而这张表里
 * 的行多半连任务都没了(删除把身份整批带走),两件事互不覆盖。
 */
export async function sweepMonitorReclaimDebts(): Promise<{ settled: number; left: number }> {
  if (dbClient.closed) return { settled: 0, left: 0 };
  const rows = await db.select().from(monitorReclaimDebts);
  let settled = 0;
  for (const row of rows) {
    try {
      if (await settleDebt(row.monitorId)) { settled += 1; continue; }
      console.error(
        `[ash] 开机仍有收不掉的哨兵进程 pid=${row.pid} monitor=${row.monitorId} task=${row.taskId}`
        + ` 命令：${row.command}（${row.reason}）`,
      );
      scheduleReclaimRetry(row.monitorId);
    } catch (error) {
      console.error(`[ash] 清扫回收责任失败 monitor=${row.monitorId}:`, error);
    }
  }
  return { settled, left: rows.length - settled };
}
