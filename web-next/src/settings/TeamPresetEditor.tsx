import type {
  AgentExecutorProfile,
  AgentType,
  LlmProvider,
  TeamPresetConfig,
} from "@harness/shared";
import { CrownSimple, MagnifyingGlass, Robot } from "@phosphor-icons/react";
import { Dropdown } from "../components/Dropdown.tsx";
import { Toggle } from "../components/ui.tsx";
import {
  registeredAgentTypes,
  residentAgentTypes,
  useAgentAvailability,
} from "../lib/agentAvailability.ts";
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
  providers,
  residentTypes,
  preserveStaleType,
  disabled,
  onChange,
}: {
  role: PresetRole;
  value: RoleDraft;
  profiles: AgentExecutorProfile[];
  providers: LlmProvider[];
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
  const showStaleType = staleType && preserveStaleType;
  const selectValue = staleType && !preserveStaleType ? "" : value.agentType;
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
      <header title={meta.hint}>
        <span><Icon size={15} weight={role === "worker" ? "fill" : "regular"} aria-hidden="true" /></span>
        <b>{meta.label}</b>
      </header>
      <div className="team-preset-role-fields">
        <label>
          <span>智能体类型</span>
          <Dropdown
            label={`${meta.label} 的智能体类型`}
            value={selectValue}
            options={[
              ...(showStaleType
                ? [{ value: value.agentType, label: value.agentType, detail: staleReason }]
                : []),
              ...typeOptions.map((type) => ({ value: type, label: type })),
            ]}
            disabled={disabled || typeOptions.length === 0}
            filterable={typeOptions.length > 6}
            placeholder={typeOptions.length
              ? "请选择已注册类型"
              : leadOnly ? "暂无已注册的常驻类型" : "暂无已注册类型"}
            onChange={(agentType) => onChange({
              agentType: agentType as AgentType,
              executorId: null,
              model: "",
              reasoningEffort: "",
            })}
          />
        </label>
        <label>
          <span>执行器 Profile</span>
          <Dropdown
            label={`${meta.label} 的执行器 Profile`}
            value={value.executorId ?? ""}
            options={[
              { value: "", label: "类型默认" },
              ...(staleExecutor
                ? [{ value: value.executorId ?? "", label: "当前执行器", detail: "已不可用" }]
                : []),
              ...matchingProfiles.map((profile) => ({
                value: profile.id,
                label: profile.name,
                detail: profile.isDefault ? "默认" : "",
              })),
            ]}
            disabled={disabled || (staleType && !preserveStaleType)}
            filterable={matchingProfiles.length > 6}
            placeholder="类型默认"
            onChange={(executorId) => onChange({
              ...value,
              executorId: executorId || null,
              model: "",
              reasoningEffort: "",
            })}
          />
        </label>
        <label>
          <span>模型与思考强度</span>
          <ProviderModelInput
            type={value.agentType}
            provider={provider}
            value={value.model}
            disabled={disabled || (staleType && !preserveStaleType)}
            compact
            effort={{
              value: value.reasoningEffort,
              onChange: (reasoningEffort) => onChange({ ...value, reasoningEffort }),
            }}
            onChange={(model) => onChange({ ...value, model })}
          />
        </label>
      </div>
      {staleType && (
        <p className="team-preset-role-warning">
          {!preserveStaleType
            ? typeOptions.length
              ? "请选择类型下拉中已注册的智能体类型。"
              : leadOnly
                ? "还没有已注册且支持常驻会话的调度者类型。"
                : "还没有已注册的智能体类型。"
            : staleReason === "未注册"
              ? `${value.agentType} 当前没有已注册执行器；请先注册，或改选类型下拉里的其它类型。`
              : `${value.agentType} 不支持常驻会话，当不了调度者；用这个预设建团队时会被拦下。请改选类型下拉里的其它类型。`}
        </p>
      )}
    </section>
  );
}

export function TeamPresetEditor({
  draft,
  profiles,
  providers,
  busy,
  preserveStaleTypes = false,
  onChange,
}: {
  draft: TeamPresetDraft;
  profiles: AgentExecutorProfile[];
  providers: LlmProvider[];
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
          providers={providers}
          residentTypes={residentTypes}
          preserveStaleType={preserveStaleTypes}
          disabled={busy}
          onChange={(value) => changeRole(role, value)}
        />
      ))}
    </div>
  );
}
