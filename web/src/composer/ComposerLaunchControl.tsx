import type { ReactNode } from "react";
import { ArrowUp, ArrowsClockwise, Clock, ListNumbers, Play, Plus } from "@phosphor-icons/react";
import {
  ScheduleFields,
  type ScheduleKind,
} from "../components/ScheduleControl.tsx";
import { Button } from "../components/ui.tsx";
import { ComposerPopover } from "./ComposerPopover.tsx";

// "queue" = 创建并排队:建完入队不起跑,等所选目标任务跑完由队列自动拉起。
// 目标选择器由面板经 queueSlot 递进来(候选要任务列表,这个纯展示组件不该自己去取)。
export type LaunchMode = "create" | "run" | "queue" | ScheduleKind;

const LAUNCH_OPTIONS: { value: LaunchMode; label: string }[] = [
  { value: "run", label: "创建并运行" },
  { value: "queue", label: "创建并排队" },
  { value: "create", label: "仅创建" },
  { value: "once", label: "一次性定时" },
  { value: "cron", label: "循环 Cron" },
];

function submitLabel(mode: LaunchMode): string {
  if (mode === "run") return "创建并运行";
  if (mode === "queue") return "创建并排队";
  if (mode === "create") return "创建任务";
  return "创建并定时";
}

function SubmitIcon({ mode }: { mode: LaunchMode }) {
  if (mode === "run") return <Play size={12} weight="fill" />;
  if (mode === "queue") return <ListNumbers size={12} />;
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
  queueSlot,
  queueUnavailable,
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
  /** mode="queue" 时的目标任务选择器(由面板构造,这里只负责摆进浮层)。 */
  queueSlot?: ReactNode;
  /** 非空 = 当前任务模式不支持排队(如团队任务),选项置灰并附上原因。 */
  queueUnavailable?: string | null;
}) {
  return (
    <div className="composer-launch-control">
      <div className="studio-input-tools">
      {attachmentTool}
      <span className="studio-tool-divider" aria-hidden="true" />
      {executorTools}
      </div>
      {/* 启动设置贴着提交按钮(连体的 ▾ 段):提交方式和提交动作是一件事,放回左侧
          工具堆里会被淹没,用户找不到「创建并排队」在哪(2026-10-10 反馈)。 */}
      <div className="studio-submit-group">
        <Button variant="primary" className="studio-submit" disabled={!canSubmit} onClick={onSubmit}
          aria-label={busy ? "创建中…" : submitLabel(mode)}>
          <span>{busy ? "创建中…" : submitLabel(mode)}</span><ArrowUp size={18} weight="bold" />
        </Button>
        <ComposerPopover label="启动设置" value={LAUNCH_OPTIONS.find((option) => option.value === mode)?.label}
          disabled={busy} className={`studio-submit-mode${mode !== "run" ? " is-configured" : ""}`}
          trigger={<SubmitIcon mode={mode} />}>
        {/* 启动方式平铺成单选 chip(用户 2026-10-10:别再套一层原生下拉,点一下直达)。 */}
        <div className="composer-launch-mode" role="radiogroup" aria-label="启动方式">
          <span>启动方式</span>
          <div className="composer-launch-mode-grid">
            {LAUNCH_OPTIONS.map((option) => {
              const blocked = option.value === "queue" && !!queueUnavailable;
              return (
                <button key={option.value} type="button" role="radio"
                  aria-checked={mode === option.value} disabled={busy || blocked}
                  aria-label={blocked ? `${option.label}（${queueUnavailable}）` : option.label}
                  className={`composer-launch-mode-chip${mode === option.value ? " is-active" : ""}`}
                  onClick={() => onModeChange(option.value)}>
                  <SubmitIcon mode={option.value} />{option.label}
                </button>
              );
            })}
          </div>
          {queueUnavailable && <small className="composer-launch-blocked">{queueUnavailable}</small>}
        </div>
        {mode === "queue" && queueSlot}
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
        <p className="studio-help"><SubmitIcon mode={mode} />{mode === "run" ? "创建后立即开始执行。" : mode === "queue" ? "建完入队不起跑，排在所选任务之后，轮到它时自动开始。" : mode === "create" ? "先放入待办，需要时再运行。" : mode === "once" ? "在指定的本地时间运行一次。" : "按 Cron 表达式循环运行。"}</p>
        </ComposerPopover>
      </div>
    </div>
  );
}
