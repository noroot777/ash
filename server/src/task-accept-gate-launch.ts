import { dropPendingAcceptGate, startPendingAcceptGate } from "./accept-gate.js";
import { appendTaskTimeline } from "./task-timeline.js";
import type { AcceptTaskResult } from "./task-accept.js";

export async function discardPendingAcceptanceGate(taskId: string, error: unknown): Promise<void> {
  if (dropPendingAcceptGate(taskId)) await appendTaskTimeline(taskId,
    `验收在门禁发射前异常退出，已撤销未执行的启动登记，不保留工作区占用：${String(error)}`);
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
      // 归类出了结论就**只给结论**：这条回执是 MCP/HTTP 调用方（多半是个 agent）唯一
      // 读到的东西，把 npm 的原始报错贴给它正是这次要修的那个毛病。
      : { ...result, reason: "accept_gate_failed", gate,
        error: gate.diagnosis
          ? `${result.error} 但它没能启动：\n${gate.diagnosis}`
          : `${result.error} 但这条命令没能跑起来：${gate.logTail.trim() || "详见任务时间线"}` };
  } finally { if (!handedOff) dropPendingAcceptGate(taskId); }
}
