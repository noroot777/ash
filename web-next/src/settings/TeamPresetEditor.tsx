import type {
  AgentExecutorProfile,
  AgentType,
  LlmProvider,
  TeamPresetConfig,
} from "@harness/shared";
import { AGENT_TYPES } from "@harness/shared";
import { REASONING_EFFORT_VALUES } from "@harness/shared/cli-presets";
import { CrownSimple, MagnifyingGlass, Robot } from "@phosphor-icons/react";
import { Toggle } from "../components/ui.tsx";
import { ProviderModelInput } from "./ProviderModelInput.tsx";

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

export function createTeamPresetDraft(): TeamPresetDraft {
  const role = (agentType: AgentType): RoleDraft => ({
    agentType,
    executorId: null,
    model: "",
    reasoningEffort: "",
  });
  return {
    name: "",
    review: true,
    roles: {
      lead: role("claude"),
      worker: role("codex"),
      reviewer: role("codex"),
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

const ROLE_META = {
  lead: { label: "调度者", hint: "维持团队会话并分派工作", icon: CrownSimple },
  worker: { label: "执行者", hint: "接收调度并完成具体任务", icon: Robot },
  reviewer: { label: "审查者", hint: "在执行完成后独立验收", icon: MagnifyingGlass },
} as const;

function TeamRoleFields({
  role,
  value,
  profiles,
  providers,
  disabled,
  onChange,
}: {
  role: PresetRole;
  value: RoleDraft;
  profiles: AgentExecutorProfile[];
  providers: LlmProvider[];
  disabled: boolean;
  onChange: (value: RoleDraft) => void;
}) {
  const meta = ROLE_META[role];
  const Icon = meta.icon;
  const matchingProfiles = profiles.filter((profile) => profile.type === value.agentType);
  const selectedProfile = value.executorId
    ? matchingProfiles.find((profile) => profile.id === value.executorId)
    : undefined;
  const provider = selectedProfile?.providerId
    ? providers.find((candidate) => candidate.id === selectedProfile.providerId)
    : undefined;
  const staleExecutor = !!value.executorId && !selectedProfile;

  return (
    <section className={`team-preset-role is-${role}`}>
      <header>
        <span><Icon size={15} weight={role === "worker" ? "fill" : "regular"} /></span>
        <div><b>{meta.label}</b><small>{meta.hint}</small></div>
      </header>
      <div className="team-preset-role-fields">
        <label>
          <span>智能体类型</span>
          <select
            value={value.agentType}
            disabled={disabled}
            onChange={(event) => onChange({
              agentType: event.target.value as AgentType,
              executorId: null,
              model: "",
              reasoningEffort: "",
            })}
          >
            {AGENT_TYPES.map((type) => <option value={type} key={type}>{type}</option>)}
          </select>
        </label>
        <label>
          <span>执行器 Profile</span>
          <select
            value={value.executorId ?? ""}
            disabled={disabled}
            onChange={(event) => onChange({
              ...value,
              executorId: event.target.value || null,
              model: "",
              reasoningEffort: "",
            })}
          >
            <option value="">类型默认</option>
            {staleExecutor && <option value={value.executorId ?? ""} disabled>当前执行器已不可用</option>}
            {matchingProfiles.map((profile) => (
              <option value={profile.id} key={profile.id}>
                {profile.name}{profile.isDefault ? "（默认）" : ""}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span>模型</span>
          <ProviderModelInput
            inputId={`team-preset-${role}-model`}
            type={value.agentType}
            provider={provider}
            value={value.model}
            disabled={disabled}
            compact
            onChange={(model) => onChange({ ...value, model })}
          />
        </label>
        <label>
          <span>思考强度</span>
          <select
            value={value.reasoningEffort}
            disabled={disabled}
            onChange={(event) => onChange({ ...value, reasoningEffort: event.target.value })}
          >
            <option value="">跟随执行器</option>
            {REASONING_EFFORT_VALUES[value.agentType].map((effort) => (
              <option value={effort} key={effort}>{effort}</option>
            ))}
          </select>
        </label>
      </div>
    </section>
  );
}

export function TeamPresetEditor({
  draft,
  profiles,
  providers,
  busy,
  onChange,
}: {
  draft: TeamPresetDraft;
  profiles: AgentExecutorProfile[];
  providers: LlmProvider[];
  busy: boolean;
  onChange: (draft: TeamPresetDraft) => void;
}) {
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
          providers={providers}
          disabled={busy}
          onChange={(value) => changeRole(role, value)}
        />
      ))}
    </div>
  );
}
