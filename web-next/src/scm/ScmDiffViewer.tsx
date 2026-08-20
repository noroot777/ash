import { useEffect, useMemo, useState } from "react";
import { GitDiff, SpinnerGap, Warning, X } from "@phosphor-icons/react";
import { api, type ScmDiffSource, type ScmFileDiff } from "../lib/api.ts";
import { countDiffLines, parseDiffLines } from "../review/diffModel.ts";

// 单个文件的工作区 diff，摆在中间那一栏（跟 FileViewer 同一个位置，也沿用它的外壳样式：
// 两者是同一种「中间区换一块内容、关掉就回会话」的东西，没必要各长一套边框和标题栏）。
//
// 解析复用 `review/diffModel.ts`：这里和分支审查读的是同一种 `git diff` 文本，行号推算
// 的坑（文件头的 `---`/`+++` 不能当增删行）只该踩一次。

const INITIAL_LINES = 400;

const SOURCE_LABEL: Record<ScmDiffSource, string> = {
  staged: "已暂存",
  unstaged: "工作区改动",
  untracked: "未跟踪 · 全文视为新增",
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
  source: ScmDiffSource;
  origPath: string | null;
  onClose: () => void;
}) {
  const [diff, setDiff] = useState<ScmFileDiff | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [visible, setVisible] = useState(INITIAL_LINES);

  useEffect(() => {
    let alive = true;
    setDiff(null);
    setError(null);
    setVisible(INITIAL_LINES);
    api.taskScmDiff(taskId, path, source, origPath)
      .then((result) => { if (alive) setDiff(result); })
      .catch((reason: unknown) => { if (alive) setError(reason instanceof Error ? reason.message : String(reason)); });
    return () => { alive = false; };
  }, [origPath, path, source, taskId]);

  const lines = useMemo(() => parseDiffLines(diff?.diff ?? ""), [diff?.diff]);
  const counts = useMemo(() => countDiffLines(lines), [lines]);
  const empty = diff && (diff.binary || !diff.diff.trim());

  return (
    <div className="file-viewer" aria-label="工作区改动">
      <header className="file-viewer__bar">
        <div className="file-viewer__title">
          <b><GitDiff size={13} aria-hidden="true" /> {path.split("/").pop()}</b>
          <small>{origPath ? `${origPath} → ` : ""}{path} · {SOURCE_LABEL[source]}</small>
        </div>
        {diff && !diff.binary && (
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
        {empty && (
          <p className="file-viewer__state">
            {diff.binary ? "二进制文件，没有可显示的文本 diff。" : "没有差异可显示——文件内容可能已经和对比基准一致。"}
          </p>
        )}
        {diff && !empty && (
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
