import { useEffect, useMemo, useState } from "react";
import type { Task } from "@ash/shared";
import { CaretRight, GitBranch, GitCommit, GitDiff, SpinnerGap } from "@phosphor-icons/react";
import { api, type TaskCommit, type TaskDiffResult } from "../lib/api.ts";
import { sharedTeamParent } from "../review/reviewModel.ts";

interface ChangeData {
  branch: string | null;
  commits: TaskCommit[];
  diff: TaskDiffResult;
}

export function TaskChangeSummary({
  task,
  allTasks,
  onOpenReview,
}: {
  task: Task;
  allTasks: Task[];
  onOpenReview: () => void;
}) {
  const sharedParent = useMemo(() => sharedTeamParent(task, allTasks), [allTasks, task]);
  const sourceTask = sharedParent ?? task;
  const [data, setData] = useState<ChangeData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError(null);
    Promise.all([api.taskCommits(sourceTask.id), api.taskDiff(sourceTask.id)]).then(
      ([commits, diff]) => {
        if (alive) setData({ branch: commits.branch, commits: commits.commits, diff });
      },
      (reason) => {
        if (alive) {
          setData(null);
          setError(reason instanceof Error ? reason.message : String(reason));
        }
      },
    ).finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [sourceTask.id, sourceTask.updatedAt]);

  const additions = data?.diff.files.reduce((sum, file) => sum + (file.additions ?? 0), 0) ?? 0;
  const deletions = data?.diff.files.reduce((sum, file) => sum + (file.deletions ?? 0), 0) ?? 0;
  const branch = data?.branch || data?.diff.sourceBranch || null;

  return (
    <section className="task-change-summary">
      <h2>改动</h2>
      {loading && <p className="task-change-summary__state"><SpinnerGap size={12} className="is-spinning" />正在汇总分支与提交…</p>}
      {!loading && error && <p className="task-change-summary__state is-error">改动信息读取失败：{error}</p>}
      {!loading && data && (
        <div className="task-change-summary__facts">
          <div><span><GitBranch size={12} />{sharedParent ? "共享分支" : "分支"}</span><code title={branch ?? undefined}>{branch ?? "项目当前分支"}</code></div>
          <div><span><GitCommit size={12} />{sharedParent ? "团队提交" : "提交"}</span><b>{data.commits.length}</b></div>
          <div><span><GitDiff size={12} />改动文件</span><b>{data.diff.available ? data.diff.files.length : "—"}</b></div>
          <div><span>增删</span>{data.diff.available ? <b className="task-change-summary__delta"><i>+{additions}</i><em>−{deletions}</em></b> : <b>—</b>}</div>
        </div>
      )}
      {sharedParent && <p className="task-inspector-note">该执行者与团队共用工作区，改动元数据按所属团队汇总。</p>}
      {!loading && data && !data.diff.available && <p className="task-inspector-note">当前无法生成分支 diff：{data.diff.reason || "未解析到可比较的工作区"}。</p>}
      <button className="task-inspector-action" type="button" onClick={onOpenReview}>
        <span><GitDiff size={13} />查看改动与提交</span><CaretRight size={13} />
      </button>
    </section>
  );
}
