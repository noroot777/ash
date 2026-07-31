import { useEffect, useRef, useState } from "react";
import type { Group, Session, Task } from "@harness/shared";
import { canArchive, taskDisplayStatus } from "@harness/shared";
import { agentMix, isTeamSettled, teamNeverStarted } from "@harness/shared/team";
import {
  Archive,
  ArrowCounterClockwise,
  CheckCircle,
  Copy,
  DotsThree,
  DownloadSimple,
  Play,
  Stop,
} from "@phosphor-icons/react";
import { LegacyLink } from "../components/LegacyLink.tsx";
import { TaskStatusDot } from "../components/TaskStatusDot.tsx";
import type { IndicatorForTask } from "../lib/useTaskReadState.ts";
import { ConfirmDialog } from "../task-detail/ConfirmDialog.tsx";
import { TaskPinButton } from "../task-detail/TaskPinButton.tsx";
import { TaskTimeMeta } from "../task-detail/TaskTimeMeta.tsx";
import { safeDownloadName } from "../task-detail/utils.ts";
import { teamLeadLabel, teamReviewerLabel, teamWorkerLabel } from "./teamModel.ts";

export function TeamHeader({
  task,
  workers,
  groups,
  sessions,
  haltedByHistory,
  conversationMarkdown,
  busy,
  reviewOpen,
  onTitle,
  onTogglePin,
  onReview,
  onRun,
  onHalt,
  onResume,
  onArchive,
  indicatorForTask,
  notify,
}: {
  task: Task;
  workers: Task[];
  groups: Group[];
  sessions: Session[];
  haltedByHistory: boolean;
  conversationMarkdown: string;
  busy: boolean;
  reviewOpen: boolean;
  onTitle: (title: string) => Promise<void>;
  onTogglePin: () => Promise<void>;
  onReview: () => void;
  onRun: () => void;
  onHalt: () => void;
  onResume: () => void;
  onArchive: () => void;
  indicatorForTask: IndicatorForTask;
  notify: (message: string) => void;
}) {
  const [menu, setMenu] = useState(false);
  const [haltOpen, setHaltOpen] = useState(false);
  const [title, setTitle] = useState(task.title);
  const [editing, setEditing] = useState(false);
  const menuRoot = useRef<HTMLDivElement>(null);
  const pausedGroups = groups.filter((group) => group.paused);
  const stopped = pausedGroups.length > 0 || haltedByHistory;
  const settled = isTeamSettled(task.status === "running", workers);
  const display = taskDisplayStatus(task.status, task.stage, !!task.question);
  const indicator = indicatorForTask(task);
  const latestSession = [...sessions].sort((left, right) => right.startedAt.localeCompare(left.startedAt))[0];
  const reviewEnabled = task.team?.review !== false;

  useEffect(() => { if (!editing) setTitle(task.title); }, [editing, task.title]);
  useEffect(() => {
    if (!menu) return;
    const close = (event: PointerEvent) => {
      if (!menuRoot.current?.contains(event.target as Node)) setMenu(false);
    };
    window.addEventListener("pointerdown", close);
    return () => window.removeEventListener("pointerdown", close);
  }, [menu]);

  const commitTitle = async () => {
    setEditing(false);
    const next = title.trim();
    if (!next || next === task.title) return setTitle(task.title);
    try {
      await onTitle(next);
    } catch (error) {
      setTitle(task.title);
      notify(error instanceof Error ? error.message : String(error));
    }
  };
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(conversationMarkdown);
      notify("已复制调度者的全部对话");
    } catch {
      notify("复制失败，请用旧版打开后重试");
    }
    setMenu(false);
  };
  const download = () => {
    const blob = new Blob([conversationMarkdown], { type: "text/markdown;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `${safeDownloadName(task)}.md`;
    link.click();
    URL.revokeObjectURL(url);
    setMenu(false);
  };

  return (
    <>
      <header className="team-header">
        <span className="team-kind">团队</span>
        <TaskPinButton task={task} onTogglePin={onTogglePin} notify={notify} />
        <input
          value={title}
          aria-label="团队标题"
          onFocus={() => setEditing(true)}
          onChange={(event) => setTitle(event.target.value)}
          onBlur={() => void commitTitle()}
          onKeyDown={(event) => {
            if (event.key === "Enter") event.currentTarget.blur();
            if (event.key === "Escape") { setTitle(task.title); event.currentTarget.blur(); }
          }}
        />
        <span className="team-busy-pill">
          {indicator && <TaskStatusDot indicator={indicator} surface="team" />}
          {display.label}
        </span>
        <TaskTimeMeta task={task} />
        <div className="team-header-actions">
          <button type="button" className={reviewOpen ? "is-primary" : ""} onClick={onReview}>
            <CheckCircle size={14} weight="fill" />{reviewOpen ? "返回协作" : "验收"}
          </button>
          {!task.archived && !settled && !stopped && !teamNeverStarted(task.status) && (
            <button type="button" className="is-danger" disabled={busy} onClick={() => setHaltOpen(true)}><Stop size={13} weight="fill" />停止全组</button>
          )}
          {!task.archived && stopped && (
            <button type="button" className="is-primary" disabled={busy} onClick={onResume}><Play size={13} weight="fill" />恢复全组</button>
          )}
          {!task.archived && teamNeverStarted(task.status) && (
            <button type="button" className="is-primary" disabled={busy} onClick={onRun}><Play size={13} weight="fill" />运行</button>
          )}
          <div className="team-header-menu" ref={menuRoot}>
            <button type="button" aria-label="更多团队操作" aria-expanded={menu} onClick={() => setMenu((value) => !value)}><DotsThree size={18} weight="bold" /></button>
            {menu && (
              <div role="menu">
                <button type="button" role="menuitem" disabled={!conversationMarkdown.trim()} onClick={() => void copy()}><Copy size={14} />复制全部对话</button>
                <button type="button" role="menuitem" disabled={!conversationMarkdown.trim()} onClick={download}><DownloadSimple size={14} />下载 Markdown</button>
                <LegacyLink projectId={task.projectId} taskId={task.id} />
                <span role="separator" />
                <button type="button" role="menuitem" disabled={!task.archived && !canArchive(task.status)} onClick={() => { setMenu(false); onArchive(); }}>
                  {task.archived ? <ArrowCounterClockwise size={14} /> : <Archive size={14} />}{task.archived ? "取消归档" : "归档团队"}
                </button>
              </div>
            )}
          </div>
        </div>
      </header>
      <div className="team-meta" aria-label="团队执行配置">
        <span>调度者 <b>{teamLeadLabel(task, latestSession)}</b></span>
        <span>
          执行者 <b>{workers.length}</b>
          {workers.length ? `（${agentMix(workers)}）` : `（默认派 ${teamWorkerLabel(task)}）`}
        </span>
        <span className={reviewEnabled ? "is-review" : ""}>
          审查 <b>{reviewEnabled ? teamReviewerLabel(task) : "已关闭"}</b>
          {reviewEnabled && ` · ${task.team?.reviewerModel || "模型跟随"} · ${task.team?.reviewerReasoningEffort || "强度跟随"}`}
        </span>
        {latestSession?.branch && <span>分支 <code title={latestSession.branch}>{latestSession.branch}</code></span>}
        {latestSession?.worktreePath && <code title={latestSession.worktreePath}>…/{latestSession.worktreePath.split("/").filter(Boolean).at(-1)}</code>}
      </div>
      {haltOpen && (
        <ConfirmDialog
          title="停止全组？"
          message="调度台进程会停止，正在运行的执行者会落为可恢复的暂停状态；会话和已完成结果都会保留。"
          confirmLabel="停止全组"
          danger
          busy={busy}
          onConfirm={() => { setHaltOpen(false); onHalt(); }}
          onClose={() => setHaltOpen(false)}
        />
      )}
    </>
  );
}
