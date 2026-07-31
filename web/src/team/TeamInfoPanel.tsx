import { useEffect, useState } from "react";
import type { Session, Task } from "@harness/shared";
import { agentMix, statusCounts } from "@harness/shared/team";
import {
  Check,
  Copy,
  DownloadSimple,
  GitBranch,
  PencilSimple,
  Scales,
  Trash,
} from "@phosphor-icons/react";
import { conversationToText, downloadConversation, type ConvItem } from "../Conversation";
import {
  teamLeadExecutorLabel,
  teamReviewerExecutorLabel,
  teamWorkerExecutorLabel,
} from "../executorLabel";
import {
  AttachmentDisplay,
  parseAttachmentText,
  replaceAttachmentTextBody,
} from "../messageAttachments";
import { StatusIcon } from "../StatusIcon";
import { TaskPinButton } from "../TaskPinMenu";
import { toast } from "../toast";
import { CollapsibleText } from "../ui";

export function TeamInfoPanel({
  task,
  workers,
  sessions,
  items,
  onPatch,
  onDelete,
  canIterateDebate,
  iterateBusy,
  onIterateDebate,
}: {
  task: Task;
  workers: Task[];
  sessions: Session[];
  items: ConvItem[];
  onPatch: (patch: Partial<Task>) => void | Promise<void>;
  onDelete: () => void;
  canIterateDebate: boolean;
  iterateBusy: boolean;
  onIterateDebate: () => void;
}) {
  const last = sessions[sessions.length - 1];
  const objective = parseAttachmentText(task.body);
  const reviewEnabled = task.team?.review !== false;
  const counts = statusCounts(workers);

  return (
    <div className="min-h-full bg-canvas px-4 py-4">
      <section>
        <PanelHeading eyebrow="团队配置" title="角色与运行环境" />
        <div className="mt-3 space-y-2">
          <RoleCard
            role="调度者"
            executor={teamLeadExecutorLabel(task)}
            model={task.team?.leadModel}
            reasoning={task.team?.leadReasoningEffort}
          />
          <RoleCard
            role={`执行者 · ${workers.length}`}
            executor={teamWorkerExecutorLabel(task)}
            model={task.team?.workerModel}
            reasoning={task.team?.workerReasoningEffort}
            note={workers.length ? `当前 ${agentMix(workers)}` : "尚未派活"}
          />
          <RoleCard
            role="审查者"
            executor={reviewEnabled ? teamReviewerExecutorLabel(task) : "已关闭"}
            model={reviewEnabled ? task.team?.reviewerModel : null}
            reasoning={reviewEnabled ? task.team?.reviewerReasoningEffort : null}
            disabled={!reviewEnabled}
          />
        </div>
        {counts.length > 0 && (
          <div className="mt-2.5 flex flex-wrap gap-x-3 gap-y-1 rounded-md border border-line bg-panel px-3 py-2 text-[11px] text-faint">
            {counts.map((count) => (
              <span key={count.label} className="inline-flex items-center gap-1">
                <StatusIcon status={count.status} size={11} awaitingAnswer={count.awaitingAnswer} />
                {count.n} {count.label}
              </span>
            ))}
          </div>
        )}
      </section>

      <section className="mt-5 border-t border-line pt-4">
        <PanelHeading eyebrow="工作区" title="分支与 worktree" />
        <div className="mt-3 overflow-hidden rounded-lg border border-line bg-panel">
          <InfoRow label="分支" value={last?.branch || "未记录"} mono />
          <InfoRow label="Worktree" value={last?.worktreePath || "未记录"} mono border />
          <InfoRow label="策略" value={task.useWorktree ? "独立 worktree" : "当前工作目录"} border />
        </div>
      </section>

      <ObjectiveSection task={task} objective={objective} onPatch={onPatch} />

      <section className="mt-5 border-t border-line pt-4">
        <PanelHeading eyebrow="任务操作" title="调度台工具" />
        <div className="mt-3 grid grid-cols-2 gap-2">
          {items.length > 0 && (
            <>
              <CopyConversationButton text={conversationToText(items, task)} />
              <button
                type="button"
                onClick={() => downloadConversation(items, task)}
                className="inline-flex items-center justify-center gap-1.5 rounded-md border border-line bg-panel px-2.5 py-2 text-[12px] font-medium text-muted transition-colors hover:bg-raised hover:text-ink"
              >
                <DownloadSimple size={14} />
                导出对话
              </button>
            </>
          )}
          {!task.archived && <TaskPinButton task={task} onPatch={onPatch} />}
          {canIterateDebate && (
            <button
              type="button"
              disabled={iterateBusy}
              onClick={onIterateDebate}
              className="inline-flex h-[30px] items-center justify-center gap-1.5 rounded-md border border-violet-500/35 bg-violet-500/[0.07] px-2.5 text-[12px] font-medium text-violet-700 transition-colors hover:bg-violet-500/[0.12] disabled:opacity-40"
            >
              <Scales size={13} weight="fill" />
              {iterateBusy ? "创建中…" : "再辩一轮"}
            </button>
          )}
          <button
            type="button"
            onClick={onDelete}
            className="inline-flex h-[30px] items-center justify-center gap-1.5 rounded-md px-2.5 text-[12px] font-medium text-muted transition-colors hover:bg-red-500/10 hover:text-red-600"
          >
            <Trash size={14} />
            删除任务
          </button>
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

function RoleCard({
  role,
  executor,
  model,
  reasoning,
  note,
  disabled = false,
}: {
  role: string;
  executor: string;
  model?: string | null;
  reasoning?: string | null;
  note?: string;
  disabled?: boolean;
}) {
  return (
    <div className={`rounded-lg border border-line bg-panel px-3 py-2.5 ${disabled ? "opacity-60" : ""}`}>
      <div className="flex items-start gap-2">
        <span className="min-w-0 flex-1 text-[11px] font-medium text-faint">{role}</span>
        {note && <span className="text-[10.5px] text-faint">{note}</span>}
      </div>
      <div className="mt-1 truncate font-mono text-[12px] font-medium text-ink">{executor}</div>
      {!disabled && (
        <dl className="mt-2 grid grid-cols-2 gap-2 text-[10.5px]">
          <div>
            <dt className="text-faint">模型</dt>
            <dd className="mt-0.5 break-words text-muted">{model || "跟随执行器"}</dd>
          </div>
          <div>
            <dt className="text-faint">思考强度</dt>
            <dd className="mt-0.5 break-words text-muted">{reasoning || "跟随执行器"}</dd>
          </div>
        </dl>
      )}
    </div>
  );
}

function InfoRow({ label, value, mono = false, border = false }: { label: string; value: string; mono?: boolean; border?: boolean }) {
  return (
    <div className={`grid grid-cols-[72px_minmax(0,1fr)] gap-2 px-3 py-2.5 text-[11px] ${border ? "border-t border-line" : ""}`}>
      <span className="text-faint">{label}</span>
      <span className={`break-all text-muted ${mono ? "font-mono" : ""}`}>
        {label === "分支" && value !== "未记录" ? <GitBranch size={12} className="mr-1 inline text-faint" /> : null}
        {value}
      </span>
    </div>
  );
}

function ObjectiveSection({
  task,
  objective,
  onPatch,
}: {
  task: Task;
  objective: ReturnType<typeof parseAttachmentText>;
  onPatch: (patch: Partial<Task>) => void | Promise<void>;
}) {
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [draft, setDraft] = useState(objective.body);

  useEffect(() => {
    if (!editing) setDraft(objective.body);
  }, [task.id, objective.body, editing]);

  const save = async () => {
    if (saving) return;
    setSaving(true);
    try {
      await onPatch({ body: replaceAttachmentTextBody(task.body, draft) });
      setEditing(false);
    } catch (error) {
      toast(error instanceof Error ? error.message : String(error));
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className="mt-5 border-t border-line pt-4">
      <div className="flex items-start gap-3">
        <PanelHeading eyebrow="输入" title="原始需求" />
        {!task.archived && !editing && (
          <button
            type="button"
            onClick={() => setEditing(true)}
            className="ml-auto inline-flex items-center gap-1 rounded-md px-2 py-1 text-[11px] text-muted transition-colors hover:bg-raised hover:text-ink"
          >
            <PencilSimple size={12} />
            编辑
          </button>
        )}
      </div>
      {editing ? (
        <div className="mt-3 overflow-hidden rounded-lg border border-accent/40 bg-panel ring-2 ring-accent/10">
          <textarea
            autoFocus
            rows={8}
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
                event.preventDefault();
                void save();
              } else if (event.key === "Escape") {
                event.preventDefault();
                setDraft(objective.body);
                setEditing(false);
              }
            }}
            className="block w-full resize-y bg-transparent px-3 py-2.5 text-[12px] leading-relaxed text-ink outline-none placeholder:text-faint"
            placeholder="写下交给调度者的完整需求…"
          />
          {objective.paths.length > 0 && (
            <AttachmentDisplay paths={objective.paths} className="border-t border-line px-3 py-2" />
          )}
          <div className="flex items-center justify-end gap-1.5 border-t border-line px-2.5 py-2">
            <button
              type="button"
              onClick={() => {
                setDraft(objective.body);
                setEditing(false);
              }}
              className="rounded-md px-2.5 py-1 text-[11px] text-muted hover:bg-raised hover:text-ink"
            >
              取消
            </button>
            <button
              type="button"
              disabled={saving}
              onClick={() => void save()}
              className="rounded-md bg-accent px-3 py-1 text-[11px] font-medium text-accent-fg hover:bg-accent-hover disabled:opacity-50"
            >
              {saving ? "保存中…" : "保存"}
            </button>
          </div>
        </div>
      ) : objective.body ? (
        <CollapsibleText text={objective.body}>
          {objective.paths.length > 0 ? <AttachmentDisplay paths={objective.paths} className="px-3 pb-2" /> : null}
        </CollapsibleText>
      ) : objective.paths.length > 0 ? (
        <AttachmentDisplay paths={objective.paths} className="mt-3" />
      ) : (
        <p className="mt-3 rounded-md border border-dashed border-line px-3 py-4 text-[11.5px] text-faint">未填写原始需求。</p>
      )}
    </section>
  );
}

function CopyConversationButton({ text }: { text: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      onClick={() => {
        void navigator.clipboard.writeText(text);
        setDone(true);
        window.setTimeout(() => setDone(false), 1200);
      }}
      className="inline-flex items-center justify-center gap-1.5 rounded-md border border-line bg-panel px-2.5 py-2 text-[12px] font-medium text-muted transition-colors hover:bg-raised hover:text-ink"
    >
      {done ? <Check size={14} weight="bold" className="text-emerald-600" /> : <Copy size={14} />}
      {done ? "已复制" : "复制对话"}
    </button>
  );
}
