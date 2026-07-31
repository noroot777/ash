import { useEffect, useMemo, useRef, useState } from "react";
import type { Task } from "@harness/shared";
import { canArchive, taskDisplayStatus } from "@harness/shared";
import {
  Archive,
  ArrowCounterClockwise,
  CheckCircle,
  Copy,
  DotsThree,
  DownloadSimple,
  GitDiff,
  ListNumbers,
  Play,
  SpinnerGap,
  Stop,
  Trash,
} from "@phosphor-icons/react";
import { TaskPinButton } from "./TaskPinButton.tsx";
import { TaskTimeMeta } from "./TaskTimeMeta.tsx";
import { safeDownloadName, STATUS_TONES } from "./utils.ts";

export type PrimaryAction = "run" | "retry" | "stop" | "accept" | "unarchive" | null;

function primaryAction(task: Task): { kind: PrimaryAction; label: string; danger?: boolean; disabled?: boolean } {
  if (task.archived) return { kind: "unarchive", label: "取消归档" };
  if (task.status === "running") return { kind: "stop", label: "停止", danger: true };
  if (task.stage === "accepted") return { kind: null, label: "已验收", disabled: true };
  if (task.parentId !== null && task.status === "done") return { kind: null, label: "已完成", disabled: true };
  if (task.status === "done" || task.stage === "awaiting_acceptance" || task.stage === "verified") {
    return { kind: "accept", label: "验收" };
  }
  if (task.status === "failed") return { kind: "retry", label: "重试" };
  if (task.status === "backlog" || task.status === "canceled") return { kind: "run", label: "运行" };
  if (task.status === "paused") return { kind: "run", label: "继续" };
  if (task.status === "queued") return { kind: null, label: "排队中", disabled: true };
  if (task.status === "awaiting_review") return { kind: null, label: "等待裁决", disabled: true };
  return { kind: null, label: task.status === "idle" ? "待命" : "进行中", disabled: true };
}

export function TaskHeader({
  task,
  conversationMarkdown,
  busy,
  refreshing,
  onTitle,
  onTogglePin,
  onPrimary,
  onRequeue,
  onArchive,
  onRefresh,
  onReview,
  onDelete,
  notify,
}: {
  task: Task;
  conversationMarkdown: string;
  busy: boolean;
  refreshing: boolean;
  onTitle: (title: string) => Promise<void>;
  onTogglePin: () => Promise<void>;
  onPrimary: (action: Exclude<PrimaryAction, null>) => void;
  onRequeue: () => void;
  onArchive: () => void;
  onRefresh: () => void;
  onReview: () => void;
  onDelete: () => void;
  notify: (message: string) => void;
}) {
  const [title, setTitle] = useState(task.title);
  const [editing, setEditing] = useState(false);
  const [menu, setMenu] = useState(false);
  const menuRoot = useRef<HTMLDivElement>(null);
  const pointerToggle = useRef(false);
  const action = primaryAction(task);
  const canRequeue = task.parentId === null
    && !task.archived
    && !!task.queueId
    && (task.status === "failed" || task.status === "canceled");
  const display = taskDisplayStatus(task.status, task.stage, !!task.question);

  useEffect(() => { if (!editing) setTitle(task.title); }, [editing, task.title]);
  useEffect(() => {
    if (!menu) return;
    const close = (event: PointerEvent) => {
      if (!menuRoot.current?.contains(event.target as Node)) setMenu(false);
    };
    window.addEventListener("pointerdown", close);
    return () => window.removeEventListener("pointerdown", close);
  }, [menu]);

  const download = () => {
    const blob = new Blob([conversationMarkdown], { type: "text/markdown;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `${safeDownloadName(task)}.md`;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(url);
    setMenu(false);
  };
  const copy = async (text: string, message: string) => {
    try {
      await navigator.clipboard.writeText(text);
      notify(message);
    } catch {
      notify("复制失败，请用旧版打开后重试");
    }
    setMenu(false);
  };
  const taskUrl = useMemo(() => window.location.href, [task.id]);

  const commitTitle = async () => {
    setEditing(false);
    const next = title.trim();
    if (!next || next === task.title) return setTitle(task.title);
    try {
      await onTitle(next);
    } catch (reason) {
      setTitle(task.title);
      notify(reason instanceof Error ? reason.message : String(reason));
    }
  };

  return (
    <header className="task-detail-header">
      <span className="task-detail-kind">{task.mode === "single" ? "任务" : task.mode === "team" ? "团队" : "辩论"}</span>
      {task.parentId === null && <TaskPinButton task={task} onTogglePin={onTogglePin} notify={notify} />}
      {task.parentId !== null ? (
        <span className="task-detail-title is-readonly">{task.title || "未命名任务"}</span>
      ) : (
        <input
          className="task-detail-title"
          value={title}
          aria-label="任务标题"
          onFocus={() => setEditing(true)}
          onChange={(event) => setTitle(event.target.value)}
          onBlur={() => void commitTitle()}
          onKeyDown={(event) => {
            if (event.key === "Enter") event.currentTarget.blur();
            if (event.key === "Escape") { setTitle(task.title); event.currentTarget.blur(); }
          }}
        />
      )}
      <span className={`task-detail-status task-detail-status--${STATUS_TONES[task.question ? "awaiting_answer" : task.status]}`}>
        <i aria-hidden="true" />{display.label}
      </span>
      <TaskTimeMeta task={task} />
      <button
        className={`task-primary-action${action.danger ? " is-danger" : ""}`}
        type="button"
        data-workspace-run-action={action.kind === "run" || action.kind === "retry" ? action.kind : undefined}
        disabled={busy || action.disabled || !action.kind}
        onClick={() => action.kind && onPrimary(action.kind)}
      >
        {busy ? <SpinnerGap size={13} className="is-spinning" />
          : action.kind === "stop" ? <Stop size={13} weight="fill" />
            : action.kind === "accept" ? <CheckCircle size={14} weight="fill" />
              : action.kind === "retry" || action.kind === "unarchive" ? <ArrowCounterClockwise size={13} />
                : <Play size={13} weight="fill" />}
        {action.label}
      </button>
      {canRequeue && (
        <button
          className="task-requeue-action"
          type="button"
          disabled={busy}
          title="回到队列等待；若队列已经越过此任务，则移到队尾"
          onClick={onRequeue}
        >
          <ListNumbers size={13} />
          <span>重新排队</span>
        </button>
      )}
      <div className="task-overflow" ref={menuRoot}>
        <button
          className="task-overflow-trigger"
          type="button"
          aria-label="更多任务操作"
          aria-expanded={menu}
          onPointerDown={(event) => {
            event.preventDefault();
            pointerToggle.current = true;
            setMenu((open) => !open);
          }}
          onClick={() => {
            if (pointerToggle.current) { pointerToggle.current = false; return; }
            setMenu((open) => !open);
          }}
        >
          <DotsThree size={18} weight="bold" aria-hidden="true" />
        </button>
        {menu && (
          <div className="task-overflow-menu" role="menu">
            <button type="button" role="menuitem" onClick={() => { setMenu(false); onRefresh(); }} disabled={refreshing}>
              <ArrowCounterClockwise size={14} className={refreshing ? "is-spinning" : ""} />刷新
            </button>
            <button type="button" role="menuitem" onClick={() => { setMenu(false); onReview(); }}>
              <GitDiff size={14} />查看改动与审查
            </button>
            <button type="button" role="menuitem" onClick={() => void copy(conversationMarkdown, "已复制全部对话")} disabled={!conversationMarkdown.trim()}>
              <Copy size={14} />复制全部对话
            </button>
            <button type="button" role="menuitem" onClick={download} disabled={!conversationMarkdown.trim()}>
              <DownloadSimple size={14} />下载 Markdown
            </button>
            <button type="button" role="menuitem" onClick={() => void copy(taskUrl, "已复制任务链接")}>
              <Copy size={14} />复制任务链接
            </button>
            {task.parentId === null && <span role="separator" />}
            {task.parentId === null && (
              <button type="button" role="menuitem" onClick={() => { setMenu(false); onArchive(); }} disabled={!task.archived && !canArchive(task.status)}>
                <Archive size={14} />{task.archived ? "取消归档" : "归档任务"}
              </button>
            )}
            {task.parentId === null && (
              <button className="is-danger" type="button" role="menuitem" onClick={() => { setMenu(false); onDelete(); }}>
                <Trash size={14} />删除任务
              </button>
            )}
          </div>
        )}
      </div>
    </header>
  );
}
