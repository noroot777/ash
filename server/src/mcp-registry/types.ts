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

/**
 * 一个兼容名(`ash` / 历史名 `harness`)在**一份**配置里的事实 —— 刻意**不折叠**。
 *
 * 为什么要有这一层(本轮审查 F3):`ash` 和 `harness` 是**两条独立登记**,一条关着、另一条
 * 开着时 ash MCP 是能用的。上一版每份来源先压成一个四态结论,再按来源优先级选赢家 ——
 * 两个名字的事实在第一步就被混成了一个,于是「高优先级那份里 ash 关着、低优先级那份里
 * harness 开着」被判成 disabled(预检硬拒),而真 CLI 那边工具明明连得上。
 */
export interface AshMcpNameFact {
  /** on=登记在且没关 / off=显式关掉了 / doubt=写法认不出来(**别据此下结论**)。 */
  readonly status: "on" | "off" | "doubt";
  /** 给用户看的一句话(off/doubt 必填)。**不带来源前缀** —— 前缀由消费者按来源加。 */
  readonly detail: string;
  /**
   * 这条登记**在这份来源里真正贡献的那些字段**,整条搬给隔离档用。
   *
   * **跨来源的逐字段合并也靠它**(`AshMcpShape.mergeFacts`):几份来源各写了同一个名字时,
   * CLI 最终用的是它们合起来那一条,所以 `status` / `launch` 都必须从**合完的原值**上重算,
   * 不能从某一份的结论上取。有 `raw` 还意味着「这一份的写法认得出来、能参与合并」——
   * `status: "doubt"` 而**不带** `raw` 的那种(值根本不是对象、或者少到让 CLI 整份拒载)
   * 一合就只能继续 doubt。
   *
   * 「真正贡献」不是「原文照抄」(本轮审查 F1-A):有些 schema 会**按写法丢字段** ——
   * opencode 的条目是三支并集,没写 `type` 的那一支只认 `enabled`,同时写的 `command` /
   * `environment` 真 CLI 一律丢掉。所以投影在逐条判据里就做掉(见 `shapes.ts` 的
   * `opencodeFact`),合并两边因此一视同仁;上一版只在「高优先级那份」上投影、最低那份原值
   * 照抄,于是那些本该被丢掉的字段被合进了有效登记,搬进隔离档后把一条连得上的登记搬成
   * 连不上的(`MCP error -32000: Connection closed`)。
   */
  readonly raw?: Record<string, unknown>;
  /** 这条登记的原文(TOML 族),整段搬给隔离档用。 */
  readonly block?: string;
  /** 这条登记写的启动方式,只给 `launchHint` 出提示。 */
  readonly launch?: AshMcpLaunch | null;
}

/**
 * **一份**配置扫出来的「每个兼容名各自的事实」。
 *
 * 折叠成四态是 `shapes.ts` 的 `foldScan`,跨来源逐名解析是 `register.ts` 的 `resolveAshMcp` ——
 * 读状态、幂等判断、宿主搬运、诊断提示全部消费同一个选中结果,不许各自再选一遍。
 */
export interface AshMcpNameScan {
  /** 整份读不准(解析不了、登记容器不是对象…):它声明了哪些名字也就谈不上。 */
  readonly doubt?: string;
  /** 确认没有这份配置(文件不存在 / 正文空白)。 */
  readonly missing?: boolean;
  /** **声明过**的那几个兼容名(没声明的不出现)。 */
  readonly names: ReadonlyMap<string, AshMcpNameFact>;
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
  /**
   * 这份配置里**每个兼容名各自**的事实。`text === null` = 确认没有这个文件。
   *
   * 读那一侧的**唯一**族内实现:`read` / `hostRaw` / `hostBlock` / `launch` 全是它折一下或
   * 投影一下(见 `shapes.ts` 的 `readSide`)。各写一遍就会漂 —— 本轮审查 F3 实测到的那次:
   * `hostBlock` 按名字固定先挑 `ash`,`read` 挑**开着**的那条,于是 `ash` 关着、`harness`
   * 开着时,搬过去的是那条关着的。
   */
  scan(text: string | null): AshMcpNameScan;
  /** 这份配置里 ash 登记的状态(= `scan` 折一下)。`text === null` = 确认没有这个文件。 */
  read(text: string | null): AshMcpConfigState;
  /** 把 ash 这一条拼进去(已有一律不覆盖 —— 调用方先 `read` 过)。 */
  compose(text: string | null, entry: AshMcpEntry, opts?: AshMcpComposeOpts): AshMcpCompose;
  /**
   * 同一个名字在**几份来源**里各有一条时,合起来是哪一条 —— 只有**实测过合并语义**的格式
   * 族有(本轮审查 F1)。`lower` 是优先级低的那份,`higher` 是高的那份,按升序两两折叠;
   * `name` 只用来拼那句给用户看的话。
   *
   * 为什么非得是「合并」而不是「选一份赢家」(2026-10-31 真 opencode 实测):全局那份写着
   * 完整的启动命令和环境变量、`OPENCODE_CONFIG` 那份只写 `{"enabled": true}` 时,真 CLI
   * 用的是**两份合起来**那一条(`ash connected`)。上一版只取赢家那一份的原值,于是搬进
   * 隔离档的只有 `{"enabled": true}` —— 注册报成功,而那份档里真 CLI 打印
   * `No MCP servers configured`,agent 一个 ash 工具都没有。
   *
   * 这一位在不在是**格式**的事(这种写法怎么合),站点上的 `sourcesMerge` 是**那家 CLI**
   * 的事(它到底会不会把几份读到一起)。两个都成立才真的合 —— kilo 跟 opencode 同格式、
   * 但没有真 CLI 可问,所以它那边几份结论不一致仍然只能答 unknown。
   */
  mergeFacts?(name: string, lower: AshMcpNameFact, higher: AshMcpNameFact): AshMcpNameFact;
  /** 把一条原值登记按规范名拼进去(配 `AshMcpNameFact.raw`,JSON 两族有)。 */
  composeRaw?(text: string | null, value: Record<string, unknown>): AshMcpCompose;
  /** 没有宿主那段可搬时,按一条登记现渲染一段(「整段原文照搬」只有 TOML 族有)。 */
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
   * 这家 CLI 的几份来源**合起来看**,而且「谁覆盖谁」这件事 ash **逐格实测过** ——
   * 置真表示两件事都成立:**加载序**是确定的(含同一个目录里那几个文件名的先后),
   * **逐字段合并**语义是确定的。判定、搬运、安装都据此算最终生效的那一条
   * (`register.ts` 的 `resolveAshMcp`)。
   *
   * 2026-10-31 用真 opencode 1.19.3 实测,升序是:默认目录(`opencode.json` <
   * `opencode.jsonc`)< `OPENCODE_CONFIG` 那个文件 < `OPENCODE_CONFIG_DIR` 那个目录 <
   * `OPENCODE_CONFIG_CONTENT` 那整段 JSON(它还**没有文件可写**)。合并是**逐字段深合并**:
   * 低的那份写完整启动命令、高的那份只写 `{"enabled": false}` ⇒ 命令留着、开关被关掉;
   * 嵌套的 `environment` 也是按键合,数组整条替换。逐格记在 catalog 那家的 `source` 里。
   *
   * 没实测过的家(kilo)**不要**置真:几份来源结论不一致时判定只能回 unknown,猜「合并」会把
   * 没接上说成接上了,猜「取代」会把接上了说成没接上、还要再写一条顶掉它。
   */
  readonly sourcesMerge?: boolean;
  /**
   * 指到**另一个配置目录**、而且优先级高于默认目录的变量(opencode 的 `OPENCODE_CONFIG_DIR`)。
   *
   * 和 `dirEnv` 的区别是它**不取代**默认目录:实测默认目录那份照样生效,而这个目录里的
   * `enabled = false` 盖得住默认那份的开启。
   *
   * **它比 `dirEnvIsFile` 那份文件还高**(本轮审查 F1 实测:那个文件里写完整的
   * `enabled: false`、这个目录里只写 `{"enabled": true}` ⇒ 真 CLI `ash connected`)。
   * 上一版按「文件比目录具体、所以更高」排,排反了 —— 于是一条连得上的登记被判成
   * disabled,预检当场硬拒,安装器还说是用户自己关的。
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
