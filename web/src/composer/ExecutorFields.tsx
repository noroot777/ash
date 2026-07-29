import type { ReactNode } from "react";
import type { AgentExecutorProfile, AgentType, LlmProvider } from "@harness/shared";
import { sameExecutor } from "@harness/shared/executors";
import { Crown, MagnifyingGlass, Robot } from "@phosphor-icons/react";
import { ExecutorPicker, type ExecutorSelection } from "../ExecutorPicker";
import { TaskModelControls } from "../TaskModelControls";

// 「谁来干活 + 用什么模型」是一组不可分的选择：换了执行器，原来那套模型/思考强度
// 多半在新执行器上根本不存在（换类型自不必说；同类型换 profile 也可能换了供应商，
// 模型 id 各认各的），所以清空由这里统一负责——单任务和团队的调度者/执行者三处共用
// 同一份逻辑，免得再漏掉一处（辩论链路就漏过一次）。判定走 shared 的 sameExecutor，
// 与服务端创建/编辑路径同一条口径。
export function ExecutorField({

  icon,
  selection,
  types,
  label,
  profiles,
  providers,
  model,
  reasoningEffort,
  onSelect,
  onModel,
  onReasoningEffort,
  onOpenAgents,
  className = "flex flex-wrap items-center gap-1.5",
}: {
  icon: ReactNode;
  selection: ExecutorSelection;
  types: AgentType[];
  label?: ReactNode;
  profiles: AgentExecutorProfile[];
  providers: LlmProvider[];
  model: string;
  reasoningEffort: string;
  onSelect: (sel: ExecutorSelection) => void;
  onModel: (v: string) => void;
  onReasoningEffort: (v: string) => void;
  onOpenAgents?: () => void;
  className?: string;
}) {
  return (
    <div className={className}>
      <ExecutorPicker
        icon={icon}
        selection={selection}
        onSelect={(next) => {
          if (!sameExecutor(next, selection)) {
            onModel("");
            onReasoningEffort("");
          }
          onSelect(next);
        }}
        profiles={profiles}
        providers={providers}
        types={types}
        label={label}
        includeManage={!!onOpenAgents}
        onOpenAgents={onOpenAgents}
        menuWidth={320}
      />
      <TaskModelControls
        selection={selection}
        profiles={profiles}
        providers={providers}
        model={model}
        reasoningEffort={reasoningEffort}
        onModelChange={onModel}
        onReasoningEffortChange={onReasoningEffort}
      />
    </div>
  );
}

export type RoleExecutorState = {
  selection: ExecutorSelection;
  types: AgentType[];
  model: string;
  reasoningEffort: string;
  onSelect: (sel: ExecutorSelection) => void;
  onModel: (v: string) => void;
  onReasoningEffort: (v: string) => void;
};

const roleClass = "flex flex-wrap items-center gap-1.5 rounded-xl bg-raised/50 p-1";

// 团队模式的两组执行器：调度者(常驻拆活)和默认执行者(真正干活的那批)。
export function TeamExecutorFields({
  lead,
  worker,
  reviewer,
  reviewEnabled = true,
  onReviewEnabled,
  profiles,
  providers,
  onOpenAgents,
}: {
  lead: RoleExecutorState;
  worker: RoleExecutorState;
  reviewer?: RoleExecutorState;
  reviewEnabled?: boolean;
  onReviewEnabled?: (enabled: boolean) => void;
  profiles: AgentExecutorProfile[];
  providers: LlmProvider[];
  onOpenAgents?: () => void;
}) {
  const name = (sel: ExecutorSelection) =>
    profiles.find((a) => a.id === sel.executorId)?.name ?? `默认 ${sel.agentType}`;
  return (
    <>
      <ExecutorField
        {...lead}
        icon={<Crown size={14} />}
        label={`调度者 ${name(lead.selection)}`}
        profiles={profiles}
        providers={providers}
        onOpenAgents={onOpenAgents}
        className={roleClass}
      />
      <ExecutorField
        {...worker}
        icon={<Robot size={14} />}
        label={`执行者 ${name(worker.selection)}`}
        profiles={profiles}
        providers={providers}
        onOpenAgents={onOpenAgents}
        className={roleClass}
      />
      {reviewer && (
        <div className={`${roleClass} gap-2`}>
          <button
            type="button"
            role="switch"
            aria-checked={reviewEnabled}
            onClick={() => onReviewEnabled?.(!reviewEnabled)}
            className={`relative h-5 w-9 shrink-0 rounded-full transition-colors ${reviewEnabled ? "bg-violet-600" : "bg-line2"}`}
          >
            <span className={`absolute left-0 top-0.5 h-4 w-4 rounded-full bg-white shadow-sm transition-transform ${reviewEnabled ? "translate-x-[18px]" : "translate-x-0.5"}`} />
          </button>
          <span className={`shrink-0 text-[11.5px] font-medium ${reviewEnabled ? "text-violet-700" : "text-muted"}`}>
            自动审查
          </span>
          {reviewEnabled && (
            <ExecutorField
              {...reviewer}
              icon={<MagnifyingGlass size={14} />}
              label={`审查者 ${name(reviewer.selection)}`}
              profiles={profiles}
              providers={providers}
              onOpenAgents={onOpenAgents}
              className="flex flex-wrap items-center gap-1.5"
            />
          )}
        </div>
      )}
    </>
  );
}
