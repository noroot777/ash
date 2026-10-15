// 历史回填：把 agent 已经起过的内置 Monitor 补进投影表，并按来源事实纠正已有的记录。
//
// 为什么非有不可：这个功能的起点就是用户打开一个任务，agent 在对话里反复说「等 Monitor
// 通知」，而哨兵面板写着「这个任务上还没有哨兵」。实时投影只能管**之后**发生的事——对那个
// 触发需求的任务本身，以及所有升级前跑过的任务，面板仍然是空的。
//
// 文件枚举、增量读取和事件认人都在 `claude-monitor-scan.ts`；这个文件只管两件事：
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
import { loadPendingCalls, syncPendingCalls } from "./claude-monitor-pending.js";
import {
  clearedCallsOf, clearLateFacts, clearPendingLedger, foundOf, lateFactsOf, newTaskScan,
  parkableCursors, pendingCallsOf, scanSession, type LateFact, type TaskScan,
} from "./claude-monitor-scan.js";
import { db, dbClient } from "./db/index.js";
import { monitors, sessions } from "./db/schema.js";
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
 * 被硬上限挤掉的任务，**只留下它读到哪儿**。
 *
 * 一份快照里的重东西是 `found`/`pending`/孤儿缓冲，而「读到第几字节」只是每个文件几十字节。
 * 所以内存上限该淘汰的是前者，不是后者：位置一丢，下一轮就从零重读，而单次只读 128 MiB
 * ——「超过上限、Monitor 在末尾」的任务会反复重读同一段前缀、永远读不到末尾（第 8 轮审查
 * 指出把阈值从 32 抬到 64 并不改变这一点）。
 *
 * 这张表只存位置，所以可以给一个宽得多的上限；真要越界也只是退回「从头重读」，而不是把
 * 「还没读完」这件事本身忘掉（那条账在恢复账本里，跟这里无关）。
 */
const parked = new Map<string, Map<string, { size: number; offset: number }>>();
const PARKED_CAP = 512;

/** 新建扫描状态，但**继承之前停好的读取位置**（见 `parked`）。 */
function adoptParkedCursors(taskId: string): TaskScan {
  const scan = newTaskScan();
  const saved = parked.get(taskId);
  if (!saved) return scan;
  parked.delete(taskId);
  // 位置按文件路径存（路径本来就唯一），`scanSession` 新建会话桶时会从这里取。
  scan.parkedCursors = saved;
  return scan;
}

/**
 * 记下这个任务的扫描快照，并按「最久没用的先挤掉」淘汰——**但正在恢复中的游标不挤**，
 * 真要挤也只挤掉重的那部分、把读取位置停好（`parked`）。
 *
 * 为什么要豁免：快照里记着「这个文件读到第几字节」。被挤掉之后下一轮从零开始，而单次只读
 * 128 MiB，于是「超过上限、Monitor 在末尾」的那种任务会反复重读同一段前缀、永远到不了
 * 末尾；更糟的是 `advanced` 只说明「相对这一轮的新游标读过字节」，看起来还一直在前进
 * （第 7 轮审查按控制流推断，第 8 轮指出硬上限这一支仍是原来的行为）。
 */
function rememberScan(taskId: string, scan: TaskScan): void {
  snapshots.delete(taskId);
  snapshots.set(taskId, scan); // 用过的挪到末尾
  if (snapshots.size <= SNAPSHOT_CAP) return;
  const protectedTasks = monitorRecoveryTasks();
  for (const key of [...snapshots.keys()]) {
    if (snapshots.size <= SNAPSHOT_CAP) return;
    if (key === taskId || protectedTasks.has(key)) continue; // 还没读完的不动
    const victim = snapshots.get(key);
    snapshots.delete(key);
    // **位置也要停好**，跟硬上限那一支一个待遇（第 11 轮审查的类问题）。读完一个任务的历史
    // 之后它就不再受保护，于是常规淘汰把位置一起扔掉 —— 下一次打开它又从 0 读起，几百 MB
    // 的历史得重走一遍 128 MiB 的阶梯（实测：销账之后每隔几轮又报一次 scan-unfinished，
    // 位置在 0 和 EOF 之间来回）。位置只有几十字节，没有任何理由跟着配对状态一起丢。
    if (victim) parkCursors(key, victim);
  }
  // 全都在恢复中：按硬上限兜底，但**位置要停好**（只丢可重建的那部分）。
  while (snapshots.size > SNAPSHOT_HARD_CAP) {
    const oldest = snapshots.keys().next();
    if (oldest.done || oldest.value === taskId) break;
    const victim = snapshots.get(oldest.value);
    snapshots.delete(oldest.value);
    if (victim) parkCursors(oldest.value, victim);
    console.warn(`[ash] 内置 Monitor 扫描快照超过硬上限（${SNAPSHOT_HARD_CAP}），`
      + `task=${oldest.value} 的配对状态已丢弃，读取位置已停好，下一轮从原位继续`);
  }
}

/**
 * 把一份快照里的读取位置抠出来留着（见 `parked`）。
 *
 * **位置照原样停住、不往回退**：位置之前那段里唯一只存在于内存的东西是「还悬着的调用」，
 * 而它已经落盘了（`claude-monitor-pending.ts`），下一轮新建会话桶时接回来。
 *
 * 上一版停的是「最后一个没有悬着关联的位置」。那条路在**永远不会完结的调用**上会把位置钉死
 * ——启动被拒、进程在那一行之后被杀 —— 于是每轮重读同一个窗口，末尾的 Monitor 永远读不到
 * （第 11 轮审查实测 12 轮停滞；回退这件事本身也不算进展，见 `rewound`）。
 */
function parkCursors(taskId: string, scan: TaskScan): void {
  // **没确认提交过就不许停在半路**（检查点不变量，见 claude-monitor-scan.ts 文件头）：这一轮
  // 读过的字节还没落库时，位置之前那段既不在内存里、也不在库里，从它往后读再也拼不回来。
  // 那种情况只有一条安全的路：整份丢掉，下一轮从零重放（代价是重读，不是错误显示）。
  //
  // 按现在的调用序其实到不了这一支（提交没落地的那几条路都会先 `discardScan`，快照根本不在表
  // 里），它是这条不变量的**硬闸**：留着是为了下一次改动绕不过去，不是因为有哪条回归打在它
  // 身上。
  if (!scan.committedThrough) { discardScan(taskId); return; }
  const cursors = parkableCursors(scan);
  if (!cursors.size) return;
  parked.delete(taskId);
  parked.set(taskId, cursors);
  while (parked.size > PARKED_CAP) {
    const oldest = parked.keys().next();
    if (oldest.done) break;
    // 位置表也满了：这一条只能丢。丢位置 = 下一轮从零重放（不丢正确性），但**那一轮同样是
    // 重读**，不能当成进展（第 9 轮审查点名的同类位置）。
    rewound.add(oldest.value);
    parked.delete(oldest.value);
  }
}

/** 正在跑的那次 → 它的 Promise。并发调用共享同一次工作，不重复读盘。 */
const inflight = new Map<string, Promise<number>>();

/** 这个任务的扫描游标还在不在（只给回归用：验「恢复中的游标没被挤掉」）。 */
export const monitorScanTracked = (taskId: string): boolean => snapshots.has(taskId);

/**
 * 「上一轮把这个任务的游标丢了」。
 *
 * 丢游标之后的那一轮必然「读到新字节」（它在重读已经读过的前缀），拿这个当**进展**会让
 * 退避预算永远清零，于是每秒重读一个大文件、永远到不了 exhausted（第 8 轮审查指出的对称
 * 错误）。进展要绑定**确认落地的事实**或**单调往前的位置**，不是「这一轮读了字节」。
 */
const rewound = new Set<string>();

/** 丢掉这个任务的扫描游标，并记下「下一轮是重读、不算进展」。 */
function discardScan(taskId: string): void {
  snapshots.delete(taskId);
  parked.delete(taskId);
  rewound.add(taskId);
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
  const running = inflight.get(taskId);
  if (running) return running;
  // 退避推到上限之后账是留着的、定时器是停的。真实请求进来时把预算还给它，否则那条账
  // 永远卡在「已停、且没人会再推」。
  if (opts.external !== false) resetMonitorRecoveryBudget(taskId);
  const job = runBackfill(taskId).finally(() => inflight.delete(taskId));
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
      .select({ id: sessions.id, cliSessionId: sessions.cliSessionId, outPath: sessions.agentOutPath })
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
    const scan = snapshots.get(taskId) ?? adoptParkedCursors(taskId);
    rememberScan(taskId, scan);
    scan.truncated = false;
    scan.failed = false;
    scan.advanced = false;
    scan.generationChanged = false;
    scan.lateOverflow = false;

    scan.runFiles = { all: new Set(), latest: new Set() };
    // 悬着的调用（读到了 `tool_use`、还没配上 `task_started`）每轮都取一次：快照可能刚被内存
    // 上限挤掉，也可能这是第一次读这个任务。只给**新建的会话桶**倒进去，复用的桶里那份才是
    // 权威（它可能已经比库里新）。
    scan.restoredPending = await loadPendingCalls(taskId);
    for (const session of rows) {
      if (!session.outPath) continue;
      await scanSession(scan, session.id, session.cliSessionId, session.outPath);
    }
    runFiles = scan.runFiles;
    if (scan.foreign.size) {
      console.warn(`[ash] 内置 Monitor 历史回填：task=${taskId} 的文件里出现了别的会话身份`
        + `（${[...scan.foreign].join(", ")}），已按文件归属采用`);
    }
    if (scan.truncated || scan.failed) {
      // **不是「下次打开面板继续」**：记进待恢复账本，由它退避重排自己往下推。游标已经
      // 记下，所以每一次重推都真的往后读一段；`scan.advanced` 作为「有进展」喂给退避预算。
      unread = true;
      // 重读那一轮的「读到新字节」不算进展（见 `rewound`）。
      const progressed = scan.advanced && !reread;
      if (scan.truncated) noteMonitorRecovery(taskId, "scan-unfinished", progressed);
      if (scan.failed) noteMonitorRecovery(taskId, "scan-failed", progressed);
      console.warn(`[ash] 内置 Monitor 历史回填这一轮没读完（task=${taskId}，`
        + `${scan.truncated ? "有文件读到了单次上限" : ""}${scan.truncated && scan.failed ? "，" : ""}`
        + `${scan.failed ? "有文件读失败" : ""}），游标已记下，已排自动续读`);
    }

    // 乱序事实把缓冲占满了 → 扫描**背压**停下，游标停在那条还没消费的事实之前（见
    // claude-monitor-scan.ts 的 ORPHAN_CAP）。所以这里**不丢游标**：丢了就是从零重读同一段
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
    const late = lateFactsOf(scan);
    let undecidable: LateFact[] = [];
    if (scan.advanced || scan.generationChanged || late.length) {
      const outcome = await commitRound(taskId, foundOf(scan), late, (n) => { added = n; });
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
        discardScan(taskId);
        noteMonitorRecovery(taskId, "update-missed", added > 0);
      } else {
        // **这一轮消费过的都确认落库了** ⇒ 位置可以停在半路了（见 parkCursors）。
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
    // 步成立（见 parkCursors）。
    if (scan.committedThrough) {
      await syncPendingCalls(taskId, pendingCallsOf(scan), clearedCallsOf(scan));
      clearPendingLedger(scan);
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
      discardScan(taskId);
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
    discardScan(taskId); // 失败的快照不留，下次从头建（游标归零，事实能被重新读到）
    // 事实已经从文件里读出来过、却没确认落库。留账 + 自动重排：这一条上一版只有一句
    // 「历史回填会再补」，而历史回填本身只在用户打开面板时才跑。
    noteMonitorRecovery(taskId, "write-failed", added > 0);
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
