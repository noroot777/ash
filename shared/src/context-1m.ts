import { splitProfileExtraArgs } from "./cli-args.ts";
import type { LlmProvider } from "./index.ts";

// ── claude 的模型窗口:200k 还是 1M ─────────────────────────────────────────────
// claude CLI 只在模型名带 `[1m]` 后缀时按 1M 算窗口,否则一律 200k。ash 这边的开关是
// 供应商上的 `context1mModels`:列在里面的模型,起 CLI 时自动补上后缀并改走本机的 1M
// 转发(server/src/anthropic-context-1m.ts)。
//
// 这件事和执行器上配的自动压缩窗口是**咬合**的:CLI 会把 `CLAUDE_CODE_AUTO_COMPACT_WINDOW`
// 截到模型窗口(2.1.283 的 autocompact_state 说明原文:"clamped to the model window")。
// 于是「执行器配 600k、模型没开 1M」= 实际按 200k 算,触发点从 ~480k 掉到 ~149k,
// 而界面上照样写着 600k —— 任务隔几步就压一次,看上去像 CLI 抽风。
// 判定集中在这一份,设置页、会话尾栏的上下文胶囊、执行器起进程三处共用。

export const CONTEXT_1M_SUFFIX = "[1m]";
export const CLAUDE_STANDARD_WINDOW = 200_000;
export const CLAUDE_1M_WINDOW = 1_000_000;

export function stripContext1mSuffix(model: string): string {
  const trimmed = model.trimEnd();
  return trimmed.toLowerCase().endsWith(CONTEXT_1M_SUFFIX)
    ? trimmed.slice(0, -CONTEXT_1M_SUFFIX.length).trimEnd()
    : model;
}

export function hasContext1mSuffix(model: string): boolean {
  return model.trimEnd().toLowerCase().endsWith(CONTEXT_1M_SUFFIX);
}

export function modelUsesContext1m(model: string | null | undefined, configured: readonly string[]): boolean {
  if (!model) return false;
  const base = stripContext1mSuffix(model).trim();
  return configured.some((candidate) => candidate.trim() === base);
}

type ProviderFacts = Pick<LlmProvider, "id" | "name" | "protocol" | "model" | "context1mModels" | "hasKey">;

/** 为什么这一档按不出「开启 1M」—— 前端按它换一句可执行的说法。 */
export type Context1mBlocker =
  /** 没挂供应商:官方账号只认模型名里的 `[1m]`。 */
  | { kind: "official" }
  /** 挂了供应商但没填 key:执行器起跑时会退回官方账号(server executors/index.ts loadRelay)。 */
  | { kind: "no-key"; provider: { id: string; name: string } }
  /** 额外参数里自带 `--model`,排在 ash 那份之后,覆盖了这里判的模型。 */
  | { kind: "extra-args-model"; model: string };

export interface ClaudeModelWindow {
  /** 去掉 `[1m]` 后缀的模型名。 */
  model: string;
  /** 下一次起跑 CLI 会按多大窗口算。 */
  window: number;
  /** 能一键开启 1M 的那家供应商;按不了时是 null,原因在 blocker。 */
  provider: { id: string; name: string } | null;
  blocker: Context1mBlocker | null;
}

/** 参数里最后一个 `--model` 的值(claude 对重复选项取最后一个)。 */
export function lastModelArg(args: readonly string[]): string | null {
  let model: string | null = null;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (arg === "--model" && index + 1 < args.length) model = args[index + 1]!;
    else if (arg.startsWith("--model=")) model = arg.slice("--model=".length);
  }
  return model?.trim() || null;
}

/**
 * 这条会话**实际起跑时**传给 CLI 的模型(含 `[1m]` 后缀与否),从会话固化的命令行里读。
 * 当前执行器配置只说明下一次怎么起,解释不了已经在跑的这一轮(第 1 轮审查 F1)。
 */
export function launchedModelOf(commandLine: string | null | undefined): string | null {
  return commandLine ? lastModelArg(commandLine.split(/\s+/)) : null;
}

/**
 * 这个 claude 执行器**下一次起跑**时 CLI 认的窗口是多大。判据必须跟起跑那一侧逐条对齐
 * (第 1 轮审查 F2):供应商得是 anthropic 协议**且有 key** 才真的挂上,否则退回官方账号;
 * 额外参数里的 `--model` 排在后面、会覆盖选中的模型,而 ash 只给选中的模型补 `[1m]`。
 *
 * `model` 为空 = 跟随执行器默认,挂了供应商就退到供应商的默认模型;都没有就判不出来,返回 null
 * (官方账号的别名 `opus`/`sonnet` 指向哪个具体模型、窗口多大,ash 这边不知道 —— 不猜)。
 */
export function claudeModelWindow(
  model: string | null | undefined,
  provider: ProviderFacts | null | undefined,
  extraArgs: readonly string[] = [],
): ClaudeModelWindow | null {
  const relay = provider?.protocol === "anthropic" && provider.hasKey ? provider : null;
  const overridden = lastModelArg(splitProfileExtraArgs(extraArgs));
  if (overridden) {
    return {
      model: stripContext1mSuffix(overridden).trim(),
      window: hasContext1mSuffix(overridden) ? CLAUDE_1M_WINDOW : CLAUDE_STANDARD_WINDOW,
      provider: null,
      blocker: { kind: "extra-args-model", model: overridden },
    };
  }
  const picked = (model?.trim() || relay?.model.trim() || "");
  if (!picked) return null;
  const base = stripContext1mSuffix(picked).trim();
  const is1m = hasContext1mSuffix(picked) || (!!relay && modelUsesContext1m(base, relay.context1mModels));
  const blocker: Context1mBlocker | null = relay
    ? null
    : provider?.protocol === "anthropic"
      ? { kind: "no-key", provider: { id: provider.id, name: provider.name } }
      : { kind: "official" };
  return {
    model: base,
    window: is1m ? CLAUDE_1M_WINDOW : CLAUDE_STANDARD_WINDOW,
    provider: relay ? { id: relay.id, name: relay.name } : null,
    blocker,
  };
}

/** 配的压缩窗口比模型窗口大 = CLI 会把它截到模型窗口。没截就返回 null。 */
export function clampedCompactWindow(
  configured: number | null | undefined,
  modelWindow: number | null | undefined,
): { configured: number; effective: number } | null {
  if (typeof configured !== "number" || !Number.isFinite(configured) || configured <= 0) return null;
  if (typeof modelWindow !== "number" || !Number.isFinite(modelWindow) || modelWindow <= 0) return null;
  return configured > modelWindow ? { configured, effective: modelWindow } : null;
}
