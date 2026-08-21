import { useEffect, useMemo, useState } from "react";
import { GitDiff, SpinnerGap, Warning, X } from "@phosphor-icons/react";
import { api } from "../lib/api.ts";
import { countDiffLines, parseDiffLines } from "../review/diffModel.ts";
import { branchDiffReason, type ScmDiffKind } from "./scmModel.ts";

// 单个文件的 diff，摆在中间那一栏（跟 FileViewer 同一个位置，也沿用它的外壳样式：
// 两者是同一种「中间区换一块内容、关掉就回会话」的东西，没必要各长一套边框和标题栏）。
//
// 两类数据源共用这一个查看器：工作区那三档（索引/工作树/未跟踪）和 `branch`（这条任务
// 分支相对合入目标**已经提交**的那份）。对用户来说都是「这个文件改了什么」，差别只在拿
// 哪一段来比——那句差别写在标题栏的副标题里，不值得为它另起一个组件。
//
// 解析复用 `review/diffModel.ts`：这里和分支审查读的是同一种 `git diff` 文本，行号推算
// 的坑（文件头的 `---`/`+++` 不能当增删行）只该踩一次。

const INITIAL_LINES = 400;

const SOURCE_LABEL: Record<ScmDiffKind, string> = {
  staged: "已暂存",
  unstaged: "工作区改动",
  untracked: "未跟踪 · 全文视为新增",
  branch: "已提交 · 相对合入目标",
};

/** 两个接口的返回体收敛成同一份形状。`unavailable` 只有 `branch` 那档给得出。 */
type ViewerDiff = {
  diff: string;
  truncated: boolean;
  limitBytes: number;
  binary: boolean;
  unavailable: string | null;
};

export function ScmDiffViewer({
  taskId,
  path,
  source,
  origPath,
  onClose,
}: {
  taskId: string;
  path: string;
  source: ScmDiffKind;
  origPath: string | null;
  onClose: () => void;
}) {
  const [diff, setDiff] = useState<ViewerDiff | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [visible, setVisible] = useState(INITIAL_LINES);

  useEffect(() => {
    let alive = true;
    setDiff(null);
    setError(null);
    setVisible(INITIAL_LINES);
    const load: Promise<ViewerDiff> = source === "branch"
      ? api.taskBranchFileDiff(taskId, path, origPath).then((result) => ({
        diff: result.diff,
        truncated: result.truncated,
        limitBytes: result.limitBytes,
        binary: result.binary,
        // 这一档「读不到」是**正常返回**而不是抛错（分支可能已经被验收清掉了），
        // 所以不能只接 catch，得自己把它翻成一句话。
        unavailable: result.available ? null : branchDiffReason(result.reason),
      }))
      : api.taskScmDiff(taskId, path, source, origPath).then((result) => ({
        diff: result.diff,
        truncated: result.truncated,
        limitBytes: result.limitBytes,
        binary: result.binary,
        unavailable: null,
      }));
    load
      .then((result) => { if (alive) setDiff(result); })
      .catch((reason: unknown) => { if (alive) setError(reason instanceof Error ? reason.message : String(reason)); });
    return () => { alive = false; };
  }, [origPath, path, source, taskId]);

  const lines = useMemo(() => parseDiffLines(diff?.diff ?? ""), [diff?.diff]);
  const counts = useMemo(() => countDiffLines(lines), [lines]);
  const empty = diff && !diff.unavailable && (diff.binary || !diff.diff.trim());

  return (
    <div className="file-viewer" aria-label={source === "branch" ? "已提交的改动" : "工作区改动"}>
      <header className="file-viewer__bar">
        <div className="file-viewer__title">
          <b><GitDiff size={13} aria-hidden="true" /> {path.split("/").pop()}</b>
          <small>{origPath ? `${origPath} → ` : ""}{path} · {SOURCE_LABEL[source]}</small>
        </div>
        {diff && !diff.binary && !diff.unavailable && (
          <span className="scm-diff__counts"><i>+{counts.additions}</i><em>−{counts.deletions}</em></span>
        )}
        <button type="button" className="file-viewer__action" aria-label="关闭 diff，回到会话" onClick={onClose}>
          <X size={13} aria-hidden="true" />
        </button>
      </header>

      {diff?.truncated && (
        <p className="file-viewer__notice">
          <Warning size={12} aria-hidden="true" />
          diff 超过 {Math.round(diff.limitBytes / 1024)} KB，只显示了截断后的内容。
        </p>
      )}

      <div className="file-viewer__body">
        {!diff && !error && <p className="file-viewer__state"><SpinnerGap size={14} aria-hidden="true" />正在生成 diff…</p>}
        {error && <p className="file-viewer__state is-error"><Warning size={14} aria-hidden="true" />{error}</p>}
        {diff?.unavailable && (
          <p className="file-viewer__state is-error"><Warning size={14} aria-hidden="true" />读不到这个文件的改动：{diff.unavailable}。</p>
        )}
        {empty && (
          <p className="file-viewer__state">
            {diff.binary ? "二进制文件，没有可显示的文本 diff。" : "没有差异可显示——文件内容可能已经和对比基准一致。"}
          </p>
        )}
        {diff && !empty && !diff.unavailable && (
          <div className="single-review-code" role="table" aria-label={`${path} 的改动`}>
            {lines.slice(0, visible).map((line, index) => (
              <div className={`single-review-line is-${line.kind}`} role="row" key={index}>
                <span className="single-review-old" role="cell">{line.oldLine ?? ""}</span>
                <span className="single-review-new" role="cell">{line.newLine ?? ""}</span>
                <code role="cell">{line.text || " "}</code>
              </div>
            ))}
            {visible < lines.length && (
              <button type="button" className="single-review-more-lines" onClick={() => setVisible((count) => count + INITIAL_LINES)}>
                展开后续 {Math.min(INITIAL_LINES, lines.length - visible)} 行
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
