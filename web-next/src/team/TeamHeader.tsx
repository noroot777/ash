import { useEffect, useRef, useState, type ReactNode } from "react";
import type { Group, Task } from "@harness/shared";
import { canArchive, taskDisplayStatus } from "@harness/shared";
import { isTeamSettled, teamNeverStarted } from "@harness/shared/team";
import {
  Archive,
  ArrowCounterClockwise,
  CheckCircle,
  Copy,
  DotsThree,
  DownloadSimple,
  Play,
  ChatsCircle,
  Stop,
  Trash,
} from "@phosphor-icons/react";
import { useDismissable } from "../lib/useDismissable.ts";
import { TaskPinButton } from "../task-detail/TaskPinButton.tsx";
import { TaskStatusDot } from "../components/TaskStatusDot.tsx";
import type { IndicatorForTask } from "../lib/useTaskReadState.ts";
import { ConfirmDialog } from "../task-detail/ConfirmDialog.tsx";
import { safeDownloadName } from "../task-detail/utils.ts";
import { teamDuetIterationState } from "../duet/handoffPolicy.ts";

export function TeamHeader({
  task,
  allTasks,
  workers,
  groups,
  haltedByHistory,
  conversationMarkdown,
  busy,
  iterateBusy,
  reviewOpen,
  onTitle,
  onTogglePin,
  onReview,
  onRun,
  onHalt,
  onResume,
  onIterateDuet,
  onArchive,
  onDelete,
  indicatorForTask,
  inspectorToggle,
  notify,
}: {
  task: Task;
  allTasks: Task[];
  workers: Task[];
  groups: Group[];
  haltedByHistory: boolean;
  conversationMarkdown: string;
  busy: boolean;
  iterateBusy: boolean;
  reviewOpen: boolean;
  onTitle: (title: string) => Promise<void>;
  onTogglePin: () => Promise<void>;
  onReview: () => void;
  onRun: () => void;
  onHalt: () => void;
  onResume: () => void;
  onIterateDuet: () => void;
  onArchive: () => void;
  onDelete: () => void;
  indicatorForTask: IndicatorForTask;
  inspectorToggle?: ReactNode;
  notify: (message: string) => void;
}) {
  const [menu, setMenu] = useState(false);
  const [haltOpen, setHaltOpen] = useState(false);
  const [title, setTitle] = useState(task.title);
  const [editing, setEditing] = useState(false);
  const menuRoot = useRef<HTMLDivElement>(null);
  const menuButton = useRef<HTMLButtonElement>(null);
  const pausedGroups = groups.filter((group) => group.paused);
  const stopped = pausedGroups.length > 0 || haltedByHistory;
  const settled = isTeamSettled(task.status === "running", workers);
  const iteration = teamDuetIterationState(task, allTasks);
  const display = taskDisplayStatus(task.status, task.stage, !!task.question);
  const indicator = indicatorForTask(task);

  useEffect(() => { if (!editing) setTitle(task.title); }, [editing, task.title]);
  useDismissable({
    enabled: menu,
    containerRef: menuRoot,
    onClose: () => setMenu(false),
    restoreFocusRef: menuButton,
  });

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
      notify("复制失败，请检查浏览器剪贴板权限后重试");
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
        <div className="team-header-actions">
          <button type="button" className={reviewOpen ? "is-primary" : ""} onClick={onReview}>
            <CheckCircle size={14} weight="fill" />{reviewOpen ? "返回协作" : "验收"}
          </button>
          {iteration.eligible && (
            <button
              type="button"
              className="is-iterate"
              disabled={busy || iterateBusy}
              onClick={onIterateDuet}
              title={iteration.existing ? "打开这个团队已经创建的下一轮讨论" : "读取团队执行记录，沿用来源讨论配置创建下一轮"}
            >
              <ChatsCircle size={13} weight="fill" />
              {iterateBusy ? "创建中…" : iteration.existing ? "打开下一轮" : "再讨论一轮"}
            </button>
          )}
          {!task.archived && !settled && !stopped && !teamNeverStarted(task.status) && (
            <button type="button" className="is-danger" disabled={busy} onClick={() => setHaltOpen(true)}><Stop size={13} weight="fill" />停止全组</button>
          )}
          {!task.archived && stopped && (
            <button type="button" className="is-primary" data-workspace-run-action="resume" disabled={busy} onClick={onResume}><Play size={13} weight="fill" />恢复全组</button>
          )}
          {!task.archived && teamNeverStarted(task.status) && (
            <button type="button" className="is-primary" data-workspace-run-action="run" disabled={busy} onClick={onRun}><Play size={13} weight="fill" />运行</button>
          )}
          <div className="team-header-menu" ref={menuRoot}>
            <button ref={menuButton} type="button" aria-label="更多团队操作" aria-expanded={menu} onClick={() => setMenu((value) => !value)}><DotsThree size={18} weight="bold" /></button>
            {menu && (
              <div role="menu">
                <button type="button" role="menuitem" disabled={!conversationMarkdown.trim()} onClick={() => void copy()}><Copy size={14} />复制全部对话</button>
                <button type="button" role="menuitem" disabled={!conversationMarkdown.trim()} onClick={download}><DownloadSimple size={14} />下载 Markdown</button>
                <span role="separator" />
                <button type="button" role="menuitem" disabled={!task.archived && !canArchive(task.status)} onClick={() => { setMenu(false); onArchive(); }}>
                  {task.archived ? <ArrowCounterClockwise size={14} /> : <Archive size={14} />}{task.archived ? "取消归档" : "归档团队"}
                </button>
                <button type="button" role="menuitem" className="is-danger" onClick={() => { setMenu(false); onDelete(); }}>
                  <Trash size={14} />删除团队
                </button>
              </div>
            )}
          </div>
          {inspectorToggle}
        </div>
      </header>
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
