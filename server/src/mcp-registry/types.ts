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
  /**
   * 别处(通常是宿主机那份**同格式**配置)里 ash 那条登记的**原值**,整个搬过来复用。
   *
   * 为什么返回原值而不是 `{command,args,env}`:投影一遍就丢东西。宿主那条可能是
   * `{"type":"http","url":…,"headers":{…}}`(远程),也可能带 `cwd`/`timeout`/`tools`,
   * 投影成那三位之后「远程」变成「连本机 4317 的 stdio」、启动字段静默消失 ——
   * 本轮审查 R5 在沙盘里实测到的就是这两种。搬得了就一个字节不改地搬,搬不了就老实
   * 用内置那条(`builtinEntry`),**不许把「表达不了」解释成「宿主没有登记」**。
   *
   * 只返回**开着**的那条(关着的搬过去等于把「已关闭」一起搬过去)。
   */
  hostRaw?(text: string): Record<string, unknown> | null;
  /** 把一条原值登记按规范名拼进去(配 `hostRaw`,JSON 两族有)。 */
  composeRaw?(text: string | null, value: Record<string, unknown>): AshMcpCompose;
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
  /**
   * 这家 CLI 的几份来源是「**合起来看、同名键由优先级高的那份赢**」—— 置真表示这件事
   * **已实测**(判定与安装据此按 `effectiveConfigState` 算最终生效的那一条)。
   *
   * 2026-10-31 用真 opencode 实测(本轮审查 R3/F4,逐格记在 catalog 的 `source` 里):
   * 全局那份有 ash、`OPENCODE_CONFIG` 那份没有 ⇒ 照样列出 ash;同名各放一条 ⇒ 变量那份赢;
   * 高优先级那份只写 `{"enabled": false}` ⇒ 真 CLI 报 `ash disabled`;默认目录里 `.json`
   * 和 `.jsonc` **两份都读**;`OPENCODE_CONFIG_DIR` 再加一个目录、优先级高于默认目录;
   * `OPENCODE_CONFIG_CONTENT` 那整段 JSON 优先级最高。
   *
   * 没实测过的家(kilo)**不要**置真:几份来源结论不一致时判定只能回 unknown,猜「合并」会把
   * 没接上说成接上了,猜「取代」会把接上了说成没接上、还要再写一条顶掉它。
   */
  readonly sourcesMerge?: boolean;
  /**
   * 指到**另一个配置目录**、而且优先级高于默认目录的变量(opencode 的 `OPENCODE_CONFIG_DIR`)。
   *
   * 和 `dirEnv` 的区别是它**不取代**默认目录:本轮实测,默认目录那份照样生效,而这个目录里的
   * `enabled = false` 盖得住默认那份的开启。
   */
  readonly altDirEnv?: string;
  /**
   * 整段配置 JSON 直接装在这个变量里(opencode 的 `OPENCODE_CONFIG_CONTENT`)。
   *
   * 它是**只读来源**:优先级最高(本轮实测它能盖掉 `OPENCODE_CONFIG` 文件里的 enabled),
   * 但没有文件可写 —— 只有它里面有 ash 时,判定必须是 present、而且一个字都不许写
   * (上一版判 absent 还去改全局文件)。
   */
  readonly contentEnv?: string;
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
  /**
   * 同一个配置目录里这家 CLI **也会读、而这个格式族读不了**的文件(trae 的原生
   * `traecli.yaml` 和它那两个 `mcp.yaml`)。存在就两件事都不做:
   *
   *  · 判:答 unknown —— 用户完全可能把 ash 写在那里面,「我们读不了」不是「没有」;
   *  · 写:不写 —— 同名登记同时出现在两个来源,谁生效没有文档依据(trae 只写了「项目级
   *    更近者优先」),而两份里有一份是我们看不见的。
   */
  readonly opaque?: readonly (readonly string[])[];
}

/** 证据等级:本机真 CLI 验过,还是只按官方文档写。 */
export type AshMcpEvidence = "tested" | "docs";

/** 回合身份(`@ash/shared/mcp` 的 `ASH_TURN_IDENTITY_ENV`)怎么进 MCP 子进程。 */
export type AshMcpIdentity =
  /** CLI 把自己的环境原样(或只按名字黑名单)传给 MCP 子进程 —— ash 起跑时注进去就够了。 */
  | "inherit"
  /** CLI 过滤子进程环境,必须在登记里声明放行哪几个变量(codex 的 `env_vars`)。 */
  | "declare"
  /**
   * CLI 过滤子进程环境,而登记里那个位置**只收字面值**(copilot:文档明写只自动继承
   * `PATH`,其余要写死在 `env` 里)—— 回合 token 一轮一个,写死就是过期的假身份。
   *
   * 这一档的意思是「登记写对了也交不了卷」,所以必须配 `caveat` 当场说出来:ash 送不进
   * 回合身份,用户只能自己换个接法。**在 ash 给出 `PATH` 那条通路之后,这一档空着** ——
   * 留着是因为判据还在:下一家 CLI 若连 `PATH` 都过滤,它就该落这一档。
   */
  | "blocked"
  /**
   * CLI 只把 `PATH` 自动交给 MCP 子进程(copilot 文档原文),于是身份改走**文件**:
   * ash 每回合开一个一次性目录、把 `identity.json` 放进去、把目录追加到 `PATH` 末尾,
   * MCP 侧在变量都不在时读它。约定与四条安全要点见 `@ash/shared/mcp` 的
   * `ASH_TURN_IDENTITY_PATH_DIR`,两侧实现在 `server/src/turn-identity.ts` 与
   * `mcp/src/runtime.ts`。
   *
   * 这一档**不需要在登记里写任何东西**(写进 `env` 的只有静态的 `ASH_URL`)。
   */
  | "path"
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
     * JSON 族:那条登记里 `type` 写什么值(不写这一项就不带 `type`)。
     *
     * **值按各家文档照抄,不许套用**:cursor 文档说 stdio 这条 `type` 必填、claude 自己
     * `mcp add` 写出来的也是 `"stdio"`;而 copilot 的本地服务在文件里叫 `"local"`
     * (它的 `--transport stdio` 是命令行那一侧的拼法,两边不同名)。其余几家实测/文档都
     * 不要求,就不写 —— 多塞一个字段进别人的 schema 是在赌它宽松。
     */
    writeType?: string;
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
