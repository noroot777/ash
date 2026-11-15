// 新建框里 `@` 一个人：跟任务回复框同一套（叫谁、来做什么的状态在 task-detail/useReplyCall.ts，框顶那一行是
// ReplyCallDock，讨论时那颗胶囊是 DiscussCapsule），只是这里没有「派出去」——要他来跑这条任务，在胶囊上选他。
// 叫着人时底栏是两颗胶囊：这条任务自己的执行器缩成一段排在前面，后面是被叫的那个人，各改各的。
// 叫谁、来做什么存在新建框的草稿里（跟正文同生共死），切走再回来还在。
import { useEffect } from "react";
import type { AgentExecutorProfile, AgentType } from "@ash/shared";
import type { DraftHandle } from "../lib/DraftStore.tsx";
import { executorRunSummary, registeredAgentTypes } from "../lib/agentAvailability.ts";
import { RunTargetPicker } from "../components/RunTargetPicker.tsx";
import { CallCancelKey, ReplyCallDock } from "../task-detail/ReplyCallDock.tsx";
import { DiscussCapsule } from "../task-detail/ReplyDiscussSegments.tsx";
import { useReplyCall } from "../task-detail/useReplyCall.ts";
import { COMPOSER_CALL_ABILITY } from "./composerOpening.ts";

export function useComposerCall({ host, profiles, draft }: {
  host: AgentType;
  profiles: AgentExecutorProfile[];
  draft: Pick<DraftHandle, "call" | "setCall">;
}) {
  const calling = useReplyCall({ ownAgent: host, ability: COMPOSER_CALL_ABILITY, profiles, state: [draft.call, draft.setCall] });
  // 胶囊换成了叫着的那个人：他现在就是跑这条任务的那个，不再算被叫来的。
  useEffect(() => calling.drop(host), [host]);
  // `@` 菜单里能叫的人：已注册的执行器里除了这条任务自己的那个（@ 它没有意义，它本来就是跑这条任务的）。
  const callable = registeredAgentTypes(profiles).filter((type) => type !== host);
  return { ...calling, callable };
}

export type ComposerCall = ReturnType<typeof useComposerCall>;

/** 框顶那一行：叫来的人来做什么（问一句 / 讨论）。不叫人时不出。 */
export function ComposerCallDock({ calling, onCancel }: { calling: ComposerCall; onCancel: () => void }) {
  if (!calling.call) return null;
  return <ReplyCallDock call={calling.call} self={false} ability={COMPOSER_CALL_ABILITY} onVerb={calling.setVerb}
    onCancel={onCancel} baseError={null} onRetryBase={() => {}} />;
}

/** 叫着人时排在这条任务自己那颗胶囊后面的：被叫的人（讨论时是「和谁 · 几轮」），加一颗不叫了的小叉。 */
export function ComposerCallCapsule({ calling, host, profiles, disabled, onCancel }: {
  calling: ComposerCall;
  host: AgentType;
  profiles: AgentExecutorProfile[];
  disabled: boolean;
  onCancel: () => void;
}) {
  const { call, callable } = calling;
  if (!call) return null;
  const { target } = call;
  const summary = executorRunSummary({ agentType: target.agent, executorId: target.executorId }, profiles,
    { model: target.model, effort: target.reasoningEffort });
  const types = callable.length ? callable : [target.agent];
  return <>
    {call.verb === "discuss"
      ? <DiscussCapsule call={call} types={types} profiles={profiles} ownAgent={host} disabled={disabled}
        model={summary.model} effort={summary.effort ?? ""} onToggle={calling.togglePerson} onRounds={calling.setRounds}
        onCommit={calling.commitTarget} onEffortChange={calling.commitEffort} />
      : <RunTargetPicker label={`叫来的智能体：${target.agent}`} types={types} profiles={profiles}
        selection={{ agentType: target.agent, executorId: target.executorId }} model={summary.model}
        effort={summary.effort ?? ""} variant="chip" highlight disabled={disabled}
        onCommit={calling.commitTarget} onEffortChange={calling.commitEffort} />}
    <CallCancelKey agent={target.agent} onCancel={onCancel} />
  </>;
}
