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
//
// ── 「追空了」和「记下来了」是两件事(第 14 轮审查 F2)─────────────────────────────
//
// 第 13 轮把「线索追空」这一档改成了收档留行,但**留档失败被吞掉了**:插入只 `catch` 一句
// 日志,而追空这一支无论记没记下来都返回 `closed`。于是审查用一条只拒绝这张表的真实 SQLite
// trigger 注入失败,销毁前核对拿到 `closed`、照样放行,任务和哨兵行一起删掉,后代仍在跑 ——
// `risk.log:33`:`escapedAliveAfterDeleteAndSweep=true`、`taskRows/monitorRows/debtRows` 全 0。
//
// 所以这一层现在分得很清:
//  · `traceless` 是**资源观测**(能追的线索都空了);
//  · `accounted` 是**持久记录事实**(账本上有没有这条创建的身份);
//  · 两者**不许再合成一个 `closed`**。记不下来就返回 `unaccounted`,由调用方按自己的后果
//    决定 —— 销毁身份那条路整笔中止(行留着、任务留着),普通收尾出声 + 继续重试落盘。
// 写进去之后还要**回读确认**(`ensureIdentityArchived`):插入那一步报成功也可能被约束/触发器
// 悄悄挡掉,而这一行是最后一份可定位身份。
import { and, eq, inArray, isNull } from "drizzle-orm";
import { db, dbClient } from "./db/index.js";
import { monitorReclaimDebts, monitors } from "./db/schema.js";
import {
  confirmTraceless, isTracelessState, killProvenUnit, reclaimState,
  shootProvenUnitNow, stateNote, type MonitorUnit,
} from "./monitor-reclaim-evidence.js";
import { authorizeRecoveredIdentity } from "./monitor-identity-authz.js";
import { clearSpawnIdentity, readSpawnIdentity } from "./monitor-spawn.js";
import { processStartedNear } from "./proc.js";
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
      identityDisprovedAt: debt.identityDisproved ? now() : null,
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
        // **反证只许置上,不许抹掉**:它说的是「这个号不是这条记录的那个进程」,那件事不会
        // 因为下一轮问不出来而变回未知(第 17 轮审查 F1)。
        ...(debt.identityDisproved ? { identityDisprovedAt: now() } : {}),
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
 *
 * 返回「戳盖上了没有」。**它跟「身份在不在」是两档,不许混成一个返回值**(第 14 轮审查 F2):
 * 戳没盖上时**行还在**(最后一份身份没有消失),所以不算 `unaccounted` —— 这一行会以「还欠着」
 * 的样子留在表上,梯子和开机清扫下一遍重判出 `traceless` 再把戳补上。
 */
export async function closeReclaimDebt(monitorId: string, note: string): Promise<boolean> {
  if (dbClient.closed) return false;
  try {
    // **只盖还没盖过的那一行**:戳是「追到这里为止」的时刻,反复刷新等于把它改成「最后一次
    // 看了一眼」—— 这一句让所有入口都可以无条件调它(幂等)。
    await db.update(monitorReclaimDebts)
      .set({ closedAt: now(), closedNote: note })
      .where(and(eq(monitorReclaimDebts.monitorId, monitorId), isNull(monitorReclaimDebts.closedAt)));
    return true;
  } catch (err) {
    console.error(`[ash] 回收责任收档失败 ${monitorId}（行还在，下一遍清扫会把戳补上）:`, err);
    scheduleReclaimRetry(monitorId);
    return false;
  }
}

/**
 * 持久身份这一问的三档(第 14 轮审查 F2)。**`existing` 和 `written` 的后果一样**(盘上有一份
 * 可定位身份),分开只为日志说得清;`failed` 是唯一会拦下销毁的那一档。
 */
export type IdentityArchive = "existing" | "written" | "failed";

/**
 * **留档**:这一行追不到任何线索了,但它**起过进程** —— 把最后一份可定位身份存下来(直接
 * 落成收档态:命令、pid、记号、追不下去的理由)。
 *
 * 为什么必须有这一步(第 13 轮审查 F1-B 的残留一半):`traceless` 只说明「线索到此为止」,
 * 而后代能同时甩掉记号和进程组 —— 那时**哨兵行自己**是最后一份身份,可是删除紧接着就把它
 * 连任务一起带走,于是 `taskRows=0`、`monitorRows=0`、`debtRows=0`,那条可能还在跑的命令
 * 从此谁都找不到(审查实测 `R1_RESOURCE_FALSE_GONE` 就是这一幕)。
 *
 * **幂等**:已经有行就一个字都不动(`onConflictDoNothing`)—— 不许把还欠着的那一行盖成收档,
 * 也不该反复刷新戳。
 *
 * **写完要回读**(第 14 轮审查 F2):`failed` 必须真的表示「盘上没有这份身份」,所以不能只看
 * 插入有没有抛 —— 审查用一条只拒绝这张表的真实 SQLite trigger 注入过失败,而上一版把异常
 * `catch` 成一句日志、返回 `void`,销毁前核对因此拦不下删除(`risk.log:33`)。
 */
export async function archiveTracelessIdentity(m: {
  id: string; taskId: string; pid: number; pidStartedAt: string | null;
  command: string; unitToken: string | null;
}): Promise<IdentityArchive> {
  const note = stateNote("traceless");
  return ensureIdentityArchived({
    monitorId: m.id, taskId: m.taskId, pid: m.pid, pidStartedAt: m.pidStartedAt,
    spawnAnchorMs: null, unitToken: m.unitToken, command: m.command,
    reason: `身份销毁前留档（${note}）`,
  }, note);
}

/**
 * 「账本上**现在**有没有这条创建的持久身份」—— 留档、追空收档、补记梯子**共用的那一个事实**
 * (第 14 轮审查 F2:四个入口不许各自判一遍)。
 *
 * `closeNote` 非空 = 这一笔生下来就是收档态(线索已经追空,没有可下刀的落点)。
 */
async function ensureIdentityArchived(
  debt: DebtInput, closeNote: string | null,
): Promise<IdentityArchive> {
  if (dbClient.closed) return "failed";   // 库都关了 ⇒ 没有任何持久交接发生
  try {
    const before = (await db.select({ monitorId: monitorReclaimDebts.monitorId })
      .from(monitorReclaimDebts)
      .where(eq(monitorReclaimDebts.monitorId, debt.monitorId))).at(0);
    if (before) {
      // 身份已经在盘上(可能还欠着):线索这一刻追空了就把戳补上。戳盖不上**不算身份消失**
      // ——那一行还在,`closeReclaimDebt` 自己会出声并挂上重试(第 14 轮审查 F2:有行/无行是
      // 两档,不许混成一个返回值)。
      if (closeNote) await closeReclaimDebt(debt.monitorId, closeNote);
      return "existing";
    }
    await db.insert(monitorReclaimDebts).values({
      monitorId: debt.monitorId, taskId: debt.taskId, pid: debt.pid,
      pidStartedAt: debt.pidStartedAt, spawnAnchorMs: debt.spawnAnchorMs ?? null,
      unitToken: debt.unitToken, command: debt.command, reason: debt.reason,
      identityDisprovedAt: debt.identityDisproved ? now() : null,
      lastError: null, attempts: 0, createdAt: now(), lastAttemptAt: null,
      closedAt: closeNote ? now() : null, closedNote: closeNote,
    }).onConflictDoNothing({ target: monitorReclaimDebts.monitorId });
    // **回读**:插入报成功不等于行在盘上(触发器/约束可以悄悄挡掉),而这是最后一份身份。
    const after = (await db.select({ monitorId: monitorReclaimDebts.monitorId })
      .from(monitorReclaimDebts)
      .where(eq(monitorReclaimDebts.monitorId, debt.monitorId))).at(0);
    if (after) return "written";
    console.error(`[ash] 哨兵身份留档写进去了又读不回来 monitor=${debt.monitorId} pid=${debt.pid}`);
    return "failed";
  } catch (err) {
    console.error(`[ash] 哨兵身份留档失败 monitor=${debt.monitorId} pid=${debt.pid}:`, err);
    return "failed";
  }
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
  /**
   * 这个号已经被反证过(见 monitor-identity-authz.ts)。**跟着这一笔一起落盘**:行还没落盘
   * 时反证戳那一句 UPDATE 影响 0 行,只有随插入带进去才活得过这一轮(第 17 轮审查 F1)。
   */
  identityDisproved?: boolean;
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
 * **下刀资格只看档位,不看调用点**(第 14 轮审查 F1 的「不要在四个入口分别打补丁」):
 *
 * | 档 | 做什么 |
 * |---|---|
 * | `traceless` | 留档盖戳(**不删行**)→ `closed`;记不下来 → `unaccounted` |
 * | `ours-alive` | 记责任 + 杀(根自己的代次对得上,隔多久都是我们的) |
 * | `ours-orphans` | 记责任 + 杀 —— 这一档**只由真实环境项里的记号产生**,后代各自带着这一次创建的那条记号,跨几次重启都认得回来(第 12 轮审查 F1-A) |
 * | `not-ours` | 记责任、不杀(那是别人的进程) |
 * | `suspected` | 记责任、不杀 —— 展示文本里看得见记号,证不出在谁身上(第 14 轮审查 F1) |
 * | `unverifiable` | 记责任、不杀(没记启动时刻,证不出代次) —— **第 9 轮加的就是这一格** |
 * | `unknown` | 记责任、不杀(记号这一问自己失败了) —— **第 6 轮改的就是这一格** |
 *
 * 上一版这里还有一个 `fresh` 开关(「这一组刚刚还在我们手上吗」)用来收口孤儿档。它已经没有
 * 适用面了:存量行(没有记号)在 `reclaimEvidence` 里根本到不了 `ours-orphans`,而带记号的
 * 孤儿后代本来就不靠「刚刚」证明归属。留着只会让四个入口各传一个不同的值。
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
}): Promise<{ pidStartedAt: string | null; anchorMs: number | null; disproved: boolean }> {
  const side = m.logPath ? readSpawnIdentity(m.logPath) : null;
  const anchorMs = side?.pid === m.pid ? side.spawnedAtMs : m.spawnAnchorMs ?? null;
  if (m.pidStartedAt) return { pidStartedAt: m.pidStartedAt, anchorMs, disproved: false };
  // **政策只有一份**(第 17 轮审查 F1):「凭什么给这个号签身份」整套判据在
  // `monitor-identity-authz.ts` —— 这一侧和重启后认领那一侧(`adoptSpawnIdentity`)共用它。
  // 上一版这里只拦了代次 `changed`,`none` 和「`ours` 名单里没有这个号」都落回「没答出来」,
  // 于是**首次拒绝之后的清扫和自动梯子照样走弱判据**:同号新进程在那两秒窗口里起来、命令
  // 文本又恰好包含记录的那一段时,它真实的启动时刻被写成旧哨兵的身份,随后按这条身份收到
  // 真实 SIGKILL(`round-7/refutation-retry.log`、`refutation-auto.log`)。
  const authz = await authorizeRecoveredIdentity({ monitorId: m.id, pid: m.pid, unitToken: m.unitToken });
  // `proven` 但换算没交出启动时刻:号是记号证明过的,**启动时刻等下一遍** —— 不许因为
  // 「这一刻没拿到值」就回落到弱判据(那正是第 16 轮 F1-B 的犯法方式)。
  const provenStartedAt = authz.strong.grade === "proven" ? authz.strong.startedAt : null;
  const weak = !provenStartedAt && authz.weakAllowed && anchorMs !== null;
  if (!provenStartedAt && !weak) return { pidStartedAt: null, anchorMs, disproved: authz.disproved };
  // 命令原文一起交过去:时间邻近单独不足以认下一个号(见 proc.ts 的 `processStartedNear`)。
  const { verdict, startedAt } = provenStartedAt
    ? { verdict: "same" as const, startedAt: provenStartedAt }
    : processStartedNear(m.pid, anchorMs!, 2_000, m.command);
  if (verdict !== "same" || !startedAt) return { pidStartedAt: null, anchorMs, disproved: authz.disproved };
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
  return { pidStartedAt: startedAt, anchorMs, disproved: authz.disproved };
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
): Promise<ReclaimOutcome> {
  const pid = m.pid;
  if (pid === null) return { state: "closed" }; // claude 投影行:没有进程,也没有责任
  // **先补身份再判档**:补得上就按完整身份走(该杀的杀、该销的销),补不上才落到「不知道」。
  const identity = await completeIdentity({ ...m, pid });
  const pidStartedAt = identity.pidStartedAt;
  const unit: MonitorUnit = { unitToken: m.unitToken, command: m.command };
  // **判档吃备忘、发信号自己 fresh**(第 14 轮审查 F1):这一问要走两遍全表 `ps -E`(本机
  // 约 160ms),而判档这一份只决定「记什么、该不该动手」—— 备忘最多 400ms,而唯一能造出
  // 「资源存在但扫描里没有」的动作(起进程)会当场把它作废。真正需要当代证据的是下刀那一刻,
  // 那由 `killProvenUnit` 自己重新取证(上一版把这一份快照攒着跨过落库 `await` 再传下去)。
  const state = reclaimState(pid, pidStartedAt, unit);
  const debt: DebtInput = {
    monitorId: m.id, taskId: m.taskId, pid, pidStartedAt,
    // 身份还没补全就把锚一起留下:哨兵行和边条都可能先没了,之后这笔债是唯一的线索。
    spawnAnchorMs: pidStartedAt ? null : identity.anchorMs,
    unitToken: m.unitToken, identityDisproved: identity.disproved,
    command: m.command, reason: `${reason}（${stateNote(state)}）`,
  };
  if (isTracelessState(state)) {
    // **线索追到这里为止 ⇒ 留行、盖戳,不删**(第 13 轮审查 F1-B):删掉就等于声称整项退出
    // 已经证明,而那件事在当前平台能力下证不出来(理由见 `isTracelessState`)。
    //
    // **记不下来就不是 `closed`**(第 14 轮审查 F2):上一版这里出一句日志照样返回 `closed`,
    // 于是销毁前核对拿到「没什么要负责的」、把任务和哨兵行一起删掉,而那条命令可能还在跑
    // (`risk.log:33`)。「线索追空」是资源观测,「身份在盘上」是持久记录 —— 两件事。
    // 调用方按自己的后果决定:销毁身份那条路整笔中止,普通收尾出声 + 继续重试落盘。
    if (await ensureIdentityArchived(debt, stateNote(state)) !== "failed") return { state: "closed" };
    console.error(`[ash] 收档记录落不下来 monitor=${m.id} pid=${pid}（${stateNote(state)}）`);
    return { state: "unaccounted", debt };
  }
  const accounted = await noteReclaimDebt(debt);
  // **下刀之前重新取证**:上面那一份判完之后隔着一次落库 `await`,数据库等待期间成员可以
  // 退出、号可以被别人接手(第 14 轮审查 F1)。`killProvenUnit` 自己 `fresh` 取一遍,所以
  // 这里只决定「这一档该不该动手」,不把快照传下去。
  if (state === "ours-alive" || state === "ours-orphans") killProvenUnit(pid, pidStartedAt, unit);
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
    // 库可能只是忙了一下:再看一遍线索,空了就补留档,没空就立刻重试落盘,仍然不行才往上报。
    //
    // **追空了也要先把身份留住**(第 14 轮审查 F2):上一版这里无论补记成不成都返回 `closed`
    // —— 于是「该留责任却没留下来」被一句「线索追空了」洗掉,销毁前核对再也拦不下删除。
    if (await confirmTraceless(debt.pid, debt.pidStartedAt, deadlineMs, debt)) {
      if (await ensureIdentityArchived(debt, stateNote("traceless")) !== "failed") return "closed";
      console.error(
        `[ash] 线索已追空,但最后一份身份留不下来 monitor=${debt.monitorId} pid=${debt.pid}`
        + ` 命令：${debt.command} —— 继续重试落盘`,
      );
      scheduleReclaimPersist(debt);
      return "unaccounted";
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
      // **补不上就接着爬梯子**(第 14 轮审查 F2):上一版这一支无论成不成都 `return`,于是
      // 「追空」成了停止重试的理由 —— 而这一档恰恰是身份只剩这一行的那一档。
      if (isTracelessState(reclaimState(debt.pid, debt.pidStartedAt, debt))) {
        if (await ensureIdentityArchived(debt, stateNote("traceless")) !== "failed") return;
        scheduleReclaimPersist(debt, step + 1);
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
  // 判档吃备忘,发信号那一刀由 `shootProvenUnitNow` 自己 fresh 取证(同 `reclaimMonitorProcess`)。
  const state = reclaimState(debt.pid, debt.pidStartedAt, debt);
  if (isTracelessState(state)) {
    await closeDebtAndAnchor(monitorId, stateNote(state));
    return true;
  }
  // **`ours-orphans` 在这里也能收**:这一档只由**真实环境项里的记号**产生,后代各自带着这一次
  // 创建的那条记号,隔几次重启都认得回来(上一版这一档被判成「跟别人拿这个号当过组长分不开」,
  // 于是永远留在账上)。落点是那几个成员而不是整组(见 `killProvenUnit`)。
  if (state === "ours-alive" || state === "ours-orphans") {
    // 第一刀由落账那一侧发过了(TERM + 两秒后 KILL)。还在就说明那条路没走完(多半是 server
    // 在补刀之前退了),所以这里直接上 SIGKILL,不再等第二个两秒。
    //
    // **这一刀自己重新取证**(第 14 轮审查 F1):上面那一份判完之后隔着 `completeIdentity` 等
    // 几次 `await`,拿它当授权就是把一次性的凭证存成了跨等待可复用的裸 pid 数组。
    shootProvenUnitNow(debt.pid, debt.pidStartedAt, debt, "SIGKILL");
    if (await confirmTraceless(debt.pid, debt.pidStartedAt, 1_000, debt)) {
      await closeDebtAndAnchor(monitorId, stateNote("traceless"));
      console.error(`[ash] 回收责任已收档 monitor=${monitorId} pid=${debt.pid}（补杀成功,线索已空）`);
      return true;
    }
  }
  // 剩下四档都是**不敢杀、也不敢收档**:
  //  · `suspected` —— 展示文本里还看得见这次创建的记号,但这台机器上切不出真实环境项边界,
  //    证不出它在谁身上(第 14 轮审查 F1);记号读得精确的那一种上面已经收掉了;
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
