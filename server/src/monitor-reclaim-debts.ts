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
// `kill(-pgid, 0)`,所以这里用 `isProcessGroupAlive`;pid 复用的风险仍由 `isSameProcess`
// 挡在**杀**那一侧(问得出身份才敢杀)。
import { eq } from "drizzle-orm";
import { db, dbClient } from "./db/index.js";
import { monitorReclaimDebts } from "./db/schema.js";
import { IS_WINDOWS, isPidAlive, isProcessGroupAlive, killTree } from "./platform.js";
import { isSameProcess } from "./proc.js";
import { now } from "./util.js";

/**
 * 这一条此刻处在哪一档。**只在能肯定的时候说 `gone`。**
 *
 * - `gone` = 确认收干净了(POSIX:整组已空)。只有这一档能销账。
 * - `ours-alive` = 还在,而且身份对得上 —— 可以接着杀。
 * - `unknown` = 问不出来(ps 不可用、组里有人但组长身份对不上/pid 被复用)。既不敢杀也
 *   **不许销账**:`inspectProcess` 把「不存在」和「查不到」都返回 null,拿它当「已经退了」
 *   就是把最后那一份责任丢掉(第 4 轮审查 F1 的并条之一)。
 */
export type ReclaimState = "gone" | "ours-alive" | "unknown";

export function reclaimState(pid: number, pidStartedAt: string | null): ReclaimState {
  if (!IS_WINDOWS) {
    if (!isProcessGroupAlive(pid)) return "gone";
    return isSameProcess(pid, pidStartedAt) ? "ours-alive" : "unknown";
  }
  // win32 没有进程组这回事,`killTree` 打的是 `taskkill /T` 那棵树,能问的只有这个 pid 本身
  // —— 跟这几列原来的判据完全一样,**这里不新增任何跨平台断言**(没有 Windows 真机实证
  // 之前不冒充;约定见根 AGENTS.md)。
  if (isSameProcess(pid, pidStartedAt)) return "ours-alive";
  return isPidAlive(pid) ? "unknown" : "gone";
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
    if (reclaimState(pid, pidStartedAt) === "gone") return true;
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

/** 推一笔。true = 这一笔结了(确认不在了,或者再也认不出它);false = 还欠着。 */
async function settleDebt(monitorId: string): Promise<boolean> {
  if (dbClient.closed) return false;
  const debt = (await db.select().from(monitorReclaimDebts)
    .where(eq(monitorReclaimDebts.monitorId, monitorId))).at(0);
  if (!debt) return true; // 别人已经销了
  const state = reclaimState(debt.pid, debt.pidStartedAt);
  if (state === "gone") {
    await clearReclaimDebt(monitorId);
    return true;
  }
  if (state === "ours-alive") {
    // 第一刀由落账那一侧的 `killByPid` 发过了(TERM + 两秒后 KILL)。还在就说明那条路没走完
    // (多半是 server 在补刀之前退了),所以这里直接上 SIGKILL,不再等第二个两秒。
    killTree(debt.pid, "SIGKILL");
    if (await confirmReclaimed(debt.pid, debt.pidStartedAt, 1_000)) {
      await clearReclaimDebt(monitorId);
      console.error(`[ash] 回收责任已销账 monitor=${monitorId} pid=${debt.pid}（补杀成功）`);
      return true;
    }
  }
  // `unknown`:组里有人、身份又对不上(pid 被复用 / ps 问不出来)。**不敢杀也不销账** ——
  // 杀错人不可逆,而丢掉这一笔就等于再也没人知道这件事。留着,每次开机再问一遍。
  await db.update(monitorReclaimDebts)
    .set({ attempts: debt.attempts + 1, lastAttemptAt: now(), lastError: `回收未确认（${state}）` })
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
