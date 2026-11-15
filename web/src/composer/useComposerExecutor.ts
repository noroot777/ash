// 新建框里「这条任务由谁跑」（胶囊上那一套）。它跟正文、叫的人一起存在草稿里（DraftStore 的 executor）：
// 叫来的人算不算「叫自己」由它定，面板关了再开要是退回默认值，叫来的人就会被当成叫自己删掉。
// 任务已经建好、在等重发第一回合时，以那条任务的实际配置为准，而且不让改——改了也落不到已建好的任务上。
import { useMemo } from "react";
import type { AgentExecutorProfile, AgentType } from "@ash/shared";
import { executorValue, parseExecutorValue } from "../lib/agentAvailability.ts";
import type { DraftHandle } from "../lib/DraftStore.tsx";
import {
  emptyComposerExecutorConfigs,
  initialComposerExecutors,
  patchComposerExecutor,
  reconcileComposerExecutors,
  setComposerExecutorProfile,
  type ComposerExecutorConfig,
} from "./executorOverrides.ts";

export function useComposerExecutor({ draft, profiles, profilesReady, types }: {
  draft: Pick<DraftHandle, "executor" | "setExecutor" | "created">;
  profiles: AgentExecutorProfile[];
  profilesReady: boolean;
  types: AgentType[];
}) {
  const stored = draft.executor;
  const createdTask = draft.created?.task ?? null;
  // 没选过就用默认的那个；注册表读回来之后再拉回「当下真的能选」的（纯计算，不写回草稿）。profilesReady 只认读成功。
  const chosen = useMemo<ComposerExecutorConfig>(() => {
    const base = stored ? { single: stored } : initialComposerExecutors(emptyComposerExecutorConfigs(), profiles);
    return (profilesReady ? reconcileComposerExecutors(base, { profiles, types }) : base).single;
  }, [profiles, profilesReady, stored, types]);
  const config = useMemo<ComposerExecutorConfig>(() => (createdTask ? {
    profile: executorValue({ agentType: createdTask.agentType ?? "claude", executorId: createdTask.executorId ?? null }),
    model: createdTask.model ?? "",
    effort: createdTask.reasoningEffort ?? "",
  } : chosen), [chosen, createdTask]);
  // 已建好的那条：是谁就是谁，直接取它存着的，不拿注册表反查——注册表读不到、那个执行器后来删了，它也还是它。
  const selection = createdTask
    ? { agentType: createdTask.agentType ?? "claude", executorId: createdTask.executorId ?? null }
    : parseExecutorValue(config.profile, profiles, { agentType: "claude", executorId: null });
  const run = {
    agentType: selection.agentType,
    executorId: selection.executorId,
    model: config.model || null,
    reasoningEffort: config.effort || null,
  };
  const configs = { single: chosen };
  return {
    config,
    run,
    /** 任务已经建好：胶囊只读。 */
    locked: !!createdTask,
    change: (profile: string, override: { model: string; effort: string }) =>
      draft.setExecutor(setComposerExecutorProfile(configs, "single", profile, override).single),
    changeEffort: (effort: string) => draft.setExecutor(patchComposerExecutor(configs, "single", { effort }).single),
  };
}
