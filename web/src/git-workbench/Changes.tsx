import { useEffect, useState } from "react";
import {
  Minus,
  Plus,
  Trash,
  GitCommit,
  Sparkle,
  Stack,
} from "@phosphor-icons/react";
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
  assist,
  resolve,
}: {
  projectId: string;
  workbench: Workbench;
  ask: AskAction;
  assist?: () => void;
  resolve: (path: string) => void;
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
      const source = (["unstaged", "staged", "untracked"] as const).find(
        (key) => data.status[key].some((file) => !file.nested),
      );
      const file = source && data.status[source].find((file) => !file.nested);
      setSelection(source && file ? { source, path: file.path } : null);
      setLoading(false);
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
  const currentFile =
    selection &&
    data.status[selection.source].find((file) => file.path === selection.path);
  const stage = (files: GitFile[], source: Source) =>
    void w.run({
      kind: source === "staged" ? "unstage" : "stage",
      paths: pathsOf(files),
    });
  const stash = () =>
    ask({
      title: "贮藏改动",
      message: "保存当前未提交改动，稍后可以在贮藏页恢复。",
      fields: [
        { key: "message", label: "说明", required: true },
        {
          key: "includeUntracked",
          label: "包含未跟踪文件",
          type: "checkbox",
          initial: "true",
        },
      ],
      action: (values) => ({
        kind: "stash-save",
        message: values.message,
        untracked: values.includeUntracked === "true",
      }),
    });
  return (
    <div className="gwb-split changes-view">
      <section className="gwb-file-pane changes-list" aria-label="工作区变更">
        {!!data.status.merge.length && (
          <section className="change-group group-conflict">
            <header className="group-head">
              <b>合并冲突</b>
              <span className="group-count">{data.status.merge.length}</span>
            </header>
            {data.status.merge.map((file) => (
              <button
                className="file-row ui-selectable"
                key={file.path}
                onClick={() => resolve(file.path)}
              >
                <span className="kind-badge kind-!">!</span>
                <span className="file-name">{file.path}</span>
                <span className="conflict-state">待解决</span>
              </button>
            ))}
          </section>
        )}
        <div className="gwb-file-groups">
          {(["staged", "unstaged", "untracked"] as const).map((source) => {
            const files = data.status[source];
            const actionable = files.filter((file) => !file.nested);
            return (
              <section key={source} className="gwb-file-group change-group">
                <header className="group-head">
                  <b>{labels[source]}</b>
                  <span className="group-count">{files.length}</span>
                  <i className="group-hint">
                    {source === "staged"
                      ? "将进入下一次提交"
                      : source === "unstaged"
                        ? "工作树里的改动"
                        : "新文件"}
                  </i>
                  <div className="group-actions">
                    {!!actionable.length && (
                      <button
                        className="mini-btn"
                        disabled={w.isBlocked(
                          source === "staged" ? "unstage" : "stage",
                        )}
                        onClick={() => stage(actionable, source)}
                      >
                        {source === "staged" ? (
                          <Minus size={12} />
                        ) : (
                          <Plus size={12} />
                        )}
                        {source === "staged" ? "全部取消暂存" : "全部暂存"}
                      </button>
                    )}
                    {source === "unstaged" && !!actionable.length && (
                      <button
                        className="mini-btn"
                        disabled={w.blocked}
                        onClick={stash}
                      >
                        <Stack size={12} />
                        贮藏…
                      </button>
                    )}
                  </div>
                </header>
                {!files.length && (
                  <p className="empty-line">
                    {source === "staged" ? "暂无已暂存文件" : "没有改动"}
                  </p>
                )}
                {files.map((file) => {
                  const kind =
                    source === "untracked"
                      ? "U"
                      : {
                          modified: "M",
                          added: "A",
                          deleted: "D",
                          renamed: "R",
                          copied: "C",
                          untracked: "U",
                        }[file.kind] || "M";
                  const slash = file.path.lastIndexOf("/");
                  const active =
                    selection?.path === file.path &&
                    selection.source === source;
                  return (
                    <div
                      key={file.path}
                      className={`gwb-file-row file-row ui-selectable${active ? " is-active is-selected" : ""}`}
                    >
                      <button
                        className="gwb-file-select"
                        aria-label={file.path}
                        disabled={file.nested}
                        onClick={() =>
                          setSelection({ path: file.path, source })
                        }
                      >
                        <span className={`kind-badge kind-${kind}`}>
                          {kind}
                        </span>
                        <span className="file-name">
                          {file.path.slice(slash + 1)}
                          <i className="file-dir">
                            {file.nested
                              ? "嵌套仓库"
                              : file.path.slice(0, slash + 1)}
                          </i>
                        </span>
                      </button>
                      {(file.additions !== undefined ||
                        file.deletions !== undefined) && (
                        <span className="stat">
                          {!!file.additions && (
                            <i className="stat-add">+{file.additions}</i>
                          )}
                          {!!file.deletions && (
                            <i className="stat-del">−{file.deletions}</i>
                          )}
                        </span>
                      )}
                      {!file.nested && (
                        <div className="file-actions">
                          <button
                            className="icon-btn"
                            disabled={w.isBlocked(
                              source === "staged" ? "unstage" : "stage",
                            )}
                            aria-label={`${source === "staged" ? "取消暂存" : "暂存"} ${file.path}`}
                            onClick={() => stage([file], source)}
                          >
                            {source === "staged" ? (
                              <Minus size={13} />
                            ) : (
                              <Plus size={13} />
                            )}
                          </button>
                          {source !== "staged" && (
                            <button
                              className="icon-btn tone-danger"
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
                  );
                })}
              </section>
            );
          })}
        </div>
        {(clean || data.status.merge.length > 0 || data.status.operation) && (
          <p className="gwb-pane-title gwb-worktree-summary">{summary}</p>
        )}
        <section className="gwb-commit-form commit-box">
          <textarea
            className="commit-input"
            id="gwb-message"
            aria-label="提交信息"
            value={message}
            onChange={(event) => setMessage(event.target.value)}
            placeholder="提交信息（第一行是标题）"
            rows={3}
          />
          <div className="commit-row">
            {assist && (
              <button
                className="mini-btn tone-accent"
                onClick={assist}
                disabled={w.busy}
              >
                <Sparkle size={12} />
                AI 生成
              </button>
            )}
            <label className="gwb-check amend-toggle">
              <input
                type="checkbox"
                checked={amend}
                onChange={(event) => setAmend(event.target.checked)}
                disabled={!data.status.branch.oid || w.blocked}
              />
              修补上一次提交
            </label>
            <button
              className="gwb-primary ui-btn primary"
              disabled={
                w.blocked ||
                !message.trim() ||
                (!amend && !data.status.staged.length) ||
                !!data.status.operation ||
                !!data.status.merge.length
              }
              onClick={commit}
            >
              <GitCommit size={14} />
              {amend
                ? "修订提交"
                : `提交（${data.status.staged.length} 个文件）`}
            </button>
          </div>
        </section>
      </section>
      <section className="gwb-detail-pane diff-pane">
        <div className="gwb-pane-title diff-pane-head">
          <code className="diff-path">{selection?.path || "差异预览"}</code>
          {currentFile && (
            <span className="stat">
              {!!currentFile.additions && (
                <i className="stat-add">+{currentFile.additions}</i>
              )}
              {!!currentFile.deletions && (
                <i className="stat-del">−{currentFile.deletions}</i>
              )}
            </span>
          )}
          <span className="flex-1" />
          {selection && currentFile && (
            <>
              <button
                className="mini-btn"
                disabled={w.isBlocked(
                  selection.source === "staged" ? "unstage" : "stage",
                )}
                onClick={() => stage([currentFile], selection.source)}
              >
                <Plus size={12} />
                {selection.source === "staged" ? "取消暂存" : "暂存"}
              </button>
              {selection.source !== "staged" && (
                <button
                  className="mini-btn tone-danger"
                  disabled={w.blocked}
                  onClick={() => discard([currentFile], selection.source)}
                >
                  <Trash size={12} />
                  丢弃改动
                </button>
              )}
            </>
          )}
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
                  onDiscard:
                    selection.source === "unstaged"
                      ? (lines, scope) =>
                          ask({
                            title: scope === "selection" ? "丢弃所选改动" : "丢弃这个改动块",
                            danger: true,
                            typed: "丢弃",
                            message: `${selection.path}：${scope === "selection" ? `仅还原勾选的 ${lines.length} 行改动` : "还原这个改动块内的全部改动"}，保留其他未暂存改动及暂存区。未提交内容无法从历史备份找回。`,
                            action: () => ({
                              kind: "discard-patch",
                              path: selection.path,
                              diff: diff.diff,
                              lines,
                            }),
                          })
                      : undefined,
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
