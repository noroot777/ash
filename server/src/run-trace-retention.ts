// 原始事件流（`<会话>-<回合>.codex-events.jsonl`）的保留期。判据（了结身份 + 满 KEEP_DAYS）
// 和清扫本身在 run-retention.ts，这里只说清删哪几份。
//
// 名字带 codex，其实除 claude 以外的执行器都经 RunTraceRecorder 写这一份（executors/diagnostics.ts）：
// CLI 吐出来的每一行事件原样落盘，**没有任何代码回读它**——会话正文在 `<会话>.md`、执行过程在
// `<会话>.trace.jsonl`，网页读的是那两份。它唯一的用途是出事时人去翻现场（失败诊断、上游停滞
// 提示里给的「原始日志」路径）。体积的大头是命令输出的逐段推送（实测单份可到 160M，98% 是
// outputDelta），完整命令输出只存在这里。claude 那边对应的原始流是 `.agent-out.jsonl`，由
// run-logs-gc.ts 在回合结束一天后回收。用户 2026-11-13 拍板「保留全文，设保留期」。
//
// `.diagnostics.json` / `.stderr.log` 只有几百字节，失败分类和 stderr 尾巴都在里面，留着。
import { readdirSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import type { RetainedKind } from "./run-retention.js";

const SUFFIX = ".codex-events.jsonl";

function traceNames(dir: string): string[] {
  try {
    return readdirSync(dir).filter((name) => name.endsWith(SUFFIX));
  } catch {
    return [];
  }
}

export const rawTraces: RetainedKind = {
  pending: (_taskId, dir) => traceNames(dir).length > 0,
  reclaim(_taskId, dir, due) {
    let removed = 0;
    let bytes = 0;
    for (const name of traceNames(dir)) {
      const full = join(dir, name);
      try {
        const st = statSync(full);
        if (!due(st.mtimeMs)) continue;
        unlinkSync(full);
        removed++;
        bytes += st.size;
      } catch {
        /* 已经没了 / 没权限：跳过这一份 */
      }
    }
    return { removed, bytes };
  },
};
