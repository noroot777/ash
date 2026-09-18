import { useCallback, useEffect, useRef, useState } from "react";
import type { GitDiff, GitHistoryCommit } from "@ash/shared/git-workbench";
import type { AskAction } from "./ActionDialog.tsx";
import type { Workbench } from "./useWorkbench.ts";
import { workbenchApi } from "./api.ts";
import { DiffView } from "./DiffView.tsx";
import { CommitGraphRow, useCommitGraph } from "./CommitGraph.tsx";
import { WorkbenchMenu } from "./WorkbenchMenu.tsx";
import { RebaseDialog } from "./RebaseDialog.tsx";
import { HistorySplit } from "./HistorySplit.tsx";

export function History({
  projectId,
  workbench: w,
  ask,
  initialRef,
  initialCommit,
}: {
  projectId: string;
  workbench: Workbench;
  ask: AskAction;
  initialRef?: string;
  initialCommit?: string;
}) {
  const data = w.data!;
  const [ref, setRef] = useState(initialRef || "");
  useEffect(() => {
    setRef(initialRef || "");
  }, [initialRef]);
  const [search, setSearch] = useState("");
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
  const historyRequest = useRef(0);
  // 「点开某一条提交」跳进来的落点。两件事要保证：这一条被选中（右边直接是它的 diff），
  // 而且它得在视野里——默认范围是全部分支、一页 100 条，目标很可能排在需要滚动的位置。
  //
  // 找不到的兜底只做一次：把范围收成这条提交本身（`git log <sha>` 保证它是第一行），
  // 否则仓库里分支一多，任务分支上的提交会被别的分支挤出第一页，点了等于没反应。
  //
  // 这个意图**只兑现一次**（兑现完 `pending` 置空）。它是「跳进来时打开哪一条」，不是一条
  // 常驻规则：之后用户自己在列表里点别的提交、换范围、或者后台刷新重取，都不该被它拽回来。
  const pending = useRef<string | null>(initialCommit || null);
  const fellBack = useRef(false);
  const scrolledTo = useRef<string | null>(null);
  useEffect(() => {
    pending.current = initialCommit || null;
    fellBack.current = false;
    scrolledTo.current = null;
  }, [initialCommit]);
  const pinnedRow = useCallback(
    (node: HTMLDivElement | null) => {
      if (!node || !initialCommit || scrolledTo.current === initialCommit) return;
      scrolledTo.current = initialCommit;
      node.scrollIntoView({ block: "center" });
    },
    [initialCommit],
  );
  const refsVersion = data.refs.map((r) => r.sha + r.name).join(":");
  const refClass = (name: string) => {
    if (name.startsWith("HEAD")) return " is-head";
    if (name.startsWith("tag:")) return " is-tag";
    if (data.refs.some((ref) => ref.kind === "remote" && ref.name === name))
      return " is-remote";
    if (data.worktrees.some((tree) => tree.managed && tree.branch === name))
      return " is-task";
    return "";
  };
  useEffect(() => {
    let alive = true;
    let handoff = false;
    historyRequest.current++;
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
        if (!alive) return;
        const want = pending.current;
        const target = want
          ? next.commits.find((commit) => commit.sha === want) || null
          : null;
        if (want && !target && !fellBack.current) {
          fellBack.current = true;
          handoff = true;
          setRef(want);
          return;
        }
        if (want) pending.current = null;
        setCommits(next.commits);
        setSelected(target || next.commits[0] || null);
        setMore(next.more);
      })
      .catch((reason: Error) => {
        if (alive) setError(reason.message);
      })
      .finally(() => {
        if (alive && !handoff) setLoading(false);
      });
    return () => {
      alive = false;
      historyRequest.current++;
    };
  }, [
    projectId,
    data.root,
    data.status.branch.oid,
    refsVersion,
    w.revision,
    ref,
    path,
    initialCommit,
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
  const action = (kind: string, selectedCommit = selected) => {
    const selected = selectedCommit;
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
  const menuItems = (commit: GitHistoryCommit) =>
    [
      ["cherry-pick", "拣选（cherry-pick）"],
      ["revert", "反做（revert）"],
      ["branch", "从这里建分支"],
      ["tag", "打标签"],
      ["reset", "重置到这里…"],
      ["rebase-plan", "编辑此提交之后的历史…"],
    ].map(([kind, label]) => ({
      label,
      disabled: w.blocked,
      danger: kind === "reset",
      onClick: () => action(kind, commit),
    }));
  return (
    <>
      <HistorySplit>
        <section
          className="gwb-history-list history-list"
          aria-label="提交历史"
        >
          <div className="history-bar">
            <div>
              <input
                className="ui-input history-search"
                aria-label="搜索提交"
                placeholder="搜索提交 / 作者 / SHA…"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
              />
              <select
                className="ui-input"
                aria-label="历史范围"
                value={ref}
                onChange={(event) => setRef(event.target.value)}
              >
                <option value="">全部分支</option>
                <option value="HEAD">当前分支</option>
                {/* 定位到某条提交时范围会被收成那条 sha（见上面的兜底）。它不在分支列表里，
                    不补一项的话这颗下拉会显示成空的——用户看不出当前在按什么范围筛。 */}
                {/^[0-9a-f]{7,40}$/.test(ref) && (
                  <option value={ref}>提交 {ref.slice(0, 8)} 及更早</option>
                )}
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
            </div>
            <details>
              <summary>文件历史与逐行归属</summary>
              <form
                onSubmit={(event) => {
                  event.preventDefault();
                  setPath(pathDraft);
                  setBlame(false);
                }}
              >
                <input
                  className="ui-input"
                  aria-label="文件历史路径"
                  placeholder="按文件路径查看历史…"
                  value={pathDraft}
                  onChange={(event) => setPathDraft(event.target.value)}
                />
                <button className="mini-btn">查看文件历史</button>
                {path && (
                  <button
                    className="mini-btn"
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
            </details>
          </div>
          <div className="history-rows">
            {error && (
              <p className="gwb-error" role="alert">
                {error}
              </p>
            )}
            {loading && <div className="gwb-empty">正在读取提交图…</div>}
            {commits.map((commit, index) => {
              if (
                search &&
                !`${commit.subject} ${commit.author} ${commit.sha} ${commit.refs}`
                  .toLocaleLowerCase()
                  .includes(search.toLocaleLowerCase())
              )
                return null;
              return (
                <div
                  key={commit.sha}
                  ref={commit.sha === initialCommit ? pinnedRow : undefined}
                  className={`gwb-commit-row commit-row ui-selectable${selected?.sha === commit.sha ? " is-active is-selected" : ""}`}
                >
                  <button
                    className="gwb-commit-select"
                    onClick={() => setSelected(commit)}
                    aria-label={`${commit.subject} ${commit.sha.slice(0, 8)}`}
                  >
                    <CommitGraphRow
                      row={graph.rows[index]}
                      width={graph.width}
                    />
                    <code className="commit-sha">{commit.sha.slice(0, 7)}</code>
                    <span className="commit-main">
                      <span className="commit-refs">
                        {commit.refs
                          .split(", ")
                          .filter(Boolean)
                          .map((name) => (
                            <em
                              key={name}
                              className={`ref-chip${refClass(name)}`}
                            >
                              {name
                                .replace(/^HEAD -> /, "")
                                .replace(/^tag: /, "")}
                            </em>
                          ))}
                      </span>
                      <span className="commit-msg">{commit.subject}</span>
                    </span>
                    <span className="commit-author">{commit.author}</span>
                    <time className="commit-time">
                      {new Date(commit.at).toLocaleDateString(undefined, {
                        month: "short",
                        day: "numeric",
                      })}
                    </time>
                  </button>
                  <WorkbenchMenu
                    className="icon-btn row-menu"
                    label={`${commit.sha.slice(0, 8)} 提交操作`}
                    disabled={w.blocked}
                    items={menuItems(commit)}
                  />
                </div>
              );
            })}
            {!commits.length && !loading && !error && (
              <div className="gwb-empty">没有符合条件的提交</div>
            )}
            {more && (
              <button
                className="gwb-load-more"
                disabled={loading}
                onClick={() => {
                  const request = historyRequest.current;
                  setLoading(true);
                  void workbenchApi
                    .history(projectId, data.root, {
                      ref: ref || undefined,
                      path: path || undefined,
                      skip: commits.length,
                    })
                    .then((next) => {
                      if (request !== historyRequest.current) return;
                      setCommits((old) => [...old, ...next.commits]);
                      setMore(next.more);
                    })
                    .catch((reason: Error) => {
                      if (request === historyRequest.current)
                        setError(reason.message);
                    })
                    .finally(() => {
                      if (request === historyRequest.current) setLoading(false);
                    });
                }}
              >
                加载更早提交
              </button>
            )}
          </div>
        </section>
        <section className="gwb-detail-pane detail-pane">
          <header className="gwb-pane-title detail-head">
            {selected ? (
              <>
                <code className="sha-chip">{selected.sha.slice(0, 12)}</code>
                <strong className="detail-msg">{selected.subject}</strong>
                <div className="detail-meta">
                  <span>{selected.author}</span>
                  <time>{new Date(selected.at).toLocaleString()}</time>
                  <span>{selected.parents.length} 个父提交</span>
                </div>
                <div className="detail-menu">
                  <WorkbenchMenu label="提交操作" disabled={w.blocked} items={menuItems(selected)} />
                </div>
              </>
            ) : (
              <strong>提交详情</strong>
            )}
            {selected && path && (
              <button
                className="mini-btn"
                onClick={() => setBlame((value) => !value)}
              >
                {blame ? "查看差异" : "逐行归属（blame）"}
              </button>
            )}
          </header>
          <DiffView
            key={`${selected?.sha}:${blame}`}
            value={detail}
            loading={detailLoading}
            error={detailError}
          />
        </section>
      </HistorySplit>
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
