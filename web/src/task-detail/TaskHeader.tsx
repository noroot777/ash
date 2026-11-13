import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { Task, TaskListItem } from "@ash/shared";
import { canArchive, hasPendingAcceptCommit } from "@ash/shared";
import { taskCreationLabel } from "@ash/shared/task-origin";
import {
  Archive,
  ArrowCounterClockwise,
  CheckCircle,
  Copy,
  DotsThree,
  DownloadSimple,
  GitCommit,
  GitDiff,
  GitFork,
  ListNumbers,
  Play,
  Robot,
  SealCheck,
  SpinnerGap,
  Trash,
  UsersThree,
} from "@phosphor-icons/react";
import { TaskModeIcon, taskModeLabel, taskParentLink, taskParentRelation } from "../components/TaskOrigin.tsx";
import { HoverTip, useHoverTip } from "../components/HoverTip.tsx";
import { IconButton } from "../components/IconButton.tsx";
import { useDismissable } from "../lib/useDismissable.ts";
import { useLayoutMotion } from "../lib/motion/index.ts";
import { TaskPinButton } from "./TaskPinButton.tsx";
import { headSteps, sealState, type HeadStep } from "./taskHeadSteps.ts";
import { safeDownloadName } from "./utils.ts";

export type PrimaryAction = "run" | "retry" | "stop" | "accept" | "unarchive";

/**
 * 头上一回合级别的「重来」：上一回合崩了、任务却停在终态（续聊回合、自由工作流的修复 / 审查
 * 回合异常结束不改任务状态），判据和动作都在 TaskDetail（turnRetry.ts），这里只摆那颗图标。
 */
export type HeadTurnRetry = { label: string; tip: string; run: () => Promise<void> };

/**
 * 任务头：左边说「这是哪个任务」——类型（灰图标）、标题、来源（灰图标）、图钉；右边只有图标：
 * 此刻轮到你的那一步（重试 / 运行 / 继续）、验收的那枚章、更多、面板开关（docs/ui-ux-audit head-1）。
 *
 * 状态词不在头上写：在跑看回复框那颗键（它就是停止），别的看侧栏那一行的点，右侧「信息」格里
 * 也有一行。时间住进右侧面板；「重新排队」进更多。
 */
export function TaskHeader({
  task,
  allTasks,
  conversationMarkdown,
  busy,
  refreshing,
  reviewOpen,
  turnRetry,
  onTitle,
  onTogglePin,
  onPrimary,
  onRequeue,
  onMarkDone,
  onArchive,
  onRefresh,
  onReview,
  onOpenTask,
  postMergeReviewLabel,
  onPostMergeReview,
  onDelete,
  inspectorToggle,
  notify,
}: {
  task: Task;
  allTasks: TaskListItem[];
  conversationMarkdown: string;
  busy: boolean;
  refreshing: boolean;
  reviewOpen: boolean;
  turnRetry?: HeadTurnRetry | null;
  onTitle: (title: string) => Promise<void>;
  onTogglePin: () => Promise<void>;
  onPrimary: (action: PrimaryAction) => void;
  onRequeue: () => void;
  /** 「标记为已完成」：结算说明让用户核对产物后自己收尾，这是那句话对应的入口。 */
  onMarkDone?: () => void;
  onArchive: () => void;
  onRefresh: () => void;
  onReview: () => void;
  onOpenTask: (taskId: string) => void;
  postMergeReviewLabel?: string | null;
  onPostMergeReview?: () => void;
  onDelete: () => void;
  inspectorToggle?: ReactNode;
  notify: (message: string) => void;
}) {
  const [title, setTitle] = useState(task.title);
  const [editing, setEditing] = useState(false);
  const [menu, setMenu] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const menuRoot = useRef<HTMLDivElement>(null);
  const menuButton = useRef<HTMLButtonElement>(null);
  const pointerToggle = useRef(false);
  // 头上的图标多一颗少一颗时，留下的滑到新位置（run-6）。
  const acts = useRef<HTMLSpanElement>(null);
  useLayoutMotion(acts, ":scope > *");
  const steps = headSteps(task);
  const seal = sealState(task);
  const canRequeue = task.parentId === null
    && !task.archived
    && task.handoff?.direction !== "out"
    && !!task.queueId
    && (task.status === "failed" || task.status === "canceled");
  // 「没交卷」记 failed 时，结算说明请用户「核对产物后直接标记完成」—— 那句话得有个真按得
  // 到的地方，否则它就是空头支票（在此之前，把状态改回 done 只有 API / MCP 能做）。放进
  // 更多菜单而不是顶栏：它是收拾残局用的低频动作，不该在每个失败任务上都摆一颗按钮。
  // 团队执行者不给：调度者是靠结算事件被叫醒的，绕过它直接改状态只会让调度台一直等下去。
  const canMarkDone = task.parentId === null
    && !task.archived
    && task.handoff?.direction !== "out"
    && (task.status === "failed" || task.status === "canceled");

  useEffect(() => { if (!editing) setTitle(task.title); }, [editing, task.title]);
  useDismissable({
    enabled: menu,
    containerRef: menuRoot,
    onClose: () => setMenu(false),
    restoreFocusRef: menuButton,
  });

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
      notify("复制失败，请检查浏览器剪贴板权限后重试");
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

  const runTurnRetry = async () => {
    if (!turnRetry) return;
    setRetrying(true);
    try { await turnRetry.run(); } finally { setRetrying(false); }
  };

  // 任务级的那一步优先：失败了是任务级重试；只有任务停在终态、上一回合却崩了，才轮到回合级那颗。
  const stepButtons: { key: string; step: HeadStep | null }[] = steps.length
    ? steps.map((step) => ({ key: step.kind, step }))
    : turnRetry ? [{ key: "turn-retry", step: null }] : [];

  return (
    <header className="task-detail-header">
      <div className="task-head-name">
        <TaskKindGlyph mode={task.mode} />
        {task.parentId !== null ? (
          <span className="task-detail-title is-readonly">{task.title || "未命名任务"}</span>
        ) : (
          <span className="task-title-sizer" data-value={title || " "}>
            <input
              className="task-detail-title"
              value={title}
              size={1}
              aria-label="任务标题"
              spellCheck={false}
              autoComplete="off"
              onFocus={() => setEditing(true)}
              onChange={(event) => setTitle(event.target.value)}
              onBlur={() => void commitTitle()}
              onKeyDown={(event) => {
                if (event.nativeEvent.isComposing) return;
                if (event.key === "Enter") event.currentTarget.blur();
                if (event.key === "Escape") { setTitle(task.title); event.currentTarget.blur(); }
              }}
            />
          </span>
        )}
        <TaskSourceGlyph task={task} allTasks={allTasks} onOpen={onOpenTask} />
        {task.parentId === null && <TaskPinButton task={task} onTogglePin={onTogglePin} notify={notify} />}
      </div>
      <span className="task-head-grow" />
      <span className="task-head-acts" ref={acts}>
        {stepButtons.map(({ key, step }) => step ? (
          <IconButton
            key={key}
            label={step.label}
            tip={step.tip}
            className="task-head-step"
            data-workspace-run-action={step.kind === "resume" ? "run" : step.kind}
            disabled={busy}
            onClick={() => onPrimary(step.kind === "retry" ? "retry" : "run")}
          >
            {busy ? <SpinnerGap size={16} className="is-spinning" aria-hidden="true" />
              : step.kind === "retry" ? <ArrowCounterClockwise size={16} aria-hidden="true" />
                : <Play size={16} aria-hidden="true" />}
          </IconButton>
        ) : (
          <IconButton
            key={key}
            label={turnRetry!.label}
            tip={turnRetry!.tip}
            className="task-head-step"
            disabled={retrying}
            onClick={() => void runTurnRetry()}
          >
            {retrying ? <SpinnerGap size={16} className="is-spinning" aria-hidden="true" /> : <ArrowCounterClockwise size={16} aria-hidden="true" />}
          </IconButton>
        ))}
        {/* 「合并后不提交」那一档欠着的那一步。收尾的卡片只住在验收台里（用户 2026-09-15：
            那张卡不用在对话区永远铺着），所以头上留这一颗——一眼看得出还欠一步，点一下就进验收台。 */}
        {!reviewOpen && hasPendingAcceptCommit(task) && (
          <IconButton label="这次验收还欠一步提交，打开验收台收尾" className="task-head-pending" onClick={onReview}>
            <GitCommit size={16} weight="bold" aria-hidden="true" />
          </IconButton>
        )}
        {/* 验收台开着时，回去的口在验收台顶栏右端（TaskReviewWorkspace），这里不再另放一颗。 */}
        {seal && (
          <IconButton
            label={seal === "done" ? "已验收" : "验收"}
            tip={seal === "done" ? "已验收 · 打开改动工作区" : "验收 · 打开改动工作区"}
            className={`task-head-seal${seal === "done" ? " is-done" : ""}`}
            aria-expanded={reviewOpen}
            onClick={onReview}
          >
            <SealCheck size={17} weight={seal === "done" ? "fill" : "regular"} aria-hidden="true" />
          </IconButton>
        )}
      </span>
      <div className="task-overflow" ref={menuRoot}>
        <IconButton
          ref={menuButton}
          label="更多任务操作"
          aria-haspopup="menu"
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
        </IconButton>
        {menu && (
          <div className="task-overflow-menu" role="menu">
            {canRequeue && (
              <button type="button" role="menuitem" disabled={busy} onClick={() => { setMenu(false); onRequeue(); }}>
                <ListNumbers size={14} />重新排队
              </button>
            )}
            {canRequeue && <span role="separator" />}
            {/* 正在读就把「刷新」禁掉，等于把唯一的恢复入口交给了它要恢复的那件事——
                会话读取卡住时 refreshing 恰好一直是 true。重读本身是抢占式的（点它就
                掐掉在途那一发重来，见 lib/useConversation.ts），连点无害，所以只留转圈
                这个反馈，不再拦着点。 */}
            <button type="button" role="menuitem" onClick={() => { setMenu(false); onRefresh(); }}>
              <ArrowCounterClockwise size={14} className={refreshing ? "is-spinning" : ""} />刷新
            </button>
            <button type="button" role="menuitem" onClick={() => { setMenu(false); onReview(); }}>
              <GitDiff size={14} />查看改动与审查
            </button>
            {postMergeReviewLabel && onPostMergeReview && (
              <button type="button" role="menuitem" onClick={() => { setMenu(false); onPostMergeReview(); }}>
                <GitCommit size={14} />{postMergeReviewLabel}
              </button>
            )}
            <button type="button" role="menuitem" onClick={() => void copy(conversationMarkdown, "已复制全部对话")} disabled={!conversationMarkdown.trim()}>
              <Copy size={14} />复制全部对话
            </button>
            <button type="button" role="menuitem" onClick={download} disabled={!conversationMarkdown.trim()}>
              <DownloadSimple size={14} />下载 Markdown
            </button>
            <button type="button" role="menuitem" onClick={() => void copy(taskUrl, "已复制任务链接")}>
              <Copy size={14} />复制任务链接
            </button>
            <button type="button" role="menuitem" onClick={() => void copy(task.id, "已复制任务 ID")}>
              <Copy size={14} />复制任务 ID
            </button>
            {canMarkDone && onMarkDone && <span role="separator" />}
            {canMarkDone && onMarkDone && (
              <button type="button" role="menuitem" onClick={() => { setMenu(false); onMarkDone(); }}>
                <CheckCircle size={14} />标记为已完成
              </button>
            )}
            {task.parentId === null && <span role="separator" />}
            {task.parentId === null && (
              <button
                type="button"
                role="menuitem"
                onClick={() => { setMenu(false); onArchive(); }}
                disabled={!task.archived && !canArchive(task.status)}
              >
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
      {inspectorToggle}
    </header>
  );
}

/** 类型：标题前面的一个灰图标，名字在提示里（和侧栏行尾那颗是同一套 TaskModeIcon）。 */
function TaskKindGlyph({ mode }: { mode: Task["mode"] }) {
  const hover = useHoverTip();
  const name = mode === "single" ? "任务" : `${taskModeLabel(mode)}任务`;
  return (
    <span className="task-head-glyph" role="img" aria-label={name} tabIndex={-1} {...hover.anchorProps}>
      <TaskModeIcon mode={mode} size={14} />
      <HoverTip at={hover.at}>{name}</HoverTip>
    </span>
  );
}

/**
 * 来源：标题后面的一个灰图标，自己建的任务没有。名字（谁开的、从哪个任务来）在提示里，点它去
 * 来源任务——原来那一整条「来自…」横条（OriginTaskBar）的事，在这一颗上做完，不另占一行。
 */
function TaskSourceGlyph({ task, allTasks, onOpen }: { task: TaskListItem; allTasks: TaskListItem[]; onOpen: (taskId: string) => void }) {
  const link = taskParentLink(task, allTasks);
  const creator = task.creationOrigin?.kind === "agent" ? task.creationOrigin : null;
  if (!link && !creator) return null;
  const relation = link ? taskParentRelation(link) : null;
  const sourceTitle = link?.task?.title || (creator?.taskId === link?.taskId ? creator?.taskTitle : null) || null;
  const said = [
    creator ? [taskCreationLabel(creator), creator.executorLabel].filter(Boolean).join(" · ") : null,
    relation ? `${relation}${sourceTitle ? `：${sourceTitle}` : ""}` : null,
  ].filter(Boolean).join("，");
  const glyph = link?.kind === "team" ? <UsersThree size={14} aria-hidden="true" />
    : creator ? <Robot size={14} aria-hidden="true" />
      : <GitFork size={14} aria-hidden="true" />;
  if (link?.task) {
    return (
      <IconButton label={said} size="sm" className="task-head-source" onClick={() => onOpen(link.taskId)}>
        {glyph}
      </IconButton>
    );
  }
  return <SourceMark said={said}>{glyph}</SourceMark>;
}

function SourceMark({ said, children }: { said: string; children: ReactNode }) {
  const hover = useHoverTip();
  return (
    <span className="task-head-glyph task-head-source" role="img" aria-label={said} {...hover.anchorProps}>
      {children}
      <HoverTip at={hover.at}>{said}</HoverTip>
    </span>
  );
}
