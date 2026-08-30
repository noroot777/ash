import type { ChildProcess } from "node:child_process";
import type { AgentEvent, AgentType } from "@ash/shared";
import type { RunTracePaths } from "./diagnostics.js";
import type { DetachedPaths } from "./detached.js";

export interface RunOpts {
  prompt: string;
  cwd: string;
  sessionId?: string; // resume an existing CLI session
  model?: string;
  extraArgs?: string[];
  trace?: RunTracePaths;
  // 只作用于这一回合的进程环境（例如 ASH_TURN_TOKEN）；真实值不得拼进 commandLine。
  env?: Record<string, string | undefined>;
  // 非空 = 用「活得过 server 重启」的跑法：stdout/stderr 落到这几个文件而不是
  // 匿名管道（见 executors/detached.ts）。只有一次性 run() 该传；常驻会话
  // （openResident）必须保留可写的 stdin，不适用。
  detach?: DetachedPaths;
}

// A planned invocation: the resolved session id + exact command, plus a live
// event stream. The orchestrator records sessionId/commandLine for traceability
// before/while consuming the stream. `kill` terminates the
// underlying subprocess (manual stop) — the stream then ends like a normal exit.
export interface RunHandle {
  sessionId: string;
  commandLine: string;
  events: AsyncIterable<AgentEvent>;
  kill(): void;
  // 单飞当前回合的原生引导通道。存在时调用方把新 user 消息送进同一个活动回合，
  // 不结束任务、不释放单飞锁；回合自然结束后这根通道随 RunHandle 一起关闭。
  steer?(text: string, beforeSend?: () => void | Promise<void>): Promise<void>;
  /** 事件流结束后回收 CLI 甩出去的后台后代；没有真实进程的失败句柄可省略。 */
  cleanup?: () => Promise<void>;
  // 只有走了 detach 的这一轮才有：agent 的 pid + 已消费到的字节位置。
  // 调用方把它们存进 sessions，重启后据此找回并接管这个还活着的进程。
  detached?: { pid: number; committed: () => number };
}

// 挂在执行器上的供应商(§5)。非空时启动 CLI 前注入 base_url + key,顶掉 CLI
// 自己的官方登录账号。baseUrl 恒为根地址(不含 /v1),各 executor 按需自行补路径。
export interface RelayConfig {
  providerId: string;
  name: string;
  baseUrl: string;
  apiKey: string;
  defaultModel: string;
  protocolConversionEnabled: boolean;
  context1mModels: string[];
}

// 常驻会话(§Team 的调度台):一个**会话**吃多个回合,会话全程同一个。
// 跟 RunHandle 的区别只有两点 —— events 不会因为「一个回合说完」而结束(那是
// {kind:"turnEnd"}),以及多了 send/interrupt/close 这几根注入管子。
// 注意契约说的是「会话不断」而不是「进程不断」:claude 靠一个不退的进程做到,
// codex 靠 `exec resume <thread_id>` 一回合一进程做到,对调用方是一样的。
export interface ResidentHandle {
  sessionId: string;
  commandLine: string;
  events: AsyncIterable<AgentEvent>; // 直到 close()/kill() 才结束
  /**
   * 注入一条 user 消息(即时,无 tick)。
   *
   * **返回值 = 这个进程收下了没有**,调用方必须看:false 代表这条消息一个字都没进去
   * (进程正在收尾、stdin 已经关掉),而不是「稍后会处理」。团队调度台把执行者汇报攒在
   * 内存里等回合收尾合并投递,拿不到这个回执就只能假定送到了 —— 一次拒收就是一份执行
   * 结果或一个待回答的提问无声消失(2026-08-26 第 11 轮审查)。
   */
  send(text: string): boolean;
  // 打断正在跑的回合。claude 的 stdin 注入是「排到回合结束才处理」,所以用户
  // 插话要先 interrupt 再 send 才有 codex 那种当场转向的手感(见 team/session.ts)。
  // codex 侧没有原生打断,interrupt 就是杀掉当前回合的进程。
  interrupt(): void;
  /** 单飞原生引导可选的可确认写入；至少保证 interrupt 与新消息都被 stdin 接受。 */
  steer?(
    text: string,
    onInterrupted?: () => void,
    beforeSend?: () => void | Promise<void>,
  ): Promise<void>;
  /** 忘掉恢复 id；Codex 常驻的下一回合会 fresh，进程级常驻执行器可不实现。 */
  dropSession?(): void;
  close(): void; // 优雅收尾:关 stdin,等它自己退出
  kill(): void; // 硬杀,走 killChild 三层击杀
  /** 单飞适配器收流后继续清理 CLI 遗留的后台后代。 */
  cleanup?: () => Promise<void>;
}

// 从执行器 profile(agents 表一行)解析出来的构造参数 —— 单点在
// executors/index.ts 的 build(),专用类(claude/codex)与 GenericCliExecutor
// 都吃同一个形状,所以目录里的 factory 可以直接挂进来。
export interface ExecutorBuildOpts {
  /** profile 名,直接当 label(缺省时各执行器自己拼 `type@where·model`)。 */
  name?: string;
  model?: string;
  extraArgs?: string[];
  reasoningEffort?: string;
  speed?: "fast";
  /** 覆盖默认命令名(缺省用 spec.bins[0])。 */
  bin?: string;
  /** 预检已经确认无法启动时，由执行器走 failedChild 留下持久错误，不再起真实 CLI。 */
  startupError?: string;
  relay?: RelayConfig;
  /**
   * 盖过 CLI 自己配置文件的那几项(以 env 注入)。已按 @ash/shared/cli-overrides
   * 的声明归一过,执行器直接 `cliConfigOverrideEnv()` 落成环境变量即可。
   */
  configOverrides?: Record<string, number>;
}

/**
 * 「复制到终端接着聊」那条命令的**全部依据**,一次给齐。三样东西同源同时算出来:
 *   · resumeCommand —— 直接能粘的整条命令
 *   · resumeEnv     —— 存进 `sessions.resume_env`:供应商 key 占位符
 *   · resumeArgs    —— 存进 `sessions.resume_args`:跟在 CLI 后面的参数
 *                      (claude 的 `--settings '{…}'`)。盖掉 CLI 配置文件的那几项走
 *                      这里而**不是** env 前缀:CLI 会把各层 settings 的 env 写回自己的
 *                      进程环境,前缀那份打不过用户的 settings.json(第 2 轮审查 finding 2)。
 *
 * 为什么是一个方法而不是三个字段:
 *   ① 这三样**必须同时落库**。读取端 `resumeCommandFor` 是拿 resume_env + resume_args
 *      重算命令的,少刷新一列就给出一条跑不起来的恢复命令 —— 第 2 轮 finding 6 就是
 *      duet 复用 session 行时漏掉了其中两列。
 *   ② `--settings` 的内容**跟会话 cwd 有关**(项目那几层 settings 文件参与换算),所以
 *      cwd 是必填参数。先前它是构造器里算好的字段,executor 建出来时还不知道要在哪个
 *      目录跑,于是 ash 自己带着项目层的值跑、复制出来的命令却少了那一截,两边压缩
 *      水位差着几千 token(第 3 轮审查 finding 2)。签名里要 cwd,这个错就编译不过。
 */
export interface ResumeFields {
  resumeCommand: string;
  resumeEnv: string | null;
  resumeArgs: string | null;
}

// Hand-rolled adapter (no Vercel AI SDK). Each CLI type gets
// one implementation that knows its flags, stream-json format, and resume scheme.
export interface AgentExecutor {
  readonly type: AgentType;
  readonly label: string; // e.g. "claude@local·opus"
  readonly model?: string;
  readonly reasoningEffort?: string;
  run(opts: RunOpts): RunHandle;
  // 单飞专用的可引导运行。没有这项的执行器继续走 run()，用户点「引导会话」时由
  // 上层沿用 kill + resume 降级；它不等于团队常驻，也不影响 openResident 的筛选。
  runSteerable?(opts: RunOpts): RunHandle;
  // 重启后接管一个**还活着**的 agent 进程：把它的输出流接回本执行器自己的
  // parser。child 是 detached.ts 造的合成 ChildProcess（按 pid+offset 接回来的）。
  // 不实现 = 该执行器不支持接管，重启对它仍是「这一轮被打断」。
  // 放在接口上而不是让调用方按 agentType 去 switch parser —— 那等于在第三个
  // 地方再抄一张 CLI 名单（见 server/CLAUDE.md「执行器与模型」）。
  // configDir = 那个进程当初起跑时用的 CLI 配置目录(多用户模式下的个人 CODEX_HOME);
  // 接回来读它自己的私有产物(codex 的 rollout 水位)要去同一个目录。
  attach?(child: ChildProcess, opts: { sessionId: string; commandLine: string; configDir?: string | null }): RunHandle;
  // 常驻会话。两种实现形态,契约相同(events 只在 close/kill 后结束):
  //   • claude = **进程级**常驻,一个进程吃多个回合(stdin 双向注入)
  //   • codex  = **会话级**常驻,每回合一个 `exec resume <thread_id>` 进程
  //     (它没有 stdin 注入通道;取舍见 executors/codex-resident.ts)
  // GenericCliExecutor 一律留 undefined —— 团队模式的「调度者」下拉据此过滤(§Team)。
  openResident?(opts: RunOpts): ResidentHandle;
  // Build the ready-to-paste resume command for a finished session (§13).
  resumeCommand(cwd: string, sessionId: string): string;
  // 同一条命令 + 它落库要用的两列。写 sessions 行的地方一律整组 spread 这个返回值,
  // 别再一列一列摘(见 ResumeFields)。
  resumeFields(cwd: string, sessionId: string): ResumeFields;
}
