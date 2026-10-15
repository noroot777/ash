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

/** 这个任务上次读到哪儿了（没有记录就 null —— 从零开始读）。 */
export async function loadScanCursors(taskId: string): Promise<Map<string, ScanCursor> | null> {
  const rows = await db.select().from(monitorScanCursors)
    .where(eq(monitorScanCursors.taskId, taskId));
  if (!rows.length) return null;
  return new Map(rows.map((row) => [row.path, {
    size: row.fileSize, offset: row.readOffset,
    probe: row.probe, gaps: parseGaps(row.gaps),
  }]));
}

/**
 * 把这一轮读到的位置记下来。**只在确认提交之后调用**（见 TaskScan.committedThrough）。
 *
 * upsert 而不是「先删后插」：中间那一瞬如果进程没了，位置就凭空消失了（代价是从零重读）。
 * 这一步只认这一轮真的读过的文件，没动过的行原样留着。
 */
export async function saveScanCursors(
  taskId: string, cursors: ReadonlyMap<string, ScanCursor>,
): Promise<void> {
  const rows = [...cursors].map(([path, cursor]) => ({
    taskId, path, fileSize: cursor.size, readOffset: cursor.offset,
    probe: cursor.probe, gaps: JSON.stringify(cursor.gaps),
  }));
  for (const batch of batches(rows)) {
    // 落库资格跟 upsert 同批（见 claude-monitor-write.ts）：任务在这一轮里被删完的话，
    // 这些位置行会变成没人清得掉的孤儿，而且下一次同名任务复活还会被它们带偏。
    await writeIfTaskAlive(
      db.insert(monitorScanCursors).values(batch).onConflictDoUpdate({
        target: [monitorScanCursors.taskId, monitorScanCursors.path],
        set: {
          fileSize: sql`excluded.file_size`, readOffset: sql`excluded.read_offset`,
          probe: sql`excluded.probe`, gaps: sql`excluded.gaps`,
        },
      }),
      db.delete(monitorScanCursors).where(orphanRows(monitorScanCursors, taskId)),
    );
  }
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
