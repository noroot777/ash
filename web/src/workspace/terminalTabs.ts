// "detached":attach 的命令会话里启动脚本(PTY 组长)退了、它派生的服务还在进程组里跑
// (daemonize 形状)。不能标成 ended —— 同屏状态栏正显示「运行中」,日志抽屉说「已退出」
// 就是自相矛盾;整组死透才是 ended。
import type { TerminalSessionInfo } from "../lib/api.ts";

export type TerminalStatus = "starting" | "ready" | "reconnecting" | "detached" | "ended" | "error";

/** 上一次停止留下的责任。口径在 lib/apiTypes.ts 的 TerminalSessionInfo.stop。 */
type StopFactLike = TerminalSessionInfo["stop"];

export type ProjectTerminalTab = {
  id: string;
  ordinal: number;
  label: string;
  status: TerminalStatus;
  cwd: string;
  /**
   * shell = 交互终端。**持久**(VSCode 语义):关抽屉/收起 tab 都只是不看了,server 上的
   * 会话照活,重开抽屉从会话列表原样恢复;真正结束它的只有 tab 上的 ✕(closeTab 里
   * DELETE)和 shell 自己 exit。
   * command = 常用命令的日志镜像:生命周期归状态栏管,✕ 永远只是收起。
   */
  kind: "shell" | "command";
  /**
   * server 会话 id。attach tab 一开始就有;新建 shell 要 create 完由 pane 回填 ——
   * closeTab 靠它结束会话。
   */
  sessionId?: string;
  /** 非空 = 挂载时 attach 到 server 上已有的会话(SSE 从 seq 0 重放)而不是新建 shell。 */
  attachSessionId?: string;
  /** attach tab:会话事实的镜像,由集中轮询维护,驱动状态点与正文说明的措辞。 */
  stoppedByUser?: boolean;
  /**
   * 上一次停止留下的责任。状态点只认活证据(见 attachStatusOf),但正文那句话要照实说 ——
   * 「证明不到停净」的那一档如果照旧写「服务已停止」,就是拿一句谎话收尾(第 3 轮审查发现 1)。
   */
  stop?: StopFactLike;
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
    kind: "shell",
  };
}

/**
 * attach tab 的状态点表达**会话/服务的事实**(跑着/脚本退了服务在/死透),不是连接状态。
 * 「服务还在」的判据与常用命令弹层、服务端的 sessionRunning 一致 —— 进程归属之外,它打印
 * 过的端口还有人听、或者上次停止留下了没核销的号,都算还没了结(否则同一条守护化的服务,
 * 弹层说「运行中」、终端 tab 说「已结束」)。
 */
export function attachStatusOf(
  session: { exitCode: number | null; groupAlive: boolean; portsAlive?: boolean; stop?: StopFactLike },
): TerminalStatus {
  if (session.exitCode === null) return "ready";
  // 「还没了结」只认**还活着的**号:端口超额那种「证据不全」的 unresolved 一个号都举不出来,
  // 它该在状态点上说「已结束」(确实没东西在跑了),那句「没能确认停净」由文案层去说。
  const leftovers = session.stop?.kind === "unresolved" ? session.stop.pids.length : 0;
  const settled = !session.groupAlive && session.portsAlive !== true && leftovers === 0;
  return settled ? "ended" : "detached";
}

export function createAttachTab(
  session: {
    id: string;
    name: string;
    cwd: string;
    commandId: string | null;
    exitCode: number | null;
    groupAlive: boolean;
    portsAlive?: boolean;
    stop?: StopFactLike;
    stoppedByUser: boolean;
  },
  /** 恢复的交互 shell 用项目名 + 序号做标签,跟新建 shell 一个排法;命令日志用会话名。 */
  shellLabel?: { label: string; ordinal: number },
): ProjectTerminalTab {
  return {
    id: `attach:${session.id}`,
    ordinal: shellLabel?.ordinal ?? 0,
    label: shellLabel?.label ?? session.name,
    // 初始状态直接由会话事实算出:从未点开过的 tab 也要显示真实状态,不能挂在「正在启动」
    status: attachStatusOf(session),
    cwd: session.cwd,
    kind: session.commandId === null ? "shell" : "command",
    sessionId: session.id,
    attachSessionId: session.id,
    stoppedByUser: session.stoppedByUser,
    stop: session.stop,
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
