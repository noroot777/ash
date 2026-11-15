// 「派出去的活交给谁」：回复框底栏那颗胶囊点开智能体那一段，列表下面一行（RunTargetPicker 的 agentExtra）。
// 同这里 = 这条任务自己的那一套；或者指定一个（同一颗三段胶囊）。派活单上没指明的那几条、智能体绕过派活单
// 直接建任务又没给执行器的，都交给它（服务端 task-dispatch.ts `withDispatchDefaults`）。
// 设成了非默认值时，底栏胶囊最后多一段「派活 codex」，不点开也看得出来。
import type { AgentExecutorProfile, AgentType } from "@ash/shared";
import type { DispatchRunTarget } from "@ash/shared/dispatch-plan";
import { RunTargetPicker } from "../components/RunTargetPicker.tsx";
import { executorRunSummary } from "../lib/agentAvailability.ts";

// 没指定执行器 = 那个 CLI 的默认执行器（服务端照这个解析），写它的名字。
const nameOf = (target: DispatchRunTarget, profiles: AgentExecutorProfile[]) =>
  profiles.find((profile) => target.executorId
    ? profile.id === target.executorId
    : profile.type === target.agentType && profile.isDefault)?.name ?? target.agentType;

export function DispatchDefaultRow({ value, here, types, profiles, disabled, onChange }: {
  /** null = 同这里 */
  value: DispatchRunTarget | null;
  /** 这条任务自己此刻的那一套（同这里时胶囊上写它）。 */
  here: DispatchRunTarget;
  types: AgentType[];
  profiles: AgentExecutorProfile[];
  disabled: boolean;
  onChange: (next: DispatchRunTarget | null) => void;
}) {
  const shown = value ?? here;
  const executorId = shown.executorId
    ?? profiles.find((profile) => profile.type === shown.agentType && profile.isDefault)?.id ?? null;
  const summary = executorRunSummary({ agentType: shown.agentType, executorId }, profiles,
    { model: shown.model, effort: shown.reasoningEffort });
  return (
    <div className="dispatch-default-row" role="group" aria-label="派出去的活交给谁">
      <span aria-hidden="true">派出去的活</span>
      <button type="button" className="dispatch-default-same" aria-pressed={!value} disabled={disabled}
        aria-label="派出去的活交给谁：同这里" onClick={() => onChange(null)}>同这里</button>
      <RunTargetPicker
        label={value ? `派出去的活交给 ${nameOf(value, profiles)}` : "派出去的活：指定一个执行器"}
        types={types}
        profiles={profiles}
        selection={{ agentType: shown.agentType, executorId }}
        model={summary.model ?? null}
        effort={summary.effort ?? ""}
        variant="chip"
        highlight={!!value}
        disabled={disabled}
        onCommit={(next) => onChange({
          agentType: next.agent, executorId: next.executorId, model: next.model,
          reasoningEffort: value && next.agent === value.agentType ? value.reasoningEffort : null,
        })}
        onEffortChange={(effort) => onChange({ ...shown, reasoningEffort: effort || null })}
      />
    </div>
  );
}

/** 底栏胶囊最后那一段：设成了非默认值才有。 */
export function DispatchDefaultSegment({ value, profiles }: { value: DispatchRunTarget; profiles: AgentExecutorProfile[] }) {
  const name = nameOf(value, profiles);
  return (
    <span className="run-target-seg run-target-seg--tail dispatch-default-seg" aria-label={`派出去的活交给 ${name}`}>
      派活 <code>{name}</code>
    </span>
  );
}
