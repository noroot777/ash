// 环境变量的名字：当前前缀 `NAVI_`，读的时候认上几代（`ASH_`、`HARNESS_`，见 legacy-names.ts）。
//
// **读**一律走 `readEnv(env, "NAVI_X")`：新名在就用新名，不在依次退到旧名。用户已有的启动命令、
// launchd 配置、升级前起的智能体（它们的环境是旧版设的）、还在用旧名的测试，因此都照常生效。
// **写**给子进程的一律走 `setEnv`：只写新名，并把同一个变量的旧名从那份环境里拿掉 —— 留着的话，
// 子进程环境里就同时有一个新名和一个从宿主继承来的旧名，各说各的值。**擦**一律走 `clearEnv`，
// 三代一起擦（擦漏一代等于没擦）。
//
// 只有一类变量要连旧名一起导出：交给**用户自己写的命令**读的那几个（预览命令的 `$NAVI_PREVIEW_BASE`
// 之类），用户脚本里写的还是旧名 —— 那种地方用 `withLegacyEnvNames`，并在调用处写明为什么。
import { LEGACY_ENV_PREFIXES } from "./legacy-names.ts";

export const ENV_PREFIX = "NAVI_";

/** 一个环境变量的当前名。只收 `NAVI_` 开头的名字，写成别的前缀编译不过。 */
export type NaviEnvName = `NAVI_${string}`;

type EnvLike = Readonly<Record<string, string | undefined>>;
type MutableEnv = Record<string, string | undefined>;

/** 同一个变量的各代名字，新名在前：`NAVI_DB` → `["NAVI_DB", "ASH_DB", "HARNESS_DB"]`。 */
export function envNameGenerations(name: NaviEnvName): string[] {
  const key = name.slice(ENV_PREFIX.length);
  return [name, ...LEGACY_ENV_PREFIXES.map((prefix) => `${prefix}${key}`)];
}

/**
 * 读一个变量：新名优先，依次退到旧名。「设了」以 `!== undefined` 为准（跟 `??` 一致）——
 * 显式设成空串也算设了，不会被旧名的值顶掉。
 */
export function readEnv(env: EnvLike, name: NaviEnvName): string | undefined {
  for (const key of envNameGenerations(name)) {
    const value = env[key];
    if (value !== undefined) return value;
  }
  return undefined;
}

/** 这个键是不是某个变量（任一代）的名字。Windows 的环境变量名不分大小写，这里也不分。 */
export function isEnvNameOf(key: string, name: NaviEnvName): boolean {
  const upper = key.toUpperCase();
  return envNameGenerations(name).some((candidate) => candidate === upper);
}

/** 三代一起擦。按大小写不敏感找键：从 Windows 的 `process.env` 展开来的对象里键名大小写是原样的。 */
export function clearEnv(env: MutableEnv, name: NaviEnvName): void {
  for (const key of Object.keys(env)) {
    if (isEnvNameOf(key, name)) delete env[key];
  }
}

/** 写新名，同时擦掉旧名。`value === undefined` 等于三代都擦（给 spread 进 spawn 选项的环境用）。 */
export function setEnv(env: MutableEnv, name: NaviEnvName, value: string | undefined): void {
  clearEnv(env, name);
  if (value !== undefined) env[name] = value;
}

/**
 * 交给用户自己写的命令读的变量：`NAVI_` 开头的那几个再带一份上一代的旧名（`ASH_`），别的原样。
 * 只在那种地方用 —— 我们自己的进程读得到新名，用不着旧名；用户脚本、以及改名之前那一版代码
 * （预览的任务分支可能还没合进改名）只认旧名。拆：用户的命令都换成新名之后，连同调用处一起删。
 */
export function withLegacyEnvNames(vars: Readonly<Record<string, string>>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(vars)) {
    out[name] = value;
    if (name.startsWith(ENV_PREFIX)) out[envNameGenerations(name as NaviEnvName)[1]!] = value;
  }
  return out;
}
