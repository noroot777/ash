import { cliConfigOverrideEnvPrefix, type CliHostEnv } from "@harness/shared/cli-overrides";

// harness 起 CLI 时,那个子进程会看到的环境事实。**只读**,不是配置项 —— 它由 harness
// 自己的启动环境决定(shell 里 export 过、launchd plist 里写过)。
//
// 为什么要单拎出来:覆盖项里那个百分比要换算成 claude 认的「占有效窗口的比例」,而有效
// 窗口 = 窗口 − min(CLAUDE_CODE_MAX_OUTPUT_TOKENS, 20000)。这个变量在 **server 进程**里,
// 前端算不出来;不如实报一份过去,设置页写的触发水位就会跟 CLI 的实际行为对不上。
export function cliHostEnv(): CliHostEnv {
  const raw = Number(process.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS);
  return {
    maxOutputTokens: Number.isFinite(raw) && raw > 0 ? Math.round(raw) : null,
  };
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
