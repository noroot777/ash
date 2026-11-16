// 新建框里 `@` 一个人：跟任务回复框同一套（叫谁、来做什么的状态在 task-detail/useReplyCall.ts，框顶那一行是
// ReplyCallDock，讨论时那颗胶囊是 DiscussCapsule），只是这里没有「派出去」——要他来跑这条任务，在胶囊上选他。
// 叫着人时底栏是两颗胶囊：这条任务自己的执行器缩成一段排在前面，后面是被叫的那个人，各改各的。
// 叫谁、来做什么存在新建框的草稿里（跟正文同生共死），切走再回来还在。叫来的人只在用户亲手把胶囊换成他时拿掉
// （面板上的 changeExecutor）——不跟着 host 的值走：重开面板、注册表还没读回或读失败时 host 只是个临时值，
// 拿它删人就把安排删了（新建框第 2、3 轮审查）。
import type { AgentExecutorProfile, AgentType } from "@ash/shared";
import type { DraftHandle } from "../lib/DraftStore.tsx";
import { executorRunSummary, registeredAgentTypes } from "../lib/agentAvailability.ts";
import { RunTargetPicker } from "../components/RunTargetPicker.tsx";
import { CallCancelKey, ReplyCallDock } from "../task-detail/ReplyCallDock.tsx";
import { DiscussCapsule } from "../task-detail/ReplyDiscussSegments.tsx";
import { useReplyCall } from "../task-detail/useReplyCall.ts";
import { COMPOSER_CALL_ABILITY } from "./composerOpening.ts";

export function useComposerCall({ host, profiles, draft }: {
  /** 这条任务由谁跑（草稿里存着的那一套，任务已建好时是那条任务的）。 */
  host: AgentType;
  profiles: AgentExecutorProfile[];
  draft: Pick<DraftHandle, "call" | "setCall">;
}) {
  const calling = useReplyCall({ ownAgent: host, ability: COMPOSER_CALL_ABILITY, profiles, state: [draft.call, draft.setCall] });
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
