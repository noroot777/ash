import type { HandoffPeerOffline, HandoffRemoteState, TaskListItem } from "@ash/shared";

// 出站存档行的状态合并 —— 纯函数那部分（React 那半在 useOutboundState.ts）。
// 拆出来是为了能直接钉住：这里错一次，侧栏就会拿着上一轮的旧状态当实时状态用。

export function handedOut(task: Pick<TaskListItem, "handoff">): boolean {
  return task.handoff?.direction === "out" && !task.handoff.pending;
}

// 每一轮都**整份重建**，绝不在旧 Map 上叠加。
//
// 服务端有两条正常路径会「这一轮不返回某一行」：整台持有机联系不上（rows 空 + offline），
// 或者逐个鉴权时那一行读不到（对端已经把它移回/删掉）。叠加的写法下，只要某一行成功
// 问到过一次 running，之后持有机关机、降级、任务被移回，前端都会一直把它按 running 算 ——
// 列表、顶栏计数、筛选全跟着一起说谎，而屏幕上同时还写着「联系不上 X」。
//
// 本机任务的状态来源断了不会留着上一轮的 running，接力的行也不该有这种特权：**问不到就是
// 没有实时状态**，回落到本机那一行冻住的旧状态（多半是 canceled，于是它自然退出任务模式），
// 由离线提示那一行如实说明。下一轮通了自然就回来。
export function remoteStateMap(rows: HandoffRemoteState[]): Map<string, HandoffRemoteState> {
  return new Map(rows.map((row) => [row.taskId, row]));
}

// 把问回来的实时状态盖在出站行上。没问到的行原样返回（同一个对象引用）。
export function applyRemoteStates<T extends TaskListItem>(
  tasks: T[],
  states: Map<string, HandoffRemoteState>,
): T[] {
  if (!states.size) return tasks;
  return tasks.map((task) => {
    const state = handedOut(task) ? states.get(task.id) : undefined;
    if (!state) return task;
    // 标题也一起接过来：对端起过自动标题、或者用户在那边改过名，本机存档还写着老的。
    return {
      ...task,
      status: state.status,
      stage: state.stage,
      question: state.question,
      title: state.title,
      updatedAt: state.updatedAt,
    };
  });
}

// 出站行自己就记着持有机的地址和名字（接力时冻进 handoff 标记的），所以一台都问不到时
// 仍然报得出「联系不上谁」，不必等设置读回来。
export function peersOf(tasks: TaskListItem[], reason: unknown): HandoffPeerOffline[] {
  const text = reason instanceof Error ? reason.message : String(reason);
  const peers = new Map<string, HandoffPeerOffline>();
  for (const task of tasks) {
    const url = task.handoff?.peerUrl;
    if (!url || peers.has(url)) continue;
    peers.set(url, { url, name: task.handoff?.peerName || url, reason: text });
  }
  return [...peers.values()];
}
