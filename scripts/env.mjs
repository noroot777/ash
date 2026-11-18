// 环境变量的读写，口径同 `shared/src/env-names.ts`（那份的说明不复述）：读新名 `NAVI_X`，读不到依次退到
// 上几代的 `ASH_X`、`HARNESS_X`；写给子进程只写新名并擦掉旧名；擦就各代一起擦。
import { LEGACY_ENV_PREFIXES } from "./legacy-names.mjs";

export const ENV_PREFIX = "NAVI_";

/** 同一个变量的各代名字，新名在前。 */
export function envNameGenerations(name) {
  if (!name.startsWith(ENV_PREFIX)) throw new Error(`环境变量名必须以 ${ENV_PREFIX} 开头：${name}`);
  const key = name.slice(ENV_PREFIX.length);
  return [name, ...LEGACY_ENV_PREFIXES.map((prefix) => `${prefix}${key}`)];
}

/** 新名优先，依次退到旧名。「设了」以 `!== undefined` 为准。 */
export function readEnv(env, name) {
  for (const key of envNameGenerations(name)) {
    if (env[key] !== undefined) return env[key];
  }
  return undefined;
}

/** 各代一起擦（大小写不敏感：Windows 的环境变量名不分大小写）。 */
export function clearEnv(env, name) {
  const names = envNameGenerations(name);
  for (const key of Object.keys(env)) {
    if (names.includes(key.toUpperCase())) delete env[key];
  }
}

/** 写新名、擦旧名；`value === undefined` 等于各代都擦。 */
export function setEnv(env, name, value) {
  clearEnv(env, name);
  if (value !== undefined) env[name] = value;
}

/** 交给用户自己写的命令读的变量：`NAVI_` 开头的再带一份上一代旧名（`ASH_`）。 */
export function withLegacyEnvNames(vars) {
  const out = {};
  for (const [name, value] of Object.entries(vars)) {
    out[name] = value;
    if (name.startsWith(ENV_PREFIX)) out[envNameGenerations(name)[1]] = value;
  }
  return out;
}
