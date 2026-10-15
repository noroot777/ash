// 历史回填：把 agent 已经起过的内置 Monitor 补进投影表，并按来源事实纠正已有的记录。
//
// 为什么非有不可：这个功能的起点就是用户打开一个任务，agent 在对话里反复说「等 Monitor
// 通知」，而哨兵面板写着「这个任务上还没有哨兵」。实时投影只能管**之后**发生的事——对那个
// 触发需求的任务本身，以及所有升级前跑过的任务，面板仍然是空的。
//
// 按字节读盘在 `claude-monitor-read.ts`，文件枚举和事件认人在 `claude-monitor-scan.ts`；
// 这个文件只管两件事：
//
// ① **提交扫出来的事实**（`commitFound`）。缺的插进去，已有的按事实优先级补齐/纠正。
// ② **重新裁决已有行的死活**（`reconcileLiveness`）。这一步**不依赖文件有没有新内容**——
//    进程可能刚刚死掉，或者上一次把还活着的来源误判成了 lost。上一版只在「历史里读到终态」
//    时才改状态，于是实测两个方向都卡住：旧 lost 行的来源还活着也不恢复、旧 running 行的
//    进程已经没了也不纠正（第 4 轮审查 existingLiveness）。
//
// ── 事实优先级（整条链共用一套）────────────────────────────────────────────────
//
//   来源说过的终态  >  ash 按来源死活的推断（running / lost）>  没有结局
//
// ③ **没确认落地的事实留账**（`claude-monitor-recovery.ts`）。扫描没读到 EOF、暂态写失败、
//    条件更新 0 行，三条都不算「这一轮读完了」——记进待恢复账本并自动退避重排，而不是打一行
//    日志等用户再开一次面板（第 6 轮审查：三条触发路径，同一个坑）。
//
// 「没读到某条事实」不等于「那条事实不成立」：没读到终态要先问来源还活不活，而不是直接判死。
// 来源已经说过的终态不被重放改写（否则显示跟着扫描次数变），ash 自己的推断必须对纠正开放
// （判据 `monitorStatusCorrectable`，与实时投影共用）。
import { and, eq, inArray } from "drizzle-orm";
import { bus } from "./bus.js";
import { createLivenessProbe } from "./claude-monitor-liveness.js";
import {
  adoptSessionRecovery, clearMonitorRecovery, monitorRecoveryTasks, noteMonitorRecovery,
  resetMonitorRecoveryBudget,
} from "./claude-monitor-recovery.js";
import { commitRound } from "./claude-monitor-commit.js";
import { clearScanCursors, loadScanCursors, saveScanCursors, type ScanCursor } from "./claude-monitor-cursors.js";
import { loadPendingCalls, syncPendingCalls } from "./claude-monitor-pending.js";
import {
  clearedCallsOf, clearLateFacts, clearPendingLedger, cursorsOf, foundOf, lateFactsOf,
  newTaskScan, pendingCallsOf, scanSession, sourceSetOf, type LateFact, type TaskScan,
} from "./claude-monitor-scan.js";
import { db, dbClient } from "./db/index.js";
import { monitorPendingCalls, monitorScanCursors, monitors, sessions, tasks } from "./db/schema.js";
import {
  beginTaskRevocation, confirmTaskRevocation, isTaskDeleted, isTaskRevoked,
  notePurgeDone, notePurgeFailed, releaseTaskRevocation,
} from "./claude-monitor-revoked.js";
import { isSameProcess } from "./proc.js";
import { now } from "./util.js";

/**
 * 每个任务的扫描快照。**不是「扫过就永不再扫」**——它记着每个文件读到第几字节，下次只读
 * 新增那一段（见 claude-monitor-scan.ts 的文件头）。
 */
const snapshots = new Map<string, TaskScan>();
/**
 * 同时留多少个任务的扫描快照。超了挤掉**最久没用过的**那个（被挤掉只意味着下次从头重读，
 * 不丢正确性）。
 *
 * 为什么要有上限：这张表按 taskId 存，而 taskId 是无界的——每打开一个历史任务就多一份
 * 游标表，进程活着就一直留着（第 6 轮审查不拦项）。32 远大于一次会话里会翻看的任务数。
 */
const SNAPSHOT_CAP = 32;
/**
 * 连「正在恢复中」的游标都得挤时的硬上限。到这一档说明同时有 64 个任务的历史没读完，
 * 那已经不是缓存问题了——挤掉最老的并留一行日志，总比无界增长好。
 */
const SNAPSHOT_HARD_CAP = 64;
/**
 * **读到哪儿了不住在内存里，它落盘**（`claude-monitor-cursors.ts`）。
 *
 * 一份快照里的重东西是 `found`/`pending`/迟到事实通道，而「读到第几字节」只是每个文件几十
 * 字节 —— 但轻不等于可以丢：位置一丢下一轮就从零重读，而单次只读 128 MiB，「历史很长、
 * Monitor 在末尾」的任务于是反复重读同一段前缀、永远读不到末尾。
 *
 * 前三版都想给位置找一张**内存**表：先是「可重放位置」（被一条永不完结的调用钉死，第 11 轮
 * 审查），再是快照 LRU 之外的位置表（在途被别的任务拆走，第 12 轮），最后是给那张表加容量
 * （512 个还没读完的任务轮一圈就把它挤没了，第 13 轮）。同一个判据栽三次说明问题不在上限多
 * 大，而在**位置的归属不该是「哪张缓存还记得它」**。所以这一版把它落进库里：快照照旧按 LRU
 * 淘汰（只丢可重建的配对状态），位置由 `monitor_scan_cursors` 独立保管，顺带 server 重启也
 * 不必把几百 MB 的历史从零重读一遍。
 */
/**
 * 记下这个任务的扫描快照，并按「最久没用的先挤掉」淘汰——**但正在恢复中的不挤**。
 *
 * 挤掉只丢**可重建的配对状态**：位置已经落盘（见上面那一节），下一轮从库里接回来接着读。
 * 豁免恢复中的那些只是少走一趟重建，不是因为挤了会丢位置。
 */
function rememberScan(taskId: string, scan: TaskScan): void {
  snapshots.delete(taskId);
  snapshots.set(taskId, scan); // 用过的挪到末尾
  if (snapshots.size <= SNAPSHOT_CAP) return;
  const protectedTasks = monitorRecoveryTasks();
  for (const key of [...snapshots.keys()]) {
    if (snapshots.size <= SNAPSHOT_CAP) return;
    if (key === taskId || protectedTasks.has(key)) continue; // 还没读完的不动
    evictScan(key);
  }
  // 全都在恢复中：按硬上限兜底（只丢可重建的配对状态，位置在库里）。
  for (const key of [...snapshots.keys()]) {
    if (snapshots.size <= SNAPSHOT_HARD_CAP) break;
    if (key === taskId) continue;
    if (!evictScan(key)) continue; // 在途的只记账，由它自己让位
    console.warn(`[ash] 内置 Monitor 扫描快照超过硬上限（${SNAPSHOT_HARD_CAP}），`
      + `task=${key} 的配对状态已丢弃，读取位置在库里，下一轮从原位继续`);
  }
}

/**
 * 在途扫描被选中淘汰：**记在这里，等它自己这一轮跑完再让位**。
 *
 * 为什么不能当场挤掉：那份对象此刻正在 await 里往前读，这一轮的提交和落位置都发生在它身上。
 * 当场挤掉就是把读到一半的进度扔了，于是并发压力下每一轮都从同一个窗口重读（第 12 轮审查
 * F1）。延后到它自己结束时让位，整轮就有唯一接班者：跑的时候状态在这份对象上，结束时位置
 * 已经落库。代价是淘汰迟一点生效 —— 上限可能被同时在途的任务数短暂顶高（它受并发请求数
 * 封顶，不是无界的 taskId）。
 */
const evictWhenIdle = new Set<string>();

/**
 * 把一个任务的快照挤出去（**只丢配对状态**，位置在库里）。
 *
 * 返回「这次真的挤掉了没有」：在途的不挤（见 `evictWhenIdle`），调用方据此决定要不要再找
 * 下一个牺牲者、要不要打那行日志。
 */
function evictScan(taskId: string): boolean {
  if (inflight.has(taskId)) { evictWhenIdle.add(taskId); return false; }
  return snapshots.delete(taskId);
}

/**
 * 把这份快照**已确认提交**的读取位置落盘。
 *
 * **位置照原样往前、不往回退**：位置之前那段里唯一只存在于内存的东西是「还悬着的调用」，
 * 而它已经落盘了（`claude-monitor-pending.ts`），下一轮新建会话桶时接回来。
 *
 * 上一版停的是「最后一个没有悬着关联的位置」。那条路在**永远不会完结的调用**上会把位置钉死
 * ——启动被拒、进程在那一行之后被杀 —— 于是每轮重读同一个窗口，末尾的 Monitor 永远读不到
 * （第 11 轮审查实测 12 轮停滞；回退这件事本身也不算进展，见 `rewound`）。
 */
async function saveCheckpoint(taskId: string, scan: TaskScan): Promise<void> {
  // **没确认提交过就不许停在半路**（检查点不变量，见 claude-monitor-scan.ts 文件头）：这一轮
  // 读过的字节还没落库时，位置之前那段既不在内存里、也不在库里，从它往后读再也拼不回来。
  // 那种情况只有一条安全的路：位置清掉，下一轮从零重放（代价是重读，不是错误显示）。
  //
  // 按现在的调用序其实到不了这一支（提交没落地的那几条路都会先 `discardScan`），它是这条
  // 不变量的**硬闸**：留着是为了下一次改动绕不过去，不是因为有哪条回归打在它身上。
  if (!scan.committedThrough) { await discardScan(taskId); return; }
  const cursors = cursorsOf(scan);
  if (!cursors.size) return;
  await saveScanCursors(taskId, cursors);
}

/** 正在跑的那次 → 它的 Promise。并发调用共享同一次工作，不重复读盘。 */
const inflight = new Map<string, Promise<number>>();

/** 这个任务的扫描游标还在不在（只给回归用：验「恢复中的游标没被挤掉」）。 */
export const monitorScanTracked = (taskId: string): boolean => snapshots.has(taskId);

/**
 * 这个任务被删了：扫描状态、位置、恢复责任**一起作废**。
 *
 * 为什么非有不可：库删干净了，而这几张内存表是按 taskId 存的，没人通知它们。残留下来的后果
 * 不是「多占几十字节」——复用的那份快照里还留着上一轮悬着的调用，下一次有人读这个任务
 * （已经打开的页面、在途请求、恢复账本的自动重推）就会把它们**重新插回库里**，成为再也没有
 * 任何入口能清的孤儿行（第 12 轮审查 N5）。
 *
 * 单任务删、子任务删、项目删都合流到 `deleteTaskCompletely`，所以只有这一个调用点；落盘的
 * 那两张表（位置、未决调用）在那边跟着一起删。
 */
export function revokeTaskMonitors(taskId: string): void {
  // **第一件事是关闸**（`deleteTaskCompletely` 也因此必须在第一条 DELETE 之前调它）：
  // 删除不是一个瞬间，而四个 writer 的落库资格要在**整个删除期**都不成立 —— 判据和理由
  // 见 claude-monitor-revoked.ts（第 14 轮审查 N3）。
  beginTaskRevocation(taskId);
  forgetTaskMonitorScan(taskId);
  // **在途的那一轮还要补偿。** 它的会话清单、配对状态、悬着的调用都是删除之前读到的事实，
  // 而提交是一行一行写的：闸关上之前可能已经写出去了几行 —— 投影行、未决行、位置各留一条
  // 谁也清不掉的孤儿（第 13 轮审查 N2 用屏障实测：删除当刻三张表都是 0，旧扫描跑完又各回来
  // 一条）。那一轮结束时清一遍（见 `purgeRevokedTask`）。
  if (inflight.has(taskId)) needsPurge.add(taskId);
}

/**
 * 把这个任务**进程内**的扫描状态扔掉（位置、未决调用都在库里，所以这只是丢缓存）。
 *
 * **它不含「不许再写」的意思**：重启、内存上限、回归里模拟「进程内什么都不剩」都走它，那些
 * 场景之后还要照常读照常写。删除要的是另一件事 —— 见 `revokeTaskMonitors`。
 */
export function forgetTaskMonitorScan(taskId: string): void {
  snapshots.delete(taskId);
  rewound.delete(taskId);
  evictWhenIdle.delete(taskId);
  staleCursors.delete(taskId);
  clearMonitorRecovery(taskId);
}

/** 这一轮结束时要补偿清理的任务（删除撞上了在途回合）。 */
const needsPurge = new Set<string>();

/**
 * 这一轮跑的是一个已经被删掉的任务：**把它这一轮可能写下的东西全撤掉**。
 *
 * 早退那一道（见 runBackfill）挡住的是「删除发生在写之前」；这一道兜住「删除发生在写到
 * 一半」——提交是一行一行写的，没有哪一个检查点能覆盖它的中间。两道都要，因为留下的孤儿
 * 行再也没有入口能清（任务都没了）。
 */
async function purgeRevokedTask(taskId: string): Promise<void> {
  // **补偿只针对确认删除的任务。** 删除失败、任务还在的时候走到这里就是在删用户还看得见的
  // 数据（第 5 轮审查 F1 的另一半）。`settleTaskRevocation` 已经把这种情况的责任摘掉了，
  // 这一道是硬闸：顺序再变也不会误伤。
  if (!isTaskDeleted(taskId)) {
    needsPurge.delete(taskId);
    notePurgeDone(taskId);
    return;
  }
  try {
    await db.delete(monitors).where(and(eq(monitors.taskId, taskId), eq(monitors.kind, "claude")));
    await db.delete(monitorPendingCalls).where(eq(monitorPendingCalls.taskId, taskId));
    await clearScanCursors(taskId);
    // **恢复责任也得作废。** 删除那一侧已经清过一次，但这一轮在它之后还会记账（读到上限、
    // 文件读失败……都在扫描里写），留下来就是定时器一直去推一个不存在的任务。
    clearMonitorRecovery(taskId);
    needsPurge.delete(taskId);
    notePurgeDone(taskId);
  } catch (e) {
    // **清理失败不许只打一行 warn。** 任务已经没了,以后没有任何入口会再来清它 —— 留一笔
    // 可推进的清理责任:退避重试几次,全试完还不行就留着,由启动期的孤儿清扫收掉
    // （`sweepOrphanClaudeMonitors`，第 14 轮审查 N3）。
    console.warn(`[ash] 内置 Monitor 历史回填：task=${taskId} 删除后的残留清理失败，已排重试:`, e);
    notePurgeFailed(taskId, purgeRevokedTask);
  }
}

/**
 * 删除流程收口：**按「任务行还在不在」决定那道闸是关死还是打开**（第 5 轮审查 F1）。
 *
 * 删除可能在任何一条语句上失败，而失败之后任务**还在**：它还在列表里、用户还能点开。
 * 这时候闸必须打开，否则回填入口早退、恢复责任也不登记 —— 列表永远返回空数组，账面还
 * 显示「读完了」，刷新多少次都一样（审查用真实页面复现：注入一次 pending DELETE 失败，
 * 原来看得到的那张卡此后再也打不开）。
 *
 * 开闸还不够：删除是半路停的，`monitors` 可能已经删了而 `monitor_scan_cursors` 还停在
 * 那些行之后 —— 照那个位置往下读，被删掉的那一段永远不会再被读到。所以**连可重建资格一起
 * 恢复**：丢掉进程内状态、作废读取位置（清不掉就记进 `staleCursors`，下一轮也不会采用它）。
 *
 * 这个函数由 `deleteTaskCompletely` 的 finally 调用 —— 删除的全部语句（含任务行本身）都在
 * 它里面，所以「行还在不在」在这一刻才是**删除的结果**，而不是中间态。
 */
export async function settleTaskRevocation(taskId: string): Promise<void> {
  let alive = true;
  try {
    alive = !!(await db.select({ id: tasks.id }).from(tasks).where(eq(tasks.id, taskId))).length;
  } catch (e) {
    // 连「它还在不在」都查不出来：按**还在**处理。把一个仍存在的任务永久封死是用户看得见
    // 的损坏；反过来多开一会儿闸，最坏也只是几行孤儿，启动期清扫会收。
    console.warn(`[ash] 内置 Monitor：task=${taskId} 删除后核对任务是否还在失败，按「还在」放开闸:`, e);
    alive = true;
  }
  if (!alive) {
    confirmTaskRevocation(taskId);
    return;
  }
  // 还在：开闸 + 恢复可重建资格；补偿清理一律取消（绝不许清一个还活着的任务的数据）。
  needsPurge.delete(taskId);
  notePurgeDone(taskId);
  forgetTaskMonitorScan(taskId);
  await clearCursorsSafely(taskId);
  releaseTaskRevocation(taskId);
}

/**
 * 启动期的孤儿清扫：**任务都不在了的那些 claude 投影 / 未决调用 / 读取位置**。
 *
 * 为什么非有不可：上面那条补偿是进程内的（重试阶梯 + `pendingPurges`），进程在重试做完之前
 * 没了就断了。这些表没有 FK cascade，也没有任何用户入口能看到它们（卡挂在一个已经不存在的
 * 任务上），所以漏掉就是永久的脏数据。按「`task_id` 在 `tasks` 里没有对应行」判，跟删除路径
 * 的顺序无关 —— 删除期那一瞬的交错写进来的行，下次启动一定会被它收掉。
 */
export async function sweepOrphanClaudeMonitors(): Promise<{ monitors: number; pending: number; cursors: number }> {
  const live = new Set((await db.select({ id: tasks.id }).from(tasks)).map((r) => r.id));
  const countOf = async <T extends { taskId: string }>(rows: T[]): Promise<string[]> =>
    [...new Set(rows.map((r) => r.taskId).filter((id) => !live.has(id)))];
  const deadMonitors = await countOf(await db.select({ taskId: monitors.taskId })
    .from(monitors).where(eq(monitors.kind, "claude")));
  const deadPending = await countOf(await db.select({ taskId: monitorPendingCalls.taskId })
    .from(monitorPendingCalls));
  const deadCursors = await countOf(await db.select({ taskId: monitorScanCursors.taskId })
    .from(monitorScanCursors));
  for (const taskId of deadMonitors) {
    await db.delete(monitors).where(and(eq(monitors.taskId, taskId), eq(monitors.kind, "claude")));
  }
  for (const taskId of deadPending) {
    await db.delete(monitorPendingCalls).where(eq(monitorPendingCalls.taskId, taskId));
  }
  for (const taskId of deadCursors) await clearScanCursors(taskId);
  for (const taskId of [...deadMonitors, ...deadPending, ...deadCursors]) {
    clearMonitorRecovery(taskId);
    notePurgeDone(taskId);
  }
  return { monitors: deadMonitors.length, pending: deadPending.length, cursors: deadCursors.length };
}

/**
 * 这个任务落盘的读取位置（只给回归用：验「位置不随任何缓存一起丢」）。
 *
 * 「位置有没有归零」恰恰是这条路最该钉住的性质 —— 只断言「最终读到了末尾」的话，位置每轮
 * 归零、靠单窗口读完的夹具照样绿（第 12 轮审查 F1）。
 */
export const monitorCheckpointOf = (taskId: string): Promise<Map<string, ScanCursor> | null> =>
  loadScanCursors(taskId);

/**
 * 「上一轮把这个任务的游标丢了」。
 *
 * 丢游标之后的那一轮必然「读到新字节」（它在重读已经读过的前缀），拿这个当**进展**会让
 * 退避预算永远清零，于是每秒重读一个大文件、永远到不了 exhausted（第 8 轮审查指出的对称
 * 错误）。进展要绑定**确认落地的事实**或**单调往前的位置**，不是「这一轮读了字节」。
 */
const rewound = new Set<string>();

/**
 * 「库里那份位置已经作废、但还没删掉」。
 *
 * 清位置要走数据库,而**要清位置的时机多半正是数据库刚出过问题的时候**。清不掉不能当作
 * 「那就先接着用吧」:那份位置对应的事实没确认落库,照它往后读就是把那一段整个跳过。所以
 * 记在这儿,下一轮先重试清理,清不掉就**这一轮也不采用它**(从零读,代价只是重读)。
 */
const staleCursors = new Set<string>();

/**
 * 把这个任务落盘的位置清掉。**绝不抛**——调用它的地方全是「已经出错、正在回退」的路径,
 * 在那里再抛一次会把更要紧的事(登记恢复责任)整个越过去(第 14 轮审查 F1)。
 */
async function clearCursorsSafely(taskId: string): Promise<boolean> {
  try {
    await clearScanCursors(taskId);
    staleCursors.delete(taskId);
    return true;
  } catch (e) {
    staleCursors.add(taskId);
    console.warn(`[ash] 内置 Monitor 历史回填：task=${taskId} 作废读取位置失败,`
      + `这一份位置已标记为不可用,下一轮会先重试清理:`, e);
    return false;
  }
}

/**
 * 丢掉这个任务的扫描游标，并记下「下一轮是重读、不算进展」。
 *
 * **内存那半截先做完、而且永远做得成**:它才是「下一轮要重放」这件事的凭据。落盘那半截
 * best-effort,失败了由 `staleCursors` 兜住(见上)。
 */
async function discardScan(taskId: string): Promise<void> {
  snapshots.delete(taskId);
  rewound.add(taskId);
  await clearCursorsSafely(taskId);
}

/**
 * 把一个任务的内置 Monitor 补进投影表，并纠正已有记录。
 *
 * 返回新补了几行（纠正不计入）。并发调用共享同一次扫描。
 */
export function backfillClaudeMonitors(
  taskId: string,
  /**
   * `external`（默认 true）= 这是一次**外部真实请求**（用户打开面板、SSE 触发重读）。
   * 恢复账本自己的退避推进必须传 false：公共入口会还原退避预算，自己推进时还原就等于
   * 永远停在第一档、永远到不了 exhausted（第 7 轮审查实测 4 次间隔全是 ~1003ms）。
   */
  opts: { external?: boolean } = {},
): Promise<number> {
  if (dbClient.closed) return Promise.resolve(0);
  // **删掉的任务连读都不读。** 删除期内新来的请求如果照常开工，它读到的会话可能还没被删到
  // （删除是十几条语句），而写出去的行此后没有任何入口能清（第 14 轮审查 N3）。
  if (isTaskRevoked(taskId)) return Promise.resolve(0);
  const running = inflight.get(taskId);
  if (running) return running;
  // 退避推到上限之后账是留着的、定时器是停的。真实请求进来时把预算还给它，否则那条账
  // 永远卡在「已停、且没人会再推」。
  if (opts.external !== false) resetMonitorRecoveryBudget(taskId);
  const job = runBackfill(taskId)
    // **最外面这一层是不变量,不是保险丝**:`backfillClaudeMonitors` 对调用方的承诺是「这一轮
    // 要么做完、要么留下一笔能自己往前推的责任」,两个读取端点(monitor-routes.ts)都直接
    // `await` 它。里面那个 catch 漏掉任何一条出口,后果都是同一个:路由 500、责任没登记、
    // 没有任何人会再试一次 —— 稳定连接上的旧任务此后只能靠用户手动刷新(第 14 轮审查 F1)。
    .catch((e) => {
      console.warn(`[ash] 内置 Monitor 历史回填出现没被兜住的失败（task=${taskId}）:`, e);
      noteMonitorRecovery(taskId, "write-failed", false);
      return 0;
    })
    .finally(async () => {
      // **补偿清理排在最前。** 它没做完之前这个任务不算空闲：还在 `inflight` 里，所以后来
      // 的调用方 await 的是同一个 job（包含清理），不会在清理中途看到半删的状态。顺序反过来
      // 的话，先从 Map 里摘掉、再 await 清理，中间那一段里新来的扫描看不到任何「这个任务被
      // 删过」的痕迹（第 14 轮审查 N3）—— 现在那一段由门闸兜住，而顺序也一并理顺。
      if (needsPurge.has(taskId)) await purgeRevokedTask(taskId);
      inflight.delete(taskId);
      // 在途期间被选中淘汰的，到这里才真正让位（位置已经落库，这一步只丢配对状态）。
      if (evictWhenIdle.delete(taskId)) evictScan(taskId);
    });
  inflight.set(taskId, job);
  return job;
}

async function runBackfill(taskId: string): Promise<number> {
  let added = 0;
  // 这一轮有没有剩下「没确认完成」的事实。**四样都在外层**：销账的判断发生在死活裁决
  // 之后，而扫描结果是在 try 里拿到的。
  let missed = false;
  let unread = false;
  // 这一轮看到的 run 文件清单（**死活裁决在 try 之外**，所以要在外层）。它和行上的
  // `source_run` 一起回答「起它的那一代 run 结束了没有」——不依赖任何会被淘汰的内存状态。
  let runFiles: { all: Set<string>; latest: Set<string> } = { all: new Set(), latest: new Set() };
  try {
    const rows = await db
      .select({
        id: sessions.id, cliSessionId: sessions.cliSessionId, outPath: sessions.agentOutPath,
        // 只为判「文件尾那半行是正在被写、还是永久缺了」（见 scanSession 的 sessionLive）。
        agentPid: sessions.agentPid, agentStartedAt: sessions.agentStartedAt,
      })
      .from(sessions)
      .where(and(eq(sessions.taskId, taskId), eq(sessions.agentType, "claude")));

    // 按会话记的那份恢复责任，**在这里就能认到任务头上**（它的归属就是我们正在跑的这个
    // 任务）——不必等那边的定时器再查一次库，更不会因为它的阶梯推完就永远停在那儿
    // （第 9 轮审查不拦项 2）。
    adoptSessionRecovery(taskId, rows.map((r) => r.cliSessionId).filter((x): x is string => !!x));

    // 快照跨调用复用，但**会话清单每次重查**：任务后来新增了会话，上一次的快照里没有它
    // （实测 noSessionThenNewSession：首次回填时任务还没有会话，之后新增 → 永远读不到）。
    // 这一轮是不是在重读（上一轮把游标丢了）。读之前就要取，取完立刻销掉：它只影响这一轮
    // 的进展判定。
    const reread = rewound.delete(taskId);
    let scan = snapshots.get(taskId);
    if (!scan) {
      // 没有现成快照（第一次读、或者配对状态被挤掉了）：位置从库里接回来，配对状态重建。
      scan = newTaskScan();
      // **上一轮说过这份位置作废了。** 先重试清理;清不掉也绝不采用它——它对应的事实没有
      // 确认落库,照它往后读等于把那一段永久跳过(第 14 轮审查 F1)。
      scan.restoredCursors = staleCursors.has(taskId)
        ? (await clearCursorsSafely(taskId), null)
        : await loadScanCursors(taskId);
    }
    rememberScan(taskId, scan);
    scan.truncated = false;
    scan.failed = false;
    scan.advanced = false;
    scan.generationChanged = false;
    scan.lateOverflow = false;
    scan.partialTail = false;
    scan.skippedRecord = false;
    scan.cursorsDirty = false;

    scan.runFiles = { all: new Set(), latest: new Set() };
    // 悬着的调用（读到了 `tool_use`、还没配上 `task_started`）每轮都取一次：快照可能刚被内存
    // 上限挤掉，也可能这是第一次读这个任务。只给**新建的会话桶**倒进去，复用的桶里那份才是
    // 权威（它可能已经比库里新）。
    scan.restoredPending = await loadPendingCalls(taskId);
    // **这一轮查不到的会话，它那份桶一律作废。** 复用的快照里可能还留着上一轮悬着的调用，而
    // 会话行已经没了（任务被删、会话被清）——照常走下去会在提交后把它们重新写回库里，成为
    // 没有任何入口能清的孤儿行（第 12 轮审查 N5）。删除那一侧也会主动作废整份快照
    // （`forgetTaskMonitorScan`），这一步兜住「删除发生在这一轮的某个 await 里」。
    const live = new Set(rows.map((r) => r.id));
    for (const key of [...scan.sessions.keys()]) if (!live.has(key)) scan.sessions.delete(key);
    for (const session of rows) {
      if (!session.outPath) continue;
      const live = !!session.agentPid && isSameProcess(session.agentPid, session.agentStartedAt ?? null);
      await scanSession(scan, session.id, session.cliSessionId, session.outPath, undefined, live);
    }
    runFiles = scan.runFiles;
    if (scan.foreign.size) {
      console.warn(`[ash] 内置 Monitor 历史回填：task=${taskId} 的文件里出现了别的会话身份`
        + `（${[...scan.foreign].join(", ")}），已按文件归属采用`);
    }
    // **这一轮没读全的四种样子**，一条都不能漏：读到上限、读失败、末尾是半行、跳过了一条
    // 装不下的记录。漏掉任何一种就是把「未确认」当成「已完成」——账本一清，后面只能等用户
    // 自己再打开一次面板（第 13 轮审查 N3：后两种原先连提示都不留）。
    const incomplete = ([
      [scan.truncated, "scan-unfinished", "有文件读到了单次上限"],
      [scan.failed, "scan-failed", "有文件读失败"],
      [scan.partialTail, "tail-incomplete", "有文件末尾是半行"],
      [scan.skippedRecord, "record-skipped", "跳过了一条装不进窗口的记录"],
    ] as const).filter(([hit]) => hit);
    if (incomplete.length) {
      // **不是「下次打开面板继续」**：记进待恢复账本，由它退避重排自己往下推。游标已经
      // 记下，所以每一次重推都真的往后读一段；`scan.advanced` 作为「有进展」喂给退避预算。
      unread = true;
      // 重读那一轮的「读到新字节」不算进展（见 `rewound`）。
      const progressed = scan.advanced && !reread;
      for (const [, reason] of incomplete) noteMonitorRecovery(taskId, reason, progressed);
      console.warn(`[ash] 内置 Monitor 历史回填这一轮没读完（task=${taskId}，`
        + `${incomplete.map(([, , label]) => label).join("，")}），游标已记下，已排自动续读`);
    }

    // 乱序事实把缓冲占满了 → 扫描**背压**停下，游标停在那条还没消费的事实之前（见
    // claude-monitor-scan.ts 的 LATE_CAP）。所以这里**不丢游标**：丢了就是从零重读同一段
    // 前缀，而输入没变就会再次占满 —— 那条路不收敛，实测 142MB 日志下永远读不到末尾的
    // Monitor（第 8 轮审查）。留账等下一轮从那一行继续。
    if (scan.lateOverflow) {
      unread = true;
      noteMonitorRecovery(taskId, "orphan-overflow", scan.advanced && !reread);
      console.warn(`[ash] 内置 Monitor 历史回填：task=${taskId} 这一轮要裁决的迟到事实顶到了`
        + `单轮上限，游标停在那一条之前，下一轮从它继续`);
    }

    // **提交条件不只是「有新字节」。** 新回合会先创建一个空的 run 文件、过一会儿才输出，那一刻
    // 没有任何新增字节，但「上一代已经结束」这件事已经成立，必须落库（否则死活裁决退回「这条
    // 会话现在有活进程」，旧监听一直显示正在盯着——第 5 轮审查实测 emptyNewRun）。
    // 迟到事实（读过了、配不上内存状态）也要交出去配一遍：配对状态被内存上限挤掉之后，
    // 这一轮读到的可能全是「前缀里那些 Monitor 的回执和终态」（第 9 轮审查）。
    // **写之前先问一句「这个任务还在不在」。** 从查到会话到这里中间有好几个 await，任务可能
    // 已经被删干净了（见 forgetTaskMonitorScan）；这一轮手里的全是删除之前的事实。
    if (isTaskRevoked(taskId)) {
      console.warn(`[ash] 内置 Monitor 历史回填：task=${taskId} 在这一轮进行中被删除，本轮结果作废`);
      return added;
    }
    const late = lateFactsOf(scan);
    let undecidable: LateFact[] = [];
    if (scan.advanced || scan.generationChanged || late.length) {
      const outcome = await commitRound(taskId, foundOf(scan), late, (n) => { added = n; },
        sourceSetOf(scan));
      added = outcome.added;
      undecidable = outcome.undecidable;
      // 裁完的就从通道里清掉（配上了的已经落到行上，配不上的已证明与我们无关）。裁不清的
      // 留着：下一轮重放之后那些存量行会补上 `tool_use_id`，届时就配得上了。
      clearLateFacts(scan, undecidable);
      if (outcome.missed) {
        // 条件更新 0 行 = 那次更新**没有**落地（读到写之间别的 writer 改了状态）。上一版
        // 把它当成已提交，于是那条事实永久消失（实测 casAtRace）。记账 + 把快照丢掉：
        // 下一轮从头重读，重新观察到同一条事实再裁决一次（那时 prior 是对方写的新状态，
        // 多数情况下判定为「来源终态已成定局，不该改」→ 干净收场）。
        await discardScan(taskId);
        noteMonitorRecovery(taskId, "update-missed", added > 0);
      } else {
        // **这一轮消费过的都确认落库了** ⇒ 位置可以停在半路了（见 saveCheckpoint）。
        scan.committedThrough = true;
      }
      missed = outcome.missed;
    } else {
      // 一个新字节都没读、也没有迟到事实 ⇒ 这份状态消费过的内容还是上一轮那些，结论不变。
      scan.committedThrough = true;
    }

    // ── 未决调用落盘（检查点的第三半：位置、已提交的行，以及**还没成行的那一条**）────
    //
    // 顺序要紧：**只有确认提交之后才落**。没提交的那几条路会回退位置、把那些行重新读一遍，
    // 这时落盘只是留下一份马上又会被重建的拷贝。反过来，位置之所以可以不回退，正是因为这一
    // 步成立（见 saveCheckpoint）。
    if (scan.committedThrough) {
      await syncPendingCalls(taskId, pendingCallsOf(scan), clearedCallsOf(scan));
      clearPendingLedger(scan);
      // **位置也当场落盘**：这一轮的事实已经确认落库，位置之前的内容全都有归宿了。只留在
      // 内存里的话，它的存活就取决于「哪张缓存还记得它」——而那张缓存总有上限，上限一到被
      // 挤掉的可能正是这个还没读完的任务（第 11/12/13 轮审查同一个判据的三个出口）。
      if (scan.cursorsDirty) await saveCheckpoint(taskId, scan);
    }

    // ── 销账前最后一问：**还有裁不清的一次性事实吗** ─────────────────────────────
    //
    // 只剩一种裁不清：存量行连 `tool_use_id` 都没记（这一列是后加的），于是后缀里的那条起手
    // 回执配不上任何行，却也不能断言它与我们无关。回到一个**确定可重放**的位置（从零）并
    // 留账：重放一遍会把那些存量行的 `tool_use_id` 补上，下一轮这条回执就配得上了。
    //
    // 其余两种在提交层当场就裁完了（配回行 / 证明与我们无关），不占内存也不钉位置——上一版
    // 靠「这一代有没有跳过前缀」来决定销不销账，而跳过前缀是常态，于是固定输入永远读不完
    // （第 10 轮审查实测 24 轮同点停滞）。
    if (undecidable.length && !unread) {
      unread = true;
      await discardScan(taskId);
      noteMonitorRecovery(taskId, "checkpoint-incomplete", false);
      console.warn(`[ash] 内置 Monitor 历史回填：task=${taskId} 有 ${undecidable.length} 条起手回执`
        + `配不上任何已提交的行，而库里还有没记 tool_use_id 的存量行 —— 已回到可重放位置重读`);
    }
  } catch (e) {
    // 回填失败不该让面板打不开：这是补历史，不是主路径。但要留下线索，而且**部分成功的那些
    // 也要让别的页面看得到**：`added` 由 commitFound 每成功一行就回报一次（上一轮只在它
    // 整个返回后才赋值，所以第 1 行成功、第 2 行抛错时这里仍是 0，publish 到不了
    // ——第 5 轮审查不拦项 1）。
    console.warn(`[ash] 内置 Monitor 历史回填失败（task=${taskId}）:`, e);
    if (added) bus.publish({ type: "task.monitors", taskId });
    // **责任先登记,清理随后。** 顺序是硬要求,不是风格:清理自己也走数据库,同一段故障里它
    // 照样会抛,而原来的顺序让第二次异常直接越过了这一行 —— 整轮 Promise 抛到路由、页面吃
    // 一个 500,此后既没有恢复责任也没有人重试,用户只能手动刷新(第 14 轮审查 F1 实测)。
    // 事实已经从文件里读出来过、却没确认落库。留账 + 自动重排：这一条上一版只有一句
    // 「历史回填会再补」，而历史回填本身只在用户打开面板时才跑。
    noteMonitorRecovery(taskId, "write-failed", added > 0);
    await discardScan(taskId); // 失败的快照不留，下次从头建（位置归零，事实能被重新读到）
    return added;
  }

  // **死活裁决属于同一轮的恢复责任。** 它在 clear 之后跑、失败只 warn 的话，「扫描读完了」
  // 就被当成「这一轮全做完了」——实测注入一次死活 UPDATE 失败：行停在 running、账本是空的、
  // 一条事件都没发，要等人再调一次回填才变 lost（第 7 轮审查 livenessWriteFailure）。
  let reconciled = true;
  try {
    if (await reconcileLiveness(taskId, runFiles)) bus.publish({ type: "task.monitors", taskId });
  } catch (e) {
    console.warn(`[ash] 内置 Monitor 死活裁决失败（task=${taskId}）:`, e);
    reconciled = false;
    noteMonitorRecovery(taskId, "liveness-failed", added > 0);
  }
  // **销账的条件是「这一轮什么都没剩下」**，四件事都要问：读到 EOF 了、没有读失败、发出去
  // 的更新都落地了、死活也核对完了。少问任何一句都会把「未确认」当成「已完成」。
  if (!unread && !missed && reconciled) clearMonitorRecovery(taskId);
  if (added) bus.publish({ type: "task.monitors", taskId });
  return added;
}


/**
 * 重新裁决这个任务已有投影行的死活，**与文件有没有新内容无关**。
 *
 * 两个方向都要纠正：
 * - 写着 `lost`、而起它的来源其实还活着 → 回到 `running`（上一次判错了）。
 * - 写着 `running`、而来源已经没了 → 落 `lost`。
 *
 * 为什么不能并进 `mergeInto`：那条路要求「这一轮扫到了这条 Monitor」。文件没有新内容时
 * （常态）根本不会走到它，而进程的死活随时在变（实测 existingLiveness 两个方向都卡住）。
 * 来源已经给过终态的行不在此列 —— 那是事实，不是推断。
 */
async function reconcileLiveness(
  taskId: string,
  /** 这一轮看到的 run 文件（见 TaskScan.runFiles）。代次结论由它和行上的 `source_run` 现算。 */
  runFiles: { all: Set<string>; latest: Set<string> },
): Promise<boolean> {
  const rows = await db
    .select({
      id: monitors.id, status: monitors.status, cliSessionId: monitors.cliSessionId,
      taskId: monitors.taskId, sourcePid: monitors.sourcePid, sourcePidStartedAt: monitors.sourcePidStartedAt,
      sourceRun: monitors.sourceRun,
    })
    .from(monitors)
    .where(and(
      eq(monitors.taskId, taskId),
      eq(monitors.kind, "claude"),
      inArray(monitors.status, ["running", "lost"]),
    ));
  if (!rows.length) return false;

  const probe = createLivenessProbe();
  const revive: string[] = [];
  const bury: string[] = [];
  /** 这一轮新判明「那一代 run 已经结束」的行：结论要落到列上，别每轮重算（也给开机清扫用）。 */
  const stale: string[] = [];
  for (const row of rows) {
    // ── 代次：**认文件，不认内存** ───────────────────────────────────────────────
    //
    // 这一行起在哪个 run 文件里是记在列上的（`source_run`），而「这条会话最新的 run 是哪个」
    // 这一轮刚列过。两样一比就知道「后来又起过新一轮没有」——不需要 `found` 还在内存里。
    //
    // 为什么非这样不可：配对状态被内存上限挤掉之后，`found` 是空的，代次翻转无从算起；而新
    // 回合会先创建一个**空的** run 文件，于是旧监听会被「这条会话现在有活进程」证明成「还在
    // 盯着」——拿下一代人的凭据给上一代续命（第 10 轮审查用生产服务 + 真页面实测）。
    //
    // 只在「这一行的 run 文件这一轮确实列到了」时才下这个结论：列不到（文件被删、目录换了）
    // 说明我们没有权威清单，那就不猜，退回下面按 pid / 会话判。
    const outdated = !!row.sourceRun && runFiles.all.has(row.sourceRun) && !runFiles.latest.has(row.sourceRun);
    if (outdated && row.sourcePid !== 0) stale.push(row.id);
    const alive = outdated ? false : await probe.sourceAlive(row);
    if (alive && row.status === "lost") revive.push(row.id);
    else if (!alive && row.status === "running") bury.push(row.id);
  }
  if (stale.length) {
    // 0 不是缺省值而是明确结论：「起它的那一代 run 之后又起过新的 run」（见 db/schema.ts）。
    await db.update(monitors).set({ sourcePid: 0 }).where(inArray(monitors.id, stale));
  }
  if (revive.length) {
    await db.update(monitors)
      .set({ status: "running", endedAt: null, endedReason: null })
      .where(and(inArray(monitors.id, revive), eq(monitors.status, "lost")));
  }
  if (bury.length) {
    await db.update(monitors)
      .set({ status: "lost", endedAt: now(), endedReason: "起它的那个智能体进程已经不在了" })
      .where(and(inArray(monitors.id, bury), eq(monitors.status, "running")));
  }
  return revive.length + bury.length + stale.length > 0;
}
