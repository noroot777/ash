// /team 主视图的顶部:标题行(忙/闲、用时、停止全组、归档)、原始需求、meta 行、
// 时间轴,再加下面那条「有人在等你答复」的提醒条。
//
// 跟单任务 header 的差别在于**调度者没有「完成」**:它只有忙(running)/闲(idle),
// 结束靠归档。所以这里没有状态下拉、没有「重新排队」、没有严格完成协议那套东西。
import { useState } from "react";
import type {
  Group,
  Session,
  Task,
} from "@harness/shared";
import {
  agentMix,
  isTeamSettled,
  statusCounts,
  teamNeverStarted,
  workerHaltStats,
  type Waiting,
} from "@harness/shared/team";
import { ArrowsClockwise, ClipboardText, DownloadSimple, Stop, Trash, Play, Scales } from "@phosphor-icons/react";
import { api } from "../api";
import { toast } from "../toast";
import { ConfirmModal } from "../Modal";
import { CollapsibleText, CopyButton } from "../ui";
import { StatusIcon } from "../StatusIcon";
import { EditableTitle } from "../TaskDetail";
import { QuestionCard } from "../QuestionCard";
import { conversationToText, downloadConversation, type ConvItem } from "../Conversation";
import { Duration, TaskTimeChip } from "../time";
import { shortPath } from "../util";
import { TeamTimeline } from "./TeamTimeline";
import type { LeadTurn } from "./teamData";
import { teamLeadExecutorLabel, teamReviewerExecutorLabel, teamWorkerExecutorLabel } from "../executorLabel";
import { AttachmentDisplay, parseAttachmentText } from "../messageAttachments";
import { TaskPinMenu } from "../TaskPinMenu";

export function TeamHeader({
  task,
  workers,
  teamGroups,
  haltedByHistory,
  sessions,
  items,
  leadTurns,
  onPatch,
  onRun,
  onTeamHalted,
  onTeamResumed,
  onDelete,
  onArchive,
  onUnarchive,
  onOpenWorker,
  reviewOpen,
  onToggleReview,
  canIterateDebate,
  iterateBusy,
  onIterateDebate,
}: {
  task: Task;
  workers: Task[];
  teamGroups: Group[];
  haltedByHistory: boolean;
  sessions: Session[];
  items: ConvItem[];
  leadTurns: LeadTurn[];
  onPatch: (patch: Partial<Task>) => void | Promise<void>;
  onRun: () => void | Promise<void>;
  onTeamHalted: () => void | Promise<void>;
  onTeamResumed: () => void;
  onDelete: () => void;
  onArchive: () => void;
  onUnarchive: () => void;
  onOpenWorker: (id: string) => void;
  reviewOpen: boolean;
  onToggleReview: () => void;
  canIterateDebate: boolean;
  iterateBusy: boolean;
  onIterateDebate: () => void;
}) {
  const [haltOpen, setHaltOpen] = useState(false);
  const [resuming, setResuming] = useState(false);
  const counts = statusCounts(workers);
  const leadLive = task.status === "running";
  const settled = isTeamSettled(leadLive, workers);
  const pausedGroups = teamGroups.filter((g) => g.paused);
  const stopped = pausedGroups.length > 0 || haltedByHistory;
  // 分支/工作目录挂在 session 上(不是 task),取最近那次。默认不开 worktree,所以
  // 多数时候这里就是仓库当前分支 —— 仍然值得显示:它是「活干在哪」的唯一凭据。
  const last = sessions[sessions.length - 1];
  const leadLabel = teamLeadExecutorLabel(task);
  const workerLabel = teamWorkerExecutorLabel(task);
  const reviewerLabel = teamReviewerExecutorLabel(task);
  const reviewEnabled = task.team?.review !== false;
  const objective = parseAttachmentText(task.body);
  const awaitingAcceptance = workers.filter(
    (worker) => worker.useWorktree && worker.stage === "awaiting_acceptance",
  ).length;
  const reviewEmphasis = settled || awaitingAcceptance > 0;

  return (
    <header className="shrink-0 border-b border-line px-6 pb-3 pt-5">
      <div className="flex items-start gap-3">
        <span
          className="mt-0.5 shrink-0 rounded bg-accent/10 px-1.5 py-0.5 text-[11px] font-semibold text-accent"
          title="团队模式:一个常驻调度者 + 它派出去的执行者"
        >
          团队
        </span>
        <EditableTitle title={task.title} onSave={(t) => onPatch({ title: t, autoTitle: false })} />
        <div className="flex shrink-0 items-center gap-2">
          <BusyPill task={task} />
          <TaskTimeChip task={task} />
          <button
            type="button"
            onClick={onToggleReview}
            className={`inline-flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-[13px] font-medium transition-colors ${
              reviewOpen
                ? "border-accent bg-accent text-accent-fg"
                : reviewEmphasis
                  ? "border-violet-500/40 bg-violet-500/[0.09] text-violet-700 hover:bg-violet-500/[0.15]"
                  : "border-line text-muted hover:bg-raised hover:text-ink"
            }`}
            title={reviewOpen ? "返回团队协作流" : "汇总执行者目标、提交、diff 和用户消息"}
          >
            <ClipboardText size={14} weight={reviewEmphasis ? "fill" : "regular"} />
            {reviewOpen ? "返回协作" : `验收${awaitingAcceptance ? ` ${awaitingAcceptance}` : ""}`}
          </button>
          {settled && canIterateDebate && (
            <button
              type="button"
              disabled={iterateBusy}
              onClick={onIterateDebate}
              className="inline-flex items-center gap-1.5 rounded-md border border-violet-500/35 bg-violet-500/[0.07] px-3 py-1.5 text-[13px] font-medium text-violet-700 transition-colors hover:bg-violet-500/[0.12] disabled:opacity-40"
              title="读取这次团队执行记录，沿用原辩论配置创建新一轮"
            >
              <Scales size={13} weight="fill" />
              {iterateBusy ? "创建中…" : "再辩一轮"}
            </button>
          )}
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
              {/* 「停止全组」只在当前仍有活可停时出现；自然收工后不再挂红按钮。 */}
              {!settled && !stopped && (
                <button
                  onClick={() => setHaltOpen(true)}
                  className="inline-flex items-center gap-1.5 rounded-md border border-red-500/40 px-3 py-1.5 text-[13px] font-medium text-red-600 transition-colors hover:bg-red-500/10"
                  title="停调度台 + 暂停所有执行者（执行者落暂停，可恢复）"
                >
                  <Stop size={13} weight="fill" />
                  停止全组
                </button>
              )}
              {stopped && pausedGroups.length > 0 && (
                <button
                  disabled={resuming}
                  onClick={async () => {
                    setResuming(true);
                    try {
                      await Promise.all(pausedGroups.map((g) => api.runGroup(g.id)));
                      if (task.status !== "running") await onRun();
                      onTeamResumed();
                      toast("已恢复全组：内部组已继续，调度者会话已接回", "info");
                    } catch (e) {
                      toast(e instanceof Error ? e.message : String(e));
                    } finally {
                      setResuming(false);
                    }
                  }}
                  className="inline-flex items-center gap-1.5 rounded-md bg-accent px-3 py-1.5 text-[13px] font-medium text-accent-fg transition-colors hover:bg-accent-hover disabled:opacity-50"
                  title={`恢复 ${pausedGroups.length} 个已暂停的内部组，并接回调度者`}
                >
                  <Play size={13} weight="fill" />
                  {resuming ? "恢复中" : "恢复全组"}
                </button>
              )}
              {stopped && pausedGroups.length === 0 && (
                <span
                  className="inline-flex items-center gap-1.5 rounded-md border border-line bg-raised px-3 py-1.5 text-[13px] font-medium text-muted"
                  title="已从会话记录检测到停止全组；当前分组接口未下发内部组 paused 详情"
                >
                  <Stop size={13} weight="fill" />
                  已停止
                </span>
              )}
              {/* 只服务「第一次开工」。开过台之后(idle)不再摆按钮:插一句话就会
                  --resume 接回同一会话,再放一个入口纯属重复。 */}
              {teamNeverStarted(task.status) && (
                <button
                  onClick={onRun}
                  className="inline-flex items-center gap-1.5 rounded-md bg-accent px-3 py-1.5 text-[13px] font-medium text-accent-fg transition-colors hover:bg-accent-hover"
                  title="让调度者开工"
                >
                  <Play size={13} weight="fill" />
                  运行
                </button>
              )}
              <button
                onClick={onArchive}
                className="inline-flex items-center rounded-md px-2.5 py-1.5 text-[13px] font-medium text-muted transition-colors hover:bg-raised hover:text-ink"
                title="归档：团队解散（执行者一并归档）"
              >
                归档
              </button>
            </>
          )}
          {items.length > 0 && (
            <>
              <CopyButton
                text={conversationToText(items, task)}
                title="复制调度者的全部对话"
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
          <TaskPinMenu task={task} onPatch={onPatch} />
          <button
            onClick={onDelete}
            className="grid h-[30px] w-[30px] place-items-center rounded-md text-muted transition-colors hover:bg-raised hover:text-red-600"
            title="删除任务"
          >
            <Trash size={15} />
          </button>
        </div>
      </div>

      {/* 原始需求 —— 用户交给调度者的那段话,默认折两行。 */}
      {objective.body ? (
        <CollapsibleText text={objective.body}>
          {objective.paths.length > 0 ? <AttachmentDisplay paths={objective.paths} className="px-3 pb-2" /> : null}
        </CollapsibleText>
      ) : (
        <AttachmentDisplay paths={objective.paths} className="mt-2" />
      )}

      {/* 调度者反过来问用户(它调 ask_question)。答复作为插话喂回同一个常驻会话。 */}
      {task.question && <QuestionCard task={task} />}

      {stopped && <TeamHaltNotice workers={workers} pausedGroups={pausedGroups} hasGroupData={teamGroups.length > 0} />}

      <div className="mt-2.5 flex flex-wrap items-center gap-x-3 gap-y-1.5 text-[12px] text-faint">
        <span>
          调度者 <b className="text-muted">{leadLabel}</b>
        </span>
        <span>
          执行者 <b className="text-muted">{workers.length}</b>
          {workers.length > 0 && `（${agentMix(workers)}）`}
          {workers.length === 0 && `（默认派 ${workerLabel}）`}
        </span>
        <span className={reviewEnabled ? "text-violet-700" : undefined}>
          审查 <b className={reviewEnabled ? "text-violet-700" : "text-muted"}>{reviewEnabled ? reviewerLabel : "已关闭"}</b>
          {reviewEnabled && ` · ${task.team?.reviewerModel || "模型跟随"} · ${task.team?.reviewerReasoningEffort || "强度跟随"}`}
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

      {!reviewOpen && <TeamTimeline lead={task} leadTurns={leadTurns} workers={workers} groups={teamGroups} onOpen={onOpenWorker} />}

      {haltOpen && (
        <ConfirmModal
          title="停止全组？"
          message="调度台进程会被停掉（会话保留，之后能接回），正在跑的执行者被暂停 —— 都可以恢复。"
          confirmLabel="停止全组"
          danger
          onConfirm={async () => {
            try {
              await api.teamHalt(task.id);
              await onTeamHalted();
              toast("已停止全组：调度台已停，执行者已暂停", "info");
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

function TeamHaltNotice({
  workers,
  pausedGroups,
  hasGroupData,
}: {
  workers: Task[];
  pausedGroups: Group[];
  hasGroupData: boolean;
}) {
  const stats = workerHaltStats(workers);
  const inferredGroups = new Set(workers.map((w) => w.groupId).filter(Boolean)).size;
  const workerText =
    stats.interrupted > 0
      ? `${stats.interrupted} 个执行者被暂停打断`
      : stats.completed > 0
        ? `${stats.completed} 个执行者已正常完成，没有被暂停打断`
        : workers.length > 0
          ? "没有执行者被暂停打断"
          : "还没有执行者";
  const groupText = hasGroupData
    ? pausedGroups.length > 0
      ? `${pausedGroups.length} 个内部组已停止`
      : "内部组未暂停"
    : inferredGroups > 0
      ? `${inferredGroups} 个内部组有停止记录（paused 详情未下发）`
      : "内部组 paused 详情未下发";
  return (
    <div className="mt-2.5 flex flex-wrap items-center gap-x-2 gap-y-1 rounded-md border border-line bg-raised px-3 py-2 text-[12.5px]">
      <StatusIcon status="paused" size={12} />
      <b className="text-ink">已停止全组</b>
      <span className="text-muted">{groupText}</span>
      <span className="text-faint">·</span>
      <span className="text-muted">{workerText}</span>
      {(stats.waiting > 0 || stats.running > 0) && (
        <>
          <span className="text-faint">·</span>
          <span className="text-muted">
            {stats.running > 0 && `${stats.running} 个仍显示运行中`}
            {stats.running > 0 && stats.waiting > 0 && "，"}
            {stats.waiting > 0 && `${stats.waiting} 个未启动`}
          </span>
        </>
      )}
    </div>
  );
}

// 调度者只有忙/闲两态(归档才算结束),所以这里不用 STATUSES 那张表。
function BusyPill({ task }: { task: Task }) {
  if (task.status === "idle") return null;

  const label =
    task.status === "running"
      ? "调度中"
      : task.status === "failed"
          ? "调度台异常"
          : task.status === "canceled"
            ? "已停止"
            : task.status === "backlog"
              ? "未开工"
              : task.status;
  return (
    <span
      className="inline-flex items-center gap-1.5 rounded-md bg-overlay px-2 py-1 text-[12px] text-muted"
    >
      <StatusIcon status={task.status} stage={task.stage} awaitingAnswer={!!task.question} />
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
          title="把这个问题转给调度者，让它去调查并答复"
        >
          让调度者答
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
