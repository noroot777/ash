// data/runs 里「任务了结之后再留 KEEP_DAYS 天」的那几类文件，共用这一份判据和这一次清扫：
// 原始事件流（run-trace-retention.ts）和自由审查的截图（review-image-retention.ts）。用户
// 2026-11-13 拍板：两类用同一个天数、同一个开关，不另起计时。
//
// **宽限期从哪一刻算**：从「这一次了结」开始。了结的身份不靠观察中间状态去猜，而是读生命周期层
// 已经持久化的那两样：验收身份 `acceptanceId`（重新打开时清空，每一次新的验收都领新的，见
// review-acceptance.ts / task-stage.ts）和归档时刻 `archivedAt`（取回时清空，每次归档重写）。
// 清扫第一次看到某个身份就落一个 `.concluded-at`（身份 + 时刻）；身份一变——重新打开后又验收、
// 取回后又归档，哪怕两次清扫之间整个来回都看不见——旧时刻作废、从此刻重新起算。归档另有确切
// 时刻，起点取两者较晚的那个。观察时刻不早于真实验收时刻（最多晚一个清扫周期），所以只会多留
// 不会早删；升级前已经了结的老任务也从第一次清扫起重新等满。没有逐个验收入口补时间戳：把
// stage 写成 accepted 的路径有十几条，漏一条就是一验收就删。
//
// 每份文件自己写完也要满 KEEP_DAYS：接住「了结之后又写了新东西」的那几份（合并后审查就是在
// 已验收的任务上跑的）。
//
// 进行中的任务一律不碰，不管多旧；查不到任务行的目录不归这里管（删任务有自己的回收与重试，
// run-dir-reclaim.ts）。一个任务从读任务行到删完文件整段持这个编号的目录锁（task-dir-lock.ts）：
// 接力导入会往同一个目录写新文件、再改任务行，插在中间就会拿旧了结去删新导入的东西。
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { db } from "./db/index.js";
import { tasks } from "./db/schema.js";
import { RUNS_DIR } from "./paths.js";
import { withTaskDirLock } from "./task-dir-lock.js";
import { rawTraces } from "./run-trace-retention.js";
import { reviewImages } from "./review-image-retention.js";

const STAMP = ".concluded-at";
const DEFAULT_KEEP_DAYS = 7;

export type Reclaimed = { removed: number; bytes: number };

/** 一类按这份判据回收的文件。 */
export interface RetainedKind {
  /** 这个任务目录里还有没有归它管的文件——各类都没有、也没有起点要撤时，这个任务连库都不查。 */
  pending(taskId: string, dir: string): boolean;
  /** 删掉 `due(修改时间)` 为真的那些。 */
  reclaim(taskId: string, dir: string, due: (mtimeMs: number) => boolean): Reclaimed;
}

const KINDS = { traces: rawTraces, screenshots: reviewImages } satisfies Record<string, RetainedKind>;
export type RetentionSweep = Record<keyof typeof KINDS, Reclaimed>;

/**
 * ASH_TRACE_KEEP_DAYS：有限且不为负的天数，0 = 一了结就删。填错（`7d`、负数、空白）一律按
 * 默认值并告警——这是一个删文件的开关，配置读不懂时的方向只能是多留，不能是立刻删。名字带
 * TRACE 是因为它先管的是原始事件流，截图沿用同一个开关。
 */
export function retentionKeepDays(): number {
  const raw = process.env.ASH_TRACE_KEEP_DAYS?.trim();
  if (!raw) return DEFAULT_KEEP_DAYS;
  const days = Number(raw);
  if (Number.isFinite(days) && days >= 0) return days;
  console.warn(`[ash] ASH_TRACE_KEEP_DAYS=${JSON.stringify(process.env.ASH_TRACE_KEEP_DAYS)} 不是有效天数，按 ${DEFAULT_KEEP_DAYS} 天处理`);
  return DEFAULT_KEEP_DAYS;
}

type TaskConclusion = { archived: boolean; archivedAt: string | null; stage: string | null; acceptanceId: string | null };

/** 这一次了结的身份；还没了结（进行中）就是 null。 */
function conclusionOf(row: TaskConclusion): { key: string; floorMs: number } | null {
  if (!row.archived && row.stage !== "accepted") return null;
  const parts = [
    row.stage === "accepted" ? `acceptance:${row.acceptanceId ?? "legacy"}` : null,
    row.archived ? `archived:${row.archivedAt ?? "legacy"}` : null,
  ].filter(Boolean);
  const archivedMs = row.archived && row.archivedAt ? Date.parse(row.archivedAt) : NaN;
  return { key: parts.join("|"), floorMs: Number.isFinite(archivedMs) ? archivedMs : 0 };
}

/** 落盘的起点只在身份对得上时才算数。 */
function readStamp(path: string, key: string): number | null {
  try {
    const stamp = JSON.parse(readFileSync(path, "utf8")) as { key?: unknown; at?: unknown };
    const at = typeof stamp.at === "string" ? Date.parse(stamp.at) : NaN;
    return stamp.key === key && Number.isFinite(at) ? at : null;
  } catch {
    return null;
  }
}

const empty = (): RetentionSweep => ({ traces: { removed: 0, bytes: 0 }, screenshots: { removed: 0, bytes: 0 } });

async function sweepTask(taskId: string, nowMs: number, grace: number): Promise<RetentionSweep> {
  const swept = empty();
  const dir = join(RUNS_DIR, taskId);
  try {
    readdirSync(dir);
  } catch {
    return swept;
  }
  const kinds = (Object.keys(KINDS) as (keyof typeof KINDS)[]).filter((kind) => KINDS[kind].pending(taskId, dir));
  const stampPath = join(dir, STAMP);
  if (!kinds.length && !existsSync(stampPath)) return swept;
  const row = (await db.select({ archived: tasks.archived, archivedAt: tasks.archivedAt, stage: tasks.stage, acceptanceId: tasks.acceptanceId })
    .from(tasks).where(eq(tasks.id, taskId))).at(0);
  if (!row) return swept;
  const conclusion = conclusionOf(row);
  if (!conclusion) {
    rmSync(stampPath, { force: true }); // 进行中：起点作废
    return swept;
  }
  let observed = readStamp(stampPath, conclusion.key);
  if (observed === null) {
    // 头一回看到这一次了结（或身份换了）：从此刻起算。宽限期为 0 时这一趟就删，否则自然一份不删。
    writeFileSync(stampPath, `${JSON.stringify({ key: conclusion.key, at: new Date(nowMs).toISOString() })}\n`);
    observed = nowMs;
  }
  const since = Math.max(observed, conclusion.floorMs);
  const due = (mtimeMs: number) => Math.max(since, mtimeMs) + grace <= nowMs;
  for (const kind of kinds) {
    // 一类出错不拦另一类：截图的过期清单写不上，不该连带这个任务的事件流也不收。
    try {
      swept[kind] = KINDS[kind].reclaim(taskId, dir, due);
    } catch (error) {
      console.error(`[ash] 保留期清扫跳过 ${taskId} 的 ${kind}:`, error);
    }
  }
  return swept;
}

export async function sweepRunRetention(nowMs = Date.now()): Promise<RetentionSweep> {
  const grace = retentionKeepDays() * 86_400_000;
  const total = empty();
  let taskIds: string[];
  try {
    taskIds = readdirSync(RUNS_DIR);
  } catch {
    return total;
  }
  for (const taskId of taskIds) {
    // 逐任务隔离：一个目录出错（权限、被占用）不拦后面的任务。
    try {
      const swept = await withTaskDirLock(taskId, () => sweepTask(taskId, nowMs, grace));
      for (const kind of Object.keys(total) as (keyof RetentionSweep)[]) {
        total[kind].removed += swept[kind].removed;
        total[kind].bytes += swept[kind].bytes;
      }
    } catch (error) {
      console.error(`[ash] 保留期清扫跳过 ${taskId}:`, error);
    }
  }
  return total;
}
