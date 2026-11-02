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
  /**
   * 用户**显式放弃**了这次启动的管理责任（「我自己处理了」）。非 null = 他已经看过残留事实、
   * 按过那颗带风险确认的按钮：ash 不再把这条记录当「还在跑」，删除保护一并解除。
   *
   * **它不是核销** —— 停没停净的结论仍原样留在 `stop` 上，这一格另记「放弃那一刻还有什么
   * 活着」。界面照实说「已放弃管理」，不说「已停止」（判据在 server/src/terminal-abandon.ts）。
   */
  abandoned?: LaunchAbandonment | null;
  /** 这次启动打印的本机端口超过了记录额度，多出来的没记下 = 端口这条线索本身不全。 */
  portsTruncated: boolean;
};

/** 一次显式放弃留下的事实（放弃**那一刻**的快照，不是现在再探一遍的结果）。 */
export type LaunchAbandonment = {
  at: number;
  /** 账上此刻还活着、没能核销的号。 */
  owedPids: number[];
  /** 按这次启动的记号还点到名的号 —— 确凿是它起来的。 */
  taggedPids: number[];
  ports: number[];
  portState: "ours" | "stranger" | "free" | "unknown" | "unavailable";
  /** 原样显示给用户的那一段残留交代。 */
  notice: string;
  /**
   * 那段话说的是哪一种:有确定是这次启动留下的(owned)/只有 ash 分不清来路的(unsure)/
   * 什么都探不到(none)。界面据它挑「已放弃管理（…）」的说法,别去认 notice 的措辞。
   */
  left: "owned" | "unsure" | "none";
};

/** 放弃前那个弹层要的全部材料：残留事实 + 解除范围 + 它针对的那条会话 id。 */
export type LaunchResidueView = {
  sessionId: string;
  name: string;
  startedAt: number;
  residue: LaunchAbandonment;
  /** 放弃之后 ash **不再做**哪几件事，原样逐条显示 —— 用户按之前就该读到。 */
  scope: string[];
  /** 非 null = 已经放弃过，弹层直接显示当时那一份。 */
  abandoned: LaunchAbandonment | null;
};

export type TerminalEvent =
  | { seq: number; type: "data"; data: string }
  | { seq: number; type: "exit"; exitCode: number; signal?: number };
