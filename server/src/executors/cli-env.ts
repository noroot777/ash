import { cliConfigOverrideEnvPrefix, type CliHostEnv } from "@ash/shared/cli-overrides";
import { claudeMaxOutputTokens } from "./claude-settings.js";

// ash 起 CLI 时,那个子进程会看到的环境事实。**只读**,不是配置项 —— 它由 ash
// 自己的启动环境**和用户自己的 claude 配置文件**共同决定。
//
// 为什么要单拎出来:覆盖项里那个百分比要换算成 claude 认的「占有效窗口的比例」,而有效
// 窗口 = 窗口 − min(CLAUDE_CODE_MAX_OUTPUT_TOKENS, 20000)。这个值前端算不出来;不如实
// 报一份过去,设置页写的触发水位就会跟 CLI 的实际行为对不上。
//
// 只看 `process.env` 是不够的:CLI 会把各层 settings 的 `env` 写回自己的进程环境,用户
// 在 `~/.claude/settings.json` 里写的那份**压过**我们看到的环境变量(第 2 轮审查
// finding 3)。所以按 claude 自己的分层顺序解一遍,见 claude-settings.ts。
export function cliHostEnv(cwd?: string): CliHostEnv {
  return { maxOutputTokens: claudeMaxOutputTokens(cwd) };
}

/**
 * 「复制到终端接着聊」那条命令要带的 env 前缀。两截拼起来,缺一不可:
 *   · 覆盖项(窗口 / 压缩触发点)—— 不带,手跑那次就退回 settings.json,压缩行为变了
 *   · 供应商(base_url + key 占位符)—— 不带,手跑那次会走 CLI 自己的官方账号
 * 全空时返回 undefined,恢复命令就维持原来那副干净样子。
 */
export function resumeEnvHint(
  type: string,
  configOverrides: Record<string, number> | null | undefined,
  relayHint?: string,
): string | undefined {
  const hint = cliConfigOverrideEnvPrefix(type, configOverrides, cliHostEnv()) + (relayHint ?? "");
  return hint || undefined;
}
