import { useCallback, useEffect, useMemo, useState } from "react";
import {
  TASK_STATUS_LABELS,
  type ReviewConclusion,
  type Task,
  type TaskReviewInfo,
  type TaskReviewRound,
} from "@harness/shared";
import {
  ArrowSquareOut,
  CaretDown,
  CheckCircle,
  ImageSquare,
  MagnifyingGlass,
  SpinnerGap,
  WarningCircle,
} from "@phosphor-icons/react";
import { api } from "./api";
import { type ExecutorSelection, useExecutorProfiles } from "./ExecutorPicker";
import { ExecutorField } from "./composer/ExecutorFields";
import { ImageLightbox, type PreviewImage } from "./ImagePreview";
import { Markdown } from "./Markdown";
import { toast } from "./toast";
import { fallbackExecutor, isExecutorPickable, useAvailableTypes } from "./useDetectedAgents";
import { useServerEvents } from "./useEvents";

const AUTO_REVIEW_LIMIT = 2;
const REVIEW_IN_FLIGHT = new Set(["backlog", "queued", "running", "paused"]);

type Preview = PreviewImage & { round: number; name: string };

function reviewPreview(taskId: string, round: number, name: string): Preview {
  return {
    round,
    name,
    src: api.taskReviewFileUrl(taskId, round, name),
    alt: `第 ${round} 轮审查截图 ${name}`,
    label: `第 ${round} 轮 · ${name}`,
  };
}

function previewsForRound(taskId: string, rounds: TaskReviewRound[], roundNumber: number): Preview[] {
  const round = rounds.find((candidate) => candidate.round === roundNumber);
  return round?.screenshots.map((name) => reviewPreview(taskId, round.round, name)) ?? [];
}

function useTaskReviewInfo(taskId: string) {
  const [info, setInfo] = useState<TaskReviewInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const load = useCallback(async (quiet = false) => {
    if (!quiet) setLoading(true);
    try {
      const next = await api.taskReview(taskId);
      setInfo(next);
      setLoadError(null);
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : String(error));
    } finally {
      if (!quiet) setLoading(false);
    }
  }, [taskId]);

  useEffect(() => {
    setInfo(null);
    setLoadError(null);
    void load();
  }, [load]);

  useServerEvents(useCallback((event) => {
    if ((event.type === "task.review" || event.type === "task.stage") && event.taskId === taskId) {
      void load(true);
    }
  }, [load, taskId]));

  return { info, loading, loadError, load };
}

function reviewDefaults(task: Task, parent: Task | null) {
  if (parent?.mode === "team" && parent.team) {
    return {
      selection: {
        agentType: parent.team.reviewerAgentType ?? parent.team.worker,
        executorId: parent.team.reviewerExecutorId ?? null,
      } satisfies ExecutorSelection,
      model: parent.team.reviewerModel ?? "",
      reasoningEffort: parent.team.reviewerReasoningEffort ?? "",
    };
  }
  return {
    selection: {
      agentType: task.agentType ?? "claude",
      executorId: task.executorId ?? null,
    } satisfies ExecutorSelection,
    model: task.model ?? "",
    reasoningEffort: task.reasoningEffort ?? "",
  };
}

export function ReviewTaskContextBar({
  task,
  allTasks,
  onOpenTask,
}: {
  task: Task;
  allTasks: Task[];
  onOpenTask: (taskId: string) => void;
}) {
  if (!task.reviewOf) return null;
  const target = allTasks.find((candidate) => candidate.id === task.reviewOf);
  return (
    <div className="flex shrink-0 items-center gap-2 border-b border-violet-500/20 bg-violet-500/[0.06] px-6 py-2 text-[12px]">
      <MagnifyingGlass size={13} weight="bold" className="shrink-0 text-violet-700" />
      <span className="text-muted">本任务是对</span>
      <button
        type="button"
        onClick={() => onOpenTask(task.reviewOf!)}
        className="min-w-0 truncate font-medium text-violet-700 hover:underline hover:underline-offset-2"
      >
        {target?.title ?? task.reviewOf}
      </button>
      <span className="shrink-0 text-muted">的第 {task.reviewRound ?? 1} 轮审查</span>
      <ArrowSquareOut size={12} className="shrink-0 text-violet-600" />
    </div>
  );
}

export function TaskReviewPanel({
  task,
  allTasks,
  onOpenTask,
  onReviewTaskCreated,
  defaultExpanded = false,
}: {
  task: Task;
  allTasks: Task[];
  onOpenTask: (taskId: string) => void;
  onReviewTaskCreated: (task: Task) => void;
  defaultExpanded?: boolean;
}) {
  const parent = task.parentId ? allTasks.find((candidate) => candidate.id === task.parentId) ?? null : null;
  const defaults = useMemo(
    () => reviewDefaults(task, parent),
    [task.id, task.agentType, task.executorId, task.model, task.reasoningEffort, parent?.team],
  );
  const { profiles, providers } = useExecutorProfiles();
  const { detected, failed: detectFailed, types: executorTypes } = useAvailableTypes();
  const { info, loading, loadError, load } = useTaskReviewInfo(task.id);
  const [dispatchOpen, setDispatchOpen] = useState(false);
  const [dispatching, setDispatching] = useState(false);
  const [selection, setSelection] = useState<ExecutorSelection>(defaults.selection);
  const [model, setModel] = useState(defaults.model);
  const [reasoningEffort, setReasoningEffort] = useState(defaults.reasoningEffort);
  const [preview, setPreview] = useState<Preview | null>(null);

  useEffect(() => {
    setDispatchOpen(false);
    setSelection(defaults.selection);
    setModel(defaults.model);
    setReasoningEffort(defaults.reasoningEffort);
  }, [task.id]);

  useEffect(() => {
    if (!selection.executorId || profiles.length === 0) return;
    if (profiles.some((profile) => profile.id === selection.executorId && profile.type === selection.agentType)) return;
    setSelection((current) => ({ ...current, executorId: null }));
  }, [profiles, selection]);

  // 手动派审查 = **一次新建执行配置**,所以和新建面板同一套处理:默认值抄的是来源任务的
  // 执行器(可能是很久以前建的、那个 CLI 现在已经不在本机了),检测回来后不成立就顺移到
  // available 类型或已注册 profile(第四轮审查抓到:界面标了「本机未检测到」却照样能派)。
  const dispatchPickable = isExecutorPickable(selection, executorTypes, profiles);
  useEffect(() => {
    if (detected === null || dispatchPickable) return;
    const next = fallbackExecutor(executorTypes, profiles);
    if (!next) return;
    setSelection(next);
    setModel("");
    setReasoningEffort("");
  }, [detected, dispatchPickable, executorTypes, profiles]);

  const rounds = info?.rounds ?? [];
  const previewImages = preview ? previewsForRound(task.id, rounds, preview.round) : [];
  const previewIndex = previewImages.findIndex((image) => image.name === preview?.name);
  const activeRound = rounds.find((round) => REVIEW_IN_FLIGHT.has(round.reviewTaskStatus));
  const canDispatch = !task.archived && task.status !== "running" && task.status !== "queued";
  // 一个判据同时喂按钮和 dispatch(),别只挂按钮 —— 那样以后加快捷键就又漏一条路。
  // 探测失败时不拦(分不清「没装」和「探不出来」)。
  const canSend = !dispatching && !activeRound && (detectFailed || dispatchPickable);
  const autoLimitReached = !!info?.reviewRequested
    && task.stage === "verify_failed"
    && rounds.some((round) => round.round >= AUTO_REVIEW_LIMIT && round.conclusion === "verify_failed");

  const openDispatch = () => {
    setSelection(defaults.selection);
    setModel(defaults.model);
    setReasoningEffort(defaults.reasoningEffort);
    setDispatchOpen(true);
  };

  const dispatch = async () => {
    if (!canSend) return;
    setDispatching(true);
    try {
      const { reviewTask } = await api.dispatchTaskReview(task.id, {
        agentType: selection.agentType,
        executorId: selection.executorId,
        model: model || null,
        reasoningEffort: reasoningEffort || null,
      });
      onReviewTaskCreated(reviewTask);
      setDispatchOpen(false);
      await load(true);
      toast(`已派出第 ${reviewTask.reviewRound ?? rounds.length + 1} 轮审查`, "info");
    } catch (error) {
      toast(error instanceof Error ? error.message : String(error));
    } finally {
      setDispatching(false);
    }
  };

  return (
    <section className="mt-3 overflow-hidden rounded-xl border border-violet-500/20 bg-violet-500/[0.035]" aria-label="审查">
      <div className="flex flex-wrap items-center gap-2 border-b border-violet-500/15 px-3 py-2.5">
        <span className="grid h-6 w-6 place-items-center rounded-md bg-violet-500/10 text-violet-700">
          <MagnifyingGlass size={13} weight="bold" />
        </span>
        <div className="min-w-0 flex-1">
          <h2 className="text-[12.5px] font-semibold text-ink">审查</h2>
          <p className="text-[10.5px] text-faint">
            {rounds.length > 0 ? `已记录 ${rounds.length} 轮真实运行验证` : "尚无审查记录"}
          </p>
        </div>
        {canDispatch && (
          <button
            type="button"
            disabled={!!activeRound || dispatching}
            onClick={() => dispatchOpen ? setDispatchOpen(false) : openDispatch()}
            className="inline-flex items-center gap-1.5 rounded-md border border-violet-500/25 bg-panel px-2.5 py-1.5 text-[11.5px] font-medium text-violet-700 transition-colors hover:bg-violet-500/[0.08] disabled:cursor-not-allowed disabled:opacity-45"
          >
            {activeRound || dispatching ? <SpinnerGap size={13} className="animate-spin" /> : <MagnifyingGlass size={13} />}
            {activeRound ? "审查进行中" : dispatchOpen ? "收起配置" : "派审查"}
          </button>
        )}
      </div>

      {dispatchOpen && canDispatch && !activeRound && (
        <div className="border-b border-violet-500/15 bg-panel/80 px-3 py-3">
          <div className="mb-2 text-[11px] leading-relaxed text-muted">
            这轮审查会立即启动；模型与思考强度留空时跟随所选执行器。
          </div>
          {!detectFailed && !dispatchPickable && (
            <div className="mb-2 text-[11px] leading-relaxed text-amber-700">
              「{selection.agentType}」这个 CLI 本机没检测到，审查跑不起来 —— 换一个能跑的执行器再派。
            </div>
          )}
          <div className="flex flex-wrap items-center gap-2">
            <ExecutorField
              icon={<MagnifyingGlass size={14} />}
              selection={selection}
              types={executorTypes}
              profiles={profiles}
              providers={providers}
              model={model}
              reasoningEffort={reasoningEffort}
              onSelect={setSelection}
              onModel={setModel}
              onReasoningEffort={setReasoningEffort}
            />
            <button
              type="button"
              disabled={!canSend}
              onClick={() => void dispatch()}
              className="ml-auto inline-flex items-center gap-1.5 rounded-md bg-violet-600 px-3 py-1.5 text-[11.5px] font-semibold text-white transition-colors hover:bg-violet-500 disabled:opacity-45"
            >
              {dispatching && <SpinnerGap size={13} className="animate-spin" />}
              {dispatching ? "派发中" : "确认派审查"}
            </button>
          </div>
        </div>
      )}

      {autoLimitReached && (
        <div className="flex items-center gap-2 border-b border-red-500/20 bg-red-500/[0.06] px-3 py-2 text-[11.5px] text-red-700">
          <WarningCircle size={14} weight="fill" className="shrink-0" />
          自动复审已达上限，等待人工处理
        </div>
      )}

      <ReviewRecords
        taskId={task.id}
        rounds={rounds}
        loading={loading}
        loadError={loadError}
        emptyMessage="任务完成后可由团队自动派审，也可以在这里手动补审。"
        onRetry={load}
        onOpenTask={onOpenTask}
        onPreview={setPreview}
        defaultExpanded={defaultExpanded}
      />
      {previewIndex >= 0 && (
        <ImageLightbox
          images={previewImages}
          index={previewIndex}
          onIndexChange={(index) => setPreview(previewImages[index] ?? null)}
          onClose={() => setPreview(null)}
        />
      )}
    </section>
  );
}

export function TaskReviewEvidence({
  taskId,
  defaultExpanded = true,
}: {
  taskId: string;
  defaultExpanded?: boolean;
}) {
  const { info, loading, loadError, load } = useTaskReviewInfo(taskId);
  const [preview, setPreview] = useState<Preview | null>(null);
  const rounds = info?.rounds ?? [];
  const previewImages = preview ? previewsForRound(taskId, rounds, preview.round) : [];
  const previewIndex = previewImages.findIndex((image) => image.name === preview?.name);

  return (
    <section className="overflow-hidden rounded-xl border border-violet-500/25 bg-violet-500/[0.035]" aria-label="独立审查证据">
      <div className="flex items-center gap-2 border-b border-violet-500/15 px-3 py-2.5">
        <span className="grid h-6 w-6 place-items-center rounded-md bg-violet-500/10 text-violet-700">
          <MagnifyingGlass size={13} weight="bold" />
        </span>
        <div className="min-w-0 flex-1">
          <h3 className="text-[12.5px] font-semibold text-ink">独立审查证据</h3>
          <p className="text-[10.5px] text-faint">
            {rounds.length > 0 ? `已记录 ${rounds.length} 轮真实运行验证` : "验收前请结合审查结论、报告与截图判断"}
          </p>
        </div>
      </div>
      <ReviewRecords
        taskId={taskId}
        rounds={rounds}
        loading={loading}
        loadError={loadError}
        emptyMessage="尚无独立审查记录。"
        onRetry={load}
        onPreview={setPreview}
        defaultExpanded={defaultExpanded}
      />
      {previewIndex >= 0 && (
        <ImageLightbox
          images={previewImages}
          index={previewIndex}
          onIndexChange={(index) => setPreview(previewImages[index] ?? null)}
          onClose={() => setPreview(null)}
        />
      )}
    </section>
  );
}

function ReviewRecords({
  taskId,
  rounds,
  loading,
  loadError,
  emptyMessage,
  onRetry,
  onOpenTask,
  onPreview,
  defaultExpanded,
}: {
  taskId: string;
  rounds: TaskReviewRound[];
  loading: boolean;
  loadError: string | null;
  emptyMessage: string;
  onRetry: () => void | Promise<void>;
  onOpenTask?: (taskId: string) => void;
  onPreview: (preview: Preview) => void;
  defaultExpanded: boolean;
}) {
  return (
    <div className="max-h-[min(46vh,520px)] space-y-3 overflow-y-auto p-3">
      {loading && (
        <div className="flex items-center gap-2 py-2 text-[11.5px] text-faint">
          <SpinnerGap size={14} className="animate-spin" /> 正在读取审查记录…
        </div>
      )}
      {!loading && loadError && (
        <div className="flex flex-wrap items-center gap-2 rounded-lg border border-red-500/25 bg-red-500/[0.05] px-3 py-2 text-[11.5px] text-red-700">
          <WarningCircle size={14} weight="fill" />
          <span className="min-w-0 flex-1">审查记录加载失败：{loadError}</span>
          <button type="button" onClick={() => void onRetry()} className="font-medium underline underline-offset-2">重试</button>
        </div>
      )}
      {!loading && !loadError && rounds.length === 0 && (
        <p className="py-1 text-[11.5px] text-faint">{emptyMessage}</p>
      )}
      {rounds.map((round) => (
        <ReviewRoundCard
          key={`${round.round}-${round.reviewTaskId}`}
          taskId={taskId}
          round={round}
          onOpenTask={onOpenTask}
          onPreview={onPreview}
          defaultExpanded={defaultExpanded}
        />
      ))}
    </div>
  );
}

function ReviewRoundCard({
  taskId,
  round,
  onOpenTask,
  onPreview,
  defaultExpanded,
}: {
  taskId: string;
  round: TaskReviewRound;
  onOpenTask?: (taskId: string) => void;
  onPreview: (preview: Preview) => void;
  defaultExpanded: boolean;
}) {
  const [expanded, setExpanded] = useState(defaultExpanded);
  const verdict = verdictMeta(round.conclusion);
  return (
    <article className={`overflow-hidden rounded-lg border bg-panel ${verdict.border}`}>
      <div className={`flex flex-wrap items-center gap-2 px-3 py-2.5 ${expanded ? "border-b border-line" : ""}`}>
        <button
          type="button"
          aria-expanded={expanded}
          title={expanded ? "收起审查证据" : "展开审查证据"}
          onClick={() => setExpanded((current) => !current)}
          className="flex min-w-0 flex-1 flex-wrap items-center gap-2 rounded-md text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-500/40"
        >
          <span className={`grid h-6 w-6 shrink-0 place-items-center rounded-full text-[10.5px] font-bold ${verdict.badge}`}>
            {round.round}
          </span>
          <span className="text-[12px] font-semibold text-ink">第 {round.round} 轮</span>
          <span className="flex flex-wrap items-center gap-2">
            <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10.5px] font-semibold ${verdict.pill}`}>
              {round.conclusion === "verified" ? <CheckCircle size={11} weight="fill" /> : round.conclusion === "verify_failed" ? <WarningCircle size={11} weight="fill" /> : <SpinnerGap size={11} className="animate-spin" />}
              {verdict.label}
            </span>
            <span className="text-[10.5px] text-faint">审查任务：{TASK_STATUS_LABELS[round.reviewTaskStatus]}</span>
          </span>
          <CaretDown
            size={13}
            weight="bold"
            className={`ml-auto shrink-0 text-faint transition-transform ${expanded ? "rotate-180" : ""}`}
          />
        </button>
        {onOpenTask && (
          <button
            type="button"
            onClick={() => onOpenTask(round.reviewTaskId)}
            className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-[10.5px] font-medium text-violet-700 hover:bg-violet-500/[0.08]"
          >
            打开审查任务 <ArrowSquareOut size={11} />
          </button>
        )}
      </div>

      {expanded && (
        <div className="px-3 py-3">
          {round.reportMarkdown ? (
            <Markdown text={round.reportMarkdown} />
          ) : (
            <p className="text-[11.5px] text-faint">审查报告尚未写入。</p>
          )}
          {round.screenshots.length > 0 && (
            <div className="mt-3 border-t border-line pt-3">
              <div className="mb-2 flex items-center gap-1.5 text-[10.5px] font-semibold uppercase tracking-[0.08em] text-faint">
                <ImageSquare size={12} /> 截图 · {round.screenshots.length}
              </div>
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4">
                {round.screenshots.map((name) => {
                  const preview = reviewPreview(taskId, round.round, name);
                  return (
                    <button
                      key={name}
                      type="button"
                      onClick={() => onPreview(preview)}
                      className="group overflow-hidden rounded-lg border border-line bg-canvas text-left transition-colors hover:border-violet-500/35"
                    >
                      <img src={preview.src} alt={name} loading="lazy" className="aspect-video w-full bg-raised object-cover transition-transform duration-200 group-hover:scale-[1.02]" />
                      <span className="block truncate px-2 py-1.5 text-[10px] text-muted">{name}</span>
                    </button>
                  );
                })}
              </div>
            </div>
          )}
        </div>
      )}
    </article>
  );
}

function verdictMeta(conclusion: ReviewConclusion) {
  if (conclusion === "verified") {
    return {
      label: "verified",
      border: "border-emerald-500/25",
      badge: "bg-emerald-500/12 text-emerald-700",
      pill: "bg-emerald-500/10 text-emerald-700",
    };
  }
  if (conclusion === "verify_failed") {
    return {
      label: "verify_failed",
      border: "border-red-500/30",
      badge: "bg-red-500/12 text-red-700",
      pill: "bg-red-500/10 text-red-700",
    };
  }
  return {
    label: "审查中",
    border: "border-violet-500/20",
    badge: "bg-violet-500/10 text-violet-700",
    pill: "bg-violet-500/10 text-violet-700",
  };
}
