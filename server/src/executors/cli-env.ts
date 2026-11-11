import {
  claudeCompactionUnprovable,
  cliConfigOverrideConflict,
  cliConfigOverrideEnv,
  cliConfigOverrideEnvPrefix,
  type CliHostEnv,
} from "@ash/shared/cli-overrides";
import { type CompactSnapshot, compactSnapshotFromEnv, UNKNOWN_COMPACT_SNAPSHOT } from "@ash/shared/usage";
import { type ClaudeConfigDir, claudeCompactLayers, claudeMaxOutputTokens } from "./claude-settings.js";

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
//
// `configDir` = 这次起跑子进程的 `CLAUDE_CONFIG_DIR`(见 claude-settings.ts ClaudeConfigDir):
// 多人隔离档下每个用户带着自己的配置目录起跑,按宿主那份解,换算出来的就是宿主的数。
export function cliHostEnv(cwd?: string, configDir?: ClaudeConfigDir): CliHostEnv {
  const layers = claudeCompactLayers(cwd, configDir);
  return {
    maxOutputTokens: claudeMaxOutputTokens(cwd, configDir),
    compactPercent: layers.inheritedPercent,
    managedCompaction: layers.managedTouches,
  };
}

/**
 * 这次起跑 claude **最终**按什么压缩,解成启动快照(带来源标记落库,见 shared CompactSnapshot)。
 *
 * 快照必须覆盖 CLI 会消费的**每一个**压缩输入,不能只看 ash 注入了什么(审查 SaouXWB_jEuw F1),
 * 而且各层配置要按**这次起跑的配置目录**读(同一轮 F1 第 2 轮),跟 env()/settingsPayload() 用
 * 同一份 cliHostEnv(cwd, configDir):
 *   · 配了窗口:ash 的 `--settings` 压过项目/用户各层;留空的百分比由 CLI 自己从下层继承,快照把
 *     同一个继承值记下来(只记,不往 CLI 里钉 —— 钉了就是替用户改配置);
 *   · 没配窗口:ash 一个字都不注入,项目/用户层要是碰过任一压缩输入,CLI 就按它们走 —— 判不全,标「不知道」;
 *   · 额外参数(profile 的 + 本次调用的,跟 buildArgs 拼进命令的是同一份)另带 `--settings`:整份顶掉
 *     ash 那份(cliConfigOverrideConflict),「不知道」;
 *   · `--setting-sources` 筛掉某几层、企业策略层碰过压缩输入:继承的那部分判不全,「不知道」。这条判据
 *     在 shared claudeCompactionUnprovable,设置页与会话压缩设置的预览用的是同一个(审查 7pDLIAokZRHH)。
 */
export function claudeLaunchCompact(
  configOverrides: Record<string, number> | null | undefined,
  cwd?: string,
  configDir?: ClaudeConfigDir,
  extraArgs: readonly string[] = [],
): CompactSnapshot {
  const host = cliHostEnv(cwd, configDir);
  if (cliConfigOverrideConflict("claude", extraArgs) || claudeCompactionUnprovable(extraArgs, host)) return UNKNOWN_COMPACT_SNAPSHOT;
  const layers = claudeCompactLayers(cwd, configDir);
  const snapshot = compactSnapshotFromEnv(cliConfigOverrideEnv("claude", configOverrides, host));
  if (snapshot.compactWindow === undefined) return layers.lowerTouches ? UNKNOWN_COMPACT_SNAPSHOT : snapshot;
  if (snapshot.compactPercent === undefined && layers.inheritedPercent !== null) {
    return { ...snapshot, compactPercent: layers.inheritedPercent };
  }
  return snapshot;
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
