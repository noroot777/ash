import { readFileSync } from "node:fs";
import { homedir, platform } from "node:os";
import { join } from "node:path";

// claude 自己的配置分层(高 → 低):
//   企业策略 managed-settings.json > `--settings` > 项目 .claude/settings.local.json
//   > 项目 .claude/settings.json > 用户 ~/.claude/settings.json > 继承来的环境变量
// 每一层的 `env` 对象在 CLI 初始化时会被**写回它自己的 process.env**,所以文件里的
// 同名变量压过 harness 注入的环境变量(第 1 轮审查 finding 1 的根因)。
//
// 这里只解一件事:`CLAUDE_CODE_MAX_OUTPUT_TOKENS` 最终是多少。它是自动压缩换算的分母
// (有效窗口 = 声明窗口 − min(它, 20000)),harness 必须按 CLI 真正会用的那个值换算,
// 否则设置页写的触发点跟实际差一截 —— 用户 settings.json 里写 10000 时,填 80% 实际
// 会在 ~84% 才压(第 2 轮审查 finding 3)。
//
// 解出来的值调用方会原样钉进我们自己的 `--settings.env`:那不是改用户的配置,而是把
// **他自己那份赢家值**固定住,免得算完之后又被下面某层换掉。读不到就不钉(ssh 远端的
// 文件在别的机器上),按默认预留估算并在提示里说明白。
function readJsonFile(path: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null; // 不存在 / 不是合法 JSON:当这一层没写过
  }
}

/** 一层 settings 里 `env.<name>` 的值(没写过 = undefined)。 */
function envValue(path: string, name: string): string | undefined {
  const env = readJsonFile(path)?.env;
  if (!env || typeof env !== "object") return undefined;
  const value = (env as Record<string, unknown>)[name];
  return typeof value === "string" || typeof value === "number" ? String(value) : undefined;
}

function managedSettingsPath(): string {
  return platform() === "darwin"
    ? "/Library/Application Support/ClaudeCode/managed-settings.json"
    : "/etc/claude-code/managed-settings.json";
}

/**
 * 本机 claude 最终会看到的 `CLAUDE_CODE_MAX_OUTPUT_TOKENS`(没有任何一层写过 = null)。
 * 给了 cwd 才读得到项目那两层 —— 设置页那条只读接口没有项目概念,读用户层就够。
 */
export function claudeMaxOutputTokens(cwd?: string): number | null {
  const name = "CLAUDE_CODE_MAX_OUTPUT_TOKENS";
  const layers = [
    managedSettingsPath(),
    ...(cwd ? [join(cwd, ".claude", "settings.local.json"), join(cwd, ".claude", "settings.json")] : []),
    join(homedir(), ".claude", "settings.json"),
  ];
  for (const path of layers) {
    const found = envValue(path, name);
    if (found !== undefined) return toPositiveInt(found);
  }
  return toPositiveInt(process.env[name]);
}

function toPositiveInt(raw: string | undefined): number | null {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.round(n) : null;
}
