import { useState } from "react";
import { Warning } from "@phosphor-icons/react";
import type { ProjectView } from "@ash/shared";
import type { GitActionRequest, GitView } from "@ash/shared/git-workbench";
import { emptyCommitGuidance, gitChangeCount } from "@ash/shared/git-workbench";
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
import { WorkbenchHeader } from "./WorkbenchHeader.tsx";
import { WorkbenchNavIcon } from "./WorkbenchNavIcon.tsx";
import "../styles/git-workbench.css";

const views = [
  ["changes", "变更"],
  ["history", "历史"],
  ["branches", "分支"],
  ["stash", "贮藏"],
  ["tags", "标签"],
  ["worktrees", "工作树"],
  ["log", "操作日志"],
] as const;
export function GitWorkbench({
  projectId,
  projectName,
  projects,
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
  projects?: readonly ProjectView[];
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
  const emptyGuidance = data ? emptyCommitGuidance(data.status) : null;
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
        ? gitChangeCount(data.status)
        : id === "stash"
          ? data.stashes.length
          : id === "worktrees"
            ? data.worktrees.length
            : undefined;
  const latest = data?.journal[0];
  return (
    <section className="gwb gwb-design" aria-label="Git 工作台">
      <WorkbenchHeader
        projectId={projectId}
        projectName={projectName}
        projects={projects}
        view={view}
        workbench={w}
        ask={ask}
        push={push}
        assist={assist}
        onExit={onExit}
      />
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
                ? `${{ merge: "合并", rebase: "变基", "cherry-pick": "拣选", revert: "反做" }[data.status.operation]}尚未完成`
                : "还有未解决的冲突"}
            </strong>
            <span>
              {emptyGuidance
                ? "没有可提交的改动"
                : `${data.status.merge.length} 个文件待解决`}
            </span>
            {!!data.status.merge.length && (
              <button
                className="gwb-conflict-file mini-btn tone-danger"
                disabled={w.isBlocked("resolve")}
                onClick={() => setConflict(data.status.merge[0].path)}
              >
                打开冲突解决器
              </button>
            )}
            <div className="gwb-inline-actions">
              {!emptyGuidance && (
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
              )}
              {data.status.operation && data.status.operation !== "merge" && (
                <button
                  className={
                    emptyGuidance ? "gwb-primary ui-btn primary" : "mini-btn"
                  }
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
                  className="gwb-danger mini-btn tone-danger"
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
              {!data.status.operation && (
                <button
                  className="gwb-danger mini-btn tone-danger"
                  disabled={w.isBlocked("discard-conflicts")}
                  onClick={() =>
                    ask({
                      title: "放弃冲突改动",
                      danger: true,
                      typed: "放弃冲突改动",
                      message:
                        "把索引和冲突文件恢复到当前 HEAD。当前暂存的改动及冲突解决结果会被丢弃；无法安全保留的其他工作区改动会使 Git 拒绝操作。历史备份不包含未提交内容，请先复制需要保留的内容。",
                      action: () => ({ kind: "discard-conflicts" }),
                    })
                  }
                >
                  放弃冲突改动
                </button>
              )}
            </div>
          </header>
          {emptyGuidance && <p>{emptyGuidance}</p>}
          {!data.status.operation && (
            <p>
              解决并暂存所有冲突后，可到变更视图提交结果；也可放弃当前冲突及暂存改动。
            </p>
          )}
        </section>
      )}
      <div className="gwb-shell shell">
        <nav className="gwb-tabs sidenav" aria-label="Git 工作台视图">
          {views.map(([id, label]) => (
            <button
              key={id}
              aria-current={view === id ? "page" : undefined}
              className={`nav-item ui-selectable${view === id ? " is-active is-selected" : ""}`}
              onClick={() => navigate(id)}
            >
              <WorkbenchNavIcon view={id} />
              {label}
              {!!count(id) && <small className="nav-badge">{count(id)}</small>}
            </button>
          ))}
        </nav>
        <main className="gwb-body view">
          {w.loading && !data ? (
            <div className="gwb-empty">正在读取真实 Git 状态…</div>
          ) : data ? (
            view === "changes" ? (
              <Changes
                projectId={projectId}
                workbench={w}
                ask={ask}
                assist={assist}
                resolve={setConflict}
              />
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
        </main>
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
          ask={ask}
          assist={assist}
          workbench={w}
          close={() => setConflict(null)}
        />
      )}
    </section>
  );
}
