import { useEffect, useMemo, useState } from "react";
import type { AgentExecutorProfile, TeamPreset, TeamPresetConfig } from "@harness/shared";
import {
  ArrowRight,
  ArrowsClockwise,
  CheckCircle,
  FloppyDisk,
  MagnifyingGlass,
  PencilSimple,
  Robot,
  Trash,
  WarningCircle,
} from "@phosphor-icons/react";
import { Button, TextInput } from "../components/ui.tsx";
import { api } from "../lib/api.ts";
import { ConfirmDialog } from "../task-detail/ConfirmDialog.tsx";

type NameDialog =
  | { kind: "create"; config: TeamPresetConfig }
  | { kind: "rename"; preset: TeamPreset };

function presetActorLabel(preset: TeamPreset, role: "lead" | "worker" | "reviewer") {
  const type = role === "reviewer"
    ? preset.config.reviewerAgentType ?? preset.config.worker
    : preset.config[role];
  const label = role === "lead"
    ? preset.config.leadExecutorLabel
    : role === "worker"
      ? preset.config.workerExecutorLabel
      : preset.config.reviewerExecutorLabel;
  return label ?? `默认 ${type}`;
}

function configKey(config: TeamPresetConfig) {
  return JSON.stringify({
    lead: config.lead,
    worker: config.worker,
    leadExecutorId: config.leadExecutorId ?? null,
    workerExecutorId: config.workerExecutorId ?? null,
    leadModel: config.leadModel ?? null,
    leadReasoningEffort: config.leadReasoningEffort ?? null,
    workerModel: config.workerModel ?? null,
    workerReasoningEffort: config.workerReasoningEffort ?? null,
    review: config.review !== false,
    reviewerAgentType: config.reviewerAgentType ?? config.worker,
    reviewerExecutorId: config.reviewerExecutorId ?? null,
    reviewerModel: config.reviewerModel ?? null,
    reviewerReasoningEffort: config.reviewerReasoningEffort ?? null,
  });
}

function PresetNameDialog({
  dialog,
  onClose,
  onSubmit,
  notify,
}: {
  dialog: NameDialog;
  onClose: () => void;
  onSubmit: (name: string) => Promise<void>;
  notify: (message: string) => void;
}) {
  const [name, setName] = useState(dialog.kind === "rename" ? dialog.preset.name : "");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const close = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !busy) onClose();
    };
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, [busy, onClose]);

  const submit = async () => {
    const value = name.trim();
    if (!value || busy) return;
    setBusy(true);
    try {
      await onSubmit(value);
      onClose();
    } catch (error) {
      notify(error instanceof Error ? error.message : "预设保存失败");
      setBusy(false);
    }
  };

  return (
    <div
      className="task-modal-scrim"
      role="presentation"
      onMouseDown={(event) => event.target === event.currentTarget && !busy && onClose()}
    >
      <section
        className="composer-preset-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="composer-preset-dialog-title"
      >
        <header>
          <span><FloppyDisk size={16} weight="fill" /></span>
          <div>
            <h2 id="composer-preset-dialog-title">
              {dialog.kind === "create" ? "保存执行模式" : "重命名执行模式"}
            </h2>
            <p>{dialog.kind === "create" ? "保存当前三种角色的执行器和高级覆盖。" : "配置内容不会改变。"}</p>
          </div>
        </header>
        <label>
          <span>预设名称</span>
          <TextInput
            autoFocus
            maxLength={80}
            value={name}
            onChange={(event) => setName(event.target.value)}
            onKeyDown={(event) => event.key === "Enter" && void submit()}
            placeholder="如：Codex 调度 · Claude 执行"
          />
        </label>
        <footer>
          <Button disabled={busy} onClick={onClose}>取消</Button>
          <Button variant="primary" disabled={!name.trim() || busy} onClick={() => void submit()}>
            {busy ? "保存中…" : dialog.kind === "create" ? "保存预设" : "保存名称"}
          </Button>
        </footer>
      </section>
    </div>
  );
}

export function PresetBar({
  currentConfig,
  profiles,
  onApply,
  notify,
}: {
  currentConfig: TeamPresetConfig;
  profiles: AgentExecutorProfile[];
  onApply: (config: TeamPresetConfig) => void;
  notify: (message: string) => void;
}) {
  const [presets, setPresets] = useState<TeamPreset[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [dialog, setDialog] = useState<NameDialog | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<TeamPreset | null>(null);
  const [busyAction, setBusyAction] = useState<string | null>(null);

  const load = () => {
    setLoading(true);
    setLoadError(false);
    api.teamPresets()
      .then(setPresets)
      .catch(() => setLoadError(true))
      .finally(() => setLoading(false));
  };

  useEffect(load, []);

  const selectedPreset = useMemo(
    () => presets.find((preset) => preset.id === selectedId) ?? null,
    [presets, selectedId],
  );
  const selectedChanged = !!selectedPreset && configKey(selectedPreset.config) !== configKey(currentConfig);

  const applyPreset = (preset: TeamPreset) => {
    const validExecutor = (candidate: string | null | undefined, type: string) => {
      const profile = candidate ? profiles.find((item) => item.id === candidate) : null;
      return profile?.type === type ? candidate : null;
    };
    const reviewerType = preset.config.reviewerAgentType ?? preset.config.worker;
    setSelectedId(preset.id);
    onApply({
      ...preset.config,
      leadExecutorId: validExecutor(preset.config.leadExecutorId, preset.config.lead),
      workerExecutorId: validExecutor(preset.config.workerExecutorId, preset.config.worker),
      reviewerAgentType: reviewerType,
      reviewerExecutorId: validExecutor(preset.config.reviewerExecutorId, reviewerType),
    });
  };

  const saveName = async (name: string) => {
    if (!dialog) return;
    if (dialog.kind === "create") {
      const created = await api.createTeamPreset(name, dialog.config);
      setPresets((items) => [created, ...items]);
      setSelectedId(created.id);
      notify(`已保存执行模式「${created.name}」`);
      return;
    }
    const updated = await api.patchTeamPreset(dialog.preset.id, { name });
    setPresets((items) => items.map((item) => item.id === updated.id ? updated : item));
    notify(`已重命名为「${updated.name}」`);
  };

  const updateSelected = async () => {
    if (!selectedPreset) return;
    setBusyAction("update");
    try {
      const updated = await api.patchTeamPreset(selectedPreset.id, { config: currentConfig });
      setPresets((items) => items.map((item) => item.id === updated.id ? updated : item));
      notify(`已用当前配置更新「${updated.name}」`);
    } catch (error) {
      notify(error instanceof Error ? error.message : "预设更新失败");
    } finally {
      setBusyAction(null);
    }
  };

  const removePreset = async () => {
    if (!deleteTarget) return;
    setBusyAction("delete");
    try {
      await api.deleteTeamPreset(deleteTarget.id);
      setPresets((items) => items.filter((item) => item.id !== deleteTarget.id));
      if (selectedId === deleteTarget.id) setSelectedId(null);
      notify(`已删除执行模式「${deleteTarget.name}」`);
      setDeleteTarget(null);
    } catch (error) {
      notify(error instanceof Error ? error.message : "预设删除失败");
    } finally {
      setBusyAction(null);
    }
  };

  return (
    <div className="composer-preset-bar">
      <div className="composer-preset-heading">
        <div>
          <b>组合预设</b>
          <span>一键切换调度、执行与审查分工</span>
        </div>
        <Button onClick={() => setDialog({ kind: "create", config: currentConfig })}>
          <FloppyDisk size={13} />保存当前组合
        </Button>
      </div>

      {loading && <div className="composer-preset-empty">正在加载预设…</div>}
      {!loading && loadError && (
        <div className="composer-preset-empty is-error">
          <WarningCircle size={14} />预设加载失败
          <Button variant="ghost" onClick={load}>重试</Button>
        </div>
      )}
      {!loading && !loadError && presets.length === 0 && (
        <div className="composer-preset-empty">还没有预设；保存当前组合后，可在这里一键复用。</div>
      )}
      {!!presets.length && (
        <div className="composer-preset-list" aria-label="已保存的执行模式">
          {presets.map((preset) => (
            <button
              type="button"
              className="composer-preset-card"
              aria-pressed={selectedId === preset.id}
              key={preset.id}
              onClick={() => applyPreset(preset)}
            >
              <b>{preset.name}</b>
              <span>
                <span>{presetActorLabel(preset, "lead")}</span>
                <ArrowRight size={10} />
                <Robot size={11} />
                <span>{presetActorLabel(preset, "worker")}</span>
              </span>
              <small className={preset.config.review === false ? "is-off" : ""}>
                <MagnifyingGlass size={10} />
                {preset.config.review === false ? "自动审查关闭" : presetActorLabel(preset, "reviewer")}
              </small>
            </button>
          ))}
        </div>
      )}

      {selectedPreset && (
        <div className={`composer-preset-selection${selectedChanged ? " is-changed" : ""}`}>
          <span>
            {selectedChanged ? <WarningCircle size={13} /> : <CheckCircle size={13} weight="fill" />}
            {selectedChanged ? `当前配置已偏离「${selectedPreset.name}」` : `正在使用「${selectedPreset.name}」`}
          </span>
          <div>
            {selectedChanged && (
              <Button disabled={busyAction !== null} onClick={() => void updateSelected()}>
                <ArrowsClockwise size={13} />{busyAction === "update" ? "更新中…" : "用当前配置更新"}
              </Button>
            )}
            <Button variant="ghost" disabled={busyAction !== null} onClick={() => setDialog({ kind: "rename", preset: selectedPreset })}>
              <PencilSimple size={13} />重命名
            </Button>
            <Button variant="danger" disabled={busyAction !== null} onClick={() => setDeleteTarget(selectedPreset)}>
              <Trash size={13} />删除
            </Button>
          </div>
        </div>
      )}

      {dialog && (
        <PresetNameDialog dialog={dialog} onClose={() => setDialog(null)} onSubmit={saveName} notify={notify} />
      )}
      {deleteTarget && (
        <ConfirmDialog
          title="删除执行模式预设"
          message={`确定删除「${deleteTarget.name}」？已经用它创建的团队不会受影响。`}
          confirmLabel="删除"
          danger
          busy={busyAction === "delete"}
          onClose={() => setDeleteTarget(null)}
          onConfirm={() => void removePreset()}
        />
      )}
    </div>
  );
}
