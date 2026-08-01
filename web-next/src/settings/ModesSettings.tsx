import { useEffect, useMemo, useState } from "react";
import type { AgentExecutorProfile, LlmProvider, TeamPreset } from "@harness/shared";
import {
  ArrowRight,
  CirclesThreePlus,
  MagnifyingGlass,
  Plus,
  Robot,
  Trash,
  WarningCircle,
} from "@phosphor-icons/react";
import { Button } from "../components/ui.tsx";
import { api } from "../lib/api.ts";
import { ConfirmDialog } from "../task-detail/ConfirmDialog.tsx";
import {
  createTeamPresetDraft,
  TeamPresetEditor,
  teamPresetConfigFromDraft,
  teamPresetDraftFromConfig,
  type TeamPresetDraft,
} from "./TeamPresetEditor.tsx";
import "./team-presets-settings.css";

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
  return profiles.find((profile) => profile.id === executorId && profile.type === type)?.name
    ?? `默认 ${type}`;
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

  const selectPreset = (preset: TeamPreset) => {
    const nextDraft = teamPresetDraftFromConfig(preset.name, preset.config);
    setEditingId(preset.id);
    setDraft(nextDraft);
    setSavedKey(draftKey(nextDraft));
  };

  const startNew = () => {
    setEditingId(null);
    setDraft(createTeamPresetDraft());
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
        else startNew();
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
      else startNew();
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
        <Button variant="primary" disabled={loading || busy} onClick={startNew}>
          <Plus size={13} weight="bold" />新建模式
        </Button>
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
                <header><b>已保存</b><span>{presets.length}</span></header>
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
                    <span>
                      {presetActorLabel(preset, profiles, "lead")}
                      <ArrowRight size={9} />
                      <Robot size={10} />
                      {presetActorLabel(preset, profiles, "worker")}
                    </span>
                    <small className={preset.config.review === false ? "is-off" : ""}>
                      <MagnifyingGlass size={10} />
                      {preset.config.review === false
                        ? "自动审查关闭"
                        : presetActorLabel(preset, profiles, "reviewer")}
                    </small>
                  </button>
                ))}
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
                      disabled={busy || !draft.name.trim() || !dirty}
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
