import { useEffect, useState } from "react";
import type { AgentExecutorProfile, TeamPreset, TeamPresetConfig } from "@harness/shared";
import {
  ArrowRight,
  ArrowsClockwise,
  Crown,
  FloppyDisk,
  MagnifyingGlass,
  PencilSimple,
  Robot,
  Trash,
} from "@phosphor-icons/react";
import { api } from "./api";
import { ConfirmModal, fieldCls, Modal, primaryCls } from "./Modal";
import { toast } from "./toast";
import { Tip } from "./Tip";

type NameDialog =
  | { kind: "create"; config: TeamPresetConfig }
  | { kind: "rename"; preset: TeamPreset };

function presetActorLabel(
  preset: TeamPreset,
  role: "lead" | "worker" | "reviewer",
): string {
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

function PresetNameModal({
  dialog,
  onClose,
  onSubmit,
}: {
  dialog: NameDialog;
  onClose: () => void;
  onSubmit: (name: string) => Promise<void>;
}) {
  const [name, setName] = useState(dialog.kind === "rename" ? dialog.preset.name : "");
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    const value = name.trim();
    if (!value || busy) return;
    setBusy(true);
    try {
      await onSubmit(value);
      onClose();
    } catch (error) {
      toast(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      title={dialog.kind === "create" ? "保存执行模式预设" : "重命名执行模式预设"}
      onClose={onClose}
      width={420}
      footer={(
        <>
          <button onClick={onClose} className="px-3 py-1.5 text-[13px] text-muted">取消</button>
          <button disabled={!name.trim() || busy} onClick={() => void submit()} className={primaryCls}>
            {busy ? "保存中…" : dialog.kind === "create" ? "保存预设" : "保存名称"}
          </button>
        </>
      )}
    >
      <label className="flex flex-col gap-1.5">
        <span className="text-[12px] text-muted">预设名称</span>
        <input
          autoFocus
          maxLength={80}
          value={name}
          onChange={(event) => setName(event.target.value)}
          onKeyDown={(event) => event.key === "Enter" && void submit()}
          placeholder="如：Codex 调度 + Claude 执行"
          className={fieldCls}
        />
      </label>
    </Modal>
  );
}

export function TeamPresetBar({
  currentConfig,
  profiles,
  onApply,
  onDialogOpenChange,
  className = "px-4 pt-3",
}: {
  currentConfig: TeamPresetConfig;
  profiles: AgentExecutorProfile[];
  onApply: (config: TeamPresetConfig) => void;
  onDialogOpenChange: (open: boolean) => void;
  // 外框留白由宿主决定：弹窗时自带 px-4，内嵌 composer 里正文已经限宽居中了。
  className?: string;
}) {
  const [presets, setPresets] = useState<TeamPreset[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [dialog, setDialog] = useState<NameDialog | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<TeamPreset | null>(null);
  const [updatingId, setUpdatingId] = useState<string | null>(null);

  const load = () => {
    setLoading(true);
    setLoadError(false);
    api.teamPresets()
      .then(setPresets)
      .catch(() => setLoadError(true))
      .finally(() => setLoading(false));
  };
  useEffect(load, []);

  const openDialog = (next: NameDialog) => {
    setDialog(next);
    onDialogOpenChange(true);
  };
  const closeDialog = () => {
    setDialog(null);
    onDialogOpenChange(false);
  };
  const openDelete = (preset: TeamPreset) => {
    setDeleteTarget(preset);
    onDialogOpenChange(true);
  };
  const closeDelete = () => {
    setDeleteTarget(null);
    onDialogOpenChange(false);
  };

  const saveName = async (name: string) => {
    if (!dialog) return;
    if (dialog.kind === "create") {
      const created = await api.createTeamPreset(name, dialog.config);
      setPresets((items) => [created, ...items]);
      return;
    }
    const updated = await api.patchTeamPreset(dialog.preset.id, { name });
    setPresets((items) => items.map((item) => item.id === updated.id ? updated : item));
  };

  const removePreset = async (preset: TeamPreset) => {
    try {
      await api.deleteTeamPreset(preset.id);
      setPresets((items) => items.filter((item) => item.id !== preset.id));
    } catch (error) {
      toast(error instanceof Error ? error.message : String(error));
    }
  };

  const updatePresetConfig = async (preset: TeamPreset) => {
    setUpdatingId(preset.id);
    try {
      const updated = await api.patchTeamPreset(preset.id, { config: currentConfig });
      setPresets((items) => items.map((item) => item.id === updated.id ? updated : item));
      toast(`已用当前组合更新「${preset.name}」`, "info");
    } catch (error) {
      toast(error instanceof Error ? error.message : String(error));
    } finally {
      setUpdatingId(null);
    }
  };

  const normalizeForApply = (config: TeamPresetConfig): TeamPresetConfig => {
    const executorId = (candidate: string | null | undefined, type: string) => {
      const profile = candidate ? profiles.find((item) => item.id === candidate) : null;
      return profile?.type === type ? candidate : null;
    };
    const reviewerType = config.reviewerAgentType ?? config.worker;
    return {
      lead: config.lead,
      worker: config.worker,
      leadExecutorId: executorId(config.leadExecutorId, config.lead),
      workerExecutorId: executorId(config.workerExecutorId, config.worker),
      leadModel: config.leadModel ?? null,
      leadReasoningEffort: config.leadReasoningEffort ?? null,
      workerModel: config.workerModel ?? null,
      workerReasoningEffort: config.workerReasoningEffort ?? null,
      review: config.review !== false,
      reviewerAgentType: reviewerType,
      reviewerExecutorId: executorId(config.reviewerExecutorId, reviewerType),
      reviewerModel: config.reviewerModel ?? null,
      reviewerReasoningEffort: config.reviewerReasoningEffort ?? null,
    };
  };

  return (
    <>
      <div className={className}>
        <div className="rounded-xl border border-line bg-raised/35 p-2.5">
          <div className="flex flex-wrap items-center gap-2">
            <span className="shrink-0 text-[11px] font-semibold tracking-wide text-muted">执行模式</span>
            <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5">
              {loading && <span className="text-[12px] text-faint">正在加载预设…</span>}
              {!loading && loadError && (
                <span className="text-[12px] text-red-600">
                  预设加载失败。
                  <button onClick={load} className="ml-1 underline underline-offset-2">重试</button>
                </span>
              )}
              {!loading && !loadError && presets.length === 0 && (
                <span className="text-[12px] text-faint">还没有预设，保存当前组合后可一键复用。</span>
              )}
              {presets.map((preset) => (
                <div
                  key={preset.id}
                  className="group flex max-w-full items-stretch overflow-hidden rounded-lg border border-line bg-panel shadow-sm transition-colors hover:border-line2 hover:bg-canvas"
                >
                  <Tip label={`套用「${preset.name}」`} className="flex min-w-0">
                    <button
                      onClick={() => onApply(normalizeForApply(preset.config))}
                      className="min-w-0 px-2.5 py-1.5 text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
                    >
                      <span className="block truncate text-[12px] font-medium text-ink">{preset.name}</span>
                      <span className="mt-0.5 flex min-w-0 flex-wrap items-center gap-x-1 gap-y-0.5 text-[10px] text-faint">
                        <span className="inline-flex min-w-0 items-center gap-1">
                          <Crown size={10} className="shrink-0" />
                          <span className="max-w-[90px] truncate">{presetActorLabel(preset, "lead")}</span>
                          <ArrowRight size={9} className="shrink-0" />
                          <Robot size={10} className="shrink-0" />
                          <span className="max-w-[90px] truncate">{presetActorLabel(preset, "worker")}</span>
                        </span>
                        <span className="text-line2">·</span>
                        <span className={`inline-flex min-w-0 items-center gap-1 ${preset.config.review === false ? "text-faint" : "text-violet-600"}`}>
                          <MagnifyingGlass size={10} className="shrink-0" />
                          {preset.config.review === false
                            ? "审查关闭"
                            : <span className="max-w-[90px] truncate">{presetActorLabel(preset, "reviewer")}</span>}
                        </span>
                      </span>
                    </button>
                  </Tip>
                  <div className="flex border-l border-line">
                    <Tip label="用当前组合更新此预设" className="flex">
                      <button
                        onClick={() => void updatePresetConfig(preset)}
                        disabled={updatingId === preset.id}
                        className="grid w-7 place-items-center text-faint hover:bg-raised hover:text-ink disabled:opacity-40"
                        aria-label={`用当前组合更新「${preset.name}」`}
                      >
                        <ArrowsClockwise size={12} className={updatingId === preset.id ? "animate-spin" : ""} />
                      </button>
                    </Tip>
                    <Tip label={`重命名「${preset.name}」`} className="flex">
                      <button
                        onClick={() => openDialog({ kind: "rename", preset })}
                        className="grid w-7 place-items-center text-faint hover:bg-raised hover:text-ink"
                        aria-label={`重命名「${preset.name}」`}
                      >
                        <PencilSimple size={12} />
                      </button>
                    </Tip>
                    <Tip label={`删除「${preset.name}」`} className="flex">
                      <button
                        onClick={() => openDelete(preset)}
                        className="grid w-7 place-items-center text-faint hover:bg-red-50 hover:text-red-600"
                        aria-label={`删除「${preset.name}」`}
                      >
                        <Trash size={12} />
                      </button>
                    </Tip>
                  </div>
                </div>
              ))}
            </div>
            <button
              onClick={() => openDialog({ kind: "create", config: currentConfig })}
              className="inline-flex shrink-0 items-center gap-1 rounded-md border border-line2 bg-panel px-2.5 py-1.5 text-[12px] font-medium text-ink hover:bg-raised"
            >
              <FloppyDisk size={13} />
              保存当前组合
            </button>
          </div>
        </div>
      </div>
      {dialog && (
        <PresetNameModal dialog={dialog} onClose={closeDialog} onSubmit={saveName} />
      )}
      {deleteTarget && (
        <ConfirmModal
          title="删除执行模式预设"
          message={`确定删除「${deleteTarget.name}」？已用它创建的团队不会受影响。`}
          confirmLabel="删除"
          danger
          onConfirm={() => void removePreset(deleteTarget)}
          onClose={closeDelete}
        />
      )}
    </>
  );
}
