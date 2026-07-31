// /team 主视图的精简顶部：标题、状态/用时、运行控制、归档与查看改动。
// 原始需求、角色配置、工作区与时间轴都由右侧 Inspector 承载；需要用户立即行动的
// 提问和「停止全组」持久提示仍留在这里。
//
// 跟单任务 header 的差别在于**调度者没有「完成」**:它只有忙(running)/闲(idle),
// 结束靠归档。所以这里没有状态下拉、没有「重新排队」、没有严格完成协议那套东西。
import { useState, type ReactNode } from "react";
import type { Group, Task } from "@harness/shared";
import {
  isTeamSettled,
  teamNeverStarted,
  workerHaltStats,
  type Waiting,
} from "@harness/shared/team";
import { ArrowsClockwise, ClipboardText, Stop, Play } from "@phosphor-icons/react";
import { api } from "../api";
import { toast } from "../toast";
import { ConfirmModal } from "../Modal";
import { StatusIcon } from "../StatusIcon";
import { EditableTitle } from "../TaskDetail";
import { QuestionCard } from "../QuestionCard";
import { Duration, TaskTimeChip } from "../time";
import { TaskModeIcon } from "../taskOrigin";
import { Tip } from "../Tip";

export function TeamHeader({
  task,
  workers,
  teamGroups,
  haltedByHistory,
  onPatch,
  onRun,
  onTeamHalted,
  onTeamResumed,
  onArchive,
  onUnarchive,
  reviewOpen,
  onToggleReview,
  inspectorToggle,
}: {
  task: Task;
  workers: Task[];
  teamGroups: Group[];
  haltedByHistory: boolean;
  onPatch: (patch: Partial<Task>) => void | Promise<void>;
  onRun: () => void | Promise<void>;
  onTeamHalted: () => void | Promise<void>;
  onTeamResumed: () => void;
  onArchive: () => void;
  onUnarchive: () => void;
  reviewOpen: boolean;
  onToggleReview: () => void;
  inspectorToggle?: ReactNode;
}) {
  const [haltOpen, setHaltOpen] = useState(false);
  const [resuming, setResuming] = useState(false);
  const leadLive = task.status === "running";
  const settled = isTeamSettled(leadLive, workers);
  const pausedGroups = teamGroups.filter((g) => g.paused);
  const stopped = pausedGroups.length > 0 || haltedByHistory;
  const awaitingAcceptance = workers.filter(
    (worker) => worker.useWorktree && worker.stage === "awaiting_acceptance",
  ).length;
  const reviewEmphasis = settled || awaitingAcceptance > 0;

  return (
    <header className="shrink-0 border-b border-line px-5 py-3">
      <div className="flex flex-wrap items-start gap-3">
        <Tip
          label="团队任务：一个常驻调度者和它派出的执行者"
          className="mt-0.5 inline-flex h-5 w-5 shrink-0 items-center justify-center text-muted"
        >
          <TaskModeIcon mode="team" size={16} />
        </Tip>
        <EditableTitle title={task.title} onSave={(t) => onPatch({ title: t, autoTitle: false })} />
        <div className="ml-auto flex min-w-0 flex-wrap items-center justify-end gap-2">
          <BusyPill task={task} />
          <TaskTimeChip task={task} />
          <Tip label={reviewOpen ? "返回团队协作流" : "汇总执行者目标、提交、diff 和用户消息"}>
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
            >
              <ClipboardText size={14} weight={reviewEmphasis ? "fill" : "regular"} />
              {reviewOpen ? "返回协作" : `查看改动${awaitingAcceptance ? ` ${awaitingAcceptance}` : ""}`}
            </button>
          </Tip>
          {task.archived ? (
            <>
              <span className="inline-flex items-center gap-1.5 rounded-md bg-overlay px-3 py-1.5 text-[13px] font-medium text-muted">
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
                >
                  <Play size={13} weight="fill" />
                  {resuming ? "恢复中" : "恢复全组"}
                </button>
              )}
              {stopped && pausedGroups.length === 0 && (
                <span
                  className="inline-flex items-center gap-1.5 rounded-md border border-line bg-raised px-3 py-1.5 text-[13px] font-medium text-muted"
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
                >
                  <Play size={13} weight="fill" />
                  运行
                </button>
              )}
              <button
                onClick={onArchive}
                className="inline-flex items-center rounded-md px-2.5 py-1.5 text-[13px] font-medium text-muted transition-colors hover:bg-raised hover:text-ink"
              >
                归档
              </button>
            </>
          )}
          {inspectorToggle}
        </div>
      </div>

      {/* 调度者反过来问用户(它调 ask_question)。答复作为插话喂回同一个常驻会话。 */}
      {task.question && <QuestionCard task={task} />}

      {stopped && <TeamHaltNotice workers={workers} pausedGroups={pausedGroups} hasGroupData={teamGroups.length > 0} />}

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
