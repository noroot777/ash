import { useState } from "react";
import {
  ArrowClockwise,
  ArrowDown,
  ArrowLeft,
  ArrowUp,
  GitBranch,
  GitCommit,
  ClockCounterClockwise,
  Stack,
  Tag,
  TreeStructure,
  Warning,
} from "@phosphor-icons/react";
import type { GitActionRequest, GitView } from "@ash/shared/git-workbench";
import {
  ActionDialog,
  initialActionValues,
  type ActionPrompt,
} from "./ActionDialog.tsx";
import { useWorkbench } from "./useWorkbench.ts";
import { Changes } from "./Changes.tsx";
import { History } from "./History.tsx";
import { Branches } from "./Branches.tsx";
import { References } from "./References.tsx";
import { OperationLog } from "./OperationLog.tsx";
import { ConflictDialog } from "./ConflictDialog.tsx";
import { openGitWorkbench } from "./navigation.ts";
import "../styles/git-workbench.css";

const views = [
  ["changes", "变更", GitCommit],
  ["history", "历史", ClockCounterClockwise],
  ["branches", "分支", GitBranch],
  ["stash", "贮藏", Stack],
  ["tags", "标签", Tag],
  ["worktrees", "工作树", TreeStructure],
  ["log", "操作日志", ClockCounterClockwise],
] as const;
export function GitWorkbench({
  projectId,
  projectName,
  root,
  taskId,
  view = "changes",
  initialRef,
  notify,
  onExit,
  openTask,
  onAssist,
}: {
  projectId: string;
  projectName: string;
  root?: string;
  taskId?: string;
  view?: GitView;
  initialRef?: string;
  notify: (message: string) => void;
  onExit: () => void;
  openTask: (taskId: string) => void;
  onAssist?: (body: string) => void;
}) {
  const w = useWorkbench(projectId, root, taskId, notify);
  const [prompt, setPrompt] = useState<{
    value: ActionPrompt;
    snapshot: Pick<GitActionRequest, "root" | "version">;
  } | null>(null);
  const [conflict, setConflict] = useState<string | null>(null);
  const data = w.data;
  const managed = data?.worktrees.some(
    (tree) => tree.path === data.root && tree.managed,
  );
  const assist =
    onAssist && data
      ? () =>
          onAssist(
            `请帮我分析 Git 工作台当前状态，给出可检查的提交信息、冲突处理建议和操作步骤。\n\n项目：${projectName}\n工作树：${data.root}\n分支：${data.status.branch.head || "游离 HEAD"}\n当前提交：${data.status.branch.oid || "尚无提交"}\n进行中的操作：${data.status.operation || "无"}\n冲突文件：${data.status.merge.map((file) => file.path).join("、") || "无"}\n暂存文件：${
              data.status.staged
                .map((file) => file.path)
                .slice(0, 40)
                .join("、") || "无"
            }\n\n这次先给出分析和建议，由我回到 Git 工作台应用。`,
          )
      : undefined;
  const ask = (value: ActionPrompt) => {
    if (data && !w.isBlocked(value.action(initialActionValues(value)).kind))
      setPrompt({
        value,
        snapshot: { root: data.root, version: data.version },
      });
  };
  const navigate = (next: GitView) =>
    openGitWorkbench({
      projectId,
      root: data?.root || root,
      taskId,
      view: next,
    });
  const pull = () =>
    ask({
      title: "拉取上游更新",
      message: `获取 ${data?.status.branch.upstream || "上游分支"} 的新提交并整合进当前分支。若遇冲突，状态会保留在工作台中，供你解决或中止。`,
      fields: [
        {
          key: "strategy",
          label: "整合方式",
          type: "select",
          initial: "ff-only",
          options: [
            { value: "ff-only", label: "仅快进 · 分叉时停止" },
            { value: "merge", label: "合并 · 保留两侧历史" },
            ...(!managed
              ? [{ value: "rebase", label: "变基 · 重放本地提交" }]
              : []),
          ],
        },
      ],
      action: (v) => ({
        kind: "pull",
        strategy: v.strategy as "ff-only" | "merge" | "rebase",
      }),
    });
  const push = (force = false) => {
    if (!data) return;
    const upstream = data.refs.find(
      (ref) =>
        ref.kind === "remote" && ref.name === data.status.branch.upstream,
    );
    ask({
      title: force
        ? "保护强推"
        : data.status.branch.upstream
          ? "推送当前分支"
          : "发布当前分支",
      danger: force,
      typed: force ? data.status.branch.head || "HEAD" : undefined,
      message: force
        ? `将本地历史推送到 ${data.status.branch.upstream}，前提是远端仍停在你看到的 ${upstream?.sha.slice(0, 8)}。远端新增提交时 Git 会拒绝覆盖。`
        : `推送 ${data.status.branch.head || "HEAD"} 已提交的历史。未提交文件不会被推送。`,
      fields: data.status.branch.upstream
        ? []
        : [
            {
              key: "remote",
              label: "发布到远端",
              type: "select",
              initial: data.remotes[0],
              required: true,
              options: data.remotes.map((remote) => ({
                value: remote,
                label: remote,
              })),
            },
          ],
      action: (v) => ({
        kind: "push",
        remote: v.remote || "",
        ...(force && upstream ? { lease: upstream.sha } : {}),
      }),
    });
  };
  const count = (id: GitView) =>
    !data
      ? undefined
      : id === "changes"
        ? data.status.staged.length +
          data.status.unstaged.length +
          data.status.untracked.length +
          data.status.merge.length
        : id === "branches"
          ? data.refs.filter((r) => r.kind === "branch").length
          : id === "stash"
            ? data.stashes.length
            : id === "tags"
              ? data.refs.filter((r) => r.kind === "tag").length
              : id === "worktrees"
                ? data.worktrees.length
                : undefined;
  const latest = data?.journal[0];
  return (
    <section className="gwb" aria-label="Git 工作台">
      <header className="gwb-header">
        <div className="gwb-heading">
          <button
            aria-label="退出 Git 工作台"
            className="gwb-back"
            onClick={onExit}
          >
            <ArrowLeft size={17} />
          </button>
          <GitBranch size={23} className="gwb-accent" />
          <div>
            <h1>
              Git 工作台 <span>{projectName}</span>
            </h1>
            <p>{data?.root || "正在定位工作目录…"}</p>
          </div>
        </div>
        <div className="gwb-sync">
          {assist && (
            <button onClick={assist} disabled={w.busy}>
              AI 协助…
            </button>
          )}
          <button
            disabled={w.blocked || !data?.remotes.length}
            onClick={() => void w.run({ kind: "fetch", remote: "" })}
          >
            <ArrowClockwise size={14} />
            获取
          </button>
          <button
            disabled={w.blocked || !data?.status.branch.upstream}
            onClick={pull}
          >
            <ArrowDown size={14} />
            拉取
          </button>
          <button
            disabled={
              w.blocked || !data?.remotes.length || !data?.status.branch.oid
            }
            onClick={() => push()}
          >
            <ArrowUp size={14} />
            {data?.status.branch.upstream ? "推送" : "发布"}
          </button>
          <button
            className="gwb-icon-button"
            aria-label="刷新 Git 工作台"
            onClick={() => void w.refresh()}
            disabled={w.loading || w.busy}
          >
            <ArrowClockwise
              size={15}
              className={w.loading ? "is-spinning" : undefined}
            />
          </button>
        </div>
      </header>
      {data && (
        <div className="gwb-context">
          <label>
            <GitBranch size={14} />
            <select
              aria-label="选择工作树"
              value={data.root}
              disabled={w.busy}
              onChange={(event) =>
                openGitWorkbench({ projectId, root: event.target.value, view })
              }
            >
              {data.worktrees.map((tree) => (
                <option key={tree.path} value={tree.path}>
                  {tree.branch || "游离 HEAD"} ·{" "}
                  {tree.taskTitle ||
                    (tree.path === data.repo ? "项目主仓" : "手动工作树")}
                </option>
              ))}
            </select>
          </label>
          <code>{data.status.branch.oid?.slice(0, 8) || "尚无提交"}</code>
          <span>{data.status.branch.upstream || "未设置上游"}</span>
          {data.status.branch.ahead !== null && (
            <span>
              ↑ {data.status.branch.ahead} ↓ {data.status.branch.behind}
            </span>
          )}
          {data.status.branch.upstream && (
            <button
              disabled={
                w.blocked ||
                !data.refs.some(
                  (r) =>
                    r.kind === "remote" &&
                    r.name === data.status.branch.upstream,
                )
              }
              onClick={() => push(true)}
            >
              保护强推…
            </button>
          )}
        </div>
      )}
      <nav className="gwb-tabs" aria-label="Git 工作台视图">
        {views.map(([id, label, Icon]) => (
          <button
            key={id}
            aria-current={view === id ? "page" : undefined}
            className={view === id ? "is-active" : ""}
            onClick={() => navigate(id)}
          >
            <Icon size={15} />
            {label}
            {count(id) !== undefined && <small>{count(id)}</small>}
          </button>
        ))}
      </nav>
      {w.error && (
        <p className="gwb-banner is-error" role="alert">
          {w.error}
          <button disabled={w.busy} onClick={() => void w.refresh()}>
            重新读取
          </button>
          {taskId && (
            <button onClick={() => openGitWorkbench({ projectId })}>
              改为查看项目主仓
            </button>
          )}
        </p>
      )}
      {data?.readOnly && <p className="gwb-banner">{data.readOnly}</p>}
      {(w.busy || data?.busy) && (
        <p className="gwb-banner" role="status">
          {latest?.state === "queued"
            ? "正在等待仓库锁；前面的操作结束后自动继续。"
            : "Git 操作正在执行，结果会保存在操作日志中。"}
        </p>
      )}
      {data?.status.truncated && (
        <p className="gwb-banner">变更超过 2,000 条，当前列表未全部显示。</p>
      )}
      {(w.message ||
        (latest &&
          ["failed", "conflict", "interrupted"].includes(latest.state))) && (
        <div className="gwb-result" role="status">
          <span>{w.message || latest?.message}</span>
          <button onClick={() => navigate("log")}>查看日志</button>
        </div>
      )}
      {data && (!!data.status.merge.length || data.status.operation) && (
        <section className="gwb-operation">
          <header>
            <Warning size={17} />
            <strong>
              {data.status.operation
                ? `${data.status.operation} 尚未完成`
                : "还有未解决的冲突"}
            </strong>
            <span>{data.status.merge.length} 个文件待解决</span>
            <div className="gwb-inline-actions">
              <button
                disabled={
                  w.isBlocked("continue") ||
                  !!data.status.merge.length ||
                  !data.status.operation
                }
                onClick={() => void w.run({ kind: "continue" })}
              >
                继续操作
              </button>
              {data.status.operation && data.status.operation !== "merge" && (
                <button
                  disabled={w.isBlocked("skip")}
                  onClick={() =>
                    ask({
                      title: "跳过当前提交",
                      danger: true,
                      message:
                        "跳过这条提交在当前重放序列中的改动，继续下一条。",
                      action: () => ({ kind: "skip" }),
                    })
                  }
                >
                  跳过
                </button>
              )}
              {data.status.operation && (
                <button
                  className="gwb-danger"
                  disabled={w.isBlocked("abort")}
                  onClick={() =>
                    ask({
                      title: "中止 Git 操作",
                      danger: true,
                      message:
                        "回到此操作开始前的 Git 状态。已经手动编辑的冲突解决结果会被撤回。中止记录会保留在操作日志中。",
                      action: () => ({ kind: "abort" }),
                    })
                  }
                >
                  中止操作
                </button>
              )}
            </div>
          </header>
          {data.status.merge.map((file) => (
            <button
              key={file.path}
              className="gwb-conflict-file"
              disabled={w.isBlocked("resolve")}
              onClick={() => setConflict(file.path)}
            >
              <code>{file.path}</code>
              <span>{file.conflict} · 打开解决器 →</span>
            </button>
          ))}
          {!data.status.operation && (
            <p>贮藏等操作的冲突解决后，可到变更视图提交结果。</p>
          )}
        </section>
      )}
      <div className="gwb-body">
        {w.loading && !data ? (
          <div className="gwb-empty">正在读取真实 Git 状态…</div>
        ) : data ? (
          view === "changes" ? (
            <Changes projectId={projectId} workbench={w} ask={ask} />
          ) : view === "history" ? (
            <History
              projectId={projectId}
              workbench={w}
              ask={ask}
              initialRef={initialRef}
            />
          ) : view === "branches" ? (
            <Branches
              projectId={projectId}
              workbench={w}
              ask={ask}
              openTask={openTask}
            />
          ) : view === "log" ? (
            <OperationLog workbench={w} ask={ask} />
          ) : (
            <References
              view={view}
              projectId={projectId}
              workbench={w}
              ask={ask}
              openTask={openTask}
            />
          )
        ) : null}
      </div>
      {prompt && (
        <ActionDialog
          prompt={prompt.value}
          snapshot={prompt.snapshot}
          run={w.run}
          isBlocked={w.isBlocked}
          close={() => setPrompt(null)}
        />
      )}
      {conflict && (
        <ConflictDialog
          projectId={projectId}
          path={conflict}
          workbench={w}
          close={() => setConflict(null)}
        />
      )}
    </section>
  );
}
