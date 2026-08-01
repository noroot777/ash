import { useEffect, useRef, useState } from "react";
import type { AgentExecutorProfile, LlmProvider } from "@harness/shared";
import { REASONING_EFFORT_VALUES } from "@harness/shared/cli-presets";
import { Star, Trash } from "@phosphor-icons/react";
import { api } from "../lib/api.ts";
import { ConfirmDialog } from "../task-detail/ConfirmDialog.tsx";
import {
  providerProtocolForAgent,
  providersForAgent,
} from "./agentProviderRules.ts";
import { ProfileArgsControl } from "./ProfileArgsControl.tsx";
import { ProviderModelInput } from "./ProviderModelInput.tsx";

export function AgentProfileRow({
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
  const [editingName, setEditingName] = useState(false);
  const [nameDraft, setNameDraft] = useState(profile.name);
  const cancelNameCommit = useRef(false);
  const providerOptions = providersForAgent(profile.type, providers);
  const provider = providers.find((candidate) => candidate.id === profile.providerId);
  const protocol = providerProtocolForAgent(profile.type);

  useEffect(() => {
    if (!editingName) setNameDraft(profile.name);
  }, [editingName, profile.name]);

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

  const commitName = async () => {
    if (cancelNameCommit.current) {
      cancelNameCommit.current = false;
      setEditingName(false);
      setNameDraft(profile.name);
      return;
    }
    const name = nameDraft.trim();
    setEditingName(false);
    if (!name) {
      setNameDraft(profile.name);
      notify("Profile 名称不能为空");
      return;
    }
    if (name === profile.name) return;
    if (!await patch({ name })) setNameDraft(profile.name);
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
          {editingName ? (
            <input
              className="agent-profile-name-input"
              aria-label={`${profile.name} 的 Profile 名称`}
              autoFocus
              disabled={busy}
              value={nameDraft}
              onChange={(event) => setNameDraft(event.target.value)}
              onBlur={() => void commitName()}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  event.currentTarget.blur();
                }
                if (event.key === "Escape") {
                  event.preventDefault();
                  cancelNameCommit.current = true;
                  event.currentTarget.blur();
                }
              }}
            />
          ) : (
            <button
              type="button"
              className="agent-profile-name-button"
              disabled={busy}
              title="点击编辑名称"
              onClick={() => setEditingName(true)}
            >
              {profile.name}
            </button>
          )}
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
        <div className="agent-profile-actions">
          <div className="agent-profile-hover-action">
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
          </div>
          <div className={`agent-profile-default${profile.isDefault ? " is-current" : ""}`}>
            {profile.isDefault ? (
              <span className="settings-default-tag">
                <Star size={10} weight="fill" aria-hidden="true" />默认
              </span>
            ) : (
              <button
                type="button"
                className="agent-profile-default-action"
                disabled={busy}
                title="设为默认执行器"
                aria-label={`将 ${profile.name} 设为默认执行器`}
                onClick={() => void patch({ isDefault: true })}
              >
                <Star size={13} aria-hidden="true" />
              </button>
            )}
          </div>
          <button
            className="settings-icon-danger agent-profile-delete agent-profile-hover-action"
            type="button"
            disabled={busy}
            onClick={() => setConfirmDelete(true)}
            aria-label={`删除 ${profile.name}`}
          >
            <Trash size={13} aria-hidden="true" />
          </button>
        </div>
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
