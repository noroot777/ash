import { useEffect, useMemo, useState } from "react";
import type { Task, TaskListItem } from "@navi/shared";
import { CaretRight } from "@phosphor-icons/react";
import { HoverTip, useHoverTip } from "../components/HoverTip.tsx";
import { InspRow } from "../inspector/parts.tsx";
import { useInspectorNav } from "../inspector/nav.tsx";
import { api, type TaskDiffResult } from "../lib/api.ts";
import { sharedTeamParent } from "../review/reviewModel.ts";
import { branchDiffReason, commitListFailure } from "../lib/branch-diff-reason.ts";
import { RollingNumber } from "../lib/motion/index.ts";

interface ChangeData {
  branch: string | null;
  /** 真实条数（清单只列最近一批，不拿它的长度当总数）。数不出来时是 null：那时不写提交数，不写成 0。 */
  commitTotal: number | null;
  commitFailure: string | null;
  diff: TaskDiffResult;
}

/**
 * 没有独立工作区的任务：本来就没有任务分支可比，改动直接落在项目目录里 —— 那就说那个目录此刻有几个
 * 未提交的文件（同一个文件暂存了又改了只算一个）。目录里可能也有别人的改动，所以只报数，点进去看是哪些。
 */
function WorkspaceChangeSummary({ taskId, updatedAt, onOpen }: { taskId: string; updatedAt: string; onOpen: () => void }) {
  const [count, setCount] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    api.taskScm(taskId).then(
      ({ status }) => {
        if (!alive) return;
        const paths = new Set([...status.merge, ...status.staged, ...status.unstaged, ...status.untracked].map((change) => change.path));
        setCount(paths.size);
        setError(null);
      },
      (reason) => { if (alive) setError(reason instanceof Error ? reason.message : String(reason)); },
    );
    return () => { alive = false; };
  }, [taskId, updatedAt]);
  return (
    <InspRow label="改动">
      {error ? <span className="insp-bad insp-cut">读取失败：{error}</span>
        : count === null ? <span className="insp-faint">汇总中…</span>
        : (
          <button type="button" className="insp-val" aria-label={`项目目录里 ${count} 个未提交的文件；去「改动」看`} onClick={onOpen}>
            <span className={count ? "insp-num" : "insp-faint"}>{count ? `${count} 个未提交的文件` : "没有未提交的改动"}</span>
            <CaretRight size={12} aria-hidden="true" />
          </button>
        )}
    </InspRow>
  );
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

  const ownBranch = !!sourceTask.useWorktree;
  useEffect(() => {
    if (!ownBranch) return;
    let alive = true;
    setLoading(true);
    setError(null);
    Promise.all([api.taskCommits(sourceTask.id), api.taskDiff(sourceTask.id)]).then(
      ([commits, diff]) => {
        if (alive) setData({ branch: commits.branch, commitTotal: commits.total, commitFailure: commitListFailure(commits, diff.available), diff });
      },
      (reason) => {
        if (alive) {
          setData(null);
          setError(reason instanceof Error ? reason.message : String(reason));
        }
      },
    ).finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [ownBranch, sourceTask.id, sourceTask.updatedAt]);

  const additions = data?.diff.files.reduce((sum, file) => sum + (file.additions ?? 0), 0) ?? 0;
  const deletions = data?.diff.files.reduce((sum, file) => sum + (file.deletions ?? 0), 0) ?? 0;
  const open = () => (nav ? nav.openTab("scm") : onOpenReview());
  const shared = sharedParent ? "这个执行者和团队共用工作区，改动按所属团队汇总" : null;
  if (!ownBranch) return <WorkspaceChangeSummary taskId={sourceTask.id} updatedAt={sourceTask.updatedAt} onOpen={open} />;

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
                aria-label={`${shared ? `${shared}；` : ""}${data.diff.available ? `${data.diff.files.length} 个文件，增 ${additions} 行，删 ${deletions} 行` : "改动文件数未知"}${data.commitTotal === null ? "" : `，${data.commitTotal} 个提交`}；去「改动」看`}
                {...tip.anchorProps}
                onClick={open}
              >
                {data.diff.available ? (
                  <>
                    <span className="insp-num">{data.diff.files.length} 个文件</span>
                    <RollingNumber className="insp-num insp-plus" value={additions} format={(n) => `+${n}`} />
                    <RollingNumber className="insp-num insp-minus" value={deletions} format={(n) => `−${n}`} />
                  </>
                ) : <span>查看改动</span>}
                {data.commitTotal !== null && <span className="insp-num insp-faint">· {data.commitTotal} 个提交</span>}
                <CaretRight size={12} aria-hidden="true" />
              </button>
              <HoverTip at={tip.at}>{shared ?? "去「改动」看"}</HoverTip>
            </>
          ) : null}
      </InspRow>
      {!loading && data && !data.diff.available && (
        <InspRow wide><p className="insp-faint">当前无法生成分支 diff：{branchDiffReason(data.diff.reason)}。</p></InspRow>
      )}
      {!loading && data?.commitFailure && (
        <InspRow wide><p className="insp-faint">{branchDiffReason(data.commitFailure)}。</p></InspRow>
      )}
    </>
  );
}
