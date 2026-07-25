// /team 主视图的顶部:标题行(忙/闲、用时、停止全组、归档)、原始需求、meta 行、
// 时间轴,再加下面那条「有人在等你答复」的提醒条。
//
// 跟单任务 header 的差别在于**指挥者没有「完成」**:它只有忙(running)/闲(idle),
// 结束靠归档。所以这里没有状态下拉、没有「重新排队」、没有严格完成协议那套东西。
import { useState } from "react";
import type { Task, Session } from "@harness/shared";
import { ArrowsClockwise, DownloadSimple, Stop, Trash, Play } from "@phosphor-icons/react";
import { api } from "../api";
import { toast } from "../toast";
import { ConfirmModal } from "../Modal";
import { CollapsibleText, CopyButton } from "../ui";
import { StatusIcon } from "../StatusIcon";
import { EditableTitle, QuestionCard } from "../TaskDetail";
import { conversationToText, downloadConversation, type ConvItem } from "../Conversation";
import { Duration, TaskTimeChip } from "../time";
import { shortPath } from "../util";
import { TeamTimeline } from "./TeamTimeline";
import { agentMix, statusCounts, type Waiting } from "./teamData";

export function TeamHeader({
  task,
  workers,
  sessions,
  items,
  leadTurns,
  onPatch,
  onRun,
  onDelete,
  onArchive,
  onUnarchive,
  onOpenWorker,
}: {
  task: Task;
  workers: Task[];
  sessions: Session[];
  items: ConvItem[];
  leadTurns: { from: string; to: string | null }[];
  onPatch: (patch: Partial<Task>) => void | Promise<void>;
  onRun: () => void;
  onDelete: () => void;
  onArchive: () => void;
  onUnarchive: () => void;
  onOpenWorker: (id: string) => void;
}) {
  const [haltOpen, setHaltOpen] = useState(false);
  const counts = statusCounts(workers);
  const live = sessions.length > 0 || task.status === "running";
  // 分支/工作目录挂在 session 上(不是 task),取最近那次。默认不开 worktree,所以
  // 多数时候这里就是仓库当前分支 —— 仍然值得显示:它是「活干在哪」的唯一凭据。
  const last = sessions[sessions.length - 1];

  return (
    <header className="shrink-0 border-b border-line px-6 pb-3 pt-5">
      <div className="flex items-start gap-3">
        <span
          className="mt-0.5 shrink-0 rounded bg-accent/10 px-1.5 py-0.5 text-[11px] font-semibold text-accent"
          title="团队模式:一个常驻指挥者 + 它派出去的工人"
        >
          团队
        </span>
        <EditableTitle title={task.title} onSave={(t) => onPatch({ title: t, autoTitle: false })} />
        <div className="flex shrink-0 items-center gap-2">
          <BusyPill task={task} />
          <TaskTimeChip task={task} />
          {task.archived ? (
            <>
              <span className="inline-flex items-center gap-1.5 rounded-md bg-overlay px-3 py-1.5 text-[13px] font-medium text-muted" title="任务已归档（只读）">
                已归档
              </span>
              <button
                onClick={onUnarchive}
                className="inline-flex items-center gap-1.5 rounded-md border border-line px-3 py-1.5 text-[13px] font-medium text-muted transition-colors hover:bg-raised hover:text-ink"
              >
                <ArrowsClockwise size={13} />
                取消归档
              </button>
            </>
          ) : (
            <>
              {/* 「停止全组」= 停指挥台进程 + 暂停所有内部组(工人落 paused 可恢复)。
                  指挥台闲着(idle)时也给,因为工人可能还在跑。 */}
              {(live || workers.length > 0) && (
                <button
                  onClick={() => setHaltOpen(true)}
                  className="inline-flex items-center gap-1.5 rounded-md border border-red-500/40 px-3 py-1.5 text-[13px] font-medium text-red-600 transition-colors hover:bg-red-500/10"
                  title="停指挥台 + 暂停所有工人（工人落暂停，可恢复）"
                >
                  <Stop size={13} weight="fill" />
                  停止全组
                </button>
              )}
              {/* 冷启动/停过之后重新开工:指挥台是常驻会话,run 会接回同一个 CLI 会话。 */}
              {task.status !== "running" && (
                <button
                  onClick={onRun}
                  className="inline-flex items-center gap-1.5 rounded-md bg-accent px-3 py-1.5 text-[13px] font-medium text-accent-fg transition-colors hover:bg-accent-hover"
                  title={sessions.length ? "接回指挥者的会话继续" : "让指挥者开工"}
                >
                  <Play size={13} weight="fill" />
                  {sessions.length ? "接回指挥者" : "运行"}
                </button>
              )}
              <button
                onClick={onArchive}
                className="inline-flex items-center rounded-md px-2.5 py-1.5 text-[13px] font-medium text-muted transition-colors hover:bg-raised hover:text-ink"
                title="归档：团队解散（工人一并归档）"
              >
                归档
              </button>
            </>
          )}
          {items.length > 0 && (
            <>
              <CopyButton
                text={conversationToText(items, task)}
                title="复制指挥者的全部对话"
                size={15}
                className="h-[30px] w-[30px] hover:bg-raised"
              />
              <button
                onClick={() => downloadConversation(items, task)}
                className="grid h-[30px] w-[30px] place-items-center rounded-md text-muted transition-colors hover:bg-raised hover:text-ink"
                title="导出对话为 .md 文件"
              >
                <DownloadSimple size={15} />
              </button>
            </>
          )}
          <button
            onClick={onDelete}
            className="grid h-[30px] w-[30px] place-items-center rounded-md text-muted transition-colors hover:bg-raised hover:text-red-600"
            title="删除任务"
          >
            <Trash size={15} />
          </button>
        </div>
      </div>

      {/* 原始需求 —— 用户交给指挥者的那段话,默认折两行。 */}
      {task.body && <CollapsibleText text={task.body} />}

      {/* 指挥者反过来问用户(它调 ask_question)。答复作为插话喂回同一个常驻会话。 */}
      {task.question && <QuestionCard task={task} />}

      <div className="mt-2.5 flex flex-wrap items-center gap-x-3 gap-y-1.5 text-[12px] text-faint">
        <span>
          指挥 <b className="text-muted">@{task.team?.lead ?? task.agentType ?? "claude"}</b>
        </span>
        <span>
          工人 <b className="text-muted">{workers.length}</b>
          {workers.length > 0 && `（${agentMix(workers)}）`}
          {workers.length === 0 && `（默认派 @${task.team?.worker ?? "claude"}）`}
        </span>
        {last?.branch && (
          <span>
            分支 <span className="font-mono text-muted">{last.branch}</span>
          </span>
        )}
        {last?.worktreePath && <span className="font-mono">{shortPath(last.worktreePath)}</span>}
        {counts.length > 0 && (
          <span className="ml-auto flex flex-wrap items-center gap-x-2.5 gap-y-1">
            {counts.map((c) => (
              <span key={`${c.label}`} className="inline-flex items-center gap-1">
                <StatusIcon status={c.status} size={11} awaitingAnswer={c.awaitingAnswer} />
                {c.n} {c.label}
              </span>
            ))}
          </span>
        )}
      </div>

      <TeamTimeline lead={task} leadTurns={leadTurns} workers={workers} onOpen={onOpenWorker} />

      {haltOpen && (
        <ConfirmModal
          title="停止全组？"
          message="指挥台进程会被停掉（会话保留，之后能接回），正在跑的工人被暂停 —— 都可以恢复。"
          confirmLabel="停止全组"
          danger
          onConfirm={async () => {
            try {
              await api.teamHalt(task.id);
              toast("已停止全组：指挥台已停，工人已暂停");
            } catch (e) {
              toast(e instanceof Error ? e.message : String(e));
            }
          }}
          onClose={() => setHaltOpen(false)}
        />
      )}
    </header>
  );
}

// 指挥者只有忙/闲两态(归档才算结束),所以这里不用 STATUSES 那张表。
function BusyPill({ task }: { task: Task }) {
  const label =
    task.status === "running"
      ? "指挥中"
      : task.status === "idle"
        ? "待命"
        : task.status === "failed"
          ? "指挥台异常"
          : task.status === "canceled"
            ? "已停止"
            : task.status === "backlog"
              ? "未开工"
              : task.status;
  return (
    <span
      className="inline-flex items-center gap-1.5 rounded-md bg-overlay px-2 py-1 text-[12px] text-muted"
      title={task.status === "idle" ? "会话在线，这一刻没在说话；你或工人一说话就接回" : undefined}
    >
      <StatusIcon status={task.status} size={11} awaitingAnswer={!!task.question} />
      {label}
    </span>
  );
}

// 有人卡着等答复时的提醒条:它是唯一「不动手就永远停在这」的状态,所以放在 header
// 底下、流的上面,滚不掉。
export function AttentionBar({
  waiting,
  workers,
  onOpenWorker,
  onAskLead,
}: {
  waiting: Waiting[];
  workers: Task[];
  onOpenWorker: (id: string) => void;
  onAskLead: (w: Task) => void;
}) {
  const [w] = waiting;
  if (!w) return null;
  const n = workers.findIndex((x) => x.id === w.task.id) + 1;
  return (
    <div className="flex shrink-0 flex-wrap items-center gap-x-2 gap-y-1 border-b border-cyan-500/25 bg-cyan-500/[0.07] px-5 py-2 text-[12.5px]">
      <StatusIcon status="paused" size={12} awaitingAnswer />
      <span className="text-ink">
        <b>
          {n ? `${n} ` : ""}
          {w.task.title}
        </b>{" "}
        在等答复 · 已等 <Duration from={w.since} />
      </span>
      {waiting.length > 1 && <span className="text-muted">（还有 {waiting.length - 1} 个在等）</span>}
      <span className="ml-auto flex items-center gap-1.5">
        <button
          onClick={() => onAskLead(w.task)}
          className="rounded-md border border-line bg-panel px-2 py-1 text-[11.5px] text-muted transition-colors hover:bg-raised hover:text-ink"
          title="把这个问题转给指挥者，让它去调查并答复"
        >
          让指挥者答
        </button>
        <button
          onClick={() => onOpenWorker(w.task.id)}
          className="rounded-md bg-cyan-600 px-2.5 py-1 text-[11.5px] font-medium text-white transition-colors hover:bg-cyan-500"
        >
          我来答
        </button>
      </span>
    </div>
  );
}
