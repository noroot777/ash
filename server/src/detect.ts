import type { AgentType } from "@ash/shared";
import { probeBins } from "./executors/bin-probe.js";
import { CLI_SPECS } from "./executors/catalog/index.js";
import { resolveExecutorFor } from "./executors/index.js";
import { isAffectedCodexVersion } from "./executors/version-policy.js";
import { IS_WINDOWS } from "./platform.js";

export interface DetectedAgent {
  type: AgentType;
  bin: string;
  available: boolean;
  path: string | null;
  version: string | null;
  /** 支持常驻会话(openResident)——只有这类 CLI 能当 /team 的调度者。 */
  resident: boolean;
}

/**
 * 已知 CLI 目录里一项的**展示面**。
 *
 * 字段全部来自 `executors/catalog/` 里那个 CLI 的 spec —— 目录是单一真相来源,这里
 * 只是把展示需要的那几个字段挑出来(spec 还带执行参数和 parser 函数,不能整份丢给
 * 前端:函数没法序列化,执行细节也不是界面的事)。
 *
 * `type` 与 `key` 恒等,两个都留是为了兼容前端已有用法:key 做 React key、type 做
 * 「派给谁」的取值。目录里的每一项现在都能派任务(执行部分未实测的带 `untested`)。
 */
export interface KnownCli {
  /** 稳定标识,前端拿它做 key(bin 会变,见 cursor 的 cursor-agent → agent)。 */
  key: string;
  name: string;
  /** 中文一句话,卡片副标题。 */
  description: string;
  /** 候选命令名,按顺序探测,第一个探到的算数(见 spec 里各自的注释)。 */
  bins: string[];
  /** 备用命令名的自证要求(见 CliCatalogEntry.fallbackVersionMatch)。 */
  fallbackVersionMatch?: string;
  docsUrl: string;
  /**
   * 官方安装命令原文,**已按本机平台选好那一条**(Windows 上给 PowerShell 那条,
   * 见 CliCatalogEntry.installCommandWindows)。只给用户复制,**服务端永不执行**。
   * 空串 = 这个 CLI 在本平台没有官方版本,理由在 platformNote 里。
   */
  installCommand: string;
  /**
   * 本平台特有的前提或限制,一句话。目前只有 Windows 侧填得上(spec 的 windowsNote);
   * 别的平台一律 undefined —— 这个字段的意思是「你这台机器上额外要注意什么」,
   * 不是「各平台注意事项的合集」。
   */
  platformNote?: string;
  /** 可作为 ash 执行器的 AgentType(= key)。 */
  type: AgentType;
  /** true = 执行参数按官方文档写、本机未实测(前端据此打标)。 */
  untested?: boolean;
  /**
   * 该 CLI 的限制说明与待核实的点(spec 里那段 notes 原文)。
   * 前端把它连着 `untested` 一起展示 —— 光有一个「未实测」标记等于只说了「别太当真」,
   * 用户真正需要知道的是**哪里**没验、踩了什么坑(「仅企业版旗舰套餐」「未接供应商」
   * 「没有权限确认这一环」这类信息只在 notes 里)。
   */
  notes?: string;
}

export interface DetectedCli extends KnownCli {
  /** 实际探到的命令名(bins 里命中的那个);没探到则回落 bins[0]。 */
  bin: string;
  available: boolean;
  path: string | null;
  version: string | null;
  /**
   * 升级提醒只挂在这份**目录**形状上,不挂 `DetectedAgent`:`/agents/catalog` 只有用户
   * 亲手点「检测本地智能体」才会请求,而 `/agents/detect` 是执行器选择器在后台常拉的。
   * 挂到后台那条上,用户还没检测就会被糊一条升级横幅(用户 2026-08-25 明确否掉了这个)。
   */
  versionWarning?: string;
  /** 该执行器支持常驻会话(能当 /team 调度者)—— 直接问执行器本人有没有 openResident。 */
  resident: boolean;
}

const CODEX_0147_WARNING = "Codex CLI 0.147.x 有已知工具注册/恢复异常，可能把终端调用路由到错误工具。请运行 npm install -g @openai/codex，升级到 0.148.0 或更高版本。";

export function versionWarningFor(type: AgentType, version: string | null): string | undefined {
  return type === "codex" && isAffectedCodexVersion(version) ? CODEX_0147_WARNING : undefined;
}

// 安装命令在**这里**按宿主平台定死,而不是把两条都发给前端让浏览器挑:CLI 要装在
// 跑 server 的这台机器上,只有服务端知道那是什么系统(用 Windows 浏览器连 mac 上的
// ash 完全正常,那时该显示的是 mac 那条)。
//
// 单独抽成函数是为了能测 —— `IS_WINDOWS` 是模块级常量,mac 上跑的测试没法翻转它,
// 内联写就等于 Windows 分支永远没人验。
export function installCommandFor(
  spec: { installCommand: string; installCommandWindows?: string | null },
  isWindows: boolean,
): string {
  if (!isWindows) return spec.installCommand;
  // 三态(见 CliCatalogEntry.installCommandWindows):不写 = 跟 POSIX 同一条(npm 那种);
  // 字符串 = 用它;null = 官方没 Windows 版,发空串,前端据此标不可用。
  if (spec.installCommandWindows === undefined) return spec.installCommand;
  return spec.installCommandWindows ?? "";
}

// 目录 → 展示面。挑字段而不是整份 spread:spec 里有 parser / factory 这些函数,
// 一起 spread 出去会被 JSON.stringify 静默丢掉,还把执行细节泄给了界面。
const KNOWN_CLIS: KnownCli[] = CLI_SPECS.map((s) => ({
  key: s.key,
  type: s.key,
  name: s.name,
  description: s.description,
  bins: s.bins,
  fallbackVersionMatch: s.fallbackVersionMatch,
  docsUrl: s.docsUrl,
  installCommand: installCommandFor(s, IS_WINDOWS),
  platformNote: IS_WINDOWS ? s.windowsNote : undefined,
  untested: s.untested,
  notes: s.notes,
}));

// 探测走 bin-probe 的 probeBins —— **检测与执行必须是同一套判定**(候选顺序、
// 备用名自证、PATH 查找口径全部共用)。以前这里自己 `which` 一遍、执行器另认
// bins[0],于是「目录显示可用、派任务 ENOENT」(第 1 轮审查抓到的问题)。
async function detectOne(cli: KnownCli): Promise<DetectedCli> {
  const probe = await probeBins(cli.bins, cli.fallbackVersionMatch);
  const version = probe?.version ?? null;
  return {
    ...cli,
    bin: probe?.bin ?? cli.bins[0],
    available: !!probe,
    path: probe?.path ?? null,
    version,
    versionWarning: versionWarningFor(cli.type, version),
    // 没装的 CLI 不去解析执行器,直接算它不支持常驻 —— 反正启动器只在 available
    // 的里面挑。装了的才问执行器本人有没有 openResident(目前只有 claude 有;
    // GenericCliExecutor 一律不实现,「谁能当团队调度者」的过滤就靠这个)。
    resident: probe
      ? !!(await resolveExecutorFor({ type: cli.type }).then((e) => e.openResident, () => null))
      : false,
  };
}

// 探测整份已知 CLI 目录。全量返回、不做过滤 —— 装了没装、
// 执行参数实测没实测(untested)都在字段里,界面自己决定怎么展示。
export function detectKnownClis(): Promise<DetectedCli[]> {
  return Promise.all(KNOWN_CLIS.map(detectOne));
}

/**
 * 注册闸:装的是受影响版本就不让它注册(用户 2026-08-25「而且不让它注册」)。
 *
 * 返回的是**拒绝理由**,而且刻意**不带任何版本诊断** —— 连「本机装的版本有缺陷」都不能
 * 说。注册可以从任何入口发起(Profile 组里的「新增」、API 直连、旧前端),那些入口跟
 * 「检测本地智能体」无关;用户的口径是**亲手点了检测、并且检测出 0.147.x,才做版本提示**,
 * 所以这里只说「这次没注册成,先去点检测」,把版本这件事整个留给检测结果。
 * 升级怎么做由 `DetectedCli.versionWarning` 在检测结果卡片里讲。
 */
export async function registrationBlockReason(type: AgentType): Promise<string | undefined> {
  if (type !== "codex") return undefined;
  const cli = KNOWN_CLIS.find((candidate) => candidate.type === type);
  if (!cli) return undefined;
  const probe = await probeBins(cli.bins, cli.fallbackVersionMatch);
  if (!isAffectedCodexVersion(probe?.version ?? null)) return undefined;
  return "暂时不能把 Codex 注册为执行器。请先在「执行器」页点「检测本地智能体」，按检测结果处理。";
}

// 派任务视角的精简形状(形状保持不变):团队/讨论的执行器选择器靠它决定谁能当
// 调度者。`resident` 直接问执行器本人有没有 openResident —— 「谁能当调度者」只有
// 这一个真相来源,前端照着过滤就行,不用在 shared 里再抄一张名单出来漂移。
export async function detectLocalAgents(): Promise<DetectedAgent[]> {
  const all = await Promise.all(KNOWN_CLIS.map(detectOne));
  return all.map(({ type, bin, available, path, version, resident }) => ({
    type,
    bin,
    available,
    path,
    version,
    resident,
  }));
}
