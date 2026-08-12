import type { AgentType } from "./index.ts";

// ── harness 替你写进 CLI 的配置 ─────────────────────────────────────────────
// 这里声明的每一项,harness 都是**绕过 CLI 自己的配置文件**、直接以环境变量的形式
// 注入到它启动的进程里。语义是「只对 harness 起的这个进程生效」:
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
}

// claude 2.1.220 实测:自动压缩只对**白名单内的模型名**生效(sonnet-4-6 / opus-4-6 /
// opus-4-8 / opus-5 / sonnet-5)。名单外的(fable-5、经 anthropic 协议中转的第三方模型)
// 窗口来源落到 "auto",CLI 的 `toy()` 里 `if(wSe()&&!JGe(t,r))return!1` 直接把整段
// 自动压缩跳过 —— 表现就是水位一路涨到几十万也不压,直到炸掉。给上这个环境变量后
// 窗口来源变成 "env",压缩恢复,而且是**回合运行中途**压的(单次调用内压过 3 次)。
const CLAUDE_OVERRIDES: CliConfigOverride[] = [
  {
    key: "autoCompactWindow",
    label: "自动压缩窗口",
    env: "CLAUDE_CODE_AUTO_COMPACT_WINDOW",
    shadows: "~/.claude/settings.json → autoCompactWindow",
    help: "上下文涨到这个数附近时,claude 自己压缩历史。留空 = 跟随 CLI 判断;而 CLI 对白名单外的模型(fable-5、走中转的第三方模型)会整段跳过自动压缩,水位一路涨到炸。",
    min: 100_000,
    max: 1_000_000,
    placeholder: "留空 = 跟随 CLI",
    recommended: 160_000,
    unit: "token",
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

/** 落成启动进程时要注入的环境变量。没配的项不出现(不是注入空串)。 */
export function cliConfigOverrideEnv(
  type: AgentType | string,
  values: Record<string, number> | null | undefined,
): Record<string, string> {
  if (!values) return {};
  const out: Record<string, string> = {};
  for (const spec of cliConfigOverridesFor(type)) {
    const value = values[spec.key];
    if (typeof value === "number" && Number.isFinite(value)) out[spec.env] = String(value);
  }
  return out;
}
