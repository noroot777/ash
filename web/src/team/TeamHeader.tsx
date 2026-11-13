import { useEffect, useRef, useState, type ReactNode } from "react";
import type { Group, Task, TaskActions, TaskListItem } from "@ash/shared";
import { taskDisplayStatus } from "@ash/shared";
import { isTeamSettled, teamNeverStarted } from "@ash/shared/team";
import {
  Archive,
  ArrowCounterClockwise,
  CheckCircle,
  Copy,
  DotsThree,
  DownloadSimple,
  Play,
  Stop,
  Trash,
} from "@phosphor-icons/react";
import { useDismissable } from "../lib/useDismissable.ts";
import { blocker, shown } from "../lib/useTaskActions.ts";
import { ActionMenuItem } from "../components/ActionMenuItem.tsx";
import { HoverTip, useHoverTip } from "../components/HoverTip.tsx";
import { TaskPinButton } from "../task-detail/TaskPinButton.tsx";
import { TaskStatusDot } from "../components/TaskStatusDot.tsx";
import { TaskCreationBadge } from "../components/TaskOrigin.tsx";
import type { IndicatorForTask } from "../lib/useTaskReadState.ts";
import { ConfirmDialog } from "../task-detail/ConfirmDialog.tsx";
import { safeDownloadName } from "../task-detail/utils.ts";

export function TeamHeader({
  task,
  actions,
  workers,
  groups,
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
  onDelete,
  indicatorForTask,
  inspectorToggle,
  notify,
}: {
  task: Task;
  /** 「运行」和「归档团队」出不出、点不点得了照服务端的判据（lib/useTaskActions.ts）；停止全组 / 恢复全组是团队壳自己的事。 */
  actions: TaskActions | null;
  workers: TaskListItem[];
  groups: Group[];
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
  const runBlocked = blocker(actions?.primary);
  const runTip = useHoverTip();
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
  const copy = async (text: string, message: string) => {
    try {
      await navigator.clipboard.writeText(text);
      notify(message);
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
        <TaskCreationBadge task={task} />
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
          {!task.archived && !settled && !stopped && !teamNeverStarted(task.status) && (
            <button type="button" className="is-danger" disabled={busy} onClick={() => setHaltOpen(true)}><Stop size={13} weight="fill" />停止全组</button>
          )}
          {!task.archived && stopped && (
            <button type="button" className="is-primary" data-workspace-run-action="resume" disabled={busy} onClick={onResume}><Play size={13} weight="fill" />恢复全组</button>
          )}
          {shown(actions?.primary) && (
            <>
              <button type="button" className={`is-primary${runBlocked ? " is-disabled" : ""}`} data-workspace-run-action="run" disabled={busy} aria-disabled={runBlocked ? true : undefined} {...(runBlocked ? runTip.anchorProps : {})} onClick={() => { if (!runBlocked) onRun(); }}><Play size={13} weight="fill" />运行</button>
              {runBlocked && <HoverTip at={runTip.at}>{runBlocked}</HoverTip>}
            </>
          )}
          <div className="team-header-menu" ref={menuRoot}>
            <button ref={menuButton} type="button" aria-label="更多团队操作" aria-expanded={menu} onClick={() => setMenu((value) => !value)}><DotsThree size={18} weight="bold" /></button>
            {menu && (
              <div role="menu">
                <button type="button" role="menuitem" disabled={!conversationMarkdown.trim()} onClick={() => void copy(conversationMarkdown, "已复制调度者的全部对话")}><Copy size={14} />复制全部对话</button>
                <button type="button" role="menuitem" disabled={!conversationMarkdown.trim()} onClick={download}><DownloadSimple size={14} />下载 Markdown</button>
                <button type="button" role="menuitem" onClick={() => void copy(task.id, "已复制团队 ID")}><Copy size={14} />复制团队 ID</button>
                <span role="separator" />
                {task.archived ? (
                  <button type="button" role="menuitem" onClick={() => { setMenu(false); onArchive(); }}><ArrowCounterClockwise size={14} />取消归档</button>
                ) : shown(actions?.archive) && (
                  <ActionMenuItem verdict={actions!.archive} onSelect={() => { setMenu(false); onArchive(); }}><Archive size={14} />归档团队</ActionMenuItem>
                )}
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
