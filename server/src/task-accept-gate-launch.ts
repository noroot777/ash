import type { AcceptGateView } from "@ash/shared/accept-gate";
import { dropPendingAcceptGate, startPendingAcceptGate } from "./accept-gate.js";
import { appendTaskTimeline } from "./task-timeline.js";
import type { AcceptTaskResult } from "./task-accept.js";

export async function discardPendingAcceptanceGate(taskId: string, error: unknown): Promise<void> {
  if (dropPendingAcceptGate(taskId)) await appendTaskTimeline(taskId,
    `验收在门禁发射前异常退出，已撤销未执行的启动登记，不保留工作区占用：${String(error)}`);
}

/**
 * 这条回执里「它怎么了」那一句。
 *
 * **按真实的 status/failure 说**（第 2 轮审查 N2）：旧版本一律写「但这条命令没能跑起来」,
 * 于是超时、被取消、真跑完红了全被说成没启动 —— 而紧跟其后附的诊断可能正写着「这条命令
 * 跑起来了」,同一句话里自己打自己。
 *
 * 这条路是**快速收尾**那一支：命令在 startPendingAcceptGate 返回前就已经退了,所以这里能
 * 看到任何一种终态,不是只有「红了」。
 */
function gateOutcomeClause(gate: AcceptGateView): string {
  const tail = gate.logTail.trim() || "详见任务时间线";
  if (gate.status === "passed") return `它已经跑完而且是绿的，这次验收会自动接着做完，不用再点。`;
  if (gate.status === "canceled") return `但它被取消了（没有结论）：${tail}`;
  switch (gate.failure) {
    case "timeout": return `但它整条超时了（不是定位到某个断言失败）：${tail}`;
    case "spawn_failed": return `但它起不来：${tail}`;
    case "source_changed": return `但跑动期间被测的那棵树变了，这次结果不算数：${tail}`;
    case "process_unconfirmed": return `但没能确认它的进程全部退出，这次结果不算数：${tail}`;
    default: return `但它跑完是红的${typeof gate.exitCode === "number" ? `（退出码 ${gate.exitCode}）` : ""}：${tail}`;
  }
}

export async function finishAcceptanceGate(taskId: string, result: AcceptTaskResult): Promise<AcceptTaskResult> {
  let handedOff = false;
  try {
    if (result.accepted || result.reason !== "accept_gate_required") return result;
    handedOff = true;
    const gate = await startPendingAcceptGate(taskId);
    if (!gate) return result;
    return gate.status === "running"
      ? { ...result, reason: "accept_gate_running", gate,
        error: `${result.error} 已经在跑了（日志 ${gate.logPath}）。跑完如果是绿的，这次验收会自动接着做完，不用再点。` }
      // 归类出了结论就**把结论也给上**：这条回执是 MCP/HTTP 调用方（多半是个 agent）唯一
      // 读到的东西，只把 npm 的原始报错贴给它正是这次要修的那个毛病。
      : { ...result, reason: "accept_gate_failed", gate,
        error: `${result.error} ${gateOutcomeClause(gate)}`
          + (gate.diagnosis ? `\n${gate.diagnosis}` : "") };
  } finally { if (!handedOff) dropPendingAcceptGate(taskId); }
}
