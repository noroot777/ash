// 扫描层：从 agent 的 stdout 落盘文件里认出内置 Monitor，**可增量续读**。
//
// 为什么要增量：上一版缓存的是「这个任务扫过了」，没有任何版本依据。而这些文件是**活的**
// ——任务还在跑，stdout 一直在追加。于是正常运行中的任务第一次打开面板之后，后续追加的
// Monitor、以及已有 Monitor 的完成通知，同一个 server 进程里再也读不到（第 4 轮审查实测
// cachedSnapshot：空文件后追加 → rows=[]；先无会话后新增会话 → rows=[]；已扫过的文件追加
// completed → 卡片仍是 running）。
//
// 所以缓存的粒度改成**每个文件读到第几字节**：
// - `size > cursor.offset` → 从 offset 接着读，只读新增那一段
// - `size < cursor.offset` → 文件被重写或截断过，从头重读
// - 出现新会话 / 新文件 → 给它建一份新游标
// - 全部文件 size 都没变 → 这一轮不碰磁盘
//
// 顺带解决了 128 MiB 上限那条：超限不再是「永远只能读前缀」，而是这一轮读到上限为止、
// offset 停在那里，下次打开面板继续往后读。
//
// ── 按会话分区，**桶里再按来源分区** ──────────────────────────────────────────
//
// `pending`/`byToolUse` 的键是来源侧的 `tool_use_id` / 后台任务 id。上一版为了「跨文件关联
// 事件」把它们做成了**跨整个任务**共用，那是实现过头了：要跨的是同一条会话的多个 run 文件，
// 不是不同会话。实测 1017 条 task_started 里 `local_bash` 的 id 跨会话重复 0 个，但
// `local_agent` 那种出现过同 id 挂两个 tool_use 的情况 —— 来源侧并没有承诺全局唯一，所以
// 按会话分区（见 shared/monitor.ts 的 NATIVE_MONITOR_ID_SCOPE）。
//
// 一条 ash 会话**跨好几个 run 文件**（每回合一个），而来源侧的编号只在**一条 CLI 会话**内
// 唯一。所以会话桶里还得再分一层：同一个 tool_use 号底下可以挂着好几条，各属各的来源，取
// 的时候拿手上的来源凭据去认（`SourceBucket` + `matchBySource`，和认 Monitor 行、和库里的
// 唯一键同一个判据）。单值桶的后果是后读到的覆盖先读到的 —— 对 `pending` 来说覆盖掉的正是
// 一条调用入参的唯一出处（新一轮第 1 轮审查 F1）。
//
// ── 检查点：位置 + 已提交的行，两样合起来才算「读到哪儿」──────────────────────────
//
// 内存里的配对状态会被内存上限丢掉（backfill 的 `SNAPSHOT_HARD_CAP`），只剩「读到第几字节」。
// 于是有一条必须自己守住的不变量：
//
//   **绝不从某个位置开始读，除非它之前的内容都「有归宿」** —— 要么这一代读过（还在内存里），
//   要么已经成行落库（已提交）。
//
// 谁守：落盘的位置只会是上一轮**确认提交过**的那个（backfill 的 `saveCheckpoint`），其余情况
// 一律从 0 重读；而「位置之前那条还悬着的调用」不靠位置来保，它也落盘
// （`claude-monitor-pending.ts`）。两样都在库里，于是「读到哪儿」这件事不依赖任何缓存命中。
//
// 上一版是靠位置保的 —— 可重放位置绝不越过一条悬着的调用。那条路在**永远不会完结的调用**上
// 失效：启动被拒（有 `is_error` 回执、没有 `task_started`）、进程在那一行之后被杀（连回执都
// 没有），于是位置被永久钉在那儿，每轮重读同一个窗口，末尾的 Monitor 永远读不到（第 11 轮
// 审查实测 12 轮停滞）。落盘之后位置只管单调往前，两件事各归各管。
//
// 这条不变量值钱，是因为来源侧的行序是**严格因果**的（实测用户那个任务的 17 个 run 文件：
// `tool_use` → `task_started` 84/84 顺序、`task_started` → `tool_result` 12/12、
// `task_started` → 通知 84/84，一例逆序都没有），所以**配不上的一次性事实，它的另一半必然
// 在它之前**。既然它之前的内容都有归宿，这条事实当轮就能裁决：
//
//   - 库里有那一行 → 按 `native_id` / `tool_use_id` 配回去（claude-monitor-commit.ts）
//   - 库里也没有   → 它压根不是 Monitor 起的（普通后台 Bash 的通知，实测 76 条 task_started
//                    里 64 条是它们），当场丢掉
//
// 所以这里**不再维护「这个 id 不是 Monitor」这类结论集合、也不再长期缓冲孤儿事实**：结论可以
// 从「库里有没有这一行」重新推出来，而那两样都是会被容量淘汰的内存状态 —— 淘汰之后通知退成
// 孤儿、把可重放位置永久钉死在那儿，固定输入于是永远读不完（第 10 轮审查实测：连续 24 轮硬
// 淘汰，读取窗口一动不动，末尾那个 Monitor 始终缺卡）。
import { stat } from "node:fs/promises";
import { claudeMonitorStatus, parseMonitorStartReceipt } from "@ash/shared/monitor";
import { monitorStr as str, parseMonitorInput } from "./claude-monitor-call.js";
import type { ScanCursor } from "./claude-monitor-cursors.js";
import { eachLine, scanWindowBytes, streamFilesOf } from "./claude-monitor-read.js";
// 状态容器与访问器分在隔壁（见那个文件的头部）。这里整条转发出去：对调用方来说
// 「扫描」就是一个模块，拆文件是本文件内部的事。
export * from "./claude-monitor-scan-state.js";
import {
  dropBySource, findBySource, newSessionScan, putBySource,
  type Found, type SessionScan, type TaskScan,
} from "./claude-monitor-scan-state.js";
import { sourceKeyOf } from "./claude-monitor-identity.js";

/**
 * 一轮里最多交出去多少条「配不上内存状态」的事实（见 `SessionScan.late`）。
 *
 * **不是缓存上限，是单轮工作量上限**：这些事实当轮就会被提交层裁决掉（配回已提交的行、或者
 * 证明与我们无关），不需要跨轮留着。顶到上限就**停在那一行之前**：游标不越过它，这一轮按
 * 「没读完」记账，下一轮从它继续 —— 事实一条不丢，前缀也不重读。
 *
 * 512 的依据：实测一个任务 76 条 `task_started` 里 64 条是普通后台 Bash，它们的终态通知全走
 * 这条通道；真撞上就是分几批补完，不影响收敛。
 */
const LATE_CAP = 512;

/** 事件自报的时刻。只有 `assistant` / `user` 带（`system` 不带，实测）。 */
function eventTime(ev: any): string | null {
  const t = typeof ev?.timestamp === "string" ? ev.timestamp : "";
  return t && !Number.isNaN(Date.parse(t)) ? t : null;
}

/**
 * 把一条会话的全部文件扫一遍（只读新增部分），结果并进 `scan`。
 *
 * 判据与实时投影同一套：`task_started` 的 `tool_use_id` 回指发起它的工具名，只有 `Monitor`
 * 算数 —— 普通后台 Bash（`run_in_background`）同样是 `local_bash`，混进来会把面板变成一份
 * 「这个任务跑过的所有后台命令」流水账（实测 76 条里 64 条是它们）。
 */
export async function scanSession(
  scan: TaskScan, sessionId: string, cliSessionId: string | null, outPath: string,
  /** 单次读取上限。只有回归测试会传小值——128 MiB 的夹具没法写进测试里。 */
  maxBytes: number = scanWindowBytes(),
  /**
   * 这条会话**现在还有活着的 agent 进程**吗（见 TaskScan.partialTail）。
   *
   * 只影响「文件尾是半行」怎么记：活着的那条正在被追加,半行下一刻就完整了,记成「没读完」
   * 会让退避定时器每秒重扫一个还在写的文件,而且每轮都读到新字节、预算永远清零。缺省按
   * **不活**算(更保守:宁可多留一次账)。
   */
  sessionLive = false,
): Promise<void> {
  let session = scan.sessions.get(sessionId);
  if (!session) {
    session = newSessionScan();
    scan.sessions.set(sessionId, session);
    // 悬着的调用从库里接回来（见 TaskScan.restoredPending）：读取窗口切在 `tool_use` 和
    // `task_started` 之间、或者上一份快照被内存上限挤掉时，靠这一步续上，位置不必回退。
    for (const item of scan.restoredPending?.get(sessionId) ?? []) {
      putBySource(session.pending, item.toolUseId, {
        call: item.call, at: item.at, cliSessionId: item.cliSessionId, sourceRun: item.sourceRun,
      });
    }
  }
  const files = await streamFilesOf(sessionId, outPath);
  // 文件清单本身就是「代次」这件事的权威依据（见 TaskScan.runFiles）：它和行上的 `source_run`
  // 一起，让「起它的那一代 run 结束了没有」在配对状态被淘汰之后仍然算得出来。
  for (const file of files) scan.runFiles.all.add(file.path);
  if (files.length) scan.runFiles.latest.add(files[files.length - 1]!.path);
  // **按时间顺序读，前一个没读完就不读后面的。**
  //
  // 这些文件之间有因果关系：Monitor 在前一个 run 文件里起（tool_use/task_started），它的
  // 回执和终态可能落在后一个 run 文件里。乱序消费的后果是后文件的事实关联不上任何 Monitor
  // ——而它的游标已经推到尾，那些事实再也不会被读一次（第 5 轮审查实测 crossFileLimit：
  // 前文件超 128 MiB 上限，后文件的 90 秒回执和 completed 当轮被读完并丢弃，此后三次回填都
  // 恢复不出 exited + bounded）。
  //
  // 迟到事实（`session.late`）是第二道：同一文件内部的乱序、以及这一轮之前已经被消费掉的
  // 情况，靠它兜住。两道都要有——顺序保证「别制造迟到事实」，`late` 保证「已经产生的那些
  // 在提交时当场裁决掉」（见文件头的检查点不变量）。
  let blocked = false;
  for (const file of files) {
    if (blocked) break;
    let size = 0;
    try {
      size = (await stat(file.path)).size;
    } catch {
      // stat 失败和撞上限是同一类「这个文件没读完」，后面的文件同样不能先读。
      scan.failed = true;
      blocked = true;
      continue;
    }
    // 接回来的位置**惰性取**：那张表是这个任务全部会话文件的并集，整张倒进每条会话的桶里
    // 就按会话数把它复制了一遍（第 9 轮审查不拦项 4）。路径本来就唯一，按需查即可。
    //
    // 采纳它是安全的：落盘的只会是「可重放 + 已确认提交」的位置（backfill 的 saveCheckpoint），
    // 所以它之前的内容都有归宿（见文件头的检查点不变量）。
    const restored = scan.restoredCursors?.get(file.path);
    if (restored && !session.cursors.has(file.path)) {
      session.cursors.set(file.path, { ...restored });
      if (restored.offset > 0) session.skippedPrefix = true;  // 见 SessionScan.skippedPrefix
    }
    const cursor: ScanCursor = session.cursors.get(file.path)
      ?? { size: 0, offset: 0, probe: 0, gaps: [], source: null };
    // **落盘的来源先灌回内存**：`consume` 判归属时只认 `fileSources`（见那里的说明），而从
    // 半路接着读的那一轮读不到文件开头那条 init 行 —— 来源就在游标上，灌回去才用得上。
    if (cursor.source && !scan.fileSources.has(file.path)) scan.fileSources.set(file.path, cursor.source);
    // 文件比上次短 = 被重写/截断过，之前的游标无意义，从头再来（缺口证据也跟着作废：它说的
    // 是旧内容里的某一段，新内容里没有对应的东西）。
    if (size < cursor.offset) {
      // `source` 不清:文件被重写也还是同一个文件名 = 同一次进程启动的产物,来源不会变。
      cursor.offset = 0; cursor.size = 0; cursor.probe = 0; cursor.gaps = [];
      scan.cursorsDirty = true;
    }
    // ── 永久缺口：**窗口够大的那一轮回去补，补不了就一直留着账** ────────────────
    //
    // 跳过一条装不进窗口的记录之后，那条事实只剩这份证据了。它跟着游标落盘，所以下一轮
    // 干净扫描清不掉它（第 14 轮审查 N1：实测跳过的是一条完成通知，第 3 轮起账面干净，
    // 而那张卡永远停在 `lost`）。读取窗口是可配的（生产 128 MiB，回归 32 KiB），哪一轮
    // 的窗口装得下它，就把位置退回去重读一遍——重读是幂等的（按 native_id/tool_use_id 配回）。
    if (cursor.gaps.length) {
      // 从**最靠前**那个补得上的缺口开始重读:它后面那些缺口会在这一趟里被重新走一遍,
      // 所以先把 >= 这个位置的记录全扔掉(还是补不上的会被重新记上),免得补上了账还留着。
      const fillable = [...cursor.gaps].sort((a, b) => a.from - b.from)
        .find((gap) => maxBytes >= gap.need && gap.from < size);
      if (fillable) {
        cursor.offset = fillable.from;
        cursor.probe = 0;
        cursor.gaps = cursor.gaps.filter((gap) => gap.from < fillable.from);
        scan.cursorsDirty = true;
        console.warn(`[ash] 内置 Monitor 历史扫描回去补上之前跳过的记录`
          + `（${file.path} 第 ${fillable.from} 字节起，当前窗口 ${maxBytes}）`);
      }
      if (cursor.gaps.length) scan.skippedRecord = true;
    }
    // **判据是「读到文件尾了没有」，不是「文件有没有变大」。** 写成 `size === cursor.size`
    // 会在撞到单次上限之后卡死：文件大小没变、游标还停在半路，于是后半截永远读不到
    // （本轮自测：第 1 轮 offset=99134/409154 truncated=true，第 2 轮仍是 99134 就停了）。
    // 空文件也走这一支（0 >= 0），它本来就没东西可读。
    if (cursor.offset >= size) {
      session.cursors.set(file.path, { ...cursor, size });
      continue;
    }

    const sink = (line: string) =>
      consume(scan, session!, line, cliSessionId, file.startedAt, file.path, sessionId);
    /** 这个文件**还在被写**吗：只有活着的会话的最后一个 run 文件算（见下面的半行判据）。 */
    const fileLive = sessionLive && file.path === files[files.length - 1]!.path;
    try {
      const readFrom = cursor.offset;
      const { nextOffset, truncated, stopped, skipped, tail, probe } =
        await eachLine(file.path, readFrom, maxBytes, sink, cursor.probe);
      if (cursor.probe !== probe) scan.cursorsDirty = true;
      cursor.probe = probe;
      if (skipped) {
        // 缺口落在游标上一起落盘（上面那一段负责把它补回来）。**一个文件可以有好几个**，
        // 所以是往全集里加一项，不是覆盖单槽（第 5 轮审查 N1：第二条把第一条顶掉了）。
        if (!cursor.gaps.some((gap) => gap.from === readFrom)) {
          cursor.gaps = [...cursor.gaps, { from: readFrom, need: skipped }];
          scan.cursorsDirty = true;
        }
        scan.skippedRecord = true;
        console.warn(`[ash] 内置 Monitor 历史扫描跳过一条装不进读取窗口的记录`
          + `（${file.path} 第 ${readFrom} 字节起 ${skipped} 字节 > 上限 ${maxBytes}）`);
      }
      // 末尾那截没有换行符：这一轮没把这个文件读全（见 TaskScan.partialTail）。正在被写的
      // 那个文件里这是常态、不记账；**封存的文件里这半行是永久的**，必须留账。
      //
      // 判据按 run 文件给，不是整条会话：会话活着只说明**最后那个** run 文件还在被追加，
      // 之前那些早就封存了。用会话存活代替文件封存的话，旧文件的半行会照样把后面的文件挡住
      // （下面 `nextOffset < size` 那一支），账上却什么都没有 —— 停滞且无声（第 14 轮审查 N1）。
      if (tail && !fileLive) { scan.partialTail = true; blocked = true; }
      if (nextOffset > cursor.offset) {
        scan.advanced = true;
        scan.cursorsDirty = true;
        // 读到了新字节 ⇒ 这些事实还没确认落库，位置暂时不许停在半路（见 committedThrough）。
        scan.committedThrough = false;
      }
      if (truncated) { scan.truncated = true; blocked = true; }
      // 背压停下来了：游标停在那条还没消费的事实之前，这一轮和后面的文件都不算读完。
      if (stopped) { scan.lateOverflow = true; blocked = true; }
      const source = scan.fileSources.get(file.path) ?? cursor.source;
      if (source !== cursor.source) scan.cursorsDirty = true;
      session.cursors.set(file.path, { ...cursor, size, offset: nextOffset, source });
      // 这个文件还没读到尾（撞上限）也算没读完——下一轮从游标接着读，后面的文件继续等。
      if (nextOffset < size) blocked = true;
    } catch (e) {
      scan.failed = true;
      blocked = true;
      console.warn(`[ash] 内置 Monitor 历史扫描读失败（${file.path}）:`, e);
    }
  }
  // **每轮重算**：新文件出现之后，之前那些 Found 的「那一代还在跑吗」答案会翻转。
  // 翻转本身就是一条要提交的事实，哪怕这一轮一个新字节都没读到（见 TaskScan.generationChanged）。
  const latest = files.length ? files[files.length - 1]!.path : "";
  for (const row of session.found.values()) {
    const stale = !!latest && row.filePath !== latest;
    if (stale !== row.staleRun) scan.generationChanged = true;
    row.staleRun = stale;
  }
}

/**
 * `found` 的键:**(来源, native_id)**,不是裸 native_id。
 *
 * native_id 只在一条 CLI 会话内唯一(来源侧没有承诺跨会话唯一,见 claude-monitor-commit.ts
 * 的 `RowIndex`),而同一条 ash 会话 resume 之后换号,一个任务的文件里就会同时有两个来源。
 * 按裸 id 存的后果是后读到的那一条**覆盖**先读到的:两条监听合成一张卡(第 6 轮审查 N2)。
 *
 * 来源**认不出来**的时候按 **run 文件**分区:一个 run 文件 = 一次进程启动 = 一个 CLI 会话,
 * 所以「同一个文件」是手上仅有、却也足够的分区依据。都塞进同一个空桶才是错的 —— 那等于
 * 把两个文件里的同号监听又合回一张卡(第 7 轮审查 N2)。
 */
const foundKey = (owner: string | null, sourceRun: string, nativeId: string): string =>
  `${sourceKeyOf({ cliSessionId: owner, sourceRun }) ?? ""}\u0000${nativeId}`;

/** 这一轮交出去的迟到事实已经顶到单轮上限了吗（见 `LATE_CAP`，满了就背压）。 */
const lateFull = (session: SessionScan): boolean => session.late.length >= LATE_CAP;

/** 一行 stream-json。认人判据见 `scanSession` 的说明。 */
function consume(
  scan: TaskScan, session: SessionScan, line: string,
  expectSessionId: string | null, fileStartedAt: string | null, filePath: string,
  /** 读到它的那条 ash 会话（迟到事实销账要按会话分区，见 `LateFact.sessionKey`）。 */
  sessionKey: string,
): boolean {
  const text = line.trim();
  if (!text || text[0] !== "{") return true;
  let ev: any;
  try { ev = JSON.parse(text); } catch { return true; }
  if (ev.type === "stream_event") return true;
  const at = eventTime(ev);
  if (at) session.lastAt = at;

  // 会话身份核对：对不上只记一笔诊断，**不丢数据**。resume 之后 CLI 会换 session_id，而
  // 文件名前缀已经保证了「这些文件属于这条 ash 会话」。
  const evSession = str(ev.session_id) || null;
  if (evSession && expectSessionId && evSession !== expectSessionId) scan.foreign.add(evSession);
  // **归属用这一行自己报的 session_id**（第 6 轮审查 N2）。`sessions.cli_session_id` 只记得
  // **当前**那一个：resume 之后 CLI 换了号，它就被覆盖掉了，而旧 run 文件里的事实仍然属于
  // 旧号。拿当前值去归一的后果是把两轮的监听合成一条 —— 审查实测同一条 ash 会话的
  // cli-old/cli-new 各有一个同号监听，旧卡被新一轮的终态改写、新来源根本没有自己的卡。
  // 实时投影那一侧用的也是**流里报的那个** session_id（claude-monitors.ts 的 `event`），
  // 所以这么取两侧才真是同一个值。
  //
  // 这一行自己没报的时候退回**这个 run 文件已经被证实的来源**（文件开头那条 init 行报的，
  // 或者跟着游标落盘的那个），而**不是**退回 `sessions.cli_session_id`：后者是当前身份，
  // resume 之后旧 run 文件的事实会被它改姓，于是旧卡又被合进新一轮（第 7 轮审查 N2 实测：
  // 只有 init 行带 session_id、后续记录不带时，两轮监听只剩 cli-new 一张卡）。两样都没有
  // 就**留未知** —— 由认领那一层按可重验的证据决定（claude-monitor-identity.ts）。
  if (evSession) scan.fileSources.set(filePath, evSession);
  const owner = evSession ?? scan.fileSources.get(filePath) ?? null;
  /**
   * 这一行手上的来源凭据。配对（未决调用、回执→行）全按它认，跟认 Monitor 行、跟库里的
   * 唯一键同一个判据（`claude-monitor-identity.ts`）。
   *
   * 两样都给：归属认得出来就按归属，认不出来时 `run` 文件仍然自证得了 —— 同一个文件里前
   * 半截没报 session_id、后半截报了（只有 init 行带），两半还是配得上。
   */
  const evidence = { cliSessionId: owner, sourceRun: filePath };

  const content = Array.isArray(ev.message?.content) ? ev.message.content : [];
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    if (block.type === "tool_use" && str(block.name) === "Monitor") {
      const call = parseMonitorInput(block.input);
      // 入参只在这一行上，所以这条「悬着的调用」要落盘（见 `SessionScan.pending`）。
      if (call && str(block.id)) {
        putBySource(session.pending, str(block.id), { call, at, cliSessionId: owner, sourceRun: filePath });
      }
    } else if (block.type === "tool_result") {
      const toolUseId = str(block.tool_use_id);
      const raw = typeof block.content === "string"
        ? block.content
        : Array.isArray(block.content)
          ? block.content.map((b: any) => (b && typeof b.text === "string" ? b.text : "")).join("\n")
          : "";
      const link = findBySource(session.byToolUse, toolUseId, evidence);
      const row = link ? session.found.get(link.found) : undefined;
      // ── 回执配得上一条**还悬着的调用**、而它自己又没说「起成了」 ⇒ 这次调用没起来 ──
      //
      // 行序是严格因果的（见文件头）：起成了的 Monitor 一定先有 `task_started`，那时这条调用
      // 就从 `pending` 里挪走了。所以回执还能在 `pending` 里找到它，只有一种解释 —— 它压根
      // 没起来（启动被拒、入参校验失败、起之前被取消）。当场完结，别让它永远悬着。
      //
      // **判据不是回执里的错误文案**（换一句措辞就漏一类，第 11 轮审查点名），而是两件事的
      // 合取：配不上 `task_started`，且这条回执自己不是一份**起手回执**（`parseMonitorStart‑
      // Receipt` 认不出期限 ⇒ 它没说「盯到 X」）。认得出的那种留给提交层去配已提交的行 ——
      // 那是配对状态被挤掉之后的正常情形，不是失败。
      if (!row && toolUseId && parseMonitorStartReceipt(raw).lifetime === "unknown") {
        const dead = findBySource(session.pending, toolUseId, evidence);
        if (dead) {
          dropBySource(session.pending, toolUseId, dead);
          session.cleared.push({ sessionKey, sourceRun: dead.sourceRun, toolUseId });
          continue;
        }
      }
      if (!row) {
        // 配不上内存状态：**交给提交层裁决**（库里有那一行就配回去，没有就是与我们无关）。
        // 普通后台 Bash 的回执写的是 "Running in background"，连交的必要都没有。
        if (toolUseId && /Monitor started/i.test(raw)) {
          if (lateFull(session)) return false; // 背压，见 `LATE_CAP`
          session.late.push({
            kind: "receipt", toolUseId, raw, at,
            sessionKey, cliSessionId: owner, sourceRun: filePath,
            skippedPrefix: session.skippedPrefix,
          });
        }
        continue;
      }
      applyReceipt(row, raw, at);
    }
  }

  if (ev.type !== "system") return true;
  const nativeId = str(ev.task_id);
  if (ev.subtype === "task_started") {
    const toolUseId = str(ev.tool_use_id);
    const started = findBySource(session.pending, toolUseId, evidence);
    // **配不上 = 它不是 Monitor 起的。** 行序是严格因果的（见文件头），而一条还悬着的
    // Monitor 调用一定在手上（内存里，或者从 `monitor_pending_calls` 接回来的）—— 所以
    // 「这一行的调用我们没见过」只有一种解释：那个工具不是 Monitor。于是不必再维护「这个 id
    // 不是 Monitor」的结论集合（那是一张会被容量淘汰的内存表，淘汰之后它的通知就退成永远
    // 配不上的孤儿）。
    if (!started || !nativeId) return true;
    dropBySource(session.pending, toolUseId, started);
    // 销账也带着来源：库里那条按 (会话, 来源, tool_use) 分区，少一维就把另一轮的同号调用
    // 一起删了 —— 那是它入参的唯一出处（见 claude-monitor-pending.ts）。
    session.cleared.push({ sessionKey, sourceRun: started.sourceRun, toolUseId });
    putBySource(session.byToolUse, toolUseId, {
      cliSessionId: owner, sourceRun: filePath, found: foundKey(owner, filePath, nativeId),
    });
    session.found.set(foundKey(owner, filePath, nativeId), {
      nativeId, call: started.call, toolUseId,
      cliSessionId: owner,
      startedAtLow: started.at,
      startedAtHigh: null,   // 回执到了才有上界
      fileStartedAt,
      endedAt: null,
      lifetime: "unknown", expiresMs: null,
      status: null, endedReason: null,
      filePath, staleRun: false,
    });
  } else if (ev.subtype === "task_notification" && nativeId) {
    const row = session.found.get(foundKey(owner, filePath, nativeId));
    if (!row) {
      // 同上：配不上内存状态的终态通知交给提交层裁决。实测一个任务 76 条 task_started 里
      // 64 条是普通后台 Bash，它们全从这儿过 —— 当轮就被丢掉，不占内存、不钉位置。
      if (lateFull(session)) return false; // 背压，见 `LATE_CAP`
      session.late.push({
        kind: "notice", nativeId, status: claudeMonitorStatus(ev.status), summary: str(ev.summary),
        at: session.lastAt, sessionKey, cliSessionId: owner, sourceRun: filePath,
        skippedPrefix: session.skippedPrefix,
      });
      return true;
    }
    applyNotice(row, claudeMonitorStatus(ev.status), str(ev.summary), session.lastAt);
  }
  return true;
}

/** 把一条起手回执落到 Found 上。来源侧唯一说出**生效**期限的地方。 */
function applyReceipt(row: Found, raw: string, at: string | null): void {
  const receipt = parseMonitorStartReceipt(raw);
  if (receipt.lifetime === "unknown") return;
  row.lifetime = receipt.lifetime;
  row.expiresMs = receipt.ms;
  // 回执那条事件的时刻是真实起点的**上界**：计时器在工具返回前就起了，而这条消息要等
  // PostToolUse hooks 跑完才构建（见 Found.startedAtHigh 的说明）。
  row.startedAtHigh = at;
}

/** 把一条终态通知落到 Found 上。 */
function applyNotice(row: Found, status: string, summary: string, at: string | null): void {
  row.status = status;
  row.endedReason = summary || null;
  row.endedAt = at ?? row.endedAt;
}
