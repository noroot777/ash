import type { AgentExecutorProfile, AgentType, TeamPresetConfig } from "@ash/shared";
import { CrownSimple, MagnifyingGlass, Robot } from "@phosphor-icons/react";
import { ExecutorPickerField } from "../composer/ExecutorPickerField.tsx";
import { Toggle } from "../components/ui.tsx";
import {
  executorValue,
  parseExecutorValue,
  registeredAgentTypes,
  residentAgentTypes,
  useAgentAvailability,
} from "../lib/agentAvailability.ts";

type PresetRole = "lead" | "worker" | "reviewer";

type RoleDraft = {
  agentType: AgentType;
  executorId: string | null;
  model: string;
  reasoningEffort: string;
};

export type TeamPresetDraft = {
  name: string;
  review: boolean;
  roles: Record<PresetRole, RoleDraft>;
};

export function createTeamPresetDraft(profiles: AgentExecutorProfile[] = []): TeamPresetDraft {
  const role = (agentType: AgentType): RoleDraft => ({
    agentType,
    executorId: null,
    model: "",
    reasoningEffort: "",
  });
  const registeredTypes = registeredAgentTypes(profiles);
  const residentTypes = residentAgentTypes([]);
  const leadType = registeredTypes.find((type) => residentTypes.includes(type))
    ?? registeredTypes[0]
    ?? "claude";
  const workerType = registeredTypes.find((type) => type === "codex" && type !== leadType)
    ?? registeredTypes.find((type) => type !== leadType)
    ?? registeredTypes[0]
    ?? "codex";
  return {
    name: "",
    review: true,
    roles: {
      lead: role(leadType),
      worker: role(workerType),
      reviewer: role(workerType),
    },
  };
}

export function teamPresetDraftFromConfig(
  name: string,
  config: TeamPresetConfig,
): TeamPresetDraft {
  const reviewerType = config.reviewerAgentType ?? config.worker;
  return {
    name,
    review: config.review !== false,
    roles: {
      lead: {
        agentType: config.lead,
        executorId: config.leadExecutorId ?? null,
        model: config.leadModel ?? "",
        reasoningEffort: config.leadReasoningEffort ?? "",
      },
      worker: {
        agentType: config.worker,
        executorId: config.workerExecutorId ?? null,
        model: config.workerModel ?? "",
        reasoningEffort: config.workerReasoningEffort ?? "",
      },
      reviewer: {
        agentType: reviewerType,
        executorId: config.reviewerExecutorId ?? null,
        model: config.reviewerModel ?? "",
        reasoningEffort: config.reviewerReasoningEffort ?? "",
      },
    },
  };
}

export function teamPresetConfigFromDraft(draft: TeamPresetDraft): TeamPresetConfig {
  return {
    lead: draft.roles.lead.agentType,
    worker: draft.roles.worker.agentType,
    leadExecutorId: draft.roles.lead.executorId,
    workerExecutorId: draft.roles.worker.executorId,
    leadModel: draft.roles.lead.model.trim() || null,
    leadReasoningEffort: draft.roles.lead.reasoningEffort || null,
    workerModel: draft.roles.worker.model.trim() || null,
    workerReasoningEffort: draft.roles.worker.reasoningEffort || null,
    review: draft.review,
    reviewerAgentType: draft.roles.reviewer.agentType,
    reviewerExecutorId: draft.roles.reviewer.executorId,
    reviewerModel: draft.roles.reviewer.model.trim() || null,
    reviewerReasoningEffort: draft.roles.reviewer.reasoningEffort || null,
  };
}

export const ROLE_META = {
  lead: { label: "调度者", hint: "维持团队会话并分派工作", icon: CrownSimple },
  worker: { label: "执行者", hint: "接收调度并完成具体任务", icon: Robot },
  reviewer: { label: "审查者", hint: "在执行完成后独立验收", icon: MagnifyingGlass },
} as const;

function TeamRoleFields({
  role,
  value,
  profiles,
  residentTypes,
  preserveStaleType,
  disabled,
  onChange,
}: {
  role: PresetRole;
  value: RoleDraft;
  profiles: AgentExecutorProfile[];
  /** 能开常驻会话的类型——只有它们当得了调度者(来源见 detect.ts 的 resident 字段)。 */
  residentTypes: AgentType[];
  /** 编辑存量预设时保留失效当前值作诊断；新建时只展示真正可选的注册类型。 */
  preserveStaleType: boolean;
  disabled: boolean;
  onChange: (value: RoleDraft) => void;
}) {
  const meta = ROLE_META[role];
  const Icon = meta.icon;
  // 调度者要维持一个常驻会话来分派工作,只有实现了 openResident 的执行器扛得住。
  // 别的类型存得进预设、套用时却会被 composer 判成「调度者当前不可运行」而挡住提交
  // ——那时用户已经配完了,所以这一步就把不合格的类型拿掉。
  const leadOnly = role === "lead";
  const registeredTypes = registeredAgentTypes(profiles);
  const typeOptions = registeredTypes.filter((type) => !leadOnly || residentTypes.includes(type));
  const staleType = !typeOptions.includes(value.agentType);
  const staleReason = !registeredTypes.includes(value.agentType)
    ? "未注册"
    : "不支持常驻会话";
  const typeProfiles = profiles.filter((profile) => typeOptions.includes(profile.type));
  return (
    <section className={`team-preset-role is-${role}`}>
      <header>
        <span><Icon size={15} weight={role === "worker" ? "fill" : "regular"} aria-hidden="true" /></span>
        <b>{meta.label}</b>
        <small>{meta.hint}</small>
      </header>
      <div className="team-preset-role-fields">
        {/* 跟新建面板同一副形状：一颗三段胶囊「智能体 · 模型 · 智能水平」。
            见 composer/ExecutorPickerField.tsx。 */}
        <ExecutorPickerField
          label={`${meta.label} 的智能体与模型`}
          value={executorValue({ agentType: value.agentType, executorId: value.executorId })}
          types={typeOptions}
          profiles={typeProfiles}
          knownProfiles={profiles}
          fallbackType={value.agentType}
          override={{ model: value.model, effort: value.reasoningEffort }}
          disabled={disabled}
          onChange={(next, override) => onChange({
            ...value,
            ...parseExecutorValue(next, profiles, { agentType: value.agentType, executorId: null }),
            model: override.model,
            reasoningEffort: override.effort,
          })}
          onEffortChange={(effort) => onChange({ ...value, reasoningEffort: effort })}
        />
      </div>
      {staleType && (
        <p className="team-preset-role-warning">
          {!preserveStaleType
            ? typeOptions.length
              ? "请在执行器胶囊里改选已注册的智能体类型。"
              : leadOnly
                ? "还没有已注册且支持常驻会话的调度者类型。"
                : "还没有已注册的智能体类型。"
            : staleReason === "未注册"
              ? `${value.agentType} 当前没有已注册执行器；请先注册，或在执行器胶囊里改选其它类型。`
              : `${value.agentType} 不支持常驻会话，当不了调度者；用这个预设建团队时会被拦下。请在执行器胶囊里改选其它类型。`}
        </p>
      )}
    </section>
  );
}

export function TeamPresetEditor({
  draft,
  profiles,
  busy,
  preserveStaleTypes = false,
  onChange,
}: {
  draft: TeamPresetDraft;
  profiles: AgentExecutorProfile[];
  busy: boolean;
  /** 编辑已有模式时保留失效值供修复；新建模式不把未注册值混进下拉。 */
  preserveStaleTypes?: boolean;
  onChange: (draft: TeamPresetDraft) => void;
}) {
  // 检测未完成/失败时 residentAgentTypes 回落到内置名单,口径与 composer
  // 一致:「不能证明它装了」不等于「可以放它去当调度者」。
  const detection = useAgentAvailability();
  const residentTypes = residentAgentTypes(detection.agents);
  const changeRole = (role: PresetRole, value: RoleDraft) => {
    onChange({ ...draft, roles: { ...draft.roles, [role]: value } });
  };

  return (
    <div className="team-preset-editor-fields">
      <label className="team-preset-name-field">
        <span>模式名称</span>
        <input
          autoFocus
          maxLength={80}
          value={draft.name}
          disabled={busy}
          placeholder="如：Codex 调度 · Claude 执行"
          onChange={(event) => onChange({ ...draft, name: event.target.value })}
        />
      </label>
      <div className="team-preset-review-row">
        <div><b>自动审查</b><small>执行结束后自动启动审查者验证结果</small></div>
        <Toggle
          checked={draft.review}
          disabled={busy}
          label={draft.review ? "已开启" : "已关闭"}
          onChange={(review) => onChange({ ...draft, review })}
        />
      </div>
      {(["lead", "worker", "reviewer"] as const).map((role) => (
        <TeamRoleFields
          key={role}
          role={role}
          value={draft.roles[role]}
          profiles={profiles}
          residentTypes={residentTypes}
          preserveStaleType={preserveStaleTypes}
          disabled={busy}
          onChange={(value) => changeRole(role, value)}
        />
      ))}
    </div>
  );
}
