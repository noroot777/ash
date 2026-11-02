// 终端会话的**观测层**:两件事实靠周期性采样刷新,都不承担正确性,只是把「还有东西在跑」
// 这件事看得更准。从 terminal.ts 拆出来(那份文件越过了项目 700 行的上限),这一段只需要
// 「会话列表」这一个入口,与会话表、容量、事件缓冲都没有耦合。
//
//   ① 后代进程组累积(descendantPgids):job-control 把后台作业挪进独立组,shell 一 exit
//      树就断了,只有这份内存记录能在结束/关服时杀到它们。采样是**第三道防线** ——
//      交互会话的独立组孤儿由 TTY_REAPER_WRAPPER 在 shell 退出时确定性清杀,收尾路径再用
//      会话成员 + ppid 快照确定性补抓;累积只兜「leader 已退、枚举已不可用」的降级路径
//      (第 4 轮审查实锤:毫秒级的 `disown; exit`,任何采样都赢不了)。
//   ② 端口存活(portsAlive):启动脚本退了、服务却还听着它打印过的端口 —— 真·守护化的
//      服务只剩这一条线索(service-ports.ts)。lsof 比 ps 慢得多,所以自成一把锁、按拍跑。
import { PORT_TIER_AVAILABLE, probeOwnedPorts } from "./service-ports.js";
import { descendantsFromTable, readProcessTable } from "./terminal-process-tree.js";

/** 观测层只认会话的这几样事实(TerminalSession 结构上满足它)。 */
export type WatchedSession = {
  readonly process: { readonly pid: number };
  readonly commandId: string | null;
  readonly descendantPgids: Set<number>;
  readonly launchPorts: Set<number>;
  /** 这次启动的记号。端口上坐着的是不是「这次起来的东西」,只有它能核(service-ports.ts)。 */
  readonly launchToken: string | null;
  exitCode: number | null;
  portsAlive: boolean;
  portUncertain?: boolean;
  /** 端口事实的代次:停止路径核验完会 +1,这里据此丢掉取样早于它的那一拍。 */
  readonly factsGeneration: number;
};

/** 后代累积扫描的间隔。构造可注入,回归用小间隔 + 真实 sleep 按真实定时器验证。 */
const DESCENDANT_SCAN_MS = 1_500;
/** onData 触发扫描的限流窗口:shell 输出很密,别每帧都 ps。trailing edge,不丢触发。 */
const DESCENDANT_DATA_THROTTLE_MS = 250;

export class TerminalWatcher {
  private readonly scanner: ReturnType<typeof setInterval>;
  private scanningDescendants = false;
  private rescanQueued = false;
  private scanningPorts = false;
  private scanTimer: ReturnType<typeof setTimeout> | null = null;
  private lastScanAt = 0;

  constructor(
    private readonly sessions: () => Iterable<WatchedSession>,
    options: { scanMs?: number } = {},
  ) {
    this.scanner = setInterval(
      () => { void this.scanDescendants(); void this.scanPorts(); },
      options.scanMs ?? DESCENDANT_SCAN_MS,
    );
    this.scanner.unref?.();
  }

  stop(): void {
    clearInterval(this.scanner);
    if (this.scanTimer) { clearTimeout(this.scanTimer); this.scanTimer = null; }
  }

  /**
   * shell 产出输出 = 它还活着,且可能刚起了后台作业(job-control 会打印 `[1] pid`)。
   * 限流触发一次后代扫描,让新作业在毫秒级被记进 descendantPgids,而不必等满一个周期
   * —— 缩小「起作业后立刻退 shell」的漏记窗口(第 3 轮审查)。
   */
  nudge(): void {
    if (this.scanTimer) return;
    const wait = Math.max(0, this.lastScanAt + DESCENDANT_DATA_THROTTLE_MS - Date.now());
    this.scanTimer = setTimeout(() => {
      this.scanTimer = null;
      void this.scanDescendants();
    }, wait);
    this.scanTimer.unref?.();
  }

  /**
   * 持续累积每个活会话见过的后代进程组 pgid。一次 ps 覆盖全部活 shell(命令会话也扫,
   * 无害)。幂等只累积;正在扫时到达的请求**排队一次**扫完即补(不静默丢弃,第 4 轮审查)。
   */
  async scanDescendants(): Promise<void> {
    if (this.scanningDescendants) { this.rescanQueued = true; return; }
    const shells = [...this.sessions()].filter((session) => session.exitCode === null);
    if (!shells.length) return;
    this.scanningDescendants = true;
    try {
      const table = await readProcessTable();
      if (!table) return;
      for (const session of shells) {
        for (const pgid of descendantsFromTable(table, session.process.pid).pgids) {
          session.descendantPgids.add(pgid);
        }
      }
    } finally {
      this.lastScanAt = Date.now();
      this.scanningDescendants = false;
      if (this.rescanQueued) {
        this.rescanQueued = false;
        void this.scanDescendants();
      }
    }
  }

  /**
   * 刷新「启动脚本退了、但它起的服务还听着端口」这个事实。只问**启动脚本已退出**的命令
   * 会话 —— 组长还活着时进程归属已经说明一切,不必再跑 lsof。
   *
   * 认的是**归属**而不是「有没有人听」(probeOwnedPorts):别人的服务恰好坐在同一个端口上,
   * 跟这次启动还在不在是两件事 —— 混成一件,一条只打印了网址的命令会因为邻居的 vite 永远
   * 显示「运行中」,停也停不掉(第 3 轮审查发现 3)。
   *
   * **「问不出来」不许写成 false**:lsof 坏了/超时/核不上归属返回 unknown,这时保留上一次的事实
   * (第 1 轮审查发现 2:工具失灵被读成「端口空了 = 已经停净」,于是界面把还在跑的服务
   * 说成已停止)。同理这里**不看 stoppedByUser** —— 用户点过停止不等于真停下来了,那件事
   * 由停止路径自己核验后写(markCommandStopped)。
   *
   * 写回之前核对**代次**:一次 lsof 要跑几百毫秒,期间用户点了停止、停止路径核验完把
   * portsAlive 落成 false 并推进了代次,此刻这一拍带着「停止之前取的样」落地就会把它复活成
   * true —— 刷新回来停止按钮还在,等于那一下没按(第 2 轮审查发现 1 的同一类)。取样早于
   * 当前代次的,结论整条丢掉。
   */
  async scanPorts(): Promise<void> {
    if (!PORT_TIER_AVAILABLE) return;
    if (this.scanningPorts) return;
    const candidates = [...this.sessions()]
      .filter((session) => session.commandId !== null && session.launchPorts.size > 0);
    if (!candidates.length) return;
    this.scanningPorts = true;
    try {
      for (const session of candidates) {
        if (session.exitCode === null) { session.portsAlive = false; continue; }
        const sampledAt = session.factsGeneration;
        const { state } = await probeOwnedPorts(session.launchPorts, session.launchToken);
        if (session.factsGeneration !== sampledAt) continue;
        session.portUncertain = state === "unknown";
        session.portsAlive = state === "ours";
      }
    } finally { this.scanningPorts = false; }
  }
}
