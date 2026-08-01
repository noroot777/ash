import { useEffect, useMemo, useState } from "react";
import type { AgentExecutorProfile, LlmProvider, TeamPreset } from "@harness/shared";
import {
  CirclesThreePlus,
  Plus,
  Trash,
  WarningCircle,
} from "@phosphor-icons/react";
import { Button } from "../components/ui.tsx";
import {
  registeredAgentTypes,
  residentAgentTypes,
  useAgentAvailability,
} from "../lib/agentAvailability.ts";
import { api } from "../lib/api.ts";
import { ConfirmDialog } from "../task-detail/ConfirmDialog.tsx";
import {
  createTeamPresetDraft,
  ROLE_META,
  TeamPresetEditor,
  teamPresetConfigFromDraft,
  teamPresetDraftFromConfig,
  type TeamPresetDraft,
} from "./TeamPresetEditor.tsx";
import "./team-presets-settings.css";

/** 与 composer 卡片同一口径:Profile 名之外还要写出被覆盖的生效模型。 */
function presetActorLabel(
  preset: TeamPreset,
  profiles: AgentExecutorProfile[],
  role: "lead" | "worker" | "reviewer",
) {
  const type = role === "reviewer"
    ? preset.config.reviewerAgentType ?? preset.config.worker
    : preset.config[role];
  const executorId = role === "lead"
    ? preset.config.leadExecutorId
    : role === "worker"
      ? preset.config.workerExecutorId
      : preset.config.reviewerExecutorId;
  const overrideModel = (role === "lead"
    ? preset.config.leadModel
    : role === "worker"
      ? preset.config.workerModel
      : preset.config.reviewerModel)?.trim() || null;
  const profile = profiles.find((candidate) => candidate.id === executorId && candidate.type === type);
  const base = profile?.name ?? `默认 ${type}`;
  return overrideModel && overrideModel !== (profile?.model ?? null)
    ? `${base} · ${overrideModel}`
    : base;
}

function draftKey(draft: TeamPresetDraft) {
  return JSON.stringify({
    name: draft.name.trim(),
    config: teamPresetConfigFromDraft(draft),
  });
}

export function ModesSettings({ notify }: { notify: (message: string) => void }) {
  const [presets, setPresets] = useState<TeamPreset[]>([]);
  const [profiles, setProfiles] = useState<AgentExecutorProfile[]>([]);
  const [providers, setProviders] = useState<LlmProvider[]>([]);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState<TeamPresetDraft>(createTeamPresetDraft);
  const [savedKey, setSavedKey] = useState("");
  const [loading, setLoading] = useState(true);
  const [loadFailed, setLoadFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<TeamPreset | null>(null);
  const detection = useAgentAvailability();

  const selectPreset = (preset: TeamPreset) => {
    const nextDraft = teamPresetDraftFromConfig(preset.name, preset.config);
    setEditingId(preset.id);
    setDraft(nextDraft);
    setSavedKey(draftKey(nextDraft));
  };

  const startNew = (availableProfiles = profiles) => {
    setEditingId(null);
    setDraft(createTeamPresetDraft(availableProfiles));
    setSavedKey("");
  };

  const load = () => {
    setLoading(true);
    setLoadFailed(false);
    Promise.all([api.teamPresets(), api.agents(), api.llmProviders()])
      .then(([nextPresets, nextProfiles, nextProviders]) => {
        setPresets(nextPresets);
        setProfiles(nextProfiles);
        setProviders(nextProviders);
        if (nextPresets[0]) selectPreset(nextPresets[0]);
        else startNew(nextProfiles);
      })
      .catch((error) => {
        setLoadFailed(true);
        notify(error instanceof Error ? error.message : "执行模式读取失败");
      })
      .finally(() => setLoading(false));
  };

  useEffect(load, [notify]);

  const selectedPreset = useMemo(
    () => presets.find((preset) => preset.id === editingId) ?? null,
    [editingId, presets],
  );
  const dirty = editingId === null ? !!draft.name.trim() : draftKey(draft) !== savedKey;
  const registeredTypes = registeredAgentTypes(profiles);
  const residentTypes = residentAgentTypes(detection.agents);
  const draftTypesValid = registeredTypes.includes(draft.roles.worker.agentType)
    && registeredTypes.includes(draft.roles.reviewer.agentType)
    && registeredTypes.includes(draft.roles.lead.agentType)
    && residentTypes.includes(draft.roles.lead.agentType);

  const save = async () => {
    const name = draft.name.trim();
    if (!name || busy) return;
    setBusy(true);
    try {
      const config = teamPresetConfigFromDraft(draft);
      const saved = editingId
        ? await api.patchTeamPreset(editingId, { name, config })
        : await api.createTeamPreset(name, config);
      setPresets((current) => editingId
        ? current.map((preset) => preset.id === saved.id ? saved : preset)
        : [saved, ...current]);
      selectPreset(saved);
      notify(editingId ? `已保存执行模式「${saved.name}」` : `已创建执行模式「${saved.name}」`);
    } catch (error) {
      notify(error instanceof Error ? error.message : "执行模式保存失败");
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!deleteTarget || busy) return;
    setBusy(true);
    try {
      await api.deleteTeamPreset(deleteTarget.id);
      const remaining = presets.filter((preset) => preset.id !== deleteTarget.id);
      setPresets(remaining);
      setDeleteTarget(null);
      if (remaining[0]) selectPreset(remaining[0]);
      else startNew(profiles);
      notify(`已删除执行模式「${deleteTarget.name}」`);
    } catch (error) {
      notify(error instanceof Error ? error.message : "执行模式删除失败");
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <header className="settings-heading">
        <div>
          <h1>执行模式</h1>
          <p>保存团队的调度、执行和审查分工，创建团队任务时可一键套用。</p>
        </div>
      </header>

      <section className="settings-section">
        <h2>团队模式</h2>
        <div className="settings-card team-presets-settings-card">
          {loading && <div className="team-presets-loading">正在读取执行模式…</div>}
          {!loading && loadFailed && (
            <div className="team-presets-loading is-error">
              <WarningCircle size={15} />执行模式读取失败
              <Button variant="ghost" onClick={load}>重试</Button>
            </div>
          )}
          {!loading && !loadFailed && (
            <div className="team-presets-settings-layout">
              <aside className="team-presets-list" aria-label="执行模式列表">
                <header>
                  <div className="team-presets-list-meta">
                    <b>已保存</b><span>{presets.length}</span>
                  </div>
                  <button
                    type="button"
                    className="team-presets-list-add"
                    disabled={busy}
                    aria-pressed={editingId === null}
                    onClick={() => startNew()}
                  >
                    <Plus size={11} weight="bold" aria-hidden="true" />新建
                  </button>
                </header>
                <div className="team-presets-list-items">
                  {!presets.length && (
                    <div className="team-presets-list-empty">
                      <CirclesThreePlus size={20} />
                      <span>还没有执行模式</span>
                    </div>
                  )}
                  {presets.map((preset) => (
                    <button
                      type="button"
                      className="team-presets-list-item"
                      aria-selected={preset.id === editingId}
                      disabled={busy}
                      onClick={() => selectPreset(preset)}
                      key={preset.id}
                    >
                      <b>{preset.name}</b>
                      {(["lead", "worker", "reviewer"] as const).map((role) => {
                        const meta = ROLE_META[role];
                        const Icon = meta.icon;
                        const isOff = role === "reviewer" && preset.config.review === false;
                        const actorLabel = isOff
                          ? "自动审查关闭"
                          : presetActorLabel(preset, profiles, role);
                        return (
                          <span
                            className={`team-presets-list-role is-${role}${isOff ? " is-off" : ""}`}
                            role="group"
                            aria-label={`${meta.label}：${actorLabel}`}
                            key={role}
                          >
                            <Icon
                              size={11}
                              weight={role === "worker" ? "fill" : "regular"}
                              aria-hidden="true"
                            />
                            <span>{actorLabel}</span>
                          </span>
                        );
                      })}
                    </button>
                  ))}
                </div>
              </aside>

              <div className="team-preset-editor">
                <header className="team-preset-editor-head">
                  <div>
                    <b>{editingId ? "编辑执行模式" : "新建执行模式"}</b>
                    <small>
                      {editingId
                        ? dirty ? "有未保存更改" : "所有更改已保存"
                        : draft.name.trim() ? "尚未创建" : "填写名称后即可创建"}
                    </small>
                  </div>
                  <div>
                    {selectedPreset && (
                      <Button variant="danger" disabled={busy} onClick={() => setDeleteTarget(selectedPreset)}>
                        <Trash size={13} />删除
                      </Button>
                    )}
                    <Button
                      variant="primary"
                      disabled={busy || !draft.name.trim() || !dirty || !draftTypesValid}
                      onClick={() => void save()}
                    >
                      {busy ? "保存中…" : editingId ? "保存更改" : "创建模式"}
                    </Button>
                  </div>
                </header>
                <TeamPresetEditor
                  draft={draft}
                  profiles={profiles}
                  providers={providers}
                  busy={busy}
                  preserveStaleTypes={editingId !== null}
                  onChange={setDraft}
                />
              </div>
            </div>
          )}
        </div>
      </section>

      {deleteTarget && (
        <ConfirmDialog
          title="删除执行模式"
          message={`确定删除「${deleteTarget.name}」？已经用它创建的团队不会受影响。`}
          confirmLabel="删除"
          danger
          busy={busy}
          onClose={() => setDeleteTarget(null)}
          onConfirm={() => void remove()}
        />
      )}
    </>
  );
}
