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
// **宽限期从哪一刻算**：从这里第一次看到任务「了结」（已验收或已归档）的那一刻，落一个
// `.concluded-at` 时间戳；任务被重新打开（摘掉验收章、取回归档）就撤掉，下次了结重新起算。
// 不去追「验收发生在哪一秒」：把 stage 写成 accepted 的路径有十几条（各种验收、团队联动、
// 接力迁入、阶段恢复），逐条补时间戳必然漏一条，而漏的那一条就是一验收就删。观察时间不早于
// 真实时间，最多晚一个清扫周期，只会多留不会早删；升级前已经了结的老任务也从第一次清扫起
// 重新等满。另外同一份日志写完还要满 KEEP_DAYS 才删，接住「重新打开后又了结、清扫还没来得及
// 看到中间那段」时新写的那几份。
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

function readStamp(path: string): number | null {
  try {
    const at = Date.parse(readFileSync(path, "utf8").trim());
    return Number.isFinite(at) ? at : null;
  } catch {
    return null;
  }
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
    const dir = join(RUNS_DIR, taskId);
    let names: string[];
    try {
      names = readdirSync(dir).filter((name) => name.endsWith(SUFFIX));
    } catch {
      continue;
    }
    const stampPath = join(dir, STAMP);
    if (!names.length && !existsSync(stampPath)) continue;
    const row = (await db.select({ archived: tasks.archived, stage: tasks.stage }).from(tasks).where(eq(tasks.id, taskId))).at(0);
    // 任务行没了的目录不归这里管：删任务有自己的回收与重试（run-dir-reclaim.ts）。
    if (!row) continue;
    if (!(row.archived || row.stage === "accepted")) {
      rmSync(stampPath, { force: true }); // 重新打开了：下次了结重新起算
      continue;
    }
    const since = readStamp(stampPath);
    if (since === null) {
      try { writeFileSync(stampPath, `${new Date(nowMs).toISOString()}\n`); } catch { /* 下一趟再落 */ }
      continue; // 宽限期从此刻开始
    }
    for (const name of names) {
      const full = join(dir, name);
      try {
        const st = statSync(full);
        if (Math.max(since, st.mtimeMs) + grace > nowMs) continue;
        unlinkSync(full);
        removed++;
        bytes += st.size;
      } catch {
        /* 已经没了 / 没权限：跳过，清理永远不该拦住别的事 */
      }
    }
  }
  return { removed, bytes };
}
