// 接力出去的任务在本机的「硬拦截」判定,所有启动入口(runTask/continueTask/各
// HTTP 路由/定时班次)共用这一个函数,避免每处自己解析 JSON 各写各的。
// 只拦 direction === "out"(含 pending 未确认态):接力进来的("in")任务本来就
// 该在本机跑。零依赖,谁都能 import 而不会引出环。
export function handoffBlockReason(handoff: string | null | undefined): string | null {
  if (!handoff) return null;
  try {
    const h = JSON.parse(handoff) as { direction?: string; pending?: boolean; peerName?: string | null };
    if (h?.direction !== "out") return null;
    return h.pending
      ? "任务正在接力到另一台机器（还没确认送达）。重试接力完成收口，或先移除接力标记再在本机继续。"
      : `任务已接力到${h.peerName ? `「${h.peerName}」` : "另一台机器"}继续执行，本机这份是历史存档。要在本机继续，先移除接力标记。`;
  } catch {
    return null;
  }
}
