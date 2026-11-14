import type { Task, TaskListItem } from "@ash/shared";
import { GitBranch, X } from "@phosphor-icons/react";
import { IconButton } from "../components/IconButton.tsx";
import { api, type TaskCommit, type TaskDiffResult } from "../lib/api.ts";
import { AcceptanceControls } from "../acceptance/AcceptanceControls.tsx";
import { AcceptRoute } from "../acceptance/AcceptRoute.tsx";
import { ChangesLeadNote, ChangesNote } from "../acceptance/ChangesNotice.tsx";
import { useVersionedRead } from "../acceptance/useVersionedRead.ts";
import { ReviewDiffViewer } from "./ReviewDiffViewer.tsx";
import { sharedTeamParent } from "./reviewModel.ts";
import { useWorkspaceCommitVersion } from "./workspaceCommit.ts";

type ReviewData = {
  branch: string | null;
  commits: TaskCommit[];
  diff: TaskDiffResult;
};

function SharedWorkerFacts({ parent, branch }: { parent: TaskListItem; branch: string | null }) {
  const params = new URLSearchParams({ project: parent.projectId, task: parent.id });
  return (
    <>
      <dl className="single-review-facts">
        <div><dt>执行归属</dt><dd>{parent.title}</dd></div>
        <div><dt>共享分支</dt><dd><GitBranch size={12} />{branch || "由父团队统一管理"}</dd></div>
        <div><dt>验收方式</dt><dd>随父团队整体验收</dd></div>
      </dl>
      <div className="single-review-shared-note">
        <div><b>该执行者不单独合入</b><p>代码与同组执行者共同位于父团队共享分支，无法可靠按单个执行者切分 diff。请结合审查证据，在团队验收台核对共享改动并统一验收。</p></div>
        <a href={`/?${params.toString()}`}>打开父团队</a>
      </div>
    </>
  );
}

/**
 * 单任务验收台：第一行是走向与决定（AcceptanceControls 带着它自己的前提列），下面直接是 diff。
 * 任务标题、状态、目标正文在对话区和右侧 inspector 里各有一份，验证证据也在 inspector 里点得开，
 * 这一屏不再铺一遍。返回口在第一行最右端。
 */
export function TaskReviewWorkspace({
  task,
  allTasks,
  onTaskUpdated,
  notify,
  onPostMergeReview,
  onOpenReview,
  onClose,
}: {
  task: Task;
  allTasks: TaskListItem[];
  onTaskUpdated: (task: Task) => void;
  notify: (message: string) => void;
  onPostMergeReview?: () => void;
  onOpenReview?: () => void;
  onClose?: () => void;
}) {
  const commitVersion = useWorkspaceCommitVersion(task.id);
  const sharedParent = sharedTeamParent(task, allTasks);
  const version = `${task.updatedAt}|${commitVersion}`;
  const changes = useVersionedRead<ReviewData>(task.id, version, () =>
    Promise.all([api.taskCommits(task.id), api.taskDiff(task.id)])
      .then(([commits, diff]) => ({ branch: commits.branch, commits: commits.commits, diff })), !sharedParent);
  const shared = useVersionedRead<string | null>(`${task.id}>${sharedParent?.id ?? ""}`, version,
    () => api.taskCommits(sharedParent!.id).then((commits) => commits.branch), !!sharedParent);

  const close = onClose && (
    <IconButton label="返回对话" className="acc-close" onClick={onClose}>
      <X size={16} aria-hidden="true" />
    </IconButton>
  );
  if (sharedParent) {
    return (
      <section className="single-review-workspace">
        <header className="acc-bar is-host">
          <div className="acc-lead"><b className="acc-title">共享执行者</b></div>
          <div className="acc-actions"><span className="acc-done">随团队验收</span>{close}</div>
        </header>
        <div className="single-review-scroll">
          <div className="single-review-stack">
            <SharedWorkerFacts parent={sharedParent} branch={shared.current ?? shared.previous ?? null} />
            {shared.error && <p className="single-review-error">共享分支归属读取失败：{shared.error}</p>}
          </div>
        </div>
      </section>
    );
  }
  // 顶行只认这一版的走向；diff 区在这一版没到时可以摆上一版，但压暗，读失败还要明说是上一版。
  const data = changes.current;
  const shown = data ?? changes.previous;
  const route = data && {
    source: data.diff.sourceBranch || data.branch || "项目当前分支",
    target: data.diff.targetBranch || task.acceptedTargetBranch || task.mergeTargetBranch || task.worktreeBase || "验收时确定",
    commits: data.commits,
    diff: data.diff,
  };
  return (
    <section className="single-review-workspace">
      <AcceptanceControls
        className="acc-desk"
        task={task}
        onTaskUpdated={onTaskUpdated}
        notify={notify}
        onPostMergeReview={onPostMergeReview}
        onOpenReview={onOpenReview}
        onReturned={onClose}
        lead={route
          ? <AcceptRoute task={task} data={route} disabled={!!task.archived} onTaskUpdated={onTaskUpdated} notify={notify} />
          : <ChangesLeadNote loading={changes.loading} error={changes.error} retry={changes.retry} />}
        trailing={close}
      />
      <div className="single-review-diff-region">
        <ChangesNote stale={!!changes.previous} error={changes.error} retry={changes.retry} />
        {shown && <div className={data ? undefined : "acc-stale"} aria-busy={!data || undefined}><ReviewDiffViewer result={shown.diff} /></div>}
      </div>
    </section>
  );
}
