import { ArrowsClockwise, Clock, Play, Plus } from "@phosphor-icons/react";
import {
  ScheduleFields,
  type ScheduleKind,
} from "../components/ScheduleControl.tsx";
import { Button, Toggle } from "../components/ui.tsx";

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
  keepOpen,
  error,
  onModeChange,
  onAtChange,
  onCronChange,
  onKeepOpenChange,
  onSubmit,
}: {
  mode: LaunchMode;
  at: string;
  cron: string;
  busy: boolean;
  canSubmit: boolean;
  keepOpen: boolean;
  error?: string | null;
  onModeChange: (mode: LaunchMode) => void;
  onAtChange: (value: string) => void;
  onCronChange: (value: string) => void;
  onKeepOpenChange: (value: boolean) => void;
  onSubmit: () => void;
}) {
  return (
    <div className="composer-launch-control">
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
      <span className="composer-keep-open">
        <Toggle checked={keepOpen} disabled={busy} onChange={onKeepOpenChange} label="再建一个" />
      </span>
      <Button variant="primary" disabled={!canSubmit} onClick={onSubmit}>
        <SubmitIcon mode={mode} />{busy ? "创建中…" : submitLabel(mode)}
      </Button>
    </div>
  );
}
