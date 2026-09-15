import { useEffect, useState } from "react";
import { File, Minus, Plus, Trash, GitCommit } from "@phosphor-icons/react";
import type { GitDiff, GitFile } from "@ash/shared/git-workbench";
import { gitChangeCount, emptyCommitGuidance } from "@ash/shared/git-workbench";
import type { Workbench } from "./useWorkbench.ts";
import type { AskAction } from "./ActionDialog.tsx";
import { workbenchApi } from "./api.ts";
import { DiffView } from "./DiffView.tsx";

type Source = "staged" | "unstaged" | "untracked";
const labels: Record<Source, string> = {
  staged: "已暂存",
  unstaged: "未暂存",
  untracked: "未跟踪",
};
const pathsOf = (files: GitFile[]) => [
  ...new Set(
    files.flatMap((file) =>
      file.kind === "renamed" && file.origPath
        ? [file.path, file.origPath]
        : [file.path],
    ),
  ),
];
export function Changes({
  projectId,
  workbench: w,
  ask,
}: {
  projectId: string;
  workbench: Workbench;
  ask: AskAction;
}) {
  const data = w.data!;
  const [selection, setSelection] = useState<{
    path: string;
    source: Source;
  } | null>(null);
  const [diff, setDiff] = useState<GitDiff | null>(null);
  const [diffError, setDiffError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState("");
  const [amend, setAmend] = useState(false);
  const clean = gitChangeCount(data.status) === 0 && !data.status.truncated;
  const summary = data.status.merge.length
    ? `${data.status.merge.length} 个冲突待解决 · 请在上方冲突面板处理`
    : emptyCommitGuidance(data.status)
      ? `当前${data.status.operation === "revert" ? "反做" : "拣选"}没有可提交的改动 · 请在上方跳过或中止`
      : data.status.operation
        ? "Git 操作尚未完成 · 请在上方继续或中止"
        : clean
          ? "所有改动已提交"
          : "选择要提交的内容";
  useEffect(() => {
    let alive = true;
    setDiff(null);
    setDiffError(null);
    if (
      !selection ||
      !data.status[selection.source].some(
        (file) => file.path === selection.path,
      )
    ) {
      setSelection(null);
      return;
    }
    setLoading(true);
    workbenchApi
      .diff(projectId, data.root, selection)
      .then((value) => {
        if (alive) setDiff(value);
      })
      .catch((error: Error) => {
        if (alive) setDiffError(error.message);
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [projectId, data.root, data.version, selection]);
  const discard = (files: GitFile[], source: Source) =>
    ask({
      title: source === "untracked" ? "删除未跟踪文件" : "丢弃未暂存改动",
      danger: true,
      typed: "丢弃",
      message: `将处理 ${files.length} 个文件：${files
        .map((file) => file.path)
        .slice(0, 8)
        .join(
          "、",
        )}。${source === "untracked" ? "文件将从磁盘删除。" : "工作区内容将恢复到暂存区版本。"}这些未提交内容不在 Git 历史里，不能通过撤销找回。`,
      action: () => ({
        kind: "discard",
        paths: source === "unstaged" ? pathsOf(files) : [],
        deleteUntracked: source === "untracked" ? pathsOf(files) : [],
      }),
    });
  const commit = () => {
    if (!message.trim() || w.blocked) return;
    if (amend)
      ask({
        title: "修订最近一次提交",
        danger: true,
        message: `将改写 ${data.status.branch.oid?.slice(0, 8)}，包括暂存区内容与提交信息。原提交会保存为备份。已发布的提交改写后通常需要保护强推。`,
        action: () => ({ kind: "commit", message, amend: true }),
      });
    else
      void w.run({ kind: "commit", message, amend: false }).then((ok) => {
        if (ok) setMessage("");
      });
  };
  return (
    <div className="gwb-split">
      <section className="gwb-file-pane" aria-label="工作区变更">
        <div className="gwb-pane-title">
          <strong>工作区</strong>
          <span>{summary}</span>
        </div>
        <div className="gwb-file-groups">
          {(["staged", "unstaged", "untracked"] as const).map((source) => {
            const files = data.status[source];
            const actionable = files.filter((file) => !file.nested);
            return (
              <section key={source} className="gwb-file-group">
                <header>
                  <span>
                    {labels[source]} <b>{files.length}</b>
                  </span>
                  <div className="gwb-inline-actions">
                    {!!actionable.length && (
                      <button
                        disabled={w.isBlocked(
                          source === "staged" ? "unstage" : "stage",
                        )}
                        onClick={() =>
                          void w.run({
                            kind: source === "staged" ? "unstage" : "stage",
                            paths: pathsOf(actionable),
                          })
                        }
                      >
                        {source === "staged" ? "全部取消" : "全部暂存"}
                      </button>
                    )}
                    {!!actionable.length && source !== "staged" && (
                      <button
                        aria-label={`丢弃全部${labels[source]}`}
                        disabled={w.blocked}
                        onClick={() => discard(actionable, source)}
                      >
                        <Trash size={13} />
                      </button>
                    )}
                  </div>
                </header>
                {files.map((file) => (
                  <div
                    key={file.path}
                    className={`gwb-file-row${selection?.path === file.path && selection.source === source ? " is-active" : ""}`}
                  >
                    <button
                      className="gwb-file-select"
                      disabled={file.nested}
                      onClick={() => setSelection({ path: file.path, source })}
                    >
                      <File size={15} />
                      <span>
                        {file.path}
                        <small>
                          {file.origPath
                            ? `← ${file.origPath}`
                            : file.nested
                              ? "嵌套仓库"
                              : file.kind}
                        </small>
                      </span>
                    </button>
                    {!file.nested && (
                      <div className="gwb-inline-actions">
                        <button
                          disabled={w.isBlocked(
                            source === "staged" ? "unstage" : "stage",
                          )}
                          aria-label={`${source === "staged" ? "取消暂存" : "暂存"} ${file.path}`}
                          onClick={() =>
                            void w.run({
                              kind: source === "staged" ? "unstage" : "stage",
                              paths: pathsOf([file]),
                            })
                          }
                        >
                          {source === "staged" ? (
                            <Minus size={13} />
                          ) : (
                            <Plus size={13} />
                          )}
                        </button>
                        {source !== "staged" && (
                          <button
                            disabled={w.blocked}
                            aria-label={`丢弃 ${file.path}`}
                            onClick={() => discard([file], source)}
                          >
                            <Trash size={13} />
                          </button>
                        )}
                      </div>
                    )}
                  </div>
                ))}
                {!files.length && (
                  <p className="gwb-muted-empty">没有{labels[source]}的文件</p>
                )}
              </section>
            );
          })}
        </div>
        <section className="gwb-commit-form">
          <label htmlFor="gwb-message">提交信息</label>
          <textarea
            id="gwb-message"
            value={message}
            onChange={(event) => setMessage(event.target.value)}
            placeholder="说明这次改动的目的…"
            rows={3}
          />
          <label className="gwb-check">
            <input
              type="checkbox"
              checked={amend}
              onChange={(event) => setAmend(event.target.checked)}
              disabled={!data.status.branch.oid || w.blocked}
            />
            修订最近一次提交（amend）
          </label>
          <button
            className="gwb-primary"
            disabled={
              w.blocked ||
              !message.trim() ||
              (!amend && !data.status.staged.length) ||
              !!data.status.operation ||
              !!data.status.merge.length
            }
            onClick={commit}
          >
            <GitCommit size={15} />
            {amend ? "修订提交" : `提交已暂存 · ${data.status.staged.length}`}
          </button>
        </section>
      </section>
      <section className="gwb-detail-pane">
        <div className="gwb-pane-title">
          <strong>{selection?.path || "差异预览"}</strong>
          {selection && <span>{labels[selection.source]}</span>}
        </div>
        <DiffView
          key={`${selection?.path}:${selection?.source}:${diff?.diff}`}
          value={diff}
          loading={loading}
          error={diffError}
          disabled={w.blocked}
          select={
            selection && selection.source !== "untracked" && diff
              ? {
                  label:
                    selection.source === "staged"
                      ? "取消所选暂存"
                      : "暂存所选改动",
                  onApply: (lines) =>
                    void w.run({
                      kind: "patch",
                      path: selection.path,
                      source: selection.source as "staged" | "unstaged",
                      diff: diff.diff,
                      lines,
                    }),
                }
              : undefined
          }
        />
      </section>
    </div>
  );
}
