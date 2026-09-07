import type { ReactNode } from "react";
import { ArrowUp, ArrowsClockwise, Clock, Play, Plus } from "@phosphor-icons/react";
import {
  ScheduleFields,
  type ScheduleKind,
} from "../components/ScheduleControl.tsx";
import { Button } from "../components/ui.tsx";
import { ComposerPopover } from "./ComposerPopover.tsx";

export type LaunchMode = "create" | "run" | ScheduleKind;

const LAUNCH_OPTIONS: { value: LaunchMode; label: string }[] = [
  { value: "run", label: "创建并运行" },
  { value: "create", label: "仅创建" },
  { value: "once", label: "一次性定时" },
  { value: "cron", label: "循环 Cron" },
];

function submitLabel(mode: LaunchMode): string {
  if (mode === "run") return "创建并运行";
  if (mode === "create") return "创建任务";
  return "创建并定时";
}

function SubmitIcon({ mode }: { mode: LaunchMode }) {
  if (mode === "run") return <Play size={12} weight="fill" />;
  if (mode === "once") return <Clock size={12} />;
  if (mode === "cron") return <ArrowsClockwise size={12} />;
  return <Plus size={12} weight="bold" />;
}

export function ComposerLaunchControl({
  mode,
  at,
  cron,
  busy,
  canSubmit,
  error,
  onModeChange,
  onAtChange,
  onCronChange,
  onSubmit,
  attachmentTool,
  executorTools,
}: {
  mode: LaunchMode;
  at: string;
  cron: string;
  busy: boolean;
  canSubmit: boolean;
  error?: string | null;
  onModeChange: (mode: LaunchMode) => void;
  onAtChange: (value: string) => void;
  onCronChange: (value: string) => void;
  onSubmit: () => void;
  attachmentTool: ReactNode;
  executorTools: ReactNode;
}) {
  return (
    <div className="composer-launch-control">
      <div className="studio-input-tools">
      {attachmentTool}
      <ComposerPopover label="启动设置" value={LAUNCH_OPTIONS.find((option) => option.value === mode)?.label}
        disabled={busy} className={`studio-schedule-button${mode !== "run" ? " is-configured" : ""}`}
        trigger={<><Clock size={17} />{mode !== "run" && <span>{mode === "create" ? "仅创建" : mode === "once" ? "定时" : "Cron"}</span>}</>}>
      <label className="composer-launch-mode">
        <span>启动方式</span>
        <select value={mode} disabled={busy} onChange={(event) => onModeChange(event.target.value as LaunchMode)}>
          {LAUNCH_OPTIONS.map((option) => <option value={option.value} key={option.value}>{option.label}</option>)}
        </select>
      </label>
      {(mode === "once" || mode === "cron") && (
        <ScheduleFields
          kind={mode}
          at={at}
          cron={cron}
          disabled={busy}
          onAtChange={onAtChange}
          onCronChange={onCronChange}
        />
      )}
      {error && <small className="composer-launch-error">{error}</small>}
      <p className="studio-help"><SubmitIcon mode={mode} />{mode === "run" ? "创建后立即开始执行。" : mode === "create" ? "先放入待办，需要时再运行。" : mode === "once" ? "在指定的本地时间运行一次。" : "按 Cron 表达式循环运行。"}</p>
      </ComposerPopover>
      <span className="studio-tool-divider" aria-hidden="true" />
      {executorTools}
      </div>
      <Button variant="primary" className="studio-submit" disabled={!canSubmit} onClick={onSubmit}
        aria-label={busy ? "创建中…" : submitLabel(mode)}>
        <span>{busy ? "创建中…" : submitLabel(mode)}</span><ArrowUp size={18} weight="bold" />
      </Button>
    </div>
  );
}
