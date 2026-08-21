import { splitProfileExtraArgs } from "./cli-args.ts";
import type { AgentType } from "./index.ts";

// ── ash 替你写进 CLI 的配置 ─────────────────────────────────────────────
// 这里声明的每一项,ash 都是**绕过 CLI 自己的配置文件**、直接以环境变量的形式
// 注入到它启动的进程里。语义是「只对 ash 起的这个进程生效」:
//   · 用户自己在终端敲 `claude` 时读到的还是他的 settings.json,原样不动
//   · 不同 profile 可以给不同的值(官方账号那条不配,中转的那条配上)
// 所以 `shadows` 字段是这张表的重点 —— 它写清楚「这一项盖掉了谁」,前端原样显示给
// 用户看。不写明白的话,用户在 settings.json 里改了值却不生效,只会以为 CLI 坏了。

export interface CliConfigOverride {
  /** 存库用的 key(`agents.config_overrides` 的字段名)。 */
  key: string;
  /** 表单标签。 */
  label: string;
  /** 落成的环境变量名。 */
  env: string;
  /** 它盖掉的是谁 —— 前端原样显示,这是「可见」的全部意义。 */
  shadows: string;
  /** 一句话说明为什么会需要它。 */
  help: string;
  /** CLI 自己认的取值范围,超出会被它忽略,所以两端都夹一遍。 */
  min: number;
  max: number;
  /** 留空时的行为描述(前端 placeholder)。 */
  placeholder: string;
  /** 「用推荐值」按钮填的数。 */
  recommended: number;
  /** 数值单位后缀,展示用。 */
  unit?: string;
  /** 单独配没用、必须同时配上的那一项(前端据此提示)。 */
  requires?: string;
  /**
   * 落环境变量前的换算。缺省 = 原样。第二个参数是同一 profile 上的其它覆盖项,
   * 第三个是「ash 起 CLI 时它会看到的环境」(见 CliHostEnv)。
   * 返回 null = 这一项在当前组合下不起作用,干脆不注入。
   */
  toEnv?: (value: number, values: Record<string, number>, host: CliHostEnv) => string | null;
}

/**
 * ash 起 CLI 时,那个进程会看到的环境事实 —— **只读**,不是配置项。
 * 前端算不出来(变量在 server 进程里),所以由服务端如实报一份给它,好让设置页
 * 显示的触发水位和 CLI 真正的行为对得上。
 */
export interface CliHostEnv {
  /** `CLAUDE_CODE_MAX_OUTPUT_TOKENS`;没设 = null(CLI 用模型自己的上限)。 */
  maxOutputTokens: number | null;
}

export const NO_CLI_HOST_ENV: Readonly<CliHostEnv> = Object.freeze({ maxOutputTokens: null });

// ── claude 的自动压缩是怎么算的(2.1.220 反编译核对) ──────────────────────────
// 触发点不是「窗口」本身,中间垫了两层:
//   有效窗口 T   = 声明窗口 W − min(CLAUDE_CODE_MAX_OUTPUT_TOKENS, 20000)
//                  (`CSe`;现役模型 max_output 都 ≥ 20k,所以这一项恒等于 20000)
//   触发水位     = min(floor(T × pct/100), T − 13000)      (`Sfo`)
//   pct 从哪来   = CLAUDE_AUTOCOMPACT_PCT_OVERRIDE,不设就直接取 T − 13000
// 也就是说:**只配窗口的话,压缩点被钉死在 W − 33000**;想更早压只能把窗口填小,
// 而窗口填小的副作用是 claude 以为自己只有那么大 —— 剩余量显示、blocking 判定
// 全跟着偏。所以这里把两件事拆开:窗口照实填,什么时候压交给百分比。
//
// 另外一条硬前提:`toy()` 里 `if(wSe()&&!JGe(t,r))return!1` —— 窗口来源是 "auto"
// (没人显式配过)时,整段自动压缩直接跳过。白名单(sonnet-4-6 / opus-4-6 / opus-4-8 /
// opus-5 / sonnet-5)外的模型(fable-5、经 anthropic 协议中转的第三方模型)就落在这一档。
// 所以**百分比不能单独用**:不配窗口,来源仍是 auto,压缩根本不会被叫起来。
const CLAUDE_COMPACT_RESERVE = 20_000;
const CLAUDE_COMPACT_FLOOR_GAP = 13_000;

// ── 还有一道总开关,不摁住它前面这些都白配 ────────────────────────────────────
// 同一版反编译:
//   function JI(){ if(DISABLE_COMPACT)return!1;
//                  if(process.env.DISABLE_AUTO_COMPACT)return!1;
//                  return setting("autoCompactEnabled",!0).value }
// 也就是说用户只要在 `~/.claude/settings.json` 里写过 `env.DISABLE_AUTO_COMPACT=1`
// 或者顶层 `autoCompactEnabled:false`,窗口和百分比全都还在(实测两个数确实赢了),
// 自动压缩却一次都不会被叫起来 —— 而设置页上明晃晃写着「200k · 80% 已覆盖」。
// 这一档配置对外的承诺就是「让它在这个水位压」,所以**配了窗口就连总开关一起摁住**:
//   · `--settings` 顶层 `autoCompactEnabled:true`(压过用户各层 settings)
//   · 两条 kill switch 的 env 都置空串(空串是 falsy,等于把开关摁灭;顺带盖掉他
//     settings.env 里的 `1` —— 各层 env 是按 key 合并的)
// **两条都要摁**:上面那段反编译里 `DISABLE_COMPACT` 排在最前面,先前只摁了第二条,
// 于是 shell / launchd / 任一 settings 层里留着 `DISABLE_COMPACT=1` 时,页面照旧写着
// 「已覆盖」而压缩一次都不会发生(第 3 轮审查 finding 1)。2.1.220 真机实测:
//   未设                                              → slash_commands 103 条,含 compact
//   DISABLE_COMPACT=1                                 → 102 条,**连手动 /compact 都没了**
//   DISABLE_COMPACT=1 + `--settings.env` 里置空        → 103 条,压缩回来了
//   DISABLE_COMPACT=1 + 只置空 DISABLE_AUTO_COMPACT    → 102 条,救不回来
// 没配窗口就一个字都不碰:用户在自己机器上关掉自动压缩是他的事。
const CLAUDE_AUTO_COMPACT_KILL_SWITCHES = ["DISABLE_COMPACT", "DISABLE_AUTO_COMPACT"] as const;

// 百分比换算的分母(`min(它, 20000)` = 输出预留量)。ash 按自己读到的值算完触发点,
// 就**把同一个值钉进 `--settings.env`**:不钉的话,用户 settings.json 里的同名变量会在
// 换算之后把分母改小,有效窗口变大、真实触发点比页面写的晚 5 个百分点左右(第 2 轮
// 审查 finding 3)。钉的是「我们读到的那个赢家值」,所以对用户是原地不动,只是不许它
// 在我们身后再变。读不到就不钉 —— 编一个数比不钉更糟。
const CLAUDE_MAX_OUTPUT_ENV = "CLAUDE_CODE_MAX_OUTPUT_TOKENS";

/** 这个 profile 真的配了自动压缩(窗口是这一档的开关项,没它百分比也不注入)。 */
function claudeCompactionConfigured(
  type: AgentType | string,
  values: Record<string, number> | null | undefined,
): boolean {
  const window = values?.autoCompactWindow;
  return type === "claude" && typeof window === "number" && Number.isFinite(window);
}

/**
 * 预留给输出的那一段:`min(CLAUDE_CODE_MAX_OUTPUT_TOKENS, 20000)`(`CSe`/`wfo`)。
 * 现役模型的 max_output 都 ≥ 20k,所以**只有用户把那个变量设到 20k 以下**时它才不是
 * 20000 —— 但设了就真会变,硬编码 20k 会让页面上写的触发点比实际早 5% 左右。
 */
function claudeCompactReserve(host: CliHostEnv): number {
  const max = host.maxOutputTokens;
  return typeof max === "number" && Number.isFinite(max) && max > 0
    ? Math.min(max, CLAUDE_COMPACT_RESERVE)
    : CLAUDE_COMPACT_RESERVE;
}

export interface ClaudeCompactionPlan {
  /** 声明给 claude 的窗口。 */
  window: number;
  /** 用户填的百分比(占**窗口**的比例)。 */
  percent: number | null;
  /** 换算成 claude 认的那个百分比(它是占「有效窗口」的比例)。 */
  envPercent: number | null;
  /** 实际触发水位。 */
  trigger: number;
  /** 填的百分比太晚,被 claude 自己的下限(T − 13000)顶掉了。 */
  capped: boolean;
}

/**
 * 按上面那套算法把用户填的两个数翻译成「实际会在多少 token 压缩」。
 * 前端拿它显示、`toEnv` 拿它落环境变量,一个公式两处用,不会漂。
 */
export function claudeCompactionPlan(
  values: Record<string, number>,
  host: CliHostEnv = NO_CLI_HOST_ENV,
): ClaudeCompactionPlan | null {
  const window = values.autoCompactWindow;
  if (typeof window !== "number" || !Number.isFinite(window)) return null;
  const effective = window - claudeCompactReserve(host);
  const floor = effective - CLAUDE_COMPACT_FLOOR_GAP;
  const percent = typeof values.autoCompactPercent === "number" && Number.isFinite(values.autoCompactPercent)
    ? values.autoCompactPercent
    : null;
  if (percent === null || effective <= 0) {
    return { window, percent: null, envPercent: null, trigger: Math.max(0, floor), capped: false };
  }
  const wanted = Math.floor((window * percent) / 100);
  // claude 只认 0 < pct ≤ 100;换算后超过 100 说明用户想压得比它的下限还晚,
  // 那就是「等于没设」,如实标 capped 而不是偷偷把数改小。
  // 保留两位小数:claude 那边是 parseFloat,精度给够,触发点的误差就只剩几十 token。
  const raw = (wanted / effective) * 100;
  const envPercent = Math.min(100, Math.max(0.01, Math.round(raw * 100) / 100));
  const trigger = Math.min(Math.floor((effective * envPercent) / 100), floor);
  return { window, percent, envPercent, trigger, capped: wanted >= floor };
}

const CLAUDE_OVERRIDES: CliConfigOverride[] = [
  {
    key: "autoCompactWindow",
    label: "上下文窗口",
    env: "CLAUDE_CODE_AUTO_COMPACT_WINDOW",
    shadows: "~/.claude/settings.json → autoCompactWindow",
    help: `照实填这个模型的上下文窗口。留空 = 跟随 CLI 判断,而 CLI 对白名单外的模型(fable-5、走中转的第三方模型)判不出来,会整段跳过自动压缩,水位一路涨到炸 —— 所以这一项是这一档的开关,不填下面的百分比也不生效。填上之后 ash 会连 claude 的自动压缩总开关一起摁住(你 settings.json 里的 autoCompactEnabled:false / ${CLAUDE_AUTO_COMPACT_KILL_SWITCHES.map((key) => `${key}=1`).join(" / ")} 在这次调用里不算数),否则数填对了也一次都不会压。拿不准就往小了填:填小只是压得早一点,填大会压得太晚直接撞上限。`,
    min: 100_000,
    max: 1_000_000,
    placeholder: "留空 = 跟随 CLI",
    recommended: 200_000,
    unit: "token",
  },
  {
    key: "autoCompactPercent",
    label: "压缩触发点",
    env: "CLAUDE_AUTOCOMPACT_PCT_OVERRIDE",
    shadows: "claude 内置的默认触发点(窗口 − 33k)",
    help: "上下文用到窗口的百分之几时开始压缩。留空 = 用 claude 自己的默认,也就是离窗口顶还剩 33k 才压。",
    min: 1,
    max: 100,
    placeholder: "留空 = 窗口 − 33k",
    recommended: 80,
    unit: "%",
    requires: "autoCompactWindow",
    // 用户填的是「占窗口的比例」,claude 认的是「占有效窗口(窗口 − 20k)的比例」,
    // 差的就是那层 max_output 预留。这里换算一次,填 80 就真的在 80% 压。
    toEnv: (_value, values, host) => {
      const envPercent = claudeCompactionPlan(values, host)?.envPercent;
      return typeof envPercent === "number" ? String(envPercent) : null;
    },
  },
];

const BY_TYPE: Partial<Record<AgentType, CliConfigOverride[]>> = {
  claude: CLAUDE_OVERRIDES,
};

/** 某类 CLI 支持哪些覆盖项。空数组 = 这个 CLI 还没有可覆盖的配置。 */
export function cliConfigOverridesFor(type: AgentType | string): CliConfigOverride[] {
  return BY_TYPE[type as AgentType] ?? [];
}

/** 有没有任何一类 CLI 声明过覆盖项(前端决定要不要渲染这一列)。 */
export function hasCliConfigOverrides(type: AgentType | string): boolean {
  return cliConfigOverridesFor(type).length > 0;
}

/**
 * 归一化用户传来的值:丢掉没声明过的 key、非有限数、以及夹不进范围的空值,
 * 其余按 CLI 自己的上下限夹一遍(超范围的值 CLI 会**静默忽略**,与其让用户
 * 以为配上了,不如在这里就夹成一个真能生效的数)。
 */
export function normalizeCliConfigOverrides(
  type: AgentType | string,
  raw: unknown,
): Record<string, number> {
  const specs = cliConfigOverridesFor(type);
  if (!specs.length || !raw || typeof raw !== "object") return {};
  const source = raw as Record<string, unknown>;
  const out: Record<string, number> = {};
  for (const spec of specs) {
    const value = source[spec.key];
    if (value === undefined || value === null || value === "") continue;
    const n = typeof value === "number" ? value : Number(value);
    if (!Number.isFinite(n)) continue;
    out[spec.key] = Math.round(Math.min(spec.max, Math.max(spec.min, n)));
  }
  return out;
}

/**
 * 依赖项没配上的覆盖项:`cliConfigOverrideEnv` 会跳过它们,存进库也不会注入进程 ——
 * 界面上却会照实显示成「已覆盖 80%」,这就是一次静默失败。返回这些项的 key。
 */
export function ineffectiveCliConfigOverrides(
  type: AgentType | string,
  values: Record<string, number> | null | undefined,
): string[] {
  if (!values) return [];
  return cliConfigOverridesFor(type)
    .filter((spec) => typeof values[spec.key] === "number"
      && !!spec.requires
      && typeof values[spec.requires!] !== "number")
    .map((spec) => spec.key);
}

/**
 * 上面那批的人话版。**服务端拒绝写入和前端禁用保存用的是同一份判据** —— 只在前端拦,
 * 旧客户端、直接打 API、历史坏数据都能绕过去,库里于是躺着一份「显示已覆盖、实际
 * 不生效」的配置。
 */
export function cliConfigOverrideErrors(
  type: AgentType | string,
  values: Record<string, number> | null | undefined,
): string[] {
  const specs = cliConfigOverridesFor(type);
  return ineffectiveCliConfigOverrides(type, values).map((key) => {
    const spec = specs.find((candidate) => candidate.key === key)!;
    const required = specs.find((candidate) => candidate.key === spec.requires);
    return `「${spec.label}」要配合「${required?.label ?? spec.requires}」一起填才生效`;
  });
}

/**
 * 从库里读回来的那一侧的唯一入口(`agents.config_overrides` 存的是一段 JSON 文本)。
 *
 * 写入端已经归一过,但**库里躺着的那份不一定过过今天这道闸**:升级前写下的、手工
 * 改坏的、声明范围后来改小的。读端直接 `JSON.parse` 有两种炸法 ——
 *   · 非法 JSON:`GET /agents` 整个 500(设置页打不开),执行器解析同样抛,这个
 *     profile 从此派不出任务;
 *   · 合法但越界:API 原样返给页面显示 2M,执行器那边却按当前声明夹成 1M ——
 *     显示与行为分叉,而这一档配置的全部意义就是「看得见」。
 * 所以两端一律走这里:解析不了当没配,解析得了也按当前声明夹一遍。
 */
export function readCliConfigOverrides(
  type: AgentType | string,
  raw: string | null | undefined,
): Record<string, number> {
  if (!raw) return {};
  try {
    return normalizeCliConfigOverrides(type, JSON.parse(raw));
  } catch {
    return {}; // 坏数据按「没配」算:页面显示「未覆盖」,CLI 也真的没被注入
  }
}

/** 落成启动进程时要注入的环境变量。没配的项不出现(不是注入空串)。 */
export function cliConfigOverrideEnv(
  type: AgentType | string,
  values: Record<string, number> | null | undefined,
  host: CliHostEnv = NO_CLI_HOST_ENV,
): Record<string, string> {
  if (!values) return {};
  const out: Record<string, string> = {};
  for (const spec of cliConfigOverridesFor(type)) {
    const value = values[spec.key];
    if (typeof value !== "number" || !Number.isFinite(value)) continue;
    // 依赖项没配上的,这一项对 CLI 毫无意义,注进去只会让人以为它在起作用。
    if (spec.requires && typeof values[spec.requires] !== "number") continue;
    const encoded = spec.toEnv ? spec.toEnv(value, values, host) : String(value);
    if (encoded !== null) out[spec.env] = encoded;
  }
  // 配了窗口才动这几个:两条是总开关(不摁住,上面这些数全是摆设),一个是换算分母
  // (不钉住,算完还会被改)。理由见上面 CLAUDE_AUTO_COMPACT_KILL_SWITCHES 那段。
  if (claudeCompactionConfigured(type, values)) {
    for (const key of CLAUDE_AUTO_COMPACT_KILL_SWITCHES) out[key] = "";
    const reserveSource = host.maxOutputTokens;
    if (typeof reserveSource === "number" && Number.isFinite(reserveSource) && reserveSource > 0) {
      out[CLAUDE_MAX_OUTPUT_ENV] = String(Math.round(reserveSource));
    }
  }
  return out;
}

/**
 * 落成子进程环境的**补丁**:配了的给值,**没配的显式给 `undefined` = 从子进程里删掉**。
 *
 * 后半句不是多余的。spawn 传的是 `{ ...process.env, ...补丁 }`,ash 自己启动时若
 * 环境里已经带着同名变量(用户在 shell 里 export 过、launchd plist 里写过),不删就等于
 * 每个 profile 都被那份全局值悄悄覆盖 —— 而设置页还老老实实显示「留空 = 跟随 CLI」。
 * 这一档配置的语义是「只有这里配的才算数」,所以留空必须是真的空。
 */
export function cliConfigOverrideEnvPatch(
  type: AgentType | string,
  values: Record<string, number> | null | undefined,
  host: CliHostEnv = NO_CLI_HOST_ENV,
): Record<string, string | undefined> {
  const patch: Record<string, string | undefined> = {};
  for (const spec of cliConfigOverridesFor(type)) patch[spec.env] = undefined;
  return { ...patch, ...cliConfigOverrideEnv(type, values, host) };
}

/**
 * 同一批变量落成 **CLI 自己的配置形态**(claude 的 `--settings`)。没配就返回 null。
 *
 * 为什么光有环境变量不够(2026-08-12 实测 claude 2.1.220):CLI 初始化时会把各层
 * settings 的 `env` 对象**再写回自己的进程环境**,于是用户 `~/.claude/settings.json`
 * 或项目 `.claude/settings.json` 里的同名变量反过来盖掉 ash 注入的那份 —— 设置页
 * 上写着 200k · 80%,实际按他文件里的数跑,而且一声不吭。这一档配置对外的承诺正是
 * 「覆盖 settings.json」,所以必须赢下它。
 *
 * `--settings` 是优先级最高的那一档(之上只剩企业策略文件),且各层 `env` 是**按 key
 * 合并**的:只写我们声明的这几个 key,用户 env 里的其它变量原样保留(同一次实测)。
 */
export function cliConfigOverrideSettings(
  type: AgentType | string,
  values: Record<string, number> | null | undefined,
  host: CliHostEnv = NO_CLI_HOST_ENV,
): Record<string, unknown> | null {
  const env = cliConfigOverrideEnv(type, values, host);
  if (!Object.keys(env).length) return null;
  // 总开关只有 settings 这一层认(它不是环境变量,`setting("autoCompactEnabled")` 读的是
  // 合并后的各层配置),所以 env 之外还得摆一个顶层字段 —— 两件事一起才摁得住。
  return claudeCompactionConfigured(type, values) ? { autoCompactEnabled: true, env } : { env };
}

/**
 * profile 自带的额外参数里有没有 `--settings` —— 有就说明 ash 写进去的那份会被
 * 整份顶掉(claude 只认最后一个)。
 *
 * **判定必须拆词后再做**:参数编辑器按 token 存,但历史配置和整段粘贴会留下
 * `["--settings {}"]` 这种合并 token,执行器那边 `normalizeProfileExtraArgs()` 会把它
 * 拆成两个词再拼进命令 —— 只按原始 token 比对的话,页面看不出冲突、跑起来却真的被顶掉
 * (第 2 轮审查 finding 4)。两边共用 shared/src/cli-args.ts 那份拆法。
 */
function hasSettingsArg(extraArgs: readonly string[] | null | undefined): boolean {
  if (!extraArgs?.length) return false;
  return splitProfileExtraArgs(extraArgs).some((arg) => arg === "--settings" || arg.startsWith("--settings="));
}

/**
 * 额外参数会不会把这一档覆盖整个顶掉 —— 会就返回一句人话,否则 null。
 *
 * 只有 claude 需要判:它的覆盖是靠 `--settings` 注入的,而**两个 `--settings` 不合并、
 * 最后一个整份胜出**(2026-08-12 实测 2.1.220)。额外参数排在我们那份之后,所以用户
 * 只要自己写了一个 `--settings`,这里填的数就一个都不会到 CLI 手上。不提示的话,设置
 * 页上明晃晃写着「已覆盖 200k · 80%」而实际行为毫无变化 —— 又是一次静默失败。
 */
export function cliConfigOverrideConflict(
  type: AgentType | string,
  extraArgs: readonly string[] | null | undefined,
): string | null {
  if (type !== "claude" || !hasSettingsArg(extraArgs)) return null;
  return "额外参数里已有 --settings：claude 只认最后一个，这里的覆盖会被它整份顶掉。要保留覆盖，请把那条 --settings 去掉。";
}

/**
 * 同一个 `--settings` 之争的另一半:1.5x 加速档(`fastMode`)走的是同一个参数,所以它
 * 会被一起顶掉,而速度那一列照样显示 `1.5x`。跟上面拆开写是因为两列各自要显示。
 */
export function cliSpeedOverrideConflict(
  type: AgentType | string,
  extraArgs: readonly string[] | null | undefined,
  speed: string | null | undefined,
): string | null {
  if (type !== "claude" || speed !== "fast" || !hasSettingsArg(extraArgs)) return null;
  return "额外参数里已有 --settings：claude 只认最后一个，1.5x 加速档（fastMode）会被它整份顶掉。";
}

/**
 * 同一批变量拼成 shell 前缀(`K=v K2=v2 `),给「复制到终端接着聊」那条命令用。
 * 不带它的话,用户手跑的那一次会退回 CLI 自己的 settings.json —— 压缩行为跟他在
 * ash 里看到的不是一回事,而这恰恰是他复制命令时最不会想到的差异。
 *
 * 只出赋值、不出 `env -u`:ash 起子进程时会把没配的项从环境里删掉(见上面的
 * 补丁),但用户自己终端里 export 了什么是他自己的事,替他 unset 属于越界。
 */
export function cliConfigOverrideEnvPrefix(
  type: AgentType | string,
  values: Record<string, number> | null | undefined,
  host: CliHostEnv = NO_CLI_HOST_ENV,
): string {
  return Object.entries(cliConfigOverrideEnv(type, values, host))
    .map(([key, value]) => `${key}=${value} `)
    .join("");
}

const fmtTokens = (n: number) => (n >= 1000 ? `${Math.round(n / 1000)}k` : String(n));

/**
 * 把「这几个数合起来会导致什么」翻译成人话,前端直接显示。
 * 存在的理由:这一档配置的值和它的效果之间隔着一层 CLI 内部算法,只显示用户填的
 * 数等于什么都没说 —— 得把算出来的触发水位摆在旁边,他才能判断填得对不对。
 */
export function cliConfigOverrideHints(
  type: AgentType | string,
  values: Record<string, number> | null | undefined,
  host: CliHostEnv = NO_CLI_HOST_ENV,
): string[] {
  if (type !== "claude" || !values) return [];
  const plan = claudeCompactionPlan(values, host);
  if (!plan) {
    return values.autoCompactPercent !== undefined
      ? ["只填百分比不起作用:窗口留空时 claude 会整段跳过自动压缩。"]
      : [];
  }
  const at = `上下文涨到 ~${fmtTokens(plan.trigger)} 时压缩(窗口 ${fmtTokens(plan.window)} 的 ${Math.round((plan.trigger / plan.window) * 100)}%)。`;
  // 摁住总开关这件事得说出来:它盖的是用户自己配置文件里的开关,不说明白就等于
  // 「悄悄改了别人的配置」;而不摁的话上面这个触发点根本不会发生(见 JI())。
  const forced = [`这次调用里 ash 会强制打开自动压缩(顶掉 settings.json 的 autoCompactEnabled:false 与 ${CLAUDE_AUTO_COMPACT_KILL_SWITCHES.join(" / ")}),否则窗口和百分比填对了也一次都不会压。`];
  if (plan.percent === null) return [`${at}这是 claude 的默认触发点;想更早压就填下面的百分比。`, ...forced];
  if (plan.capped) return [`${at}填的 ${plan.percent}% 比 claude 自己的下限还晚,已经按下限算 —— 想更早压请往小了填。`, ...forced];
  return [at, ...forced];
}
