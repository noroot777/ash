import { useEffect, useState } from "react";
import { CaretRight, GitDiff, SpinnerGap } from "@phosphor-icons/react";
import { api, type TaskDiffResult } from "../lib/api.ts";
import { branchDiffReason, dirName, fileName, type ScmDiffTarget } from "./scmModel.ts";

// 「本任务已提交的改动」——面板上半截问的是「此刻还没提交的东西」，仓库约定「改完立即
// 提交」，所以上半截绝大多数时候是空的。只留一句「工作区干净」会把人按到错误的结论上：
// 页签叫「改动」，看到空的就以为这个任务什么都没改、下面那颗提交按钮是坏的。
//
// 这一节补上另一半：这条任务分支相对合入目标**已经提交**了哪些文件。数据跟审查页、信息
// 页的改动摘要同源（`/tasks/:id/diff` → `taskBranchDiff`），所以三处对不上不了。
//
// 条目点开的是 `source:"branch"` 那一档 diff，跟上半截工作区条目走的不是同一个接口：
// 那三档读的是索引和工作树，给不出「相对 merge-base」的内容（一个提交过、工作区已经干净
// 的文件在那儿一律被拒）。所以后端另有一条 `/tasks/:id/diff/file`，跟这份清单同源、同一段
// 提交区间——清单给 A、点进去按 B 比，用户看到的会是一份对不上的 diff。

const MAX_ROWS = 60;

export function ScmCommittedChanges({
  taskId,
  revision,
  activeDiff,
  onOpenDiff,
  onOpenReview,
}: {
  taskId: string;
  /** 变一次重取一次：提交成功后 SCM 概览的最新提交会换 sha，这里跟着刷新。 */
  revision: string | null;
  activeDiff: ScmDiffTarget | null;
  onOpenDiff: (target: ScmDiffTarget) => void;
  onOpenReview?: () => void;
}) {
  const [diff, setDiff] = useState<TaskDiffResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    api.taskDiff(taskId).then(
      (result) => { if (alive) { setDiff(result); setError(null); } },
      (reason) => { if (alive) { setDiff(null); setError(reason instanceof Error ? reason.message : String(reason)); } },
    ).finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [taskId, revision]);

  const files = diff?.files ?? [];
  const additions = files.reduce((sum, file) => sum + (file.additions ?? 0), 0);
  const deletions = files.reduce((sum, file) => sum + (file.deletions ?? 0), 0);

  return (
    <section className="scm-committed">
      <header>
        <GitDiff size={13} />
        本任务已提交的改动
        {diff?.available && files.length > 0 && <span className="scm-committed__count">{files.length}</span>}
        {diff?.available && files.length > 0 && (
          <span className="scm-diff__counts"><i>+{additions}</i><em>−{deletions}</em></span>
        )}
      </header>

      {loading && !diff && <p className="scm-committed__state"><SpinnerGap size={12} className="is-spinning" />正在读取分支改动…</p>}
      {!loading && error && <p className="scm-committed__state">读取失败：{error}</p>}
      {!loading && diff && !diff.available && (
        <p className="scm-committed__state">读不到分支改动：{branchDiffReason(diff.reason)}。</p>
      )}
      {!loading && diff?.available && files.length === 0 && (
        <p className="scm-committed__state">这条分支相对 {diff.targetBranch ?? "合入目标"} 还没有提交任何改动。</p>
      )}

      {diff?.available && files.length > 0 && (
        <>
          <ul>
            {files.slice(0, MAX_ROWS).map((file) => {
              const active = activeDiff?.source === "branch" && activeDiff.path === file.path;
              return (
                <li key={file.path} className={`scm-row${active ? " is-active" : ""}`}>
                  <button
                    type="button"
                    className="scm-row__open"
                    onClick={() => onOpenDiff({ path: file.path, source: "branch", origPath: file.origPath })}
                  >
                    <span className="scm-row__name">{fileName(file.path)}</span>
                    {/* 改名的来源路径要摆出来：只显示新名字的话，清单上会凭空多一个「新文件」，
                        而它的 diff 里满是删除行。 */}
                    {file.origPath && <i className="scm-row__from">← {fileName(file.origPath)}</i>}
                    <span className="scm-row__dir">{dirName(file.path)}</span>
                  </button>
                  <span className="scm-diff__counts">
                    <i>+{file.additions ?? 0}</i>
                    <em>−{file.deletions ?? 0}</em>
                  </span>
                </li>
              );
            })}
          </ul>
          {files.length > MAX_ROWS && (
            <p className="scm-committed__state">另有 {files.length - MAX_ROWS} 个文件没有列出。</p>
          )}
          {diff.truncated && <p className="scm-committed__state">diff 内容超出上限，文件清单可能不完整。</p>}
          {onOpenReview && (
            <button type="button" className="scm-committed__open" onClick={onOpenReview}>
              <span><GitDiff size={13} />查看完整 diff 与提交</span>
              <CaretRight size={13} />
            </button>
          )}
        </>
      )}
    </section>
  );
}
