import type { ChildProcess } from "node:child_process";
import type { AgentEvent, AgentType } from "@ash/shared";
import type { RunTracePaths } from "../diagnostics.js";
import type { AgentExecutor, ExecutorBuildOpts, RelayConfig } from "../types.js";

// ── 智能体目录的单一真相来源 ────────────────────────────────────────────────
// 一个 CLI 一个 spec 文件,同时喂三条链路:
//   ① 检测与展示(detect.ts:which / --version / 安装命令 / 文档链接)
//   ② 派任务时的命令行构造(GenericCliExecutor)
//   ③ 会话恢复命令的展示(executors/resume.ts)
// 新增/删除一个智能体只有两步:shared 的 AGENT_TYPES 加/删一个字符串,这个目录
// 加/删一个 spec 文件。别在第三个地方另抄一张名单 —— 那是漂移的唯一来源。

/** 值型 flag:model / reasoning-effort 这类「有值才带」的参数。 */
export interface CliValueFlag {
  /** flag 名,如 `--model` / `-m`。 */
  flag: string;
  /** 值与 flag 的拼法。`space`(默认)= 两个 argv 项;`equals` = `--model=x` 一项。 */
  style?: "space" | "equals";
}

/**
 * 值型参数的产出方式。给不了「一个 flag 一个值」的(codex 的
 * `-c model_reasoning_effort="high"`)直接给函数,自己返回整段 argv。
 */
export type CliValueArgs = CliValueFlag | ((value: string) => string[]);

/** prompt 怎么交给 CLI。 */
export interface CliPromptSpec {
  /**
   * `stdin`:写进 stdin 后关掉(最稳:大 prompt 不撞 argv 长度上限,也不用转义)。
   * `arg`:作为最后一个位置参数。
   * `flag`:作为某个 flag 的值(`-p "<prompt>"`)。
   */
  via: "stdin" | "arg" | "flag";
  /** `via:"flag"` 时的 flag 名。 */
  flag?: string;
  /** `via:"stdin"` 且该 CLI 需要一个占位位置参数表示「从 stdin 读」(codex 的 `-`)。 */
  stdinArg?: string;
}

/** 会话延续方案。整个字段缺省 = 该 CLI 没有已知的 resume 通道。 */
export interface CliSessionSpec {
  /**
   * ash 自己生成 sessionId 并用这个 flag 告知 CLI(claude 的 `--session-id`)。
   * 缺省 = sessionId 由 CLI 自己产生,只能靠 parser 发 `{kind:"session"}` 带回来。
   */
  newIdFlag?: string;
  /**
   * 无头续跑同一会话的 argv 片段。缺省 = 不支持无头续跑,ash 会忽略
   * `RunOpts.sessionId` 并起一个全新会话(诚实降级,不假装接上了)。
   * 插入位置:subcommand 与 baseArgs 之后、其余 flag 之前。顺序凑不出来的
   * (codex 那种 `exec <flags> resume <id>`)请改用自定义 factory。
   */
  resumeArgs?: (sessionId: string) => string[];
  /**
   * 给人复制粘贴的**交互式**恢复命令(不带 `cd` 前缀,resumeFor 会包)。
   * 缺省 = 会话详情里不给恢复命令,只给一句诚实说明。
   */
  interactive?: (sessionId: string) => string;
}

/** 供应商(§5)注入方式。缺省 = 该 CLI 还没接 relay,挂了供应商也走官方账号。 */
export interface CliRelayWiring {
  /** 只走进程环境的变量。**密钥只能出现在这里**,绝不进 argv。 */
  env: Record<string, string>;
  /** 需要额外带的 argv(只放变量名之类的非密文,如 codex 的 `env_key`)。 */
  args?: string[];
  /** 恢复命令要带的 env 前缀,token 已换成 `<你的key>` 占位符。 */
  envHint: string;
}

export interface CliParserContext {
  child: ChildProcess;
  /** 实际起的命令名,报错文案用。 */
  bin: string;
  /** 执行器展示名(`gemini@local·pro`),报错文案用。 */
  label: string;
  trace?: RunTracePaths;
  /** 手停标记:`kill()` 会把它置 true,parser 据此不把「被杀」报成故障。 */
  lifecycle: { stopRequested: boolean };
}

/** 输出解析器:把 CLI 的 stdout 变成事件流。缺省用 parsers.ts 的 textParser。 */
export type CliParser = (ctx: CliParserContext) => AsyncIterable<AgentEvent>;

/**
 * 「问这个 CLI 自己现在有哪些模型」的命令。缺省 = 该 CLI 没有(或还没实测出)清单命令,
 * 模型候选只能退回 shared 的 `CLI_MODEL_PRESETS` 这份发版快照(必然滞后)。填了它,
 * `GET /agents/models` 才会现问 CLI,界面上的「刷新」也才有东西可刷。
 *
 * **只在本机实测过输出格式再填**:解析器按猜的写,失败是静默的(解析出空数组 → 悄悄
 * 退回快照),比不填更难查。没实测就把线索写进 `notes`。
 */
export interface CliModelsSpec {
  /** 查询用 argv,如 `["models"]`、`["--list-models"]`。 */
  args: string[];
  /** 默认 10s。登录态查询多半要一次网络往返,给够;卡住不该拖垮请求。 */
  timeoutMs?: number;
  /**
   * stdout(+stderr)→ 模型 id 清单。**解析不出来就返回空数组**,由上层如实降级到快照,
   * 别硬凑或抛异常。`defaultModel` 是 CLI 报告的默认值(会被排到候选首位),没有就省略。
   */
  parse: (stdout: string, stderr: string) => { models: string[]; defaultModel?: string | null };
}

/** 非交互一次性运行的命令构造。 */
export interface CliExecSpec {
  /** 一次性非交互运行的子命令,如 codex 的 `["exec"]`;多数 CLI 直接跟 flag。 */
  subcommand?: string[];
  /** 每次运行都带的固定 flag:非交互 / 自动批准工具 / 输出格式等。 */
  baseArgs?: string[];
  prompt: CliPromptSpec;
  /** 模型参数。缺省 = 该 CLI 不支持指定模型,profile 上配的 model 只用于展示。 */
  model?: CliValueArgs;
  /** 思考强度参数。缺省 = 该 CLI 没有这个概念。 */
  reasoningEffort?: CliValueArgs;
  /** 1.5x 加速档要带的 argv。缺省 = 该 CLI 无此概念,忽略 profile 上的 speed。 */
  fastArgs?: string[];
  session?: CliSessionSpec;
  /** 输出解析。缺省 = 保守的 textParser(stdout 逐行转 assistant 文本)。 */
  parser?: CliParser;
  relay?: (relay: RelayConfig) => CliRelayWiring;
}

/** 检测与展示用的字段(会原样出现在 `/agents/catalog` 响应里)。 */
export interface CliCatalogEntry {
  /** 稳定标识,同时就是 AgentType;前端拿它做 key(bin 会变,见 cursor)。 */
  key: AgentType;
  name: string;
  /** 中文一句话,卡片副标题。 */
  description: string;
  /**
   * 候选命令名,按顺序探测,第一个探到的算数。
   * 多个是为了官方改过 bin 名又留了兼容别名的情况(cursor)。
   */
  bins: string[];
  /**
   * 只对 `bins[0]` 之外的**备用**命令名生效的自证要求:`--version` 输出里必须
   * 含这个词(不区分大小写)才认。备用名常常很通用 —— cursor 官方现在的 bin 就叫
   * `agent`,本机实测 `which agent` 命中的其实是 grok,不设这道卡就会把别家的
   * 命令连版本号一起认成它。主 bin 不设卡,免得哪家改了版本号文案就漏检。
   */
  fallbackVersionMatch?: string;
  docsUrl: string;
  /** 官方安装命令原文(POSIX 侧)。只给用户复制,**服务端永不执行**。 */
  installCommand: string;
  /**
   * Windows 上的安装命令。`detect.ts` 按**宿主平台**在这两条里挑一条发给前端,所以
   * 界面上永远只出现「这台机器上能用的那条」——半数 CLI 的 `installCommand` 是
   * `curl … | bash`,原样端给 Windows 用户就是一条注定跑不通的命令。
   *
   * 三种取值:
   *  · 不写   = `installCommand` 本身就跨平台(`npm install -g …` 那种),两边同一条;
   *  · 字符串 = Windows 专用那条(PowerShell / winget / choco …),官方原文照抄;
   *  · `null` = 官方没有 Windows 版。此时目录发出去的安装命令是空串,前端据此标
   *             「本平台不可用」,理由取 `windowsNote` —— 别让用户装完才发现。
   */
  installCommandWindows?: string | null;
  /**
   * Windows 上的前提或限制,一句话(「只支持 Win11」「要先装 Git for Windows」)。
   * 只在 Windows 宿主上发给前端。`installCommandWindows: null` 时这里写的就是
   * 「为什么没有」,是用户看到的唯一理由,别留空。
   */
  windowsNote?: string;
  /**
   * true = 执行部分(exec)**按官方文档写、本机未实测**。前端据此打标,用户
   * 心里有数;B 阶段实测校准后把它去掉。检测部分(bins 等)另有注释交代来源。
   */
  untested?: boolean;
  /** 未定的点、踩过的坑、需要实测确认什么 —— 一句话写清楚,别留空猜。 */
  notes?: string;
}

/** 一个 CLI 的完整 spec。 */
export interface CliSpec extends CliCatalogEntry {
  exec: CliExecSpec;
  /**
   * 「现问这个 CLI 有哪些模型」的命令(见 CliModelsSpec)。缺省 = 只有内置快照。
   * 它跟 `exec` 是两回事:`exec` 是派活时怎么起进程,这个是**只读查询**,由
   * `executors/model-probe.ts` 直接跑,不进任务时间线、不写会话。
   */
  models?: CliModelsSpec;
  /**
   * 自定义执行器。有 factory 就完全由它接管(claude 的常驻会话、codex 的诊断
   * 链路都在专用类里),此时 `exec` 只作说明与 resume 展示之用;没有 factory
   * 就由 GenericCliExecutor 按 `exec` 装配命令行。
   */
  factory?: (opts: ExecutorBuildOpts) => AgentExecutor;
}

/** 把 CliValueArgs 落成 argv。 */
export function valueArgs(spec: CliValueArgs | undefined, value: string | undefined): string[] {
  if (!spec || !value) return [];
  if (typeof spec === "function") return spec(value);
  return spec.style === "equals" ? [`${spec.flag}=${value}`] : [spec.flag, value];
}
