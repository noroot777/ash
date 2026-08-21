import type { AgentType, SessionRole } from "@ash/shared";
import type { Workspace } from "./git.js";
import { WORKSPACE_BASE_FALLBACK_MARKER } from "./run-prompts.js";
import { appendTaskTimeline } from "./task-timeline.js";

// 「登记的基线被换掉了」这句话该不该说、怎么说，只有这一份。
//
// 之所以单拎出来：解析工作目录那一刻(`taskWorkspace` → `persistBaseFallback`)就已经把
// `tasks.worktreeBase` **落库改掉**了，而说明原本只写在 spawn 成功之后那条路上。中间任何
// 一步抛错(执行器解析不过、worktree 建不出来、spawn 挂了)，用户就只看见一句「这一轮没能
// 起跑」—— diff / 验收的目标已经悄悄换了人，而且因为库里已经是新值，重试也不会再报一次，
// 这次变更从此无从知晓(审查实测：任务带一个不被支持的 reasoningEffort，base 落成 main、
// 时间线里没有任何基线说明)。所以失败那条路必须自己补上同一句话。
//
// 判据(说不说)与措辞(怎么说)都在这里，成功路径和失败路径共用，免得两边漂。

/**
 * 这一轮值不值得说一句。既没新建工作目录、也没改任务登记值时闭嘴：那一轮什么都没变，
 * 每次都说一遍只是噪音，而「这个 base 交不掉」在验收那头本来就会明说。
 */
export function baseFallbackNote(fallback: Workspace["baseFallback"]): string | null {
  if (!fallback) return null;
  if (!fallback.workspaceRebuilt && !fallback.persisted) return null;
  return WORKSPACE_BASE_FALLBACK_MARKER(
    fallback.requested, fallback.used, fallback, !!fallback.persisted,
  );
}

/**
 * 起跑失败那条路上的同一句话。这时候还没有本回合的会话可写，所以走 appendTaskTimeline
 * 落到被 @ 的那位(或指名续的那条会话)身上 —— 跟失败交代同一个投递口径。
 */
export async function announceBaseFallback(
  taskId: string,
  fallback: Workspace["baseFallback"],
  target?: { sessionId?: string; agentType?: AgentType; role?: SessionRole },
): Promise<void> {
  const note = baseFallbackNote(fallback);
  if (!note) return;
  await appendTaskTimeline(taskId, note, target);
}
