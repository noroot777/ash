// 历史扫描**读到哪儿了**的落盘与恢复（检查点的位置那一半）。
//
// 另一半是「还悬着的调用」（`claude-monitor-pending.ts`），两样在同一处、同一个顺序落盘：
// 先确认这一轮的事实落了库，再落悬着的调用，最后落位置。不变量只有一条：
//
//   **绝不从某个位置开始读，除非它之前的内容都有归宿** —— 已经成行落库，或者作为悬着的
//   调用落在那张表里。
//
// 为什么位置必须落盘（而不是再找一张内存表存）：它原先住在进程内的两张 LRU 里 —— 扫描
// 快照（`SNAPSHOT_CAP`/`SNAPSHOT_HARD_CAP`）和它后面兜底的位置表（`PARKED_CAP`）。两张
// 都有上限，而上限一到，**挤掉的可能正是那个还没读完的任务**：它下一轮从零重读同一个
// 前缀，再次被挤掉，固定输入于是永远读不到末尾（第 11 / 12 / 13 轮审查连续三次复现同一个
// 判据，只是丢位置的出口每轮换一个：先是「被跳过的调用把位置钉死」，再是「在途快照被别的
// 任务拆走」，最后是「位置表自己的容量淘汰」）。
//
// 落盘之后这条判据就不再依赖任何缓存命中：位置的归属只有一个地方，顺带 server 重启也不必
// 把几百 MB 的历史从零重读一遍。
import { eq, sql } from "drizzle-orm";
import { db } from "./db/index.js";
import { monitorScanCursors } from "./db/schema.js";
import { orphanRows, writeIfTaskAlive } from "./claude-monitor-write.js";
import { pendingCallKeyBlocker, pendingCallKeyLive } from "./db/schema-readiness.js";

/**
 * **这一代「消费语义」的版本号** —— 一份读取位置的戳，承诺的是：
 *
 *   它之前读过的每一条事实，都已经按**当前这一代**的身份判据与合并/消费规则，
 *   被某一行**已提交**的状态包含（或者作为悬着的调用落在未决表里）。
 *
 * 所以这个号**不只管唯一键**：认行判据（`claude-monitor-identity.ts` 的 `matchBySource`）、
 * 持久唯一键（`monitors_native_source`、`monitor_pending_calls` 的主键）、未决调用的配对与
 * 销账判据（`claude-monitor-pending.ts`），以及「一条事实怎样才算消费掉」（
 * `claude-monitor-commit.ts` 的 `absorb`/`mergeInto`）任何一样改了，旧位置的那句承诺就不再
 * 成立 —— **这个数就要加一**。
 *
 * 为什么只能重放、不能「验一验」：丢掉的事实是**压根没写进去**的那种（一张卡不存在、一个
 * 终态从来没落库）。库里现有的行证明不了「还少了什么」，当前索引建得起来、同身份的容器
 * 存在、文件最后报过来源 —— 这三样都不是证据。要知道少了什么，只有把那段日志重读一遍。
 *
 * 各代之间的差别（都实测过存量后果）：
 *
 * - `1`：唯一键 `(task_id, COALESCE(cli_session_id,''), native_id)` —— 未知归属的行全挤在一个
 *   空串键上，两个 run 文件里的同号监听只留得下第一张卡（第 8 轮审查 N2）；而且撞键之后
 *   只要身份对得上就算消费，这一次读到的终态/时长一个字都没合并进去（第 9 轮审查 F1）。
 * - `2`：键改细、三条合并路也统一了，**但采用旧位置的规则是错的**：它拿「文件最后报过来源」
 *   当成「这一段事实当时都正确入库了」，于是上面两种存量错误在已知来源的任务上不会自愈，
 *   还可能把没核验过的旧前缀重新盖成 2（第 10 轮审查 F1 用 `git archive` 跑真旧代码生成库、
 *   再用当前代码升级实测）。**2 这个戳本身因此不可信**，一并作废。
 * - `3`：键和合并路都对了，**但未决调用那一条链还是另一套判据**：它拿当前
 *   `sessions.cli_session_id` 反推旧调用的归属、把两个「来源未知」当成同源，于是两轮撞同一个
 *   tool_use 号时，新一轮成行把旧一轮还悬着的那条调用销了账 —— 那一行是它入参的唯一出处，
 *   旧卡从此永久缺一张，而这一代照常给那个前缀盖上「读完了」的戳（新一轮第 1 轮审查 F1）。
 *   所以 3 这个戳同样不可信，一并作废。
 * - `4`：未决调用那条链也统一了，**但发布这一代语义的前置条件没核验**：换键的迁移失败只打
 *   一句 warn，启动照常继续，旧三列键的库于是一边吞掉同号不同来源的调用、一边照常给前缀盖
 *   上 4 的戳；下一次启动真的迁成功了也不会重放（新一轮第 2 轮审查 F1 两种失败各有实测）。
 *   所以 4 这个戳同样不可信，一并作废 —— 当代的戳只在**真实 schema 核验通过**时才盖得起来
 *   （`db/schema-readiness.ts`，判据落在 `saveScanCursors`）。
 * - `5`：发布条件核验上了，**但代次凭据本身可能是错的**：实时投影在落库那一刻才去问
 *   `sessions`，而那几列每回合被下一轮覆盖 —— 上一轮的监听排在写库队列上刚轮到落库时，
 *   抄到的是下一代人的 pid 和 run 文件；历史合并那一侧又只肯补空、不肯纠正非空的来源。于是
 *   那些行永远写着别人的代次，死活裁决拿新进程给旧卡续命，而这一代照常给前缀盖上「读完了」
 *   的戳（新一轮第 1 轮审查 F1 用真实两代进程 + 生产服务 + 真页面实测）。所以 5 这个戳同样
 *   不可信，一并作废 —— 重放之后，旧 run 文件里那条调用的事实会把写错的来源纠回来
 *   （`claude-monitor-commit.ts` 的 `mergeInto`，判据是 `tool_use_id` 对得上）。
 * - `6`：当代。只有这一代的代码盖的戳才算数。
 *
 * 成本是**一次性**的：被作废的位置等于那个文件从零重放一遍，而重放照常受单轮字节上限约束、
 * 读到哪儿就带着当代版本号落盘（见 `saveScanCursors`），下一轮接着往后读 —— 不是每次请求
 * 都全量重读历史。
 */
export const MONITOR_CHECKPOINT_SEMANTICS = 6;

/** 这份位置是**当代**确认的吗（只有它才可以被接回来往后读）。 */
const confirmedUnderCurrent = (cursor: { semantics: number | null }): boolean =>
  (cursor.semantics ?? 1) >= MONITOR_CHECKPOINT_SEMANTICS;

/**
 * 一个 run 文件读到哪儿了。三件事**分开记**，别混成一个数(第 14 轮审查 N1)：
 *
 * - `offset`：**可续读位置** —— 它之前的内容都有归宿，下一轮从这儿接着读；
 * - `probe`：**边界搜索进度** —— 一条比窗口还长的记录,找它的结尾找到哪儿了。没有它的话
 *   「单轮工作预算」就变成了永久的可读性上限：每一轮都从同一个区间重扫同样的预算、同样
 *   找不到,这个文件之后的内容再也读不到;
 * - `gaps`：**永久缺口证据的全集** —— 被跳过的每一条记录在哪、补上它要多大的窗口。
 *   它跟着游标一起落盘,所以「跳过了一条事实」不会随下一轮干净扫描被清掉;等哪一轮的窗口
 *   够大了(生产 128 MiB,或者换了配置),回到那一项的 `from` 重读一遍,这一项才销掉。
 *   **是全集不是单槽**:同一个文件可能跳过好几条,单槽会被后一条顶掉(第 5 轮审查 N1)。
 *
 * `size` 是上次读到它时的大小（变小 = 被重写，位置作废）。
 */
export type ScanGap = { from: number; need: number };
export type ScanCursor = {
  size: number; offset: number; probe: number; gaps: ScanGap[];
  /**
   * 这个文件里报的 CLI 会话身份（没读到过就 null）。
   *
   * 一个 run 文件 = 一次 agent 进程启动 = 一个 CLI 会话，所以它是「这个任务历史上有过哪几个
   * 来源」唯一可重验的依据（`sessions.cli_session_id` 只记得当前那个，resume 后旧号被覆盖）。
   * 用处见 claude-monitor-scan.ts 的 `sourceSetOf`。
   */
  source: string | null;
};

/** 落盘的 `gaps` 列解析回来。坏数据按「没有缺口」处理（它只是证据，不该让整轮读不下去）。 */
function parseGaps(raw: string): ScanGap[] {
  try {
    const parsed: unknown = JSON.parse(raw || "[]");
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((g): g is ScanGap => !!g && typeof g === "object"
        && Number.isFinite((g as ScanGap).from) && Number.isFinite((g as ScanGap).need))
      .map((g) => ({ from: g.from, need: g.need }));
  } catch { return []; }
}

/** 一条语句最多带多少行（理由同 claude-monitor-pending.ts 的 `BATCH`）。 */
const BATCH = 200;

const batches = <T>(items: readonly T[]): T[][] => {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += BATCH) out.push(items.slice(i, i + BATCH));
  return out;
};

/**
 * 这个任务上次读到哪儿了（没有记录就 null —— 从零开始读）。
 *
 * **只接回当代确认过的位置**（见 `MONITOR_CHECKPOINT_SEMANTICS`）：一份位置说的是「它之前的
 * 事实都已经按当代规则落了库」，而旧代的那句话已经被实测证伪两次（挤掉的卡、没合并的终态）。
 * 别的位置一律不接 —— 那个文件从零重放一遍，这一轮读到哪儿就带着当代版本号重新落盘。
 *
 * 判据是「有没有当代的戳」，**不是**「来源空不空」：来源非空只说明文件里某一处报过身份，
 * 既不证明更早那些启动记录当时带过身份，也不证明每一次状态/时长更新都真的落进了行里
 * （第 10 轮审查 F1 两个形状都用真旧代码跑出来过）。能接回来的理由只有一个：**那段是这一代
 * 代码自己确认的**。
 *
 * 内存里的 `ScanCursor` 因此不必再带版本号 —— 接回来的一律是当代的。
 */
export async function loadScanCursors(taskId: string): Promise<Map<string, ScanCursor> | null> {
  const rows = await db.select().from(monitorScanCursors)
    .where(eq(monitorScanCursors.taskId, taskId));
  if (!rows.length) return null;
  const usable = rows.filter(confirmedUnderCurrent);
  if (usable.length < rows.length) {
    console.warn(`[ash] 内置 Monitor 历史扫描：task=${taskId} 有 ${rows.length - usable.length}`
      + ` 个 run 文件的读取位置是旧消费语义下确认的（当代为 v${MONITOR_CHECKPOINT_SEMANTICS}），`
      + `这些文件重放一遍`);
  }
  if (!usable.length) return null;
  return new Map(usable.map((row) => [row.path, {
    size: row.fileSize, offset: row.readOffset,
    probe: row.probe, gaps: parseGaps(row.gaps), source: row.source,
  }]));
}

/**
 * 把这一轮读到的位置记下来。**只在确认提交之后调用**（见 TaskScan.committedThrough）。
 *
 * upsert 而不是「先删后插」：中间那一瞬如果进程没了，位置就凭空消失了（代价是从零重读）。
 * 这一步只认这一轮真的读过的文件，没动过的行原样留着。
 *
 * 返回「这一份位置落盘了没有」：**没落盘不是小事**，调用方据此回退、留恢复责任（见
 * `saveCheckpoint`）—— 位置是这一轮「读完了」的唯一凭据，默默跳过它等于悄悄声称读完了。
 */
export async function saveScanCursors(
  taskId: string, cursors: ReadonlyMap<string, ScanCursor>,
): Promise<boolean> {
  // **当代语义没发布出去，就不许盖当代的戳。** 判据是运行期核验过的真实 schema，不是
  // 「迁移函数返回了」也不是编译期声明（理由与两种失败的实测见 db/schema-readiness.ts）。
  // 旧三列键的库上，同号不同来源的两条调用只存得下一条 —— 那一行是它入参的唯一出处，
  // 位置一确认就再也读不回来了（新一轮第 2 轮审查 F1）。
  //
  // 反过来，**接回旧位置不受这一条约束**（`loadScanCursors` 照常接）：带当代戳的位置只可能
  // 由核验通过的那几轮盖出来，它承诺的前缀照旧成立；这一轮没盖上的那一段下一轮重读一遍。
  if (!pendingCallKeyLive()) {
    console.warn(`[ash] 内置 Monitor 历史扫描：task=${taskId} 的读取位置这一轮不落盘 ——`
      + `持久身份键还没核验成当代形状（${pendingCallKeyBlocker()}）。这一轮读到的卡照常`
      + `显示，位置留在原地，下一轮重读同一段`);
    return false;
  }
  const rows = [...cursors].map(([path, cursor]) => ({
    taskId, path, fileSize: cursor.size, readOffset: cursor.offset,
    probe: cursor.probe, gaps: JSON.stringify(cursor.gaps), source: cursor.source,
    // 盖当代的戳。**盖得起这个戳的前提是上面那句承诺成立**：能进到这里的位置只有两种
    // 来源 —— 这一轮从零读过的，或者本来就带着当代戳被接回来、再往后读的（见
    // `loadScanCursors` 与 `cursorsOf`）。没核验过的旧前缀进不到这儿，所以不会被晋升
    // （第 10 轮审查 F1 的后一半）。
    semantics: MONITOR_CHECKPOINT_SEMANTICS,
  }));
  for (const batch of batches(rows)) {
    // 落库资格跟 upsert 同批（见 claude-monitor-write.ts）：任务在这一轮里被删完的话，
    // 这些位置行会变成没人清得掉的孤儿，而且下一次同名任务复活还会被它们带偏。
    await writeIfTaskAlive(
      db.insert(monitorScanCursors).values(batch).onConflictDoUpdate({
        target: [monitorScanCursors.taskId, monitorScanCursors.path],
        set: {
          fileSize: sql`excluded.file_size`, readOffset: sql`excluded.read_offset`,
          probe: sql`excluded.probe`, gaps: sql`excluded.gaps`, source: sql`excluded.source`,
          semantics: sql`excluded.semantics`,
        },
      }),
      db.delete(monitorScanCursors).where(orphanRows(monitorScanCursors, taskId)),
    );
  }
  return true;
}

/**
 * 把这个任务的位置清掉 = **下一轮从零重放**（任务删除时也走它，见 task-delete-routes.ts）。
 *
 * 只有「这一轮消费过的事实没能确认落库」才走这里（写失败、条件更新落空、裁不清的存量行）：
 * 那时位置之前那段既不在内存里也不在库里，从它往后读再也拼不回来，只能重读一遍。
 */
export async function clearScanCursors(taskId: string): Promise<void> {
  await clearScanCursorsStatement(taskId);
}

/**
 * 同一条删除，但只**造**出来不执行 —— 删任务那条路要把它和其余删除放进同一个原子批
 * （见 task-delete-routes.ts 的 `deleteTaskCompletely`），所以语句本体留在这里一份。
 */
export function clearScanCursorsStatement(taskId: string) {
  return db.delete(monitorScanCursors).where(eq(monitorScanCursors.taskId, taskId));
}
