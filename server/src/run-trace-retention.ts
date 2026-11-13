// 原始事件流（`<会话>-<回合>.codex-events.jsonl`）的保留期。
//
// 名字带 codex，其实除 claude 以外的执行器都经 RunTraceRecorder 写这一份（executors/diagnostics.ts）：
// CLI 吐出来的每一行事件原样落盘，**没有任何代码回读它**——会话正文在 `<会话>.md`、执行过程在
// `<会话>.trace.jsonl`，网页读的是那两份。它唯一的用途是出事时人去翻现场（失败诊断、上游停滞
// 提示里给的「原始日志」路径）。体积的大头是命令输出的逐段推送（实测单份可到 160M，98% 是
// outputDelta），完整命令输出只存在这里。claude 那边对应的原始流是 `.agent-out.jsonl`，由
// run-logs-gc.ts 在回合结束一天后回收。用户 2026-11-13 拍板「保留全文，设保留期」：任务验收或
// 归档之后再留 KEEP_DAYS 天。
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
// 同一份日志写完也要满 KEEP_DAYS：接住「了结之后又写了新日志」的那几份。
//
// 进行中的任务一律不碰，不管多旧；`.diagnostics.json` / `.stderr.log` 只有几百字节，失败分类和
// stderr 尾巴都在里面，留着。
import { existsSync, readdirSync, readFileSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { db } from "./db/index.js";
import { tasks } from "./db/schema.js";
import { RUNS_DIR } from "./paths.js";

const SUFFIX = ".codex-events.jsonl";
const STAMP = ".concluded-at";
const DEFAULT_KEEP_DAYS = 7;

/**
 * ASH_TRACE_KEEP_DAYS：有限且不为负的天数，0 = 一了结就删。填错（`7d`、负数、空白）一律按
 * 默认值并告警——这是一个删文件的开关，配置读不懂时的方向只能是多留，不能是立刻删。
 */
export function traceKeepDays(): number {
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

async function sweepTask(taskId: string, nowMs: number, grace: number): Promise<{ removed: number; bytes: number }> {
  const dir = join(RUNS_DIR, taskId);
  let names: string[];
  try {
    names = readdirSync(dir).filter((name) => name.endsWith(SUFFIX));
  } catch {
    return { removed: 0, bytes: 0 };
  }
  const stampPath = join(dir, STAMP);
  if (!names.length && !existsSync(stampPath)) return { removed: 0, bytes: 0 };
  const row = (await db.select({ archived: tasks.archived, archivedAt: tasks.archivedAt, stage: tasks.stage, acceptanceId: tasks.acceptanceId })
    .from(tasks).where(eq(tasks.id, taskId))).at(0);
  // 任务行没了的目录不归这里管：删任务有自己的回收与重试（run-dir-reclaim.ts）。
  if (!row) return { removed: 0, bytes: 0 };
  const conclusion = conclusionOf(row);
  if (!conclusion) {
    rmSync(stampPath, { force: true }); // 进行中：起点作废
    return { removed: 0, bytes: 0 };
  }
  const observed = readStamp(stampPath, conclusion.key);
  if (observed === null) {
    // 头一回看到这一次了结（或身份换了）：从此刻起算，这一趟一份不删。
    writeFileSync(stampPath, `${JSON.stringify({ key: conclusion.key, at: new Date(nowMs).toISOString() })}\n`);
    return { removed: 0, bytes: 0 };
  }
  const since = Math.max(observed, conclusion.floorMs);
  let removed = 0;
  let bytes = 0;
  for (const name of names) {
    const full = join(dir, name);
    try {
      const st = statSync(full);
      if (Math.max(since, st.mtimeMs) + grace > nowMs) continue;
      unlinkSync(full);
      removed++;
      bytes += st.size;
    } catch {
      /* 已经没了 / 没权限：跳过这一份 */
    }
  }
  return { removed, bytes };
}

export async function sweepRawTraces(nowMs = Date.now()): Promise<{ removed: number; bytes: number }> {
  const grace = traceKeepDays() * 86_400_000;
  let removed = 0;
  let bytes = 0;
  let taskIds: string[];
  try {
    taskIds = readdirSync(RUNS_DIR);
  } catch {
    return { removed, bytes };
  }
  for (const taskId of taskIds) {
    // 逐任务隔离：一个目录出错（权限、被占用）不拦后面的任务。
    try {
      const swept = await sweepTask(taskId, nowMs, grace);
      removed += swept.removed;
      bytes += swept.bytes;
    } catch (error) {
      console.error(`[ash] 原始事件流清扫跳过 ${taskId}:`, error);
    }
  }
  return { removed, bytes };
}
