// 原始事件流（`<会话>-<回合>.codex-events.jsonl`）的保留期。
//
// 名字带 codex，其实除 claude 以外的执行器都经 RunTraceRecorder 写这一份（executors/diagnostics.ts）：
// CLI 吐出来的每一行事件原样落盘，**没有任何代码回读它**——会话正文在 `<会话>.md`、执行过程在
// `<会话>.trace.jsonl`，网页读的是那两份。它唯一的用途是出事时人去翻现场（失败诊断、上游停滞
// 提示里给的「原始日志」路径）。体积的大头是命令输出的逐段推送（实测单份可到 160M，98% 是
// outputDelta），完整命令输出只存在这里。claude 那边对应的原始流是 `.agent-out.jsonl`，由
// run-logs-gc.ts 在回合结束一天后回收。
//
// 所以按「任务了结 + 宽限期」删：已验收或已归档、且这份日志写完（或任务归档）已过 KEEP_DAYS 天。
// 进行中的任务一律不碰，不管多旧；`.diagnostics.json` / `.stderr.log` 只有几百字节，失败分类和
// stderr 尾巴都在里面，留着。用户 2026-11-13 拍板「保留全文，设保留期」。
import { readdirSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { db } from "./db/index.js";
import { tasks } from "./db/schema.js";
import { RUNS_DIR } from "./paths.js";

const SUFFIX = ".codex-events.jsonl";
// ASH_TRACE_KEEP_DAYS 可调，0 = 任务一了结就删。
const KEEP_DAYS = Number(process.env.ASH_TRACE_KEEP_DAYS ?? 7);

export async function sweepRawTraces(nowMs = Date.now()): Promise<{ removed: number; bytes: number }> {
  const grace = KEEP_DAYS * 86_400_000;
  let removed = 0;
  let bytes = 0;
  let taskIds: string[];
  try {
    taskIds = readdirSync(RUNS_DIR);
  } catch {
    return { removed, bytes };
  }
  for (const taskId of taskIds) {
    let names: string[];
    try {
      names = readdirSync(join(RUNS_DIR, taskId)).filter((name) => name.endsWith(SUFFIX));
    } catch {
      continue;
    }
    if (!names.length) continue;
    const row = (await db.select({ archived: tasks.archived, archivedAt: tasks.archivedAt, stage: tasks.stage })
      .from(tasks).where(eq(tasks.id, taskId))).at(0);
    // 任务行没了的目录不归这里管：删任务时整个目录已经一起收了，剩下的是别的来历，不猜。
    if (!row || !(row.archived || row.stage === "accepted")) continue;
    const archivedMs = row.archived && row.archivedAt ? Date.parse(row.archivedAt) : 0;
    for (const name of names) {
      const full = join(RUNS_DIR, taskId, name);
      try {
        const st = statSync(full);
        if (Math.max(st.mtimeMs, archivedMs || 0) + grace > nowMs) continue;
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
