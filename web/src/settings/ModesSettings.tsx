import { Fragment, useEffect, useState } from "react";
import type { AgentExecutorProfile, TeamPreset } from "@ash/shared";
import { PencilSimple, Plus, Trash } from "@phosphor-icons/react";
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

/** 正在编辑哪一个：某个模式的 id，或者「新建」那一张空表。 */
const NEW = "new";

const ROLES = ["lead", "worker", "reviewer"] as const;

// 设置 → 执行模式。跟飞书页同一副骨架：一个模式一行（三个角色各一行小字），点编辑就在
// 那一行下面展开表单（骨架样式在 styles/settings-list.css）。
export function ModesSettings({ notify }: { notify: (message: string) => void }) {
  const [presets, setPresets] = useState<TeamPreset[]>([]);
  const [profiles, setProfiles] = useState<AgentExecutorProfile[]>([]);
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState<TeamPresetDraft>(createTeamPresetDraft);
  const [savedKey, setSavedKey] = useState("");
  const [loading, setLoading] = useState(true);
  const [loadFailed, setLoadFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<TeamPreset | null>(null);
  const detection = useAgentAvailability();

  const edit = (preset: TeamPreset) => {
    if (editing === preset.id) {
      setEditing(null);
      return;
    }
    const nextDraft = teamPresetDraftFromConfig(preset.name, preset.config);
    setEditing(preset.id);
    setDraft(nextDraft);
    setSavedKey(draftKey(nextDraft));
  };

  const startNew = () => {
    setEditing(NEW);
    setDraft(createTeamPresetDraft(profiles));
    setSavedKey("");
  };

  const load = () => {
    setLoading(true);
    setLoadFailed(false);
    Promise.all([api.teamPresets(), api.agents()])
      .then(([nextPresets, nextProfiles]) => {
        setPresets(nextPresets);
        setProfiles(nextProfiles);
      })
      .catch((error) => {
        setLoadFailed(true);
        notify(error instanceof Error ? error.message : "执行模式读取失败");
      })
      .finally(() => setLoading(false));
  };

  useEffect(load, [notify]);

  const creating = editing === NEW;
  const dirty = creating ? !!draft.name.trim() : draftKey(draft) !== savedKey;
  const registeredTypes = registeredAgentTypes(profiles);
  const residentTypes = residentAgentTypes(detection.agents);
  const draftTypesValid = registeredTypes.includes(draft.roles.worker.agentType)
    && registeredTypes.includes(draft.roles.reviewer.agentType)
    && registeredTypes.includes(draft.roles.lead.agentType)
    && residentTypes.includes(draft.roles.lead.agentType);

  const save = async () => {
    const name = draft.name.trim();
    if (!name || busy || !editing) return;
    setBusy(true);
    try {
      const config = teamPresetConfigFromDraft(draft);
      const saved = creating
        ? await api.createTeamPreset(name, config)
        : await api.patchTeamPreset(editing, { name, config });
      setPresets((current) => creating
        ? [saved, ...current]
        : current.map((preset) => preset.id === saved.id ? saved : preset));
      setEditing(null);
      notify(creating ? `已创建执行模式「${saved.name}」` : `已保存执行模式「${saved.name}」`);
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
      setPresets((current) => current.filter((preset) => preset.id !== deleteTarget.id));
      if (editing === deleteTarget.id) setEditing(null);
      setDeleteTarget(null);
      notify(`已删除执行模式「${deleteTarget.name}」`);
    } catch (error) {
      notify(error instanceof Error ? error.message : "执行模式删除失败");
    } finally {
      setBusy(false);
    }
  };

  const editor = (
    <div className="settings-editor">
      <TeamPresetEditor
        draft={draft}
        profiles={profiles}
        busy={busy}
        preserveStaleTypes={!creating}
        onChange={setDraft}
      />
      <div className="settings-card-foot">
        <Button variant="ghost" disabled={busy} onClick={() => setEditing(null)}>取消</Button>
        <Button
          variant="primary"
          disabled={busy || !draft.name.trim() || !dirty || !draftTypesValid}
          onClick={() => void save()}
        >
          {busy ? "保存中…" : creating ? "创建模式" : "保存更改"}
        </Button>
      </div>
    </div>
  );

  return (
    <>
      <header className="settings-heading">
        <div>
          <h1>执行模式</h1>
          <p>保存团队的调度、执行和审查分工，创建团队任务时可一键套用。</p>
        </div>
        {!loading && !loadFailed && !creating && (
          <Button onClick={startNew}><Plus size={14} aria-hidden="true" />新建模式</Button>
        )}
      </header>

      <section className="settings-section">
        <h2>团队模式</h2>
        <div className="settings-card">
          {loading && <p className="settings-muted">正在读取执行模式…</p>}
          {!loading && loadFailed && (
            <p className="settings-muted">执行模式读取失败。<Button variant="ghost" onClick={load}>重试</Button></p>
          )}
          {creating && editor}
          {!loading && !loadFailed && !presets.length && !creating && (
            <p className="settings-muted">还没有执行模式。</p>
          )}
          {presets.map((preset) => (
            <Fragment key={preset.id}>
              <div className={`settings-row settings-item${editing === preset.id ? " is-editing" : ""}`}>
                <div>
                  <b>{preset.name}</b>
                  {ROLES.map((role) => {
                    const label = ROLE_META[role].label;
                    const actor = role === "reviewer" && preset.config.review === false
                      ? "自动审查关闭"
                      : presetActorLabel(preset, profiles, role);
                    return <small key={role}>{label}　{actor}</small>;
                  })}
                </div>
                <span className="settings-row-actions">
                  <button
                    type="button"
                    className="settings-icon-action"
                    aria-pressed={editing === preset.id}
                    aria-label={editing === preset.id ? `收起 ${preset.name} 的编辑表单` : `编辑 ${preset.name}`}
                    onClick={() => edit(preset)}
                  >
                    <PencilSimple size={14} />
                  </button>
                  <button
                    type="button"
                    className="settings-icon-danger"
                    disabled={busy}
                    aria-label={`删除 ${preset.name}`}
                    onClick={() => setDeleteTarget(preset)}
                  >
                    <Trash size={14} />
                  </button>
                </span>
              </div>
              {editing === preset.id && editor}
            </Fragment>
          ))}
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
