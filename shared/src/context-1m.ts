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

type ProviderFacts = Pick<LlmProvider, "id" | "name" | "protocol" | "model" | "context1mModels">;

export interface ClaudeModelWindow {
  /** 去掉 `[1m]` 后缀的模型名。 */
  model: string;
  /** CLI 会按多大窗口算。 */
  window: number;
  /** 能一键开启 1M 的那家供应商;官方账号(没挂供应商)只能换带 `[1m]` 的模型名,给 null。 */
  provider: { id: string; name: string } | null;
}

/**
 * 这个 claude 执行器跑 `model` 时,CLI 认的窗口是多大。
 * `model` 为空 = 跟随执行器默认,挂了供应商就退到供应商的默认模型;都没有就判不出来,返回 null
 * (官方账号的别名 `opus`/`sonnet` 指向哪个具体模型、窗口多大,ash 这边不知道 —— 不猜)。
 */
export function claudeModelWindow(
  model: string | null | undefined,
  provider: ProviderFacts | null | undefined,
): ClaudeModelWindow | null {
  const picked = (model?.trim() || provider?.model.trim() || "");
  if (!picked) return null;
  const base = stripContext1mSuffix(picked).trim();
  const relay = provider?.protocol === "anthropic" ? provider : null;
  const is1m = hasContext1mSuffix(picked) || (!!relay && modelUsesContext1m(base, relay.context1mModels));
  return {
    model: base,
    window: is1m ? CLAUDE_1M_WINDOW : CLAUDE_STANDARD_WINDOW,
    provider: relay ? { id: relay.id, name: relay.name } : null,
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
