// ash MCP 登记能力表的类型(单一真相来源的形状定义)。
//
// 为什么要有这一层:ash 的完成协议整个建立在 ash MCP 上(`complete_task` / `ask_question` /
// `pause_task` / `report_stage`),而「怎么把 ash 这一条登记写进某家 CLI 的配置」原先只有
// claude 和 codex 两份**孤岛实现**(`auth/user-cli-mcp.ts` 里两条 if、`scripts/setup.mjs` 里
// 三段 if)。执行器目录里另外十三家一行注册逻辑都没有 —— 用户 2026-10-30 实测:换别的 agent
// 跑任务,MCP 调不到、卷交不了,而界面上只看得到「失败」。
//
// 所以这里把「每家 CLI 的 MCP 机制」收成一张表:**一家一条声明**,格式族只有三种
// (见 `shapes.ts`),读/写/判都由格式族统一实现。新增一家执行器时 `satisfies Record<AgentType,…>`
// 会**编译不过**,逼着当场给出结论(支持哪条路、还是明确标 none),不许沉默跳过 —— 沉默正是
// 这条链一直在修的那个病。
import type { AgentType } from "@ash/shared";

/** 一条 ash MCP 登记的内容(格式族各自渲染成 JSON / TOML)。 */
export interface AshMcpEntry {
  /** 启动命令,一律 node(我们这份 MCP 服务是 JS)。 */
  command: string;
  /** 参数,通常是 `[<repo>/mcp/dist/index.js]`。 */
  args: string[];
  /** 进程环境:至少有 ASH_URL。 */
  env: Record<string, string>;
}

/** 配置文件里 ash 这条登记的状态。三态加一个「关着」,判据见各格式族的 `read`。 */
export interface AshMcpConfigState {
  /**
   * present=登记在且没关 / absent=确实没有 / disabled=登记在但显式关掉了 /
   * unknown=读不出来或写法判不了,**别据此下结论**。
   */
  state: "present" | "absent" | "disabled" | "unknown";
  /** present/disabled 时命中的服务名(可能是历史名 harness)。 */
  serverName: string | null;
  /** 给用户看的一句话(absent/disabled/unknown 时必填)。 */
  detail: string;
}

/** 「这条登记怎么起」—— 只拿来出提示,不参与拦/放(见 `ash-mcp-file.ts` 的 `launchHint`)。 */
export interface AshMcpLaunch {
  command?: string | null;
  args?: unknown;
  ashUrl?: string | null;
}

/** 拼的时候这家 CLI 要的那两个可选修饰(来自 `AshMcpMechanism` 的同名字段)。 */
export interface AshMcpComposeOpts {
  /** TOML 族:带上 `enabled = true`。 */
  enabled?: boolean;
  /** JSON 族:带上 `"type": "stdio"`。 */
  type?: string;
}

/** 拼一段新内容出来:给 body 就是可以发布,给 why 就是**不能自动补**(原因原样交给用户)。 */
export type AshMcpCompose = { body: string } | { why: string };

/**
 * 一个格式族(JSON 的 `mcpServers`、opencode 的 `mcp`、TOML 的 `[mcp_servers.x]`)。
 *
 * 四个动作刻意都是**纯函数**:入参是配置全文,出参是结论或新全文。读写事务(确认读到过、
 * 就地写、写完读回来比对)统一在 `auth/config-publish.ts`,格式族一律不碰文件系统 ——
 * 十五家各自一份「读改写」就是十五处可以漏掉文件身份保全的地方。
 */
export interface AshMcpShape {
  /** 格式族名字,出现在矩阵和报错文案里。 */
  readonly id: "mcp-servers-json" | "opencode-json" | "mcp-servers-toml";
  /** 这份配置里 ash 登记的状态。`text === null` = 确认没有这个文件。 */
  read(text: string | null): AshMcpConfigState;
  /** 把 ash 这一条拼进去(已有一律不覆盖 —— 调用方先 `read` 过)。 */
  compose(text: string | null, entry: AshMcpEntry, opts?: AshMcpComposeOpts): AshMcpCompose;
  /** 别处(通常是宿主机那份同格式配置)里 ash 那条登记的定义,搬过来复用。 */
  hostEntry?(text: string): AshMcpEntry | null;
  /**
   * 「整段原文照搬」那一路,只有 TOML 族有(下面三位要么都有、要么都没有)。
   *
   * 为什么 TOML 不走 `hostEntry`:宿主那条登记底下可能挂着子表(本机实测
   * `[mcp_servers.ash.tools.get_task] approval_mode = "approve"`),拆成
   * `{command,args,env}` 再拼回去会把它们丢掉。照搬原文一个字节都不丢。
   */
  hostBlock?(text: string): string | null;
  /** 没有宿主那段可搬时,按一条登记现渲染一段。 */
  blockFor?(entry: AshMcpEntry, opts?: AshMcpComposeOpts): string;
  /** 把一段登记原文接进配置(重复表、内联表这些判据跟 `compose` 同一份)。 */
  appendBlock?(text: string | null, block: string): AshMcpCompose;
  /** 这条登记写的启动方式,只给 `launchHint` 出提示。 */
  launch(text: string | null): AshMcpLaunch | null;
}

/** 这家 CLI 的配置目录由哪个环境变量指定、文件落在目录里的哪一层。 */
export interface AshMcpConfigSite {
  /**
   * 「整体取代配置目录」的环境变量名(claude 的 `CLAUDE_CONFIG_DIR`、codex 的 `CODEX_HOME`、
   * grok 的 `GROK_HOME`…)。null = 这家没有已知的等价变量,只有宿主机默认目录那一份。
   *
   * **宿主机那一份也必须尊重它**:变量由 ash 进程原样继承给子进程,CLI 认的就是它 ——
   * 写死 `homedir()` 会两头都错(实际目录有登记却报缺失;默认目录有登记而实际目录没有时
   * 又漏报)。
   */
  readonly dirEnv: string | null;
  /**
   * `dirEnv` 指向的是**配置文件**而不是目录(opencode 的 `OPENCODE_CONFIG`)。
   * 这种写法下 `relative` 对它不适用。
   */
  readonly dirEnvIsFile?: boolean;
  /** 宿主机默认配置目录(`dirEnv` 没设时用它)。XDG 之类的分支写在这里面。 */
  readonly defaultDir: (env: NodeJS.ProcessEnv, home: string) => string;
  /** 配置文件相对配置目录的位置(`["config.toml"]`、`[".gemini","settings.json"]`)。 */
  readonly relative: readonly string[];
  /**
   * 这家 CLI 还会读的**项目级**配置(相对任务目录)。只给判据那一档用:这些文件里只要
   * 提到 MCP,「用户级没有」就不再是个确定的结论 —— 按「向放行开」答 unknown,别拿
   * 一份看不全的证据拦下一整轮审查(`ash-mcp-file.ts` 文件头)。ash 永远不写它们:
   * 那是用户仓库里的文件,会被提交进去。
   */
  readonly projectRelative?: readonly (readonly string[])[];
  /**
   * 同样合法的其它文件名(opencode 的 `opencode.jsonc`)。**存在哪个就读写哪个**,
   * 一个都不存在才按 `relative` 新建 —— 否则会在用户已有的 `.jsonc` 旁边多出一份
   * `.json`,两份都被 CLI 认,到底生效哪个说不清。
   */
  readonly alternates?: readonly (readonly string[])[];
}

/** 证据等级:本机真 CLI 验过,还是只按官方文档写。 */
export type AshMcpEvidence = "tested" | "docs";

/** 回合身份(`@ash/shared/mcp` 的 `ASH_TURN_IDENTITY_ENV`)怎么进 MCP 子进程。 */
export type AshMcpIdentity =
  /** CLI 把自己的环境原样(或只按名字黑名单)传给 MCP 子进程 —— ash 起跑时注进去就够了。 */
  | "inherit"
  /** CLI 过滤子进程环境,必须在登记里声明放行哪几个变量(codex 的 `env_vars`)。 */
  | "declare"
  /** 还没验过。按 inherit 走(多数 CLI 如此),矩阵里如实标出来。 */
  | "unknown";

/** 这家 CLI 的 ash MCP 机制。 */
export type AshMcpMechanism =
  | {
    kind: "file";
    shape: AshMcpShape;
    site: AshMcpConfigSite;
    identity: AshMcpIdentity;
    /** 身份这一路上的坑(谁按名字过滤、要靠哪套别名才过得去),原样进矩阵。 */
    identityNote?: string;
    evidence: AshMcpEvidence;
    /** TOML 族:写进去的那段要不要带 `enabled = true`(跟着该 CLI 自己 `mcp add` 的写法)。 */
    writeEnabled?: boolean;
    /**
     * JSON 族:那条登记里要不要带 `"type": "stdio"`。
     *
     * 两个方向都有真实后果:cursor 的文档说这一条**必填**;claude 自己 `mcp add` 写出来的
     * 就带着它(不带的话同一份文件里两种写法并存,看上去像被谁改过)。其余几家实测/文档都
     * 不要求,就不写 —— 多塞一个字段进别人的 schema 是在赌它宽松。
     */
    writeType?: boolean;
    /** 依据出处(官方文档链接 / 本机实测记录),原样进矩阵。 */
    source: string;
    /** 已知的坑、未确认的点。`evidence:"docs"` 时必填(回归测试会拦)。 */
    notes?: string;
    /**
     * **必须当场说给用户听**的那一句(进起跑提示和预检文案)。
     *
     * `notes` 是给改代码的人看的,这一句是给「任务为什么交不了卷」的用户看的 —— 判据只有
     * 一条:**知道这条登记可能写了也不生效**(pi 老版本压根没有 MCP、kiro 的 CLI 路径没验过)。
     */
    caveat?: string;
  }
  | {
    /** 有 MCP 机制,但 ash **不自动写**(格式我们没有安全的写入器,如 trae 的 YAML 数组)。 */
    kind: "manual";
    /** 一句话说清:登记写在哪、怎么写(用户看到的唯一指引)。 */
    howTo: string;
    evidence: AshMcpEvidence;
    source: string;
    notes?: string;
  }
  | {
    /** 这家 CLI 压根没有 MCP 机制 —— 它当不了需要交卷的执行器。 */
    kind: "none";
    /** 为什么没有(实测依据或文档依据),预检拒绝时原样说给用户。 */
    why: string;
    evidence: AshMcpEvidence;
    source: string;
  };

export type AshMcpTable = Record<AgentType, AshMcpMechanism>;
