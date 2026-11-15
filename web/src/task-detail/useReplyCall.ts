import { useCallback, useEffect, useState } from "react";
import type { AgentExecutorProfile, AgentType } from "@ash/shared";
import { sameExecutor } from "@ash/shared/executors";
import { api } from "../lib/api.ts";
import type { AgentModelSelection, MentionTarget } from "./mentionPicker.ts";
import {
  initialVerb, isSelfCall, rememberCall, rememberedTarget,
  type BaseContext, type CallVerb, type DispatchBase, type ReplyCall,
} from "./replyCall.ts";

/**
 * 回复框里叫了谁、来做什么（纯逻辑在 replyCall.ts）。叫人只活在这一个框里：换任务、发出去、点小叉
 * 都清掉；正文、附件不归它管，换做法、取消叫人一个字都不动。
 */
export function useReplyCall({ ownAgent, dispatchable, profiles }: {
  /** 这条任务自己的执行器：叫它只能派出去。 */
  ownAgent: AgentType;
  /** 这里能不能派出去（普通的独立任务才能）。 */
  dispatchable: boolean;
  profiles: AgentExecutorProfile[];
}) {
  const [call, setCall] = useState<ReplyCall | null>(null);
  // 记下的执行器后来被删了：退回「这个执行器类型的默认」，别把一个不存在的 id 发出去。
  const known = (target: MentionTarget): MentionTarget => (
    target.executorId && profiles.length && !profiles.some((profile) => profile.id === target.executorId)
      ? { ...target, executorId: null } : target
  );
  const selfOf = (agent: AgentType) => isSelfCall(agent, ownAgent);

  const start = (agent: AgentType, prefer: CallVerb | null = null) => {
    setCall({ target: known(rememberedTarget(agent)), verb: initialVerb(selfOf(agent), prefer, dispatchable), base: "here" });
  };
  /** 撤回一条排着的召唤：放回当初叫的那一套。 */
  const restore = (target: MentionTarget) => setCall({ target, verb: "ask", base: "here" });
  const setVerb = (verb: CallVerb) => setCall((current) => (
    !current || (verb === "ask" && dispatchable && selfOf(current.target.agent)) ? current : { ...current, verb }
  ));
  const setBase = (base: DispatchBase) => setCall((current) => (current ? { ...current, base } : current));
  // 胶囊上换人 / 换模型：执行器没换就把已选的智能水平留着，换了执行器才清成「跟随」（旧档位在新 CLI 上
  // 多半根本不存在）。换成这条任务自己的执行器，就只剩「派出去」。
  const commitTarget = (next: AgentModelSelection) => setCall((current) => {
    if (!current) return current;
    const kept = sameExecutor(
      { agentType: next.agent, executorId: next.executorId },
      { agentType: current.target.agent, executorId: current.target.executorId },
    );
    return {
      ...current,
      target: { ...next, reasoningEffort: kept ? current.target.reasoningEffort : null },
      verb: dispatchable && selfOf(next.agent) ? "dispatch" : current.verb,
    };
  });
  const commitEffort = (effort: string) => setCall((current) => (
    current ? { ...current, target: { ...current.target, reasoningEffort: effort || null } } : current
  ));
  const cancel = () => setCall(null);
  /** 发出去了：记住叫的是谁、对他用的那一套，下次叫他（或 `/派`）先摆这一套。 */
  const sent = (target: MentionTarget) => {
    rememberCall(target);
    setCall((current) => (current?.target === target ? null : current));
  };

  return {
    call,
    self: !!call && dispatchable && selfOf(call.target.agent),
    start, restore, setVerb, setBase, commitTarget, commitEffort, cancel, sent,
  };
}

/** 派出去时「从哪开工」要的那几样：是不是仓库、有哪些分支、新任务默认开不开 worktree。只在要用时取一次。 */
export function useDispatchBaseContext(projectId: string, active: boolean): { ready: boolean; value: BaseContext | null } {
  const [context, setContext] = useState<{ projectId: string; value: BaseContext | null } | null>(null);
  const load = useCallback(async () => {
    try {
      const [health, branches, projects] = await Promise.all([api.projectHealth(projectId), api.projectBranches(projectId), api.projects()]);
      const project = projects.find((item) => item.id === projectId);
      return { isRepo: health.isRepo, ...branches, worktreeDefault: project?.useWorktreeDefault ?? true };
    } catch {
      // 读不到就不给选：新任务按默认从项目 HEAD 开，跟没有这一段时一样。
      return null;
    }
  }, [projectId]);
  useEffect(() => {
    if (!active || context?.projectId === projectId) return;
    let alive = true;
    void load().then((value) => { if (alive) setContext({ projectId, value }); });
    return () => { alive = false; };
  }, [active, context?.projectId, load, projectId]);
  const ready = context?.projectId === projectId;
  // 读回来之前不让派：那时还不知道「接着这里的代码」落在哪条分支上，按默认发出去会从别处开工。
  return { ready, value: ready ? context.value : null };
}
