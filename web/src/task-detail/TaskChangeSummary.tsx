import { useEffect, useMemo, useState } from "react";
import type { Task, TaskListItem } from "@ash/shared";
import { CaretRight } from "@phosphor-icons/react";
import { HoverTip, useHoverTip } from "../components/HoverTip.tsx";
import { InspRow } from "../inspector/parts.tsx";
import { useInspectorNav } from "../inspector/nav.tsx";
import { api, type TaskCommit, type TaskDiffResult } from "../lib/api.ts";
import { sharedTeamParent } from "../review/reviewModel.ts";
import { branchDiffReason } from "../lib/branch-diff-reason.ts";

interface ChangeData {
  branch: string | null;
  commits: TaskCommit[];
  diff: TaskDiffResult;
}

/**
 * 「信息」格里的改动统计：压成一行「N 个文件 +a −d · k 个提交」，点它去「改动」那一格
 * （面板外单独渲染时退回打开改动工作区）。分支名不在这里写——下面「分支」那一行已经有了，
 * 同一屏不说两遍。是一组 dt/dd，放在 InspKv 里用。
 */
export function TaskChangeSummary({
  task,
  allTasks,
  onOpenReview,
}: {
  task: Task;
  allTasks: TaskListItem[];
  onOpenReview: () => void;
}) {
  const sharedParent = useMemo(() => sharedTeamParent(task, allTasks), [allTasks, task]);
  const sourceTask = sharedParent ?? task;
  const nav = useInspectorNav();
  const tip = useHoverTip();
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
  const open = () => (nav ? nav.openTab("scm") : onOpenReview());
  const shared = sharedParent ? "这个执行者和团队共用工作区，改动按所属团队汇总" : null;

  return (
    <>
      <InspRow label="改动">
        {loading ? <span className="insp-faint">汇总中…</span>
          : error ? <span className="insp-bad insp-cut">读取失败：{error}</span>
          : data ? (
            <>
              <button
                type="button"
                className="insp-val"
                aria-label={`${shared ? `${shared}；` : ""}${data.diff.available ? `${data.diff.files.length} 个文件，增 ${additions} 行，删 ${deletions} 行` : "改动文件数未知"}，${data.commits.length} 个提交；去「改动」看`}
                {...tip.anchorProps}
                onClick={open}
              >
                {data.diff.available ? (
                  <>
                    <span className="insp-num">{data.diff.files.length} 个文件</span>
                    <span className="insp-num insp-plus">+{additions}</span>
                    <span className="insp-num insp-minus">−{deletions}</span>
                  </>
                ) : <span>查看改动</span>}
                <span className="insp-num insp-faint">· {data.commits.length} 个提交</span>
                <CaretRight size={12} aria-hidden="true" />
              </button>
              <HoverTip at={tip.at}>{shared ?? "去「改动」看"}</HoverTip>
            </>
          ) : null}
      </InspRow>
      {!loading && data && !data.diff.available && (
        <InspRow wide><p className="insp-faint">当前无法生成分支 diff：{branchDiffReason(data.diff.reason)}。</p></InspRow>
      )}
    </>
  );
}
