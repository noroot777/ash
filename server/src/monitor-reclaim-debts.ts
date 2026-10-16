// 停不掉的那个进程:**回收责任**,以及「到底收干净了没有」这一问。
//
// 「生命周期已撤销 ⇒ 不许再有它的资源在跑」这条不变量有两半(第 3 轮审查 F1):不许再创建
// (资格闸,见 monitor-session.ts 的 `isTaskRevoked` 那一处),以及**现有资源要么已确认退出、
// 要么回收责任已经可靠落盘**。这个文件是后半,外加判「确认退出」的那把尺子。
//
// ── 为什么「停止函数正常返回」不算确认退出(第 4 轮审查 F1)──────────────────────
//
// `finish` 发完信号就写停止态返回:下刀是 SIGTERM + 两秒后补一刀 SIGKILL,而那把
// 补刀是个 `unref` 的定时器 —— **server 在这两秒里退出,它就永远不会落下**。于是「装了
// TERM 处理器的命令 + 删除后立刻重启」这条路上:任务行、哨兵行都没了(删除紧接着就删),
// 进程还在后台跑着,接回只枚举 running 行、债表里又一笔都没有,谁都再找不到它
// (审查实测 `F1_AFTER_RECOVERY_STILL_ALIVE`)。
//
// 所以责任**在发信号之前**就落盘(第一次写),**线索追空之后才收档** —— 任何一步之后 server
// 挂掉,这一笔都还在;而收档的唯一依据是「能追的线索都追空了」,查不到、问不出一律不算。
// 注意收档**不是销账**:行留着、盖戳,因为「整项退出」在当前平台证不出
// (monitor-reclaim-evidence.ts 的 `isTracelessState`)。
//
// 「哪些进程算这一项、这一刀能打到谁、什么时候才算追不下去了」整套判据**不在这个文件里**:
// 那是 monitor-reclaim-evidence.ts(资源证明与发信号的契约)。这里只负责账本那一半 ——
// 什么时候记一笔、什么时候收档、谁来推没收掉的那几笔。
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
// ① **状态分四档可判 + 两档不可判**(见 monitor-reclaim-evidence.ts 的 `ReclaimState`):
//    哪一问失败就只污染它自己那一档,不再冒充别的结论。
// ② **返回值必须是全的**(见 `ReclaimOutcome`):`closed`(线索追空)/`owed`(责任已落盘)/
//    `unaccounted`(该留责任却没留下来)三者互斥,空值不再同时表示「没什么可收」和
//    「不敢判断」。每个调用点都得把第三种当失败处理 —— 销毁身份那条路整笔中止,其余至少
//    出声并继续重试落盘。
import { and, eq, inArray, isNull } from "drizzle-orm";
import { db, dbClient } from "./db/index.js";
import { monitorReclaimDebts, monitors } from "./db/schema.js";
import {
  confirmTraceless, isTracelessState, killProvenUnit, reclaimEvidence, reclaimState,
  shootProvenUnit, stateNote, type MonitorUnit,
} from "./monitor-reclaim-evidence.js";
import { clearSpawnIdentity, readSpawnIdentity } from "./monitor-spawn.js";
import { inspectProcess, processStartedNear, processUnitEvidence } from "./proc.js";
import { now } from "./util.js";

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
export async function noteReclaimDebt(debt: DebtInput & { error?: unknown }): Promise<boolean> {
  if (dbClient.closed) return false;
  const detail = debt.error === undefined ? null
    : (debt.error instanceof Error ? debt.error.message : String(debt.error ?? "")) || null;
  try {
    // 同一条反复欠账只占一行:覆盖的是「最近一次为什么还没收掉」,attempts 由清扫侧累加。
    await db.insert(monitorReclaimDebts).values({
      monitorId: debt.monitorId, taskId: debt.taskId, pid: debt.pid,
      pidStartedAt: debt.pidStartedAt, spawnAnchorMs: debt.spawnAnchorMs ?? null,
      unitToken: debt.unitToken,
      command: debt.command, reason: debt.reason,
      lastError: detail, attempts: 0, createdAt: now(), lastAttemptAt: null,
    }).onConflictDoUpdate({
      target: monitorReclaimDebts.monitorId,
      // 身份/锚只在「这一次知道得更多」时才覆盖:撞键的那一行可能是上一次留下的,
      // 把已知的启动时刻盖成 null 等于把证据擦掉(同一条判据见 claude 投影那边的撞键吸收)。
      set: {
        lastError: detail, reason: debt.reason,
        // **收档不是终局**(第 13 轮审查 F1-B):又有一笔新责任落到同一条哨兵上(号被复用、
        // 这一刻重新问出了线索),说明「追不下去」这个判断已经过期 —— 把戳撤掉重新开追,
        // 否则这一笔会被 `settleDebt` 的「已收档不再追」一句静静吃掉。
        closedAt: null, closedNote: null,
        ...(debt.pidStartedAt ? { pidStartedAt: debt.pidStartedAt } : {}),
        ...(debt.spawnAnchorMs ? { spawnAnchorMs: debt.spawnAnchorMs } : {}),
        ...(debt.unitToken ? { unitToken: debt.unitToken } : {}),
      },
    });
    return true;
  } catch (error) {
    // 连责任都记不下来:那就只剩日志了,但至少把 pid 打全,人工还能收。
    console.error(`[ash] 回收责任落库失败 monitor=${debt.monitorId} pid=${debt.pid}:`, error);
    return false;
  }
}

/**
 * 收档 + 把时间锚也撤掉:线索追到这里为止,边条唯一的用途(补全身份)也就没了。
 *
 * 只给清扫梯子这一侧用 —— `finish` 那一侧自己按 verdict 决定撤不撤(它手里就有 logPath)。
 */
async function closeDebtAndAnchor(monitorId: string, note: string): Promise<void> {
  await closeReclaimDebt(monitorId, note);
  if (dbClient.closed) return;
  const logPath = (await db.select({ logPath: monitors.logPath }).from(monitors)
    .where(eq(monitors.id, monitorId))).at(0)?.logPath;
  if (logPath) clearSpawnIdentity(logPath);
}

/**
 * **收档,不是销账**(第 13 轮审查 F1-B):行留着,只盖上「追到这里为止」的戳。
 *
 * 为什么不删:删掉等于声称「整项资源已经退出」,而当前平台能力下那件事证不出来 ——
 * 后代能同时清掉环境、自己建组,那时它既不带记号也不在原组里(本轮实测)。留下的这一行是
 * 这次创建最后的可定位身份:命令、pid、记号、为什么追不下去,全在上面。
 *
 * `closed_at` 非空的行**不再重试、不再发信号、开机也不再报警** —— 它已经没有可下刀的落点了,
 * 留着是为了「这件事发生过」有据可查,而不是为了继续追。
 */
export async function closeReclaimDebt(monitorId: string, note: string): Promise<void> {
  if (dbClient.closed) return;
  await db.update(monitorReclaimDebts)
    .set({ closedAt: now(), closedNote: note })
    .where(eq(monitorReclaimDebts.monitorId, monitorId))
    .catch((err) => console.error(`[ash] 回收责任收档失败 ${monitorId}:`, err));
}

/**
 * **留档**:这一行追不到任何线索了,但它**起过进程** —— 把最后一份可定位身份存下来(直接
 * 落成收档态:命令、pid、记号、追不下去的理由)。
 *
 * 为什么必须有这一步(第 13 轮审查 F1-B 的残留一半):`traceless` 只说明「线索到此为止」,
 * 而后代能同时甩掉记号和进程组 —— 那时**哨兵行自己**是最后一份身份,可是删除紧接着就把它
 * 连任务一起带走,于是 `taskRows=0`、`monitorRows=0`、`debtRows=0`,那条可能还在跑的命令
 * 从此谁都找不到(审查实测 `R1_RESOURCE_FALSE_GONE` 就是这一幕)。核对那一侧原来把这一档
 * 整条跳过(「没什么可收」),所以它一行都不留。
 *
 * **幂等**:已经有行就一个字都不动(`onConflictDoNothing`)—— 不许把还欠着的那一行盖成收档,
 * 也不该反复刷新戳。
 */
export async function archiveTracelessIdentity(m: {
  id: string; taskId: string; pid: number; pidStartedAt: string | null;
  command: string; unitToken: string | null;
}): Promise<void> {
  if (dbClient.closed) return;
  const note = stateNote("traceless");
  await db.insert(monitorReclaimDebts).values({
    monitorId: m.id, taskId: m.taskId, pid: m.pid, pidStartedAt: m.pidStartedAt,
    spawnAnchorMs: null, unitToken: m.unitToken, command: m.command,
    reason: `身份销毁前留档（${note}）`, lastError: null, attempts: 0,
    createdAt: now(), lastAttemptAt: null, closedAt: now(), closedNote: note,
  }).onConflictDoNothing({ target: monitorReclaimDebts.monitorId })
    .catch((err) => console.error(`[ash] 哨兵身份留档失败 ${m.id}:`, err));
}

/** 落了账就把梯子挂上:多数残留是「补刀还没到」,一秒后再看一眼就能收档。 */
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
  /** 命令原文:只用于日志。**归属与整项退出都不靠它**(第 12 轮审查 F1-A)。 */
  command: string;
  /** 这一次创建独有的资源记号 —— 归属与整项退出的唯一凭证(见 `reclaimEvidence`)。 */
  unitToken: string | null;
};

/** 需要补记的那一笔(落盘失败时原样带着,供重试)。 */
type DebtInput = {
  monitorId: string; taskId: string; pid: number; pidStartedAt: string | null;
  spawnAnchorMs?: number | null;
  /** 资源记号。**债上必须自己留一份**:哨兵行可能先没了,而这一笔是最后的凭证。 */
  unitToken: string | null;
  command: string; reason: string;
};

/**
 * 回收这一刀的结果。**三者互斥、没有第四种**(第 6 轮审查 F1:空值不许同时表示「没什么可收」
 * 和「不敢判断」):
 *
 * - `closed` = **这条线索到此为止**:要么压根没有进程(claude 投影行),要么记号和原进程组都已
 *   经空了。注意它不叫 `settled` 也不叫 `gone`(第 13 轮审查 F1-B):整项退出在当前平台证不出,
 *   所以责任行**留着并盖戳**,只是不再追了(见 `closeReclaimDebt`)。
 * - `owed` = 还在 / 判不出来,**责任已经可靠落盘**。之后由确认阶段收档,或留给梯子与开机清扫。
 * - `unaccounted` = **该留责任、却没留下来**(库写不进去)。调用方必须当失败处理:销毁持久
 *   身份那条路整笔中止,其余路径至少出声 + 继续重试落盘。
 */
export type ReclaimOutcome =
  | { state: "closed" }
  | { state: "owed"; ticket: ReclaimTicket }
  | { state: "unaccounted"; debt: DebtInput };

/**
 * **落责任 → 发信号**:一条哨兵的回收只能从这里开始。
 *
 * 调用点是**运行时收尾层**(`monitors.ts` 的 `finish`、创建后登记失败、启动接回认不出身份
 * 那几支),外加删除/审查收尾之前按责任核对的那一遍。顺序只有这一个对:下刀是 SIGTERM +
 * 两秒后一把 `unref` 的补刀(`killProvenUnit`),server 在这两秒里退出它就永远不会落下 ——
 * 责任先落盘,那一笔才活得过进程退出。
 *
 * `fresh` 答的是**「这个进程组刚刚还在我们手上吗」**,它**只**决定 `ours-orphans` 这一档敢不敢
 * 下刀。证据是「这一行此刻还是 running」:单实例锁保证同时只有一个 server 在写这张表,所以
 * 还没被写成终态的行要么是本进程正拿着的,要么是上一个 server 崩在那儿的 —— 而开机时
 * `reattachMonitors` / `reclaimUnconfirmedStops` 都排在任何删除之前,会先把后者重判一遍。
 *
 * | 档 | fresh=true(运行时收尾) | fresh=false(删除核对、启动扫描) |
 * |---|---|---|
 * | `traceless` | 旧账盖戳收档(**不删**)→ `closed` | 同左 |
 * | `ours-alive` | 记责任 + 杀 | 记责任 + 杀(身份对得上,隔多久都是我们的) |
 * | `ours-orphans` | 记责任 + 杀(组长刚死,组里剩的只能是它的后代) | 记责任、**不杀**(隔了一次重启,pid 可能已经被别人当组长用过) |
 * | `not-ours` | 记责任、不杀(那是别人的进程) | 同左 |
 * | `unverifiable` | 记责任、不杀(没记启动时刻,证不出代次) | 同左 —— **第 9 轮加的就是这一格**:原来它折进 `ours-alive` 就杀 |
 * | `unknown` | 记责任、不杀(身份问不出来) | 同左 —— **第 6 轮改的就是这一格**:原来它在这一列直接返回空 |
 */
/**
 * **身份不全时,用时间锚把它补全** —— 一次查询失败不许把这条记录永久降级。
 *
 * 锚有两个来处(谁在就用谁):哨兵行旁边那份身份边条(`spawn` 返回 pid 那一刻写的),或者这笔
 * 债上自己带的那一份。补得上就当场落库(行 + 债都补),补不上就照旧留「不知道」。
 *
 * 为什么必须有这一步(第 10 轮审气 F2-B):接回那一侧在 ps 恰好不可用时只回填了 pid、启动时刻
 * 留空,而**那之后再没有人会去读身份边条**(认领只发生在 pid 为空的行上),探活也只会拿现有的
 * 残缺身份反复问同一个问题 —— 于是这条行永久停在 `unverifiable`:停它只会记债、下不了刀,
 * 销不掉账。查询恢复之后本该能证出身份,证据却没人再去取。
 */
async function completeIdentity(m: {
  id: string; pid: number; pidStartedAt: string | null; command: string;
  unitToken: string | null;
  logPath?: string | null; spawnAnchorMs?: number | null;
}): Promise<{ pidStartedAt: string | null; anchorMs: number | null }> {
  const side = m.logPath ? readSpawnIdentity(m.logPath) : null;
  const anchorMs = side?.pid === m.pid ? side.spawnedAtMs : m.spawnAnchorMs ?? null;
  if (m.pidStartedAt) return { pidStartedAt: m.pidStartedAt, anchorMs };
  // **记号在手就不必靠时间锚**:带着这一次创建的记号、而且就是这个号 ⇒ 身份已经证明,
  // 把 ps 这一刻报的启动时刻记下来即可(锚那条路是给没有记号的存量行留的)。
  const proven = processUnitEvidence(m.unitToken);
  const byUnit = proven.verdict === "ours" && proven.pids.includes(m.pid)
    ? inspectProcess(m.pid)?.startedAt ?? null
    : null;
  if (!byUnit && anchorMs === null) return { pidStartedAt: null, anchorMs };
  // 命令原文一起交过去:时间邻近单独不足以认下一个号(见 proc.ts 的 `processStartedNear`)。
  const { verdict, startedAt } = byUnit
    ? { verdict: "same" as const, startedAt: byUnit }
    : processStartedNear(m.pid, anchorMs!, 2_000, m.command);
  if (verdict !== "same" || !startedAt) return { pidStartedAt: null, anchorMs };
  if (!dbClient.closed) {
    await Promise.all([
      db.update(monitors).set({ pidStartedAt: startedAt })
        .where(and(eq(monitors.id, m.id), eq(monitors.pid, m.pid), isNull(monitors.pidStartedAt)))
        .catch((e) => console.error(`[ash] 哨兵身份补全写不进库 monitor=${m.id}:`, e)),
      db.update(monitorReclaimDebts).set({ pidStartedAt: startedAt })
        .where(and(eq(monitorReclaimDebts.monitorId, m.id), isNull(monitorReclaimDebts.pidStartedAt)))
        .catch(() => { /* 这一笔还没落盘,下面记账时会带上补全后的身份 */ }),
    ]);
  }
  return { pidStartedAt: startedAt, anchorMs };
}

export async function reclaimMonitorProcess(
  m: {
    id: string; taskId: string; pid: number | null; pidStartedAt: string | null; command: string;
    /** 这一次创建独有的资源记号(见 `reclaimEvidence`)。存量行为 null ⇒ 孤儿档只能「证不出」。 */
    unitToken: string | null;
    /** 身份边条就在它旁边:身份不全时靠它补全(见 `completeIdentity`)。 */
    logPath?: string | null;
  },
  reason: string,
  opts: { fresh: boolean },
): Promise<ReclaimOutcome> {
  const pid = m.pid;
  if (pid === null) return { state: "closed" }; // claude 投影行:没有进程,也没有责任
  // **先补身份再判档**:补得上就按完整身份走(该杀的杀、该销的销),补不上才落到「不知道」。
  const identity = await completeIdentity({ ...m, pid });
  const pidStartedAt = identity.pidStartedAt;
  const unit: MonitorUnit = { unitToken: m.unitToken, command: m.command };
  // **这次取证要用来发信号,所以不许吃旧快照**(第 13 轮审查 F1-C)。
  const evidence = reclaimEvidence(pid, pidStartedAt, unit, { fresh: true });
  const state = evidence.state;
  const debt: DebtInput = {
    monitorId: m.id, taskId: m.taskId, pid, pidStartedAt,
    // 身份还没补全就把锚一起留下:哨兵行和边条都可能先没了,之后这笔债是唯一的线索。
    spawnAnchorMs: pidStartedAt ? null : identity.anchorMs,
    unitToken: m.unitToken,
    command: m.command, reason: `${reason}（${stateNote(state)}）`,
  };
  if (isTracelessState(state)) {
    // **线索追到这里为止 ⇒ 留行、盖戳,不删**(第 13 轮审查 F1-B):删掉就等于声称整项退出
    // 已经证明,而那件事在当前平台能力下证不出来(理由见 `isTracelessState`)。
    //
    // 这一笔记不下来时**不算 `unaccounted`**:这一档没有任何可下刀的落点,拿一行记录写不进去
    // 去中止删除,只会把一次正常收尾卡住 —— 出声,然后照常收档。
    if (await noteReclaimDebt(debt)) await closeReclaimDebt(m.id, stateNote(state));
    else console.error(`[ash] 收档记录落不下来 monitor=${m.id} pid=${pid}（${stateNote(state)}）`);
    return { state: "closed" };
  }
  const accounted = await noteReclaimDebt(debt);
  // **孤儿档的 `fresh` 只管「没有记号」那一种**:记号证明得出来时,这些后代是谁的已经不是
  // 推断了(它们各自带着这一次创建的那条记号),隔几次重启都一样 —— 那正是记号要解决的事。
  // 没有记号的存量行照旧按 `fresh` 收口:刚刚还在我们手上才敢打那一组。
  if (state === "ours-alive" || (state === "ours-orphans" && (opts.fresh || evidence.unitPids.length > 0))) {
    killProvenUnit(pid, pidStartedAt, unit, evidence);
  }
  if (!accounted) return { state: "unaccounted", debt };
  return {
    state: "owed",
    ticket: { monitorId: m.id, pid, pidStartedAt, command: m.command, unitToken: m.unitToken },
  };
}

/**
 * 这一轮回收到底落到哪一档。调用方**必须**把 `unaccounted` 当失败处理。
 *
 * `reclaimed` 与 `closed` 的区别是**证据的强弱,不是结果的好坏**(第 13 轮审查 F1-B):
 *  · `reclaimed` = **真的证明过**整项资源不存在。当前只有一种现场能拿到它:命令**从未开工**
 *    (放行闸没开 ⇒ 壳底下什么都没有),而壳自己的 `exit` 是我们亲手拿着的 —— 见
 *    monitor-create.ts 的 `releaseProcess`;
 *  · `closed` = 能追的线索都追空了(`traceless`),**整项退出在当前平台证不出**。责任行留档,
 *    措辞也只说这些(见 `isTracelessState`)。
 */
export type ReclaimVerdict = "reclaimed" | "closed" | "owed" | "unaccounted";

/**
 * **追到线索空 → 收档**:追不空就把责任留在表上并挂梯子 —— 那正是不变量允许的另一半。
 *
 * 跟 `reclaimMonitorProcess` 成对使用,中间可以插别的事(`finish` 就把状态落库、时间线、
 * 回推事件排在这两步之间:记账和状态要先落定,确认退出是慢的那一步)。
 *
 * `unaccounted` 这一支**不许挂收档梯子**:那条梯子读的是债表,读到空就当「别人已经收了」
 * 返回成功 —— 一笔从没落盘的责任正好会被它静静吃掉(第 6 轮审查 F1 的并条之一)。它要挂的
 * 是**补记梯子**。
 */
export async function settleReclaim(outcome: ReclaimOutcome, deadlineMs = 3_000): Promise<ReclaimVerdict> {
  if (outcome.state === "closed") return "closed";
  if (outcome.state === "unaccounted") {
    const { debt } = outcome;
    // 库可能只是忙了一下:再看一遍线索,空了就收档,没空就立刻重试落盘,仍然不行才往上报。
    if (await confirmTraceless(debt.pid, debt.pidStartedAt, deadlineMs, debt)) {
      if (await noteReclaimDebt(debt)) await closeReclaimDebt(debt.monitorId, stateNote("traceless"));
      return "closed";
    }
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
  if (await confirmTraceless(ticket.pid, ticket.pidStartedAt, deadlineMs, ticket)) {
    await closeReclaimDebt(ticket.monitorId, stateNote("traceless"));
    return "closed";
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
 * 跟收档梯子分开是因为两者的判据相反:那条问「还追得到吗」,这条问「这一笔记下来了吗」。
 * 进程内重试当然活不过退出 —— 所以调用方该失败的照样要失败(删除整笔中止);这条只是给
 * 「库忙了一下」留一条自愈的路。
 */
function scheduleReclaimPersist(debt: DebtInput, step = 0): void {
  if (step >= LADDER_MS.length) return;
  const timer = setTimeout(() => {
    void (async () => {
      // 线索已经空了也要把这一笔补上:它是「这件事发生过」的唯一记录(只是补完就收档)。
      if (isTracelessState(reclaimState(debt.pid, debt.pidStartedAt, debt))) {
        if (await noteReclaimDebt(debt)) await closeReclaimDebt(debt.monitorId, stateNote("traceless"));
        return;
      }
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

/**
 * 这几条里，**此刻已经有人在账本上负责**的是哪些。
 *
 * **收档的行不算有人负责**(第 13 轮审查 F1-B):那一行的意思是「线索追到那里为止、不再追」,
 * 而调用它的核对只问活着的进程 —— 如果这一刻又问出了线索(号被复用、组里又有人),把它当成
 * 「已经有人负责」就等于让一个活着的进程彻底没人管。重新记一笔、重新开追才对
 * (`noteReclaimDebt` 撞键时会把收档戳撤掉)。
 */
export async function heldReclaimDebts(monitorIds: string[]): Promise<Set<string>> {
  if (!monitorIds.length || dbClient.closed) return new Set();
  const rows = await db.select({ monitorId: monitorReclaimDebts.monitorId })
    .from(monitorReclaimDebts)
    .where(and(inArray(monitorReclaimDebts.monitorId, monitorIds), isNull(monitorReclaimDebts.closedAt)));
  return new Set(rows.map((r) => r.monitorId));
}

/** 推一笔。true = 这一笔结了(确认不在了,或者再也认不出它);false = 还欠着。 */
async function settleDebt(monitorId: string): Promise<boolean> {
  if (dbClient.closed) return false;
  let debt = (await db.select().from(monitorReclaimDebts)
    .where(eq(monitorReclaimDebts.monitorId, monitorId))).at(0);
  // 读到空只有一种正当解释:**这一行从来没落盘过,或者被别的流程清掉了**(收档只盖戳不删行,
  // 所以正常路径上行一定还在)。一笔从没落盘的责任绝不能走到
  // 这条梯子上来 —— 那会被这一句当成「结了」(所以落盘失败走的是补记梯子,见 settleReclaim)。
  if (!debt) return true;
  // 已经收档的行不再追:它没有可下刀的落点,留着只是记录(见 `closeReclaimDebt`)。
  if (debt.closedAt) return true;
  // 这一刻可能正是第一次问得出身份(ps 恢复了、或者当初那一笔就没记全)。补得上才轮到下刀。
  const { pidStartedAt } = await completeIdentity({
    id: debt.monitorId, pid: debt.pid, pidStartedAt: debt.pidStartedAt,
    command: debt.command, unitToken: debt.unitToken, spawnAnchorMs: debt.spawnAnchorMs,
  });
  debt = { ...debt, pidStartedAt };
  // 这一圈也会发信号 ⇒ 重新取证(第 13 轮审查 F1-C:债务重收不许吃旧快照)。
  const evidence = reclaimEvidence(debt.pid, debt.pidStartedAt, debt, { fresh: true });
  const state = evidence.state;
  if (isTracelessState(state)) {
    await closeDebtAndAnchor(monitorId, stateNote(state));
    return true;
  }
  // **`ours-orphans` 在这里也能收 —— 只要记号证明得出来**:上一版这一档隔了一次重启就被判成
  // 「跟别人拿这个号当过组长分不开」,于是永远留在账上。记号没有这个问题(它跟着后代自己走),
  // 而且落点是那几个成员而不是整组(见 `killProvenUnit`)。没有记号的存量行仍然只记不杀。
  if (state === "ours-alive" || (state === "ours-orphans" && evidence.unitPids.length > 0)) {
    // 第一刀由落账那一侧发过了(TERM + 两秒后 KILL)。还在就说明那条路没走完(多半是 server
    // 在补刀之前退了),所以这里直接上 SIGKILL,不再等第二个两秒。
    //
    // 落点跟 `killProvenUnit` 同一个判据:**组长自己证明过、而且还活着**才发组信号(它活着,
    // 这个组号就不可能已经是别人的);否则只打证明过的那几个成员各自 —— 成员的 pgid 是那个
    // 已经死掉的组长的号,发组信号打的是别人(第 12 轮审查 F1-A 实测被杀的就是那种组)。
    shootProvenUnit(debt.pid, evidence, "SIGKILL");
    if (await confirmTraceless(debt.pid, debt.pidStartedAt, 1_000, debt)) {
      await closeDebtAndAnchor(monitorId, stateNote("traceless"));
      console.error(`[ash] 回收责任已收档 monitor=${monitorId} pid=${debt.pid}（补杀成功,线索已空）`);
      return true;
    }
  }
  // 剩下四档都是**不敢杀、也不敢收档**:
  //  · `ours-orphans` **且没有记号** —— 组长已死、组里还有人,但隔了一次重启就跟「别人拿这个
  //    号当过组长」分不开(同一个判据见 `reclaimMonitorProcess` 的 `fresh`);记号证明得出来的
  //    那一种上面已经收掉了;
  //  · `not-ours` —— 这个号现在是别人的,而**原来那个**退没退证明不了(它可能带着后代还在
  //    这一组里,只是组长的号被占了);
  //  · `unverifiable` —— 当初没记启动时刻,这个号上现在有人也证不出是不是它(第 9 轮 F3);
  //  · `unknown` —— 记号这一问自己没答出来(win32 读不到别的进程的环境块、或者 ps 失败),
  //    而根也已经不在:什么都不许声称。
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
  // 已收档的行不参与清扫:它们是记录,不是待办(见 `closeReclaimDebt`)。
  const rows = (await db.select().from(monitorReclaimDebts)).filter((r) => !r.closedAt);
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
