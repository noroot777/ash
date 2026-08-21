import { useEffect, useState } from "react";
import { CaretRight, GitDiff, SpinnerGap } from "@phosphor-icons/react";
import { api, type TaskDiffResult } from "../lib/api.ts";
import { dirName, fileName } from "./scmModel.ts";

// 「本任务已提交的改动」——面板上半截问的是「此刻还没提交的东西」，仓库约定「改完立即
// 提交」，所以上半截绝大多数时候是空的。只留一句「工作区干净」会把人按到错误的结论上：
// 页签叫「改动」，看到空的就以为这个任务什么都没改、下面那颗提交按钮是坏的。
//
// 这一节补上另一半：这条任务分支相对合入目标**已经提交**了哪些文件。数据跟审查页、信息
// 页的改动摘要同源（`/tasks/:id/diff` → `taskBranchDiff`），所以三处对不上不了。
//
// 条目不做成能点的：工作区 diff 那套 `source=staged|unstaged|untracked` 读的是索引和工作
// 树，给不出「相对 merge-base」的那份内容。要逐文件看 diff 就整段跳去审查工作区——那里本
// 来就是干这个的，摆一个点了报错的按钮不如把人送到对的地方。

const MAX_ROWS = 60;

export function ScmCommittedChanges({
  taskId,
  revision,
  onOpenReview,
}: {
  taskId: string;
  /** 变一次重取一次：提交成功后 SCM 概览的最新提交会换 sha，这里跟着刷新。 */
  revision: string | null;
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
        <p className="scm-committed__state">读不到分支改动：{diff.reason || "未解析到可比较的工作区"}。</p>
      )}
      {!loading && diff?.available && files.length === 0 && (
        <p className="scm-committed__state">这条分支相对 {diff.targetBranch ?? "合入目标"} 还没有提交任何改动。</p>
      )}

      {diff?.available && files.length > 0 && (
        <>
          <ul>
            {files.slice(0, MAX_ROWS).map((file) => (
              <li key={file.path}>
                <span className="scm-row__name">{fileName(file.path)}</span>
                <span className="scm-row__dir">{dirName(file.path)}</span>
                <span className="scm-diff__counts">
                  <i>+{file.additions ?? 0}</i>
                  <em>−{file.deletions ?? 0}</em>
                </span>
              </li>
            ))}
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
