import { useEffect, useMemo, useState } from "react";
import type {
  AgentExecutorProfile,
  AgentType,
  LlmProvider,
} from "@harness/shared";
import { AGENT_TYPES } from "@harness/shared";
import { REASONING_EFFORT_VALUES } from "@harness/shared/cli-presets";
import { Plus, Trash } from "@phosphor-icons/react";
import { Button } from "../components/ui.tsx";
import {
  selectableAgentTypes,
  type AgentDetection,
} from "../lib/agentAvailability.ts";
import { api } from "../lib/api.ts";
import { ConfirmDialog } from "../task-detail/ConfirmDialog.tsx";
import { ExtraArgsEditor } from "./ExtraArgsEditor.tsx";
import {
  providerProtocolForAgent,
  providersForAgent,
} from "./agentProviderRules.ts";
import { ProviderModelInput } from "./ProviderModelInput.tsx";
import { ProfileArgsControl } from "./ProfileArgsControl.tsx";

function profileAvatar(type: AgentType) {
  if (type === "claude") return "C";
  if (type === "codex") return "X";
  if (type === "antigravity") return "A";
  return type.slice(0, 1).toUpperCase();
}

function ProfileRow({
  profile,
  providers,
  onChange,
  notify,
}: {
  profile: AgentExecutorProfile;
  providers: LlmProvider[];
  onChange: (profile: AgentExecutorProfile | null) => void;
  notify: (message: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const providerOptions = providersForAgent(profile.type, providers);
  const provider = providers.find((candidate) => candidate.id === profile.providerId);
  const protocol = providerProtocolForAgent(profile.type);

  const patch = async (value: Partial<AgentExecutorProfile>) => {
    setBusy(true);
    try {
      onChange(await api.patchAgent(profile.id, value));
      return true;
    } catch (error) {
      notify(error instanceof Error ? error.message : "执行器保存失败");
      return false;
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    setBusy(true);
    try {
      await api.deleteAgent(profile.id);
      onChange(null);
    } catch (error) {
      notify(error instanceof Error ? error.message : "执行器删除失败");
      setBusy(false);
    }
  };

  return (
    <>
      <article className="agent-profile-row" role="row">
        <div className="agent-profile-identity">
          <b title={profile.name}>{profile.name}</b>
          <small title={profile.target.kind === "ssh" ? `ssh ${profile.target.host}` : "本地执行"}>
            {profile.target.kind === "ssh" ? `ssh ${profile.target.host}` : "本地"}
          </small>
        </div>
        <div className="agent-profile-cell">
          <select
            aria-label={`${profile.name} 的供应商`}
            title={protocol ? "切换供应商会清除旧模型覆盖" : "该 CLI 暂不支持供应商"}
            disabled={busy || !protocol}
            value={profile.providerId ?? ""}
            onChange={(event) => void patch({
              providerId: event.target.value || null,
              model: "",
            })}
          >
            <option value="">{protocol ? "CLI 官方账号" : "暂不支持"}</option>
            {provider && !providerOptions.some((candidate) => candidate.id === provider.id) && (
              <option value={provider.id}>{provider.name}（协议不匹配）</option>
            )}
            {providerOptions.map((candidate) => (
              <option value={candidate.id} key={candidate.id}>
                {candidate.name}{candidate.hasKey ? "" : " · 缺 Key"}
              </option>
            ))}
          </select>
        </div>
        <div className="agent-profile-cell">
          <ProviderModelInput
            inputId={`profile-${profile.id}-model`}
            type={profile.type}
            provider={provider}
            value={profile.model ?? ""}
            disabled={busy}
            compact
            onChange={(model) => onChange({ ...profile, model: model || undefined })}
            onCommit={(model) => void patch({ model })}
          />
        </div>
        <div className="agent-profile-cell">
          <select
            aria-label={`${profile.name} 的思考强度`}
            disabled={busy}
            value={profile.reasoningEffort ?? ""}
            onChange={(event) => void patch({ reasoningEffort: event.target.value })}
          >
            <option value="">跟随 CLI</option>
            {REASONING_EFFORT_VALUES[profile.type].map((effort) => (
              <option value={effort} key={effort}>{effort}</option>
            ))}
          </select>
        </div>
        <div className="agent-profile-cell">
          <select
            aria-label={`${profile.name} 的速度`}
            disabled={busy || profile.type === "antigravity"}
            value={profile.speed ?? "standard"}
            onChange={(event) => void patch({
              speed: event.target.value as "standard" | "fast",
            })}
          >
            <option value="standard">标准</option>
            <option value="fast">1.5x</option>
          </select>
        </div>
        <ProfileArgsControl
          profileName={profile.name}
          value={profile.extraArgs ?? []}
          disabled={busy}
          onSave={async (extraArgs) => {
            const saved = await patch({ extraArgs });
            if (saved) notify(`${profile.name} 的 CLI 参数已保存`);
            return saved;
          }}
        />
        <div className="agent-profile-default">
          {profile.isDefault ? (
            <span className="settings-default-tag">默认</span>
          ) : (
            <button
              type="button"
              className="settings-text-action"
              disabled={busy}
              onClick={() => void patch({ isDefault: true })}
            >
              设默认
            </button>
          )}
        </div>
        <button
          className="settings-icon-danger agent-profile-delete"
          type="button"
          disabled={busy}
          onClick={() => setConfirmDelete(true)}
          aria-label={`删除 ${profile.name}`}
        >
          <Trash size={14} aria-hidden="true" />
        </button>
      </article>
      {confirmDelete && (
        <ConfirmDialog
          title="删除执行器"
          message={`确定删除“${profile.name}”？已有任务会按类型默认执行器降级。`}
          confirmLabel="删除"
          danger
          busy={busy}
          onClose={() => setConfirmDelete(false)}
          onConfirm={() => void remove()}
        />
      )}
    </>
  );
}

function AddProfile({
  profiles,
  providers,
  availability,
  onAdded,
  notify,
}: {
  profiles: AgentExecutorProfile[];
  providers: LlmProvider[];
  availability: AgentDetection;
  onAdded: (profile: AgentExecutorProfile) => void;
  notify: (message: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [type, setType] = useState<AgentType>("claude");
  const [name, setName] = useState("");
  const [model, setModel] = useState("");
  const [effort, setEffort] = useState("");
  const [speed, setSpeed] = useState<"standard" | "fast">("standard");
  const [providerId, setProviderId] = useState("");
  const [extraArgs, setExtraArgs] = useState<string[]>([]);
  const [host, setHost] = useState("");
  const [busy, setBusy] = useState(false);
  const localTypes = useMemo(() => selectableAgentTypes(availability), [availability]);
  const typeOptions = host.trim() ? [...AGENT_TYPES] : localTypes;
  const providerOptions = providersForAgent(type, providers);
  const provider = providers.find((candidate) => candidate.id === providerId);

  useEffect(() => {
    if (!host.trim() && typeOptions.length && !typeOptions.includes(type)) {
      setType(typeOptions[0]);
    }
  }, [host, type, typeOptions]);

  useEffect(() => {
    if (providerId && !providerOptions.some((candidate) => candidate.id === providerId)) {
      setProviderId("");
      setModel("");
    }
  }, [providerId, providerOptions]);

  const reset = () => {
    setName("");
    setModel("");
    setEffort("");
    setSpeed("standard");
    setProviderId("");
    setExtraArgs([]);
    setHost("");
  };

  const add = async () => {
    if (!typeOptions.includes(type)) return;
    setBusy(true);
    try {
      const location = provider?.name || host.trim() || "local";
      const profile = await api.createAgent({
        type,
        name: name.trim() || `${type}@${location}${model.trim() ? `·${model.trim()}` : ""}`,
        model: model.trim() || undefined,
        reasoningEffort: effort || undefined,
        speed: speed === "fast" ? "fast" : undefined,
        providerId: providerId || null,
        extraArgs: extraArgs.map((token) => token.trim()).filter(Boolean),
        target: host.trim() ? { kind: "ssh", host: host.trim() } : { kind: "local" },
        isDefault: !profiles.some((profile) => profile.type === type),
      });
      onAdded(profile);
      reset();
      setOpen(false);
    } catch (error) {
      notify(error instanceof Error ? error.message : "执行器新增失败");
    } finally {
      setBusy(false);
    }
  };

  if (!open) {
    return (
      <Button variant="primary" onClick={() => setOpen(true)}>
        <Plus size={13} weight="bold" /> 新增执行器
      </Button>
    );
  }

  return (
    <div className="agent-profile-create">
      <div className="agent-profile-create-grid">
        <label>
          <span>类型</span>
          <select
            value={typeOptions.includes(type) ? type : ""}
            onChange={(event) => setType(event.target.value as AgentType)}
          >
            {!typeOptions.length && <option value="">本机未检测到可用 CLI</option>}
            {typeOptions.map((value) => <option value={value} key={value}>{value}</option>)}
          </select>
          <small>{host.trim() ? "SSH Profile 可选择完整目录" : "本地候选来自可用性检测"}</small>
        </label>
        <label>
          <span>Profile 名称</span>
          <input value={name} onChange={(event) => setName(event.target.value)} placeholder="留空自动命名" />
        </label>
        <label>
          <span>SSH 主机</span>
          <input value={host} onChange={(event) => setHost(event.target.value)} placeholder="留空为本地" />
        </label>
        <label>
          <span>供应商</span>
          <select value={providerId} onChange={(event) => { setProviderId(event.target.value); setModel(""); }}>
            <option value="">CLI 官方账号</option>
            {providerOptions.map((candidate) => (
              <option value={candidate.id} key={candidate.id}>{candidate.name}</option>
            ))}
          </select>
        </label>
        <label>
          <span>模型</span>
          <ProviderModelInput
            inputId="new-profile-model"
            type={type}
            provider={provider}
            value={model}
            disabled={busy}
            onChange={setModel}
          />
        </label>
        <label>
          <span>思考强度</span>
          <select value={effort} onChange={(event) => setEffort(event.target.value)}>
            <option value="">跟随 CLI</option>
            {REASONING_EFFORT_VALUES[type].map((value) => (
              <option value={value} key={value}>{value}</option>
            ))}
          </select>
        </label>
        <label>
          <span>速度</span>
          <select
            disabled={type === "antigravity"}
            value={speed}
            onChange={(event) => setSpeed(event.target.value as "standard" | "fast")}
          >
            <option value="standard">标准</option>
            <option value="fast">1.5x</option>
          </select>
        </label>
      </div>
      <ExtraArgsEditor value={extraArgs} disabled={busy} onChange={setExtraArgs} />
      <div className="agent-profile-create-actions">
        <Button variant="ghost" disabled={busy} onClick={() => { reset(); setOpen(false); }}>取消</Button>
        <Button
          variant="primary"
          disabled={busy || !typeOptions.includes(type)}
          onClick={() => void add()}
        >
          {busy ? "添加中…" : "添加执行器"}
        </Button>
      </div>
    </div>
  );
}

export function AgentProfilesSection({
  profiles,
  providers,
  loading,
  availability,
  onProfileChanged,
  onProfileAdded,
  notify,
}: {
  profiles: AgentExecutorProfile[];
  providers: LlmProvider[];
  loading: boolean;
  availability: AgentDetection;
  onProfileChanged: (id: string, profile: AgentExecutorProfile | null) => void;
  onProfileAdded: (profile: AgentExecutorProfile) => void;
  notify: (message: string) => void;
}) {
  const profileGroups = useMemo(() => AGENT_TYPES.map((type) => ({
    type,
    profiles: profiles.filter((profile) => profile.type === type),
  })).filter((group) => group.profiles.length > 0), [profiles]);

  return (
    <section className="settings-section">
      <h2>执行器 Profile</h2>
      <div className="settings-card agent-profiles-card">
        {loading && <p className="settings-muted">读取中…</p>}
        {!loading && !profiles.length && (
          <p className="settings-muted">还没有 Profile；未指定时服务端仍会按类型使用内置本地默认。</p>
        )}
        {!!profileGroups.length && (
          <div className="agent-profile-groups">
            {profileGroups.map(({ type, profiles: typeProfiles }) => {
              const defaultProfile = typeProfiles.find((profile) => profile.isDefault);
              return (
                <section className={`agent-profile-group is-${type}`} key={type}>
                  <header className="agent-profile-group-head">
                    <span className={`settings-agent-avatar is-${type}`}>
                      {profileAvatar(type)}
                    </span>
                    <div>
                      <b>{type}</b>
                      <small>{typeProfiles.length} 个 Profile</small>
                    </div>
                    <span className="agent-profile-group-default" title={defaultProfile?.name}>
                      默认 · {defaultProfile?.name ?? "内置本地执行器"}
                    </span>
                  </header>
                  <div className="agent-profile-table" role="table" aria-label={`${type} 执行器`}>
                    <div className="agent-profile-columns" role="row" aria-hidden="true">
                      <span>Profile / 位置</span>
                      <span>供应商</span>
                      <span>模型</span>
                      <span>思考</span>
                      <span>速度</span>
                      <span>额外参数</span>
                      <span>默认</span>
                      <span />
                    </div>
                    {typeProfiles.map((profile) => (
                      <ProfileRow
                        key={profile.id}
                        profile={profile}
                        providers={providers}
                        onChange={(updated) => onProfileChanged(profile.id, updated)}
                        notify={notify}
                      />
                    ))}
                  </div>
                </section>
              );
            })}
          </div>
        )}
        <div className="settings-card-foot agent-profile-foot">
          <span>供应商决定账号与模型目录；任务仍可逐个覆盖执行器、模型和思考强度。</span>
          <AddProfile
            profiles={profiles}
            providers={providers}
            availability={availability}
            onAdded={onProfileAdded}
            notify={notify}
          />
        </div>
      </div>
    </section>
  );
}
