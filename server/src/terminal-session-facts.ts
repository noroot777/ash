/**
 * 会话**事实的形状** —— 终端会话对外是什么样(TerminalSessionInfo,进 DTO)、对内还多带了
 * 什么(TerminalSession,进程把手与各条观测线索)。
 *
 * 单独成文件的理由:这些类型的注释写的是「每条线索为什么存在、谁在读它」,是整套停止/幂等
 * 判据的说明书,跟 TerminalSessionManager 的调度代码混在一份里,两边都读不下去
 * (terminal.ts 也因此越过 700 行上限)。管理器在 terminal.ts,杀进程在
 * terminal-session-kill.ts,观测在 terminal-session-watch.ts。
 */
import type { TerminalReservation } from "./terminal-capacity.js";
import type { TerminalProcess } from "./terminal-pty.js";

export type TerminalEvent =
  | { seq: number; type: "data"; data: string }
  | { seq: number; type: "exit"; exitCode: number; signal?: number };

export type TerminalEventInput =
  | { type: "data"; data: string }
  | { type: "exit"; exitCode: number; signal?: number };

/**
 * 上一次停止**留下了什么责任**。
 *
 * 「已请求停止」「已核验停净」「没能确认」是**三件**事,早先由两个字段兼任:`stoppedByUser`
 * 一个布尔同时兼「我点过」和「它停了」,`unresolved: number[]` 一个 PID 列表同时兼「还剩谁」
 * 和「这次核验完不完整」。于是端口超额那种「证据本身不全、一个 PID 都举不出来」的形状,
 * 落到账上就是空数组,界面与下一次停止都读成「干净」(第 3 轮审查发现 1)。
 *
 *  · `none`       —— 没人要求停过;
 *  · `requested`  —— 用户点了停止、信号发了,但**还没核到终态**(terminateSession 落的就是
 *                    这一档:TERM/KILL 之前就得记下「用户要求停止」,后面每一轮都可能失败);
 *  · `verified`   —— 核验过:这次启动起来的东西都不在了;
 *  · `unresolved` —— 停止动作跑完了,但**证明不到停净**。`pids` 是核不上归属所以一个字都没
 *                    动的或仍存活的号。`complete` 独立记录证据是否完整,不随 PID 列表变化;
 *                    `why` 是原样给用户看的那句话。
 *
 * **这一档是单调的**:只有逐项确认消失了才能被 `verified` 覆盖,一次范围更窄的核验
 * (「我记下的这几个端口空了」)不许核销一笔范围更宽的责任。合并规则见
 * terminal-stop-facts.ts 的 mergeStop,停止/重启/回收/界面读的都是这一个终态。
 */
export type StopFact =
  | { kind: "none" }
  | { kind: "requested" }
  | { kind: "verified" }
  | { kind: "unresolved"; pids: number[]; complete: boolean; why: string; memberReasons?: Record<string, string>; incompleteReasons?: string[] };

/** 一次停止动作**核验之后**的结论(mergeStop 的输入)。`requested` 不在其中:那是动手前落的。 */
export type StopResolution = Extract<StopFact, { kind: "verified" } | { kind: "unresolved" }>;

export type TerminalSessionInfo = {
  id: string;
  projectId: string;
  cwd: string;
  shell: string;
  name: string;
  /** 非空 = 这是「常用命令」的常驻会话（shared/src/project-commands.ts），不是交互 shell。 */
  commandId: string | null;
  startedAt: number;
  /** null = 进程还活着。命令会话靠它区分「运行中」和「退了但日志还能回看」。 */
  exitCode: number | null;
  /**
   * 用户主动停的（区别于自己崩了）：UI 显示「已停止」，不算异常退出、不亮红点。
   *
   * **派生字段**（`stop.kind !== "none"`），不单独存 —— 它只回答「有没有人要求停过」,
   * 「停净了吗」看 `stop`。一个布尔兼两个问题就会得出「我点过停止 ⇒ 它停了」。
   */
  stoppedByUser: boolean;
  /**
   * 进程组里是否还有活着的进程(info() 时即时探测)。组长退了组不一定空:启动脚本
   * `cmd & …; exit 0` 这种 daemonize 形状下 exitCode 已落、后台子进程还在跑 ——
   * 「这条命令还活着吗」一律看这个字段,别看 exitCode(第 4 轮审查实锤)。
   */
  groupAlive: boolean;
  /**
   * 这次启动自己打印过的本机端口(`http://127.0.0.1:8787` 这种)。真·守护化的服务
   * (双 fork + setsid)从 ppid/ctty/pgid 三条线索里全逃了,这是仅剩的一条 ——
   * 停止时按它回到端口上找人(server/src/service-ports.ts)。
   */
  ports: number[];
  /**
   * 上面那些端口此刻还有没有人在听(由后代扫描那一拍顺带探,不是每次 info() 都跑 lsof)。
   * 「启动脚本退了、服务还在后台」就靠它认出来 —— groupAlive 在这种形状下是 false。
   */
  portsAlive: boolean;
  portUncertain?: boolean;
  running?: boolean;
  /**
   * 上一次停止留下的责任(见 StopFact)。界面照实说一句,下次点停止还看得见,刷新也不丢。
   * `unresolved.pids` 只报**此刻还活着**的号 —— 它们停止那刻核不出归属,但后来自己退了是
   * 常态,不过滤就会把界面永久钉在「还没停完」。
   */
  stop: StopFact;
  /**
   * 这次启动打印的本机端口**超过了记录额度**(MAX_LAUNCH_PORTS),第 9 个起没记下来。
   * 于是「记下的端口全空了」就证明不到「这次起来的东西都停了」—— 自己 setsid 单开一组、
   * 只能从它自己那个端口找到的守护进程,线索压根没进账(第 2 轮审查发现 2 的同一类)。
   */
  portsTruncated: boolean;
};

/**
 * 存在内存里的会话。与 DTO 的差只有 `stoppedByUser` —— 那是 `stop` 的投影,**不存**:
 * 两份就会漂(谁写了一份忘了另一份,就是上面注释里那个「我点过 ⇒ 它停了」)。
 */
export type TerminalSession = Omit<TerminalSessionInfo, "stoppedByUser"> & {
  process: TerminalProcess;
  events: TerminalEvent[];
  bufferBytes: number;
  nextSeq: number;
  lastAccessedAt: number;
  listeners: Set<(event: TerminalEvent) => void>;
  /**
   * 会话存续期见过的后代进程组 pgid(job-control 后台作业的独立组)。持续累积 ——
   * shell 一 exit 树就断了、实时快照抓不到,只有这份内存记录能在结束/退出时杀到它们
   * (第 2 轮自由审查实锤)。见 terminal-process-tree.ts 顶部与 terminal-session-watch.ts。
   */
  descendantPgids: Set<number>;
  /**
   * 累积这次启动打印过的本机端口。只对命令会话累积:交互 shell 里 `curl localhost:8080`
   * 这种字样跟「我起了个服务」没关系,而停止按钮只长在命令会话上。
   */
  launchPorts: Set<number>;
  /**
   * 认端口的**增量**扫描器。pty 的输出是流,地址完全可能被切成两块送来,无状态正则会
   * 整条漏掉、甚至把五位端口的前四位当成完整端口(第 1 轮审查发现 5)。见
   * service-ports.ts 的 createPortScanner。
   */
  portScanner: { feed(chunk: string): number[]; flush(): number[] };
  /**
   * 这次启动独有的随机记号,注入进 pty 的环境(`ASH_LAUNCH_ID`)。它被这次启动 fork 出来
   * 的每一个进程继承 —— 双 fork + setsid 的守护进程也带着 —— 于是「端口上坐着的是不是
   * 这次起来的」有了**可核验**的归属证据,而不是时间窗口的推断。只给命令会话发
   * (交互 shell 不长停止按钮,也就没有按端口动手的路);不进 DTO,服务端内部用。
   */
  launchToken: string | null;
  /**
   * pty slave 路径(/dev/ttysN)。leader(wrapper)活着时,按它枚举会话成员(ctty/sid
   * ∪ fd 持有者,见 terminal-process-tree.ts 文件头)就是**确定性**清单 —— 不依赖 ppid
   * 树与采样,disown、独立 PGID、stdio 全重定向都照样在列,terminate/close/shutdown
   * 都用它补抓。node-pty 未暴露进公开类型,拿不到(理论上不会)就退回快照 + 累积。
   */
  ttyPath: string | null;
  /**
   * 端口事实(portsAlive/stop)的**代次**。停止路径核验完会把它 +1,后代扫描那一拍
   * 写回之前要先核对自己取样时的代次 —— 否则一次跨 300ms 的 lsof 探测会在停止之后落地,
   * 把 portsAlive 复活成 true,「我点过停止」当场被覆盖(第 2 轮审查发现 1 的同一类)。
   */
  factsGeneration: number;
};

export type CreateOptions = {
  cols?: number;
  rows?: number;
  shell?: string;
  shellArgs?: string[];
  /**
   * 常用命令模式：不开交互 shell，直接跑这条命令，进程退出会话就结束（exitCode 落在
   * 会话上）。怎么起由 terminal-shell.ts 的 `commandLaunch` 定：POSIX 是
   * `shell -lc <script>`（`-l` 保留 —— dev 命令的 PATH/nvm 全靠登录 shell），
   * Windows 是 PowerShell `-EncodedCommand`。
   */
  command?: { id: string; name: string; script: string };
};

export type TerminalCreation = {
  projectId: string;
  reservation: TerminalReservation;
  controller: AbortController;
  done: Promise<void>;
  finish: () => void;
};
