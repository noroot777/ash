import { useEffect, useMemo, useState } from "react";
import { parseSessionOutput, STAGE_LABELS, type Session, type Task } from "@harness/shared";
import {
  CaretDown,
  CheckCircle,
  GitCommit,
  GitDiff,
  SpinnerGap,
  UserCircle,
  WarningCircle,
  X,
} from "@phosphor-icons/react";
import {
  api,
  type AcceptTaskFailure,
  type TaskCommit,
  type TaskDiffResult,
} from "./api";
import { ConfirmModal } from "./Modal";
import { StatusIcon } from "./StatusIcon";
import { toast } from "./toast";
import { parseAttachmentText } from "./messageAttachments";

type UserMessage = { text: string; at?: string };
type Evidence = {
  branch: string | null;
  commits: TaskCommit[];
  diff: TaskDiffResult;
  messages: UserMessage[];
};

const ANSWER_PREFIX = "【答复】你之前的提问:";

export function isQuestionAnswerMessage(text: string): boolean {
  return text.trimStart().startsWith(ANSWER_PREFIX);
}

export function AcceptanceAction({
  task,
  onAccepted,
  onFailure,
  compact = false,
}: {
  task: Task;
  onAccepted: (task: Task) => void;
  onFailure?: (failure: AcceptTaskFailure | null) => void;
  compact?: boolean;
}) {
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const inFlight = task.status === "running" || task.status === "queued";
  const accepted = task.stage === "accepted";

  const accept = async () => {
    setBusy(true);
    onFailure?.(null);
    try {
      const result = await api.acceptTask(task.id);
      if (!result.accepted) {
        onFailure?.(result);
        return;
      }
      const refreshed = await api.task(task.id);
      onAccepted(refreshed);
      const message = result.warnings?.length
        ? `验收通过，但有 ${result.warnings.length} 条临时 worktree 清理警告；详情已写入时间线`
        : result.kind === "already_accepted" ? "该任务此前已验收完成" : "验收通过，阶段已刷新";
      toast(message, "info");
    } catch (error) {
      onFailure?.({
        accepted: false,
        taskId: task.id,
        reason: "request_failed",
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setBusy(false);
    }
  };

  if (accepted) {
    return (
      <span className="inline-flex items-center gap-1.5 rounded-md bg-emerald-500/10 px-2.5 py-1.5 text-[12px] font-medium text-emerald-700">
        <CheckCircle size={14} weight="fill" />
        验收完成
      </span>
    );
  }

  return (
    <>
      <button
        type="button"
        disabled={busy || inFlight}
        onClick={() => setConfirmOpen(true)}
        className={compact
          ? "inline-flex items-center gap-1.5 rounded-md bg-accent px-3 py-1.5 text-[13px] font-medium text-accent-fg transition-colors hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-45"
          : "inline-flex items-center gap-1.5 rounded-md bg-accent px-3.5 py-2 text-[12.5px] font-medium text-accent-fg transition-colors hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-45"}
        title={inFlight ? "任务仍在运行，结束后才能验收" : "确认合并并清理任务 worktree"}
      >
        {busy ? <SpinnerGap size={14} className="animate-spin" /> : <CheckCircle size={14} weight="fill" />}
        {busy ? "验收中" : inFlight ? "执行中" : "验收通过"}
      </button>
      {confirmOpen && (
        <ConfirmModal
          title="确认验收通过？"
          message={`这会执行确定性验收：独立 worktree 的分支将合并回 ${task.worktreeBase || "项目当前分支"}，随后删除任务 worktree 与分支；共享团队 worktree 的执行者只标记通过，由调度台统一合并。已执行的合并和删除不可逆。`}
          confirmLabel="验收通过"
          danger
          onConfirm={() => void accept()}
          onClose={() => setConfirmOpen(false)}
        />
      )}
    </>
  );
}

export function AcceptanceFailureReport({ failure }: { failure: AcceptTaskFailure }) {
  const details = [
    ["reason", failure.reason],
    ["检查点", failure.phase],
    ["status", failure.status],
    ["源分支", failure.sourceBranch],
    ["目标分支", failure.targetBranch],
    ["目标目录", failure.targetPath],
    ["worktree", failure.worktreePath],
  ].filter((row): row is [string, string] => typeof row[1] === "string" && row[1].length > 0);
  return (
    <div role="alert" className="mt-3 rounded-lg border border-red-500/35 bg-red-500/[0.06] p-3 text-[12px]">
      <div className="flex items-start gap-2">
        <WarningCircle size={15} weight="fill" className="mt-0.5 shrink-0 text-red-600" />
        <div className="min-w-0 flex-1">
          <p className="font-semibold text-red-700">验收未完成</p>
          <p className="mt-0.5 whitespace-pre-wrap text-ink">{failure.error}</p>
          {details.length > 0 && (
            <dl className="mt-2 grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 font-mono text-[11px]">
              {details.map(([label, value]) => (
                <div key={label} className="contents">
                  <dt className="text-faint">{label}</dt>
                  <dd className="break-all text-muted">{value}</dd>
                </div>
              ))}
            </dl>
          )}
          <FileList title="冲突文件" files={failure.conflictFiles} />
          <FileList title="未提交文件" files={failure.dirtyFiles} />
          {!!failure.inFlightTasks?.length && (
            <div className="mt-2">
              <p className="font-medium text-red-700">正在使用相关 worktree 的任务（{failure.inFlightTasks.length}）</p>
              <ul className="mt-1 space-y-0.5 font-mono text-[11px] text-ink">
                {failure.inFlightTasks.map((item) => (
                  <li key={item.id} className="break-all">
                    {item.title} · {item.id} · {item.status}{item.role === "shared_worker" ? " · 共享执行者" : ""}
                  </li>
                ))}
              </ul>
            </div>
          )}
          {!!failure.warnings?.length && (
            <FileList title="合并警告" files={failure.warnings.map((warning) => warning.message)} />
          )}
        </div>
      </div>
    </div>
  );
}

function FileList({ title, files }: { title: string; files?: string[] }) {
  if (!files?.length) return null;
  return (
    <div className="mt-2">
      <p className="font-medium text-red-700">{title}（{files.length}）</p>
      <ul className="mt-1 space-y-0.5 font-mono text-[11px] text-ink">
        {files.map((file) => <li key={file} className="break-all">{file}</li>)}
      </ul>
    </div>
  );
}

export function TeamReviewWorkspace({
  lead,
  workers,
  onClose,
  onTaskUpdated,
}: {
  lead: Task;
  workers: Task[];
  onClose: () => void;
  onTaskUpdated: (task: Task) => void;
}) {
  const awaiting = workers.filter((worker) => worker.stage === "awaiting_acceptance").length;
  return (
    <section className="flex min-h-0 flex-1 flex-col bg-canvas">
      <div className="flex shrink-0 items-center gap-3 border-b border-line bg-panel px-6 py-3">
        <div>
          <h2 className="text-[14px] font-semibold text-ink">团队验收台</h2>
          <p className="text-[11.5px] text-faint">
            {workers.length} 个执行者{awaiting ? ` · ${awaiting} 个等待验收` : ""} · 问答卡答复不计入用户消息
          </p>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="ml-auto inline-flex items-center gap-1.5 rounded-md border border-line px-2.5 py-1.5 text-[12px] text-muted transition-colors hover:bg-raised hover:text-ink"
        >
          <X size={13} />
          返回团队流
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5">
        <div className="mx-auto flex w-full max-w-[1180px] flex-col gap-4">
          <ReviewSection
            task={lead}
            role={lead.useWorktree ? "调度台 / 共享 worktree" : "调度台 / 项目工作区"}
            onTaskUpdated={onTaskUpdated}
            defaultOpen
          />
          {workers.map((worker, index) => (
            <ReviewSection
              key={worker.id}
              task={worker}
              role={`执行者 ${index + 1}`}
              onTaskUpdated={onTaskUpdated}
              defaultOpen={worker.stage === "awaiting_acceptance"}
            />
          ))}
          {workers.length === 0 && (
            <p className="rounded-lg border border-dashed border-line2 bg-panel px-4 py-8 text-center text-[13px] text-faint">
              调度台还没有派出执行者；可先检查上方调度台的{lead.useWorktree ? "共享 worktree" : "项目工作区"}与用户消息。
            </p>
          )}
        </div>
      </div>
    </section>
  );
}

export function TaskDiffWorkspace({
  task,
  onClose,
  onTaskUpdated,
}: {
  task: Task;
  onClose: () => void;
  onTaskUpdated: (task: Task) => void;
}) {
  return (
    <section className="flex min-h-0 flex-1 flex-col bg-canvas">
      <div className="flex shrink-0 items-center gap-3 border-b border-line bg-panel px-6 py-3">
        <div>
          <h2 className="text-[14px] font-semibold text-ink">改动与提交</h2>
          <p className="text-[11.5px] text-faint">按文件折叠查看任务分支相对基线的 diff</p>
        </div>
        <button type="button" onClick={onClose} className="ml-auto inline-flex items-center gap-1.5 rounded-md border border-line px-2.5 py-1.5 text-[12px] text-muted hover:bg-raised hover:text-ink">
          <X size={13} /> 返回对话
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5">
        <div className="mx-auto w-full max-w-[1180px]">
          <ReviewSection task={task} role="单任务" onTaskUpdated={onTaskUpdated} defaultOpen hideMessages />
        </div>
      </div>
    </section>
  );
}

function ReviewSection({
  task,
  role,
  onTaskUpdated,
  defaultOpen = false,
  hideMessages = false,
}: {
  task: Task;
  role: string;
  onTaskUpdated: (task: Task) => void;
  defaultOpen?: boolean;
  hideMessages?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const [evidence, setEvidence] = useState<Evidence | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [failure, setFailure] = useState<AcceptTaskFailure | null>(null);
  const objective = parseAttachmentText(task.body).body.trim();

  useEffect(() => {
    let alive = true;
    setEvidence(null);
    setLoadError(null);
    void loadEvidence(task.id).then(
      (next) => { if (alive) setEvidence(next); },
      (error) => { if (alive) setLoadError(error instanceof Error ? error.message : String(error)); },
    );
    return () => { alive = false; };
  }, [task.id]);

  return (
    <article className="overflow-hidden rounded-xl border border-line2 bg-panel shadow-[0_1px_2px_rgba(20,20,25,.04)]">
      <div className="flex items-start gap-3 px-4 py-3.5">
        <button type="button" onClick={() => setOpen((value) => !value)} className="mt-0.5 grid h-6 w-6 shrink-0 place-items-center rounded-md text-faint hover:bg-raised hover:text-ink" aria-label={open ? "收起验收内容" : "展开验收内容"}>
          <CaretDown size={14} weight="bold" className={`transition-transform ${open ? "" : "-rotate-90"}`} />
        </button>
        <StatusIcon status={task.status} stage={task.stage} awaitingAnswer={!!task.question} size={8} className="mt-2" />
        <button type="button" onClick={() => setOpen((value) => !value)} className="min-w-0 flex-1 text-left">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <h3 className="truncate text-[14px] font-semibold text-ink">{task.title}</h3>
            <span className="rounded bg-overlay px-1.5 py-0.5 text-[10.5px] font-medium text-muted">{role}</span>
            <span className="text-[11px] text-faint">{task.stage ? STAGE_LABELS[task.stage] : task.status}</span>
          </div>
          <p className="mt-1 line-clamp-2 max-w-4xl whitespace-pre-wrap text-[12px] leading-relaxed text-muted">
            {objective || "未填写任务目标"}
          </p>
        </button>
        <AcceptanceAction task={task} onAccepted={onTaskUpdated} onFailure={setFailure} />
      </div>
      {failure && <div className="border-t border-line px-4 pb-3"><AcceptanceFailureReport failure={failure} /></div>}
      {open && (
        <div className="border-t border-line bg-canvas/45 px-4 py-4">
          {loadError ? (
            <p className="rounded-md border border-red-500/30 bg-red-500/[0.05] px-3 py-2 text-[12px] text-red-700">证据加载失败：{loadError}</p>
          ) : !evidence ? (
            <div className="flex items-center gap-2 py-8 text-[12px] text-faint"><SpinnerGap size={15} className="animate-spin" /> 正在汇总提交、diff 和会话…</div>
          ) : (
            <div className="grid gap-4 xl:grid-cols-[300px_minmax(0,1fr)]">
              <div className="space-y-4">
                <CommitList branch={evidence.branch} commits={evidence.commits} />
                {!hideMessages && <UserMessages messages={evidence.messages} />}
              </div>
              <DiffViewer result={evidence.diff} />
            </div>
          )}
        </div>
      )}
    </article>
  );
}

async function loadEvidence(taskId: string): Promise<Evidence> {
  const [commitResult, diff, sessions] = await Promise.all([
    api.taskCommits(taskId),
    api.taskDiff(taskId),
    api.sessions(taskId),
  ]);
  const ordered = [...sessions].sort((a, b) => a.startedAt.localeCompare(b.startedAt));
  const outputs = await Promise.all(ordered.map(async (session) => ({
    session,
    output: await api.sessionOutput(session.id),
  })));
  return {
    branch: commitResult.branch,
    commits: commitResult.commits,
    diff,
    messages: collectUserMessages(outputs),
  };
}

function collectUserMessages(outputs: { session: Session; output: string }[]): UserMessage[] {
  const messages: UserMessage[] = [];
  for (const { session, output } of outputs) {
    for (const segment of parseSessionOutput(output)) {
      if (segment.kind !== "user" || isQuestionAnswerMessage(segment.text)) continue;
      messages.push({ text: segment.text, at: segment.at || session.startedAt });
    }
  }
  return messages;
}

function CommitList({ branch, commits }: { branch: string | null; commits: TaskCommit[] }) {
  return (
    <section>
      <div className="mb-2 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-[0.08em] text-faint">
        <GitCommit size={13} /> 提交 {commits.length > 0 && `· ${commits.length}`}
      </div>
      {branch && <p className="mb-2 truncate font-mono text-[10.5px] text-muted" title={branch}>{branch}</p>}
      {commits.length > 0 ? (
        <ol className="space-y-2">
          {commits.map((commit) => (
            <li key={commit.sha} className="rounded-md border border-line bg-panel px-2.5 py-2">
              <p className="text-[12px] leading-snug text-ink">{commit.subject}</p>
              <p className="mt-1 flex items-center gap-2 font-mono text-[10px] text-faint">
                <span>{commit.sha.slice(0, 8)}</span><span>{formatDate(commit.at)}</span>
              </p>
            </li>
          ))}
        </ol>
      ) : <p className="rounded-md border border-dashed border-line2 px-3 py-4 text-center text-[11.5px] text-faint">没有可归属到该任务分支的提交</p>}
    </section>
  );
}

function UserMessages({ messages }: { messages: UserMessage[] }) {
  return (
    <section>
      <div className="mb-2 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-[0.08em] text-faint">
        <UserCircle size={13} /> 用户消息 {messages.length > 0 && `· ${messages.length}`}
      </div>
      {messages.length > 0 ? (
        <div className="space-y-2">
          {messages.map((message, index) => (
            <div key={`${message.at}-${index}`} className="rounded-md border border-indigo-500/20 bg-indigo-500/[0.04] px-3 py-2.5">
              <p className="whitespace-pre-wrap break-words text-[12px] leading-relaxed text-ink">{message.text}</p>
              {message.at && <p className="mt-1 text-[10px] text-faint">{formatDate(message.at)}</p>}
            </div>
          ))}
        </div>
      ) : <p className="rounded-md border border-dashed border-line2 px-3 py-4 text-center text-[11.5px] text-faint">没有普通用户消息；问答卡答复已按口径排除</p>}
      <p className="mt-2 text-[10.5px] leading-relaxed text-faint">口径：聚合会话中 kind=user 的消息；以“{ANSWER_PREFIX}”注入的问答卡答复不计入。</p>
    </section>
  );
}

function DiffViewer({ result }: { result: TaskDiffResult }) {
  const total = result.files.reduce((sum, file) => ({
    additions: sum.additions + (file.additions ?? 0),
    deletions: sum.deletions + (file.deletions ?? 0),
  }), { additions: 0, deletions: 0 });
  const sections = useMemo(() => splitDiff(result), [result]);
  return (
    <section className="min-w-0">
      <div className="mb-2 flex flex-wrap items-center gap-2 text-[11px]">
        <span className="inline-flex items-center gap-1.5 font-semibold uppercase tracking-[0.08em] text-faint"><GitDiff size={13} /> 文件改动</span>
        {result.available && <><span className="text-emerald-600">+{total.additions}</span><span className="text-red-600">−{total.deletions}</span><span className="text-faint">{result.files.length} 个文件</span></>}
        {result.targetBranch && <span className="ml-auto truncate font-mono text-[10px] text-faint">{result.sourceBranch} → {result.targetBranch}</span>}
      </div>
      {result.truncated && (
        <div className="mb-2 flex items-center gap-2 rounded-md border border-amber-500/30 bg-amber-500/[0.07] px-3 py-2 text-[11.5px] text-amber-800">
          <WarningCircle size={14} weight="fill" />
          diff 超过 {formatBytes(result.limitBytes)}，响应已截断；下方只展示服务端实际返回的部分。
        </div>
      )}
      {!result.available ? (
        <p className="rounded-md border border-dashed border-line2 px-3 py-8 text-center text-[12px] text-faint">无法生成分支 diff：{diffReason(result.reason)}</p>
      ) : sections.length === 0 ? (
        <p className="rounded-md border border-dashed border-line2 px-3 py-8 text-center text-[12px] text-faint">任务分支相对基线没有文件改动</p>
      ) : (
        <div className="space-y-2">
          {sections.map((section, index) => <DiffFile key={`${section.file.path}-${index}`} section={section} defaultOpen={index === 0} truncated={result.truncated} />)}
        </div>
      )}
    </section>
  );
}

type DiffSection = { file: TaskDiffResult["files"][number]; body: string };

function DiffFile({ section, defaultOpen, truncated }: { section: DiffSection; defaultOpen: boolean; truncated: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="overflow-hidden rounded-md border border-line bg-panel">
      <button type="button" onClick={() => setOpen((value) => !value)} className="flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-raised/60">
        <CaretDown size={12} weight="bold" className={`shrink-0 text-faint transition-transform ${open ? "" : "-rotate-90"}`} />
        <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-ink" title={section.file.path}>{section.file.path}</span>
        <span className="shrink-0 font-mono text-[10.5px] text-emerald-600">+{section.file.additions ?? "–"}</span>
        <span className="shrink-0 font-mono text-[10.5px] text-red-600">−{section.file.deletions ?? "–"}</span>
      </button>
      {open && (
        section.body ? <DiffCode text={section.body} /> : (
          <p className="border-t border-line px-3 py-5 text-center text-[11.5px] text-faint">{truncated ? "该文件内容未包含在已截断的响应中" : "没有文本 diff（可能是二进制文件）"}</p>
        )
      )}
    </div>
  );
}

function DiffCode({ text }: { text: string }) {
  return (
    <pre className="max-h-[560px] overflow-auto border-t border-line bg-[#fbfbfc] py-2 font-mono text-[11px] leading-[1.55]">
      {text.split("\n").map((line, index) => (
        <span key={index} className={`block min-w-max px-3 ${diffLineClass(line)}`}>{line || " "}</span>
      ))}
    </pre>
  );
}

function splitDiff(result: TaskDiffResult): DiffSection[] {
  const starts = [...result.diff.matchAll(/^diff --git /gm)].map((match) => match.index ?? 0);
  const bodies = starts.map((start, index) => result.diff.slice(start, starts[index + 1] ?? result.diff.length).trimEnd());
  if (result.files.length === 0 && bodies.length > 0) {
    return bodies.map((body, index) => ({ file: { path: `diff-${index + 1}`, additions: null, deletions: null }, body }));
  }
  return result.files.map((file, index) => ({ file, body: bodies[index] ?? "" }));
}

function diffLineClass(line: string): string {
  if (line.startsWith("+") && !line.startsWith("+++")) return "bg-emerald-500/[0.08] text-emerald-900";
  if (line.startsWith("-") && !line.startsWith("---")) return "bg-red-500/[0.08] text-red-900";
  if (line.startsWith("@@")) return "bg-indigo-500/[0.07] text-indigo-700";
  if (line.startsWith("diff --git") || line.startsWith("index ")) return "text-faint";
  return "text-muted";
}

function diffReason(reason?: string): string {
  const labels: Record<string, string> = {
    not_git_repo: "项目不是 Git 仓库",
    target_unresolved: "无法确定目标分支",
    source_branch_missing: "任务分支不存在或已清理",
    target_branch_missing: "目标分支不存在",
    no_merge_base: "源分支与目标分支没有共同基点",
  };
  return labels[reason ?? ""] ?? reason ?? "未知原因";
}

function formatDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
}

function formatBytes(value: number): string {
  return value >= 1024 * 1024 ? `${(value / 1024 / 1024).toFixed(0)} MB` : `${Math.ceil(value / 1024)} KB`;
}
