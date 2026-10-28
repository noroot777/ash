// 终端 / 常用命令会话的服务端形状。从 `apiTypes.ts` 拆出来的 —— 那份已经贴着 700 行上限
// (全局约定),这次扩充 StopFact 把它推到了 725 行(第 4 轮审查发现 3)。调用点照旧从
// `api.ts` 引:apiTypes.ts 整段再导出,导出契约没变。

export type TerminalSessionInfo = {
  id: string;
  projectId: string;
  cwd: string;
  shell: string;
  name: string;
  /** 非空 = 常用命令的常驻会话（server/src/terminal-commands.ts），不是交互 shell。 */
  commandId: string | null;
  startedAt: number;
  /** null = 进程还活着；命令会话靠它区分「运行中」和「退了但日志可回看」。 */
  exitCode: number | null;
  /**
   * 有人要求停过（区别于自己崩了）：显示「已停止」，不算异常、不亮红点。服务端派生自
   * `stop`——「有没有人要求停过」和「停净了吗」是两件事，一个布尔答不了第二问。
   */
  stoppedByUser: boolean;
  /** 进程组里是否还有活进程。组长退了组不一定空（daemonize），判「还在跑」看它，别看 exitCode。 */
  groupAlive: boolean;
  /** 这次启动自己打印过的本机端口（`http://127.0.0.1:8787`），停止时按它回去找人。 */
  ports: number[];
  /** 上面那些端口此刻还有人在听 = 服务还在后台跑着，哪怕启动脚本早退了。 */
  portsAlive: boolean;
  portUncertain?: boolean;
  running?: boolean;
  /**
   * 上一次停止**留下的责任**（服务端 StopFact，口径与注释在
   * server/src/terminal-session-facts.ts）：
   *
   *  · `none` / `requested` / `verified` —— 没人停过 / 停了但还没核到终态 / 核验过停净了；
   *  · `unresolved` —— 停止动作跑完了，但**证明不到停净**。`pids` 是核不上归属所以一个字都
   *    没敢动或仍存活的号（只报此刻还活着的）；`complete` 独立记录证据是否完整。
   *    `why` 是原样给用户看的那句话。
   *
   * 界面读它说第三种状态；`pids` 非空才算「还有东西在跑」（空的那种不卡启动按钮）。
   */
  stop:
    | { kind: "none" }
    | { kind: "requested" }
    | { kind: "verified" }
    | { kind: "unresolved"; pids: number[]; complete: boolean; why: string; memberReasons?: Record<string, string>; incompleteReasons?: string[] };
  /** 这次启动打印的本机端口超过了记录额度，多出来的没记下 = 端口这条线索本身不全。 */
  portsTruncated: boolean;
};

export type TerminalEvent =
  | { seq: number; type: "data"; data: string }
  | { seq: number; type: "exit"; exitCode: number; signal?: number };
