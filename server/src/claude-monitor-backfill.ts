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
import {
  dropLateFacts, foundOf, lateFactsOf, newTaskScan, resumedFromCheckpoint, scanSession,
  strandedFacts, type TaskScan,
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
    snapshots.delete(key);
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
 * **停的是「可重放位置」而不是「读到哪儿」**（第 9 轮审查的类问题）：配对状态马上就要被
 * 丢掉，而 `offset` 之前那段前缀里建立的关联只在内存里。`cursor.safe` 是那条会话最后一次
 * 「没有任何悬着的关联」的位置，从它往后重放不会丢关联（见 claude-monitor-scan.ts 的
 * `cursors` 说明）。
 *
 * 往回退这件事本身**不算进展**：下一轮会重读 `safe → offset` 这一段，拿它当进展就会把退避
 * 预算清零（同第 8 轮那条对称错误，见 `rewound`）。
 */
function parkCursors(taskId: string, scan: TaskScan): void {
  const cursors = new Map<string, { size: number; offset: number }>();
  let rolledBack = false;
  for (const session of scan.sessions.values()) {
    for (const [path, cursor] of session.cursors) {
      cursors.set(path, { size: cursor.size, offset: cursor.safe });
      if (cursor.safe < cursor.offset) rolledBack = true;
    }
  }
  if (!cursors.size) return;
  if (rolledBack) rewound.add(taskId);
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
    scan.orphanOverflow = false;

    for (const session of rows) {
      if (!session.outPath) continue;
      await scanSession(scan, session.id, session.cliSessionId, session.outPath);
    }
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
    if (scan.orphanOverflow) {
      unread = true;
      noteMonitorRecovery(taskId, "orphan-overflow", scan.advanced && !reread);
      console.warn(`[ash] 内置 Monitor 历史回填：task=${taskId} 还没配对的事实占满了缓冲，`
        + `游标停在那一条之前，下一轮从它继续`);
    }

    // **提交条件不只是「有新字节」。** 新回合会先创建一个空的 run 文件、过一会儿才输出，那一刻
    // 没有任何新增字节，但「上一代已经结束」这件事已经成立，必须落库（否则死活裁决退回「这条
    // 会话现在有活进程」，旧监听一直显示正在盯着——第 5 轮审查实测 emptyNewRun）。
    // 迟到事实（读过了、配不上内存状态）也要交出去配一遍：配对状态被内存上限挤掉之后，
    // 这一轮读到的可能全是「前缀里那些 Monitor 的回执和终态」（第 9 轮审查）。
    const late = lateFactsOf(scan);
    if (scan.advanced || scan.generationChanged || late.length) {
      const outcome = await commitRound(taskId, foundOf(scan), late, (n) => { added = n; });
      added = outcome.added;
      dropLateFacts(scan, outcome.resolved); // 配上了的从缓冲里销掉，别再占着
      if (outcome.missed) {
        // 条件更新 0 行 = 那次更新**没有**落地（读到写之间别的 writer 改了状态）。上一版
        // 把它当成已提交，于是那条事实永久消失（实测 casAtRace）。记账 + 把快照丢掉：
        // 下一轮从头重读，重新观察到同一条事实再裁决一次（那时 prior 是对方写的新状态，
        // 多数情况下判定为「来源终态已成定局，不该改」→ 干净收场）。
        discardScan(taskId);
        noteMonitorRecovery(taskId, "update-missed", added > 0);
      }
      missed = outcome.missed;
    }

    // ── 销账前最后一问：**还有配不上的一次性事实吗** ─────────────────────────────
    //
    // 读到文件尾不等于「什么都没剩下」。这一轮的读取位置可能跳过了一整段前缀（被内存上限
    // 挤掉时停好的位置），那段里建立的关联既不在内存里、又没落到库里时，后缀的事实就配不上
    // 任何东西——上一版照旧销账，于是面板显示一张漏掉的卡 + 一条写着 running 的已完成监听，
    // 刷新也不会变（第 9 轮审查用生产服务 + 真页面实测）。
    //
    // 两种收场，判据是**这一代有没有跳过前缀**：
    // - 没跳过：这些事实的 `task_started` 必然已经读过且不是 Monitor ⇒ 它们确实与我们
    //   无关（普通后台 Bash 的终态通知、以及「不是 Monitor」的结论被 4096 容量淘汰之后
    //   重新退成孤儿的那些）。销掉，正常收尾。
    // - 跳过了：不能这么推断。回到一个**确定可重放**的位置（从零）并留账，让它自己再读
    //   一遍——重放一遍一定能把关联重建出来，而且下一轮就落进上面那一支。
    const stranded = strandedFacts(scan);
    if (stranded && !unread) {
      if (resumedFromCheckpoint(scan)) {
        unread = true;
        discardScan(taskId);
        noteMonitorRecovery(taskId, "checkpoint-incomplete", false);
        console.warn(`[ash] 内置 Monitor 历史回填：task=${taskId} 有 ${stranded} 条读过的事实`
          + `既配不上内存状态、也配不上已提交的行，而这一轮跳过了前缀 —— 已回到可重放位置重读`);
      } else {
        dropLateFacts(scan, lateFactsOf(scan));
      }
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
    if (await reconcileLiveness(taskId)) bus.publish({ type: "task.monitors", taskId });
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
async function reconcileLiveness(taskId: string): Promise<boolean> {
  const rows = await db
    .select({
      id: monitors.id, status: monitors.status, cliSessionId: monitors.cliSessionId,
      taskId: monitors.taskId, sourcePid: monitors.sourcePid, sourcePidStartedAt: monitors.sourcePidStartedAt,
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
  for (const row of rows) {
    const alive = await probe.sourceAlive(row);
    if (alive && row.status === "lost") revive.push(row.id);
    else if (!alive && row.status === "running") bury.push(row.id);
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
  return revive.length + bury.length > 0;
}
