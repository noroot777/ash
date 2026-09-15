import { useEffect, useState } from "react";
import type { GitDiff, GitHistoryCommit } from "@ash/shared/git-workbench";
import type { AskAction } from "./ActionDialog.tsx";
import type { Workbench } from "./useWorkbench.ts";
import { workbenchApi } from "./api.ts";
import { DiffView } from "./DiffView.tsx";
import { CommitGraphRow, useCommitGraph } from "./CommitGraph.tsx";
import { RebaseDialog } from "./RebaseDialog.tsx";

export function History({
  projectId,
  workbench: w,
  ask,
  initialRef,
}: {
  projectId: string;
  workbench: Workbench;
  ask: AskAction;
  initialRef?: string;
}) {
  const data = w.data!;
  const [ref, setRef] = useState(initialRef || "");
  useEffect(() => { setRef(initialRef || ""); }, [initialRef]);
  const [path, setPath] = useState("");
  const [pathDraft, setPathDraft] = useState("");
  const [commits, setCommits] = useState<GitHistoryCommit[]>([]);
  const [more, setMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<GitHistoryCommit | null>(null);
  const [detail, setDetail] = useState<GitDiff | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [blame, setBlame] = useState(false);
  const [rebase, setRebase] = useState<GitHistoryCommit | null>(null);
  const refsVersion = data.refs.map((r) => r.sha + r.name).join(":");
  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError(null);
    setCommits([]);
    setSelected(null);
    setDetail(null);
    workbenchApi
      .history(projectId, data.root, {
        ref: ref || undefined,
        path: path || undefined,
      })
      .then((next) => {
        if (alive) {
          setCommits(next.commits);
          setMore(next.more);
        }
      })
      .catch((reason: Error) => {
        if (alive) setError(reason.message);
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [
    projectId,
    data.root,
    data.status.branch.oid,
    refsVersion,
    w.revision,
    ref,
    path,
  ]);
  useEffect(() => {
    let alive = true;
    setDetail(null);
    setDetailError(null);
    if (!selected) return;
    setDetailLoading(true);
    workbenchApi
      .diff(projectId, data.root, {
        sha: selected.sha,
        ...(path ? { path, ...(blame ? { blame: "1" } : {}) } : {}),
      })
      .then((next) => {
        if (alive) setDetail(next);
      })
      .catch((reason: Error) => {
        if (alive) setDetailError(reason.message);
      })
      .finally(() => {
        if (alive) setDetailLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [projectId, data.root, selected, path, blame]);
  const graph = useCommitGraph(commits);
  const action = (kind: string) => {
    if (!selected || w.blocked) return;
    const target = selected.sha;
    if (kind === "rebase-plan") {
      setRebase(selected);
      return;
    }
    if (kind === "branch")
      ask({
        title: "从提交新建分支",
        message: `${target.slice(0, 8)} · ${selected.subject}`,
        fields: [{ key: "name", label: "分支名", required: true }],
        action: (v) => ({
          kind: "branch-create",
          name: v.name,
          target,
          checkout: false,
        }),
      });
    else if (kind === "tag")
      ask({
        title: "为提交打标签",
        message: `${target.slice(0, 8)} · ${selected.subject}`,
        fields: [
          { key: "name", label: "标签名", required: true },
          {
            key: "message",
            label: "附注（留空创建轻量标签）",
            type: "textarea",
          },
        ],
        action: (v) => ({
          kind: "tag-create",
          name: v.name,
          target,
          message: v.message,
        }),
      });
    else if (kind === "reset")
      ask({
        title: "重置当前分支",
        danger: true,
        typed: data.status.branch.head || "HEAD",
        message: `将当前分支移到 ${target.slice(0, 8)}。soft 保留索引和工作区；mixed 取消暂存但保留工作区；hard 同时恢复工作区。操作要求工作区干净，执行前备份原 HEAD。`,
        fields: [
          {
            key: "mode",
            label: "重置方式",
            type: "select",
            initial: "mixed",
            options: [
              { value: "soft", label: "soft · 保留暂存" },
              { value: "mixed", label: "mixed · 保留文件，取消暂存" },
              { value: "hard", label: "hard · 同时重置文件" },
            ],
          },
        ],
        action: (v) => ({
          kind: "reset",
          target,
          mode: v.mode as "soft" | "mixed" | "hard",
        }),
      });
    else if (kind === "cherry-pick" || kind === "revert")
      ask({
        title: kind === "cherry-pick" ? "拣选提交到当前分支" : "反做此提交",
        danger: kind === "revert",
        message: `${target.slice(0, 8)} · ${selected.subject}。${kind === "revert" ? "生成一个反向提交，保留原历史。" : "把这次改动复制为当前分支的新提交。"}若遇冲突，可在工作台解决。`,
        fields:
          selected.parents.length > 1
            ? [
                {
                  key: "mainline",
                  label: "合并提交的主线父提交",
                  type: "select",
                  initial: "1",
                  options: selected.parents.map((sha, i) => ({
                    value: String(i + 1),
                    label: `父提交 ${i + 1} · ${sha.slice(0, 8)}`,
                  })),
                },
              ]
            : [],
        action: (v) => ({
          kind,
          target,
          ...(v.mainline ? { mainline: Number(v.mainline) } : {}),
        }),
      });
  };
  return (
    <>
      <div className="gwb-history-filters">
        <label>
          历史范围
          <select
            aria-label="历史范围"
            value={ref}
            onChange={(event) => setRef(event.target.value)}
          >
            <option value="">全部分支</option>
            <option value="HEAD">当前分支</option>
            {data.refs
              .filter((r) => r.kind !== "tag")
              .map((r) => (
                <option
                  key={`${r.kind}:${r.name}`}
                  value={`refs/${r.kind === "branch" ? "heads" : "remotes"}/${r.name}`}
                >
                  {r.name}
                </option>
              ))}
          </select>
        </label>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            setPath(pathDraft);
            setBlame(false);
          }}
        >
          <input
            aria-label="文件历史路径"
            placeholder="按文件路径查看历史…"
            value={pathDraft}
            onChange={(event) => setPathDraft(event.target.value)}
          />
          <button>查看文件历史</button>
          {path && (
            <button
              type="button"
              onClick={() => {
                setPath("");
                setPathDraft("");
              }}
            >
              清除
            </button>
          )}
        </form>
      </div>
      <div className="gwb-split gwb-history-split">
        <section className="gwb-history-list" aria-label="提交历史">
          {error && (
            <p className="gwb-error" role="alert">
              {error}
            </p>
          )}
          {loading && <div className="gwb-empty">正在读取提交图…</div>}
          {commits.map((commit, index) => (
            <button
              key={commit.sha}
              className={`gwb-commit-row${selected?.sha === commit.sha ? " is-active" : ""}`}
              onClick={() => setSelected(commit)}
            >
              <CommitGraphRow row={graph.rows[index]} width={graph.width} />
              <span className="gwb-commit-copy">
                <strong>{commit.subject}</strong>
                <small>
                  {commit.refs && <em>{commit.refs}</em>}
                  <code>{commit.sha.slice(0, 8)}</code> · {commit.author} ·{" "}
                  {new Date(commit.at).toLocaleDateString()}
                </small>
              </span>
            </button>
          ))}
          {!commits.length && !loading && !error && (
            <div className="gwb-empty">没有符合条件的提交</div>
          )}
          {more && (
            <button
              className="gwb-load-more"
              disabled={loading}
              onClick={() => {
                setLoading(true);
                void workbenchApi
                  .history(projectId, data.root, {
                    ref: ref || undefined,
                    path: path || undefined,
                    skip: commits.length,
                  })
                  .then((next) => {
                    setCommits((old) => [...old, ...next.commits]);
                    setMore(next.more);
                  })
                  .catch((reason: Error) => setError(reason.message))
                  .finally(() => setLoading(false));
              }}
            >
              加载更早提交
            </button>
          )}
        </section>
        <section className="gwb-detail-pane">
          <div className="gwb-pane-title">
            <strong>{selected ? selected.sha.slice(0, 8) : "提交详情"}</strong>
            {selected && (
              <div className="gwb-inline-actions">
                {path && (
                  <button onClick={() => setBlame((value) => !value)}>
                    {blame ? "查看差异" : "逐行归属（blame）"}
                  </button>
                )}
                <select
                  aria-label="提交操作"
                  value=""
                  disabled={w.blocked}
                  onChange={(event) => action(event.target.value)}
                >
                  <option value="">提交操作…</option>
                  <option value="cherry-pick">拣选（cherry-pick）</option>
                  <option value="revert">反做（revert）</option>
                  <option value="branch">从这里建分支</option>
                  <option value="tag">打标签</option>
                  <option value="reset">重置到这里…</option>
                  <option value="rebase-plan">编辑此提交之后的历史…</option>
                </select>
              </div>
            )}
          </div>
          <DiffView
            key={`${selected?.sha}:${blame}`}
            value={detail}
            loading={detailLoading}
            error={detailError}
          />
        </section>
      </div>
      {rebase && (
        <RebaseDialog
          projectId={projectId}
          target={rebase}
          workbench={w}
          close={() => setRebase(null)}
        />
      )}
    </>
  );
}
