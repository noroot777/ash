// "detached":attach 的命令会话里启动脚本(PTY 组长)退了、它派生的服务还在进程组里跑
// (daemonize 形状)。不能标成 ended —— 同屏状态栏正显示「运行中」,日志抽屉说「已退出」
// 就是自相矛盾;整组死透才是 ended。
export type TerminalStatus = "starting" | "ready" | "reconnecting" | "detached" | "ended" | "error";

export type ProjectTerminalTab = {
  id: string;
  ordinal: number;
  label: string;
  status: TerminalStatus;
  cwd: string;
  /**
   * 非空 = attach 到 server 上已有的会话（常用命令的常驻会话）而不是新建 shell。
   * 这类 tab 的生命周期跟前端无关：关 tab 只是不看了，会话照跑；停止走状态栏。
   */
  attachSessionId?: string;
};

export function createTerminalTab(
  id: string,
  ordinal: number,
  projectName: string,
  cwd: string,
): ProjectTerminalTab {
  return {
    id,
    ordinal,
    label: ordinal === 1 ? projectName : `${projectName} ${ordinal}`,
    status: "starting",
    cwd,
  };
}

export function createAttachTab(sessionId: string, label: string, cwd: string): ProjectTerminalTab {
  return { id: `attach:${sessionId}`, ordinal: 0, label, status: "starting", cwd, attachSessionId: sessionId };
}

export function withoutTerminalTab(
  tabs: ProjectTerminalTab[],
  activeId: string,
  closingId: string,
): { tabs: ProjectTerminalTab[]; activeId: string | null } {
  const closingIndex = tabs.findIndex((tab) => tab.id === closingId);
  if (closingIndex < 0) return { tabs, activeId };
  const next = tabs.filter((tab) => tab.id !== closingId);
  if (activeId !== closingId) return { tabs: next, activeId };
  return {
    tabs: next,
    activeId: next[Math.min(closingIndex, next.length - 1)]?.id ?? null,
  };
}
