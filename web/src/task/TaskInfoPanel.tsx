import { useEffect, useState, type ReactNode } from "react";
import type {
  Group,
  Priority,
  Session,
  Task,
  TaskStatus,
} from "@harness/shared";
import { isUserSettableStatus } from "@harness/shared";
import {
  ArrowsClockwise,
  CaretDown,
  DownloadSimple,
  GitBranch,
  GitCommit,
  GitDiff,
  ListNumbers,
  Trash,
} from "@phosphor-icons/react";
import { api } from "../api";
import {
  conversationToText,
  downloadConversation,
  type ConvItem,
} from "../Conversation";
import { PRIORITIES, STATUS_META } from "../constants";
import {
  AttachmentDisplay,
  parseAttachmentText,
} from "../messageAttachments";
import { Menu } from "../Menu";
import { ScheduleControl } from "../ScheduleControl";
import { StatusIcon } from "../StatusIcon";
import { TaskPinButton } from "../TaskPinMenu";
import { TaskTimeChip } from "../time";
import { CollapsibleText, CopyButton, LabelAdder, PriorityIcon } from "../ui";
import { groupLabel } from "../util";

export function TaskInfoPanel({
  task,
  managedWorker,
  groups,
  sessions,
  items,
  queueSize,
  refreshing,
  runConfigControls,
  onPatch,
  onCreateGroup,
  onOpenQueue,
  onOpenDiff,
  onRefresh,
  onDelete,
}: {
  task: Task;
  managedWorker: boolean;
  groups: Group[];
  sessions: Session[];
  items: ConvItem[];
  queueSize: number | null;
  refreshing: boolean;
  runConfigControls: ReactNode;
  onPatch: (patch: Partial<Task>) => void | Promise<void>;
  onCreateGroup: () => void;
  onOpenQueue: () => void;
  onOpenDiff: () => void;
  onRefresh: () => void;
  onDelete: () => void;
}) {
  const objective = parseAttachmentText(task.body);
  const lastSession = sessions[sessions.length - 1];
  const [gitMeta, setGitMeta] = useState<{ branch: string | null; commits: number } | null>(null);
  const [gitError, setGitError] = useState(false);

  useEffect(() => {
    let alive = true;
    setGitError(false);
    void api.taskCommits(task.id).then(
      ({ branch, commits }) => {
        if (alive) setGitMeta({ branch, commits: commits.length });
      },
      () => {
        if (alive) {
          setGitMeta(null);
          setGitError(true);
        }
      },
    );
    return () => { alive = false; };
  }, [task.id, task.updatedAt, task.stage]);

  const branch = gitMeta?.branch || lastSession?.branch;
  const worktree = lastSession?.worktreePath || lastSession?.cwd;
  const archivedClass = task.archived ? "pointer-events-none opacity-60" : "";

  return (
    <div className="min-h-full bg-canvas px-4 py-4">
      <section>
        <PanelHeading eyebrow="任务属性" title="状态与归类" />
        {managedWorker ? (
          <div className="mt-3 overflow-hidden rounded-lg border border-line bg-panel">
            <InfoRow
              icon={<StatusIcon status={task.status} stage={task.stage} awaitingAnswer={!!task.question} size={10} />}
              label="状态"
              value={STATUS_META[task.status].label}
            />
            <InfoRow label="优先级" value={PRIORITIES.find((priority) => priority.key === task.priority)?.label ?? task.priority} border />
            <InfoRow label="分组" value={groups.find((group) => group.id === task.groupId)?.name ?? "无分组"} border />
            <InfoRow label="标签" value={task.labels.join("、") || "无标签"} border />
          </div>
        ) : (
          <>
            <div className={`mt-3 flex flex-wrap gap-2 ${archivedClass}`}>
              <Prop
                value={task.status}
                onChange={(value) => onPatch({ status: value as TaskStatus })}
                options={Object.values(STATUS_META)
                  .filter((status) => isUserSettableStatus(status.key) || status.key === task.status)
                  .map((status) => ({ value: status.key, label: status.label }))}
                leading={(value) => <StatusIcon status={value as TaskStatus} size={13} />}
              />
              <Prop
                value={task.priority}
                onChange={(value) => onPatch({ priority: value as Priority })}
                options={PRIORITIES.map((priority) => ({ value: priority.key, label: priority.label }))}
                leading={(value) => <PriorityIcon p={value as Priority} />}
              />
              <Prop
                value={task.groupId ?? ""}
                onChange={(value) => (value === "__new" ? onCreateGroup() : onPatch({ groupId: value || null }))}
                options={[
                  { value: "", label: "无分组" },
                  ...groups.map((group) => ({ value: group.id, label: groupLabel(group) })),
                  { value: "__new", label: "+ 新建分组" },
                ]}
              />
            </div>
            <div className={`mt-3 flex flex-wrap items-center gap-1.5 ${archivedClass}`}>
              {task.labels.map((label) => (
                <button
                  key={label}
                  type="button"
                  onClick={() => onPatch({ labels: task.labels.filter((candidate) => candidate !== label) })}
                  className="rounded-full bg-overlay px-2 py-0.5 text-[11px] text-ink transition-colors hover:bg-line2"
                  title="点击移除"
                >
                  {label}
                </button>
              ))}
              <LabelAdder onAdd={(label) => !task.labels.includes(label) && onPatch({ labels: [...task.labels, label] })} />
              {task.labels.length === 0 && <span className="text-[11px] text-faint">尚未添加标签</span>}
            </div>
          </>
        )}
      </section>

      <section className="mt-5 border-t border-line pt-4">
        <PanelHeading eyebrow="调度" title="队列与定时" />
        <div className="mt-3 overflow-hidden rounded-lg border border-line bg-panel">
          <div className="flex items-center gap-2 px-3 py-2.5 text-[11px]">
            <ListNumbers size={13} className="shrink-0 text-faint" />
            <span className="text-faint">队列</span>
            {task.queueId ? (
              managedWorker ? (
                <span className="ml-auto rounded bg-overlay px-2 py-1 font-medium text-ink">
                  第 {(task.queuePosition ?? 0) + 1}{queueSize != null ? ` / ${queueSize}` : ""} 位
                </span>
              ) : (
                <button
                  type="button"
                  onClick={onOpenQueue}
                  className="ml-auto rounded bg-overlay px-2 py-1 font-medium text-ink transition-colors hover:bg-line2"
                  title="点开查看完整队列"
                >
                  第 {(task.queuePosition ?? 0) + 1}{queueSize != null ? ` / ${queueSize}` : ""} 位
                </button>
              )
            ) : (
              <span className="ml-auto text-muted">独立任务</span>
            )}
          </div>
          {!managedWorker && (
            <div className={`border-t border-line px-3 py-2.5 ${archivedClass}`}>
              <ScheduleControl taskId={task.id} />
            </div>
          )}
        </div>
      </section>

      {!managedWorker && (
        <section className="mt-5 border-t border-line pt-4">
          <PanelHeading eyebrow="运行配置" title="执行器与模型" />
          <div className="mt-3 rounded-lg border border-line bg-panel px-3 py-3">
            {runConfigControls}
          </div>
        </section>
      )}

      <section className="mt-5 border-t border-line pt-4">
        <div className="flex items-start gap-3">
          <PanelHeading eyebrow="Git" title="工作区与改动" />
          <button
            type="button"
            onClick={onOpenDiff}
            className="ml-auto inline-flex items-center gap-1 rounded-md px-2 py-1 text-[11px] font-medium text-accent transition-colors hover:bg-accent/10"
          >
            查看改动 <GitDiff size={12} />
          </button>
        </div>
        <div className="mt-3 overflow-hidden rounded-lg border border-line bg-panel">
          <InfoRow
            icon={<GitBranch size={12} />}
            label="分支"
            value={branch || (task.stage === "accepted" && task.useWorktree ? "已在验收后清理" : "未记录")}
            mono
          />
          <InfoRow
            label="基线"
            value={task.worktreeBase || "项目当前分支"}
            mono
            border
          />
          <InfoRow
            label="Worktree"
            value={worktree || (task.useWorktree ? "尚未记录" : "使用项目工作目录")}
            mono
            border
          />
          <InfoRow
            icon={<GitCommit size={12} />}
            label="提交"
            value={gitError ? "读取失败，可在改动工作区重试" : gitMeta ? `${gitMeta.commits} 个` : "读取中…"}
            border
          />
        </div>
      </section>

      <section className="mt-5 border-t border-line pt-4">
        <PanelHeading eyebrow="输入" title="原始需求" />
        {objective.body ? (
          <CollapsibleText text={objective.body}>
            {objective.paths.length > 0 ? <AttachmentDisplay paths={objective.paths} className="px-3 pb-2" /> : null}
          </CollapsibleText>
        ) : objective.paths.length > 0 ? (
          <AttachmentDisplay paths={objective.paths} className="mt-3" />
        ) : (
          <p className="mt-3 rounded-md border border-dashed border-line px-3 py-4 text-[11.5px] text-faint">未填写原始需求。</p>
        )}
      </section>

      <section className="mt-5 border-t border-line pt-4">
        <PanelHeading eyebrow="任务记录" title="时间与工具" />
        <div className="mt-3 rounded-lg border border-line bg-panel px-3 py-2.5">
          <TaskTimeChip task={task} className="flex-wrap" />
        </div>
        <div className="mt-2 grid grid-cols-2 gap-2">
          <button
            type="button"
            onClick={onRefresh}
            disabled={refreshing}
            className="inline-flex h-[32px] items-center justify-center gap-1.5 rounded-md border border-line bg-panel px-2.5 text-[12px] font-medium text-muted transition-colors hover:bg-raised hover:text-ink disabled:cursor-wait disabled:opacity-60"
          >
            <ArrowsClockwise size={14} className={refreshing ? "animate-spin" : ""} />
            刷新会话
          </button>
          {items.length > 0 && (
            <>
              <CopyButton
                text={conversationToText(items, task)}
                title="复制全部对话"
                size={14}
                className="h-[32px] w-full border border-line bg-panel hover:bg-raised"
              />
              <button
                type="button"
                onClick={() => downloadConversation(items, task)}
                className="inline-flex h-[32px] items-center justify-center gap-1.5 rounded-md border border-line bg-panel px-2.5 text-[12px] font-medium text-muted transition-colors hover:bg-raised hover:text-ink"
              >
                <DownloadSimple size={14} />
                导出对话
              </button>
            </>
          )}
          {!managedWorker && !task.archived && <TaskPinButton task={task} onPatch={onPatch} />}
          {!managedWorker && (
            <button
              type="button"
              onClick={onDelete}
              className="inline-flex h-[32px] items-center justify-center gap-1.5 rounded-md px-2.5 text-[12px] font-medium text-muted transition-colors hover:bg-red-500/10 hover:text-red-600"
            >
              <Trash size={14} />
              删除任务
            </button>
          )}
        </div>
      </section>
    </div>
  );
}

function PanelHeading({ eyebrow, title }: { eyebrow: string; title: string }) {
  return (
    <div>
      <div className="text-[10px] font-semibold uppercase tracking-[0.1em] text-faint">{eyebrow}</div>
      <h2 className="mt-0.5 text-[13px] font-semibold text-ink">{title}</h2>
    </div>
  );
}

function InfoRow({
  icon,
  label,
  value,
  mono = false,
  border = false,
}: {
  icon?: ReactNode;
  label: string;
  value: string;
  mono?: boolean;
  border?: boolean;
}) {
  return (
    <div className={`grid grid-cols-[72px_minmax(0,1fr)] gap-2 px-3 py-2.5 text-[11px] ${border ? "border-t border-line" : ""}`}>
      <span className="inline-flex items-center gap-1 text-faint">{icon}{label}</span>
      <span className={`break-all text-muted ${mono ? "font-mono" : ""}`}>{value}</span>
    </div>
  );
}

function Prop({
  value,
  onChange,
  options,
  leading,
}: {
  value: string;
  onChange: (value: string) => void;
  options: { value: string; label: string }[];
  leading?: (value: string) => ReactNode;
}) {
  const current = options.find((option) => option.value === value);
  return (
    <Menu
      value={value}
      onChange={onChange}
      options={options.map((option) => ({
        value: option.value,
        label: option.label,
        icon: leading?.(option.value),
      }))}
      triggerClassName="inline-flex items-center gap-1.5 rounded-md border border-line bg-panel px-2 py-1 text-[12px] text-ink transition-colors hover:bg-raised"
    >
      {leading?.(value)}
      <span className="whitespace-nowrap">{current?.label ?? ""}</span>
      <CaretDown size={11} weight="bold" className="text-faint" />
    </Menu>
  );
}
