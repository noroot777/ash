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
  /** attach tab:会话事实的镜像,由集中轮询维护,驱动状态点与正文说明的措辞。 */
  stoppedByUser?: boolean;
  exitCode?: number | null;
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

/** attach tab 的状态点表达**会话/服务的事实**(跑着/脚本退了服务在/死透),不是连接状态。 */
export function attachStatusOf(session: { exitCode: number | null; groupAlive: boolean }): TerminalStatus {
  return session.exitCode === null ? "ready" : session.groupAlive ? "detached" : "ended";
}

export function createAttachTab(session: {
  id: string;
  name: string;
  cwd: string;
  exitCode: number | null;
  groupAlive: boolean;
  stoppedByUser: boolean;
}): ProjectTerminalTab {
  return {
    id: `attach:${session.id}`,
    ordinal: 0,
    label: session.name,
    // 初始状态直接由会话事实算出:从未点开过的 tab 也要显示真实状态,不能挂在「正在启动」
    status: attachStatusOf(session),
    cwd: session.cwd,
    attachSessionId: session.id,
    stoppedByUser: session.stoppedByUser,
    exitCode: session.exitCode,
  };
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
