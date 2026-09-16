import { Tag, TreeStructure, Plus } from "@phosphor-icons/react";
import type { GitView } from "@ash/shared/git-workbench";
import type { AskAction } from "./ActionDialog.tsx";
import type { Workbench } from "./useWorkbench.ts";
import { openGitWorkbench } from "./navigation.ts";
import { WorkbenchMenu } from "./WorkbenchMenu.tsx";
import { Stashes } from "./Stashes.tsx";

export function References({
  view,
  projectId,
  workbench: w,
  ask,
  openTask,
}: {
  view: GitView;
  projectId: string;
  workbench: Workbench;
  ask: AskAction;
  openTask: (taskId: string) => void;
}) {
  const data = w.data!;
  const title = view === "stash" ? "贮藏" : view === "tags" ? "标签" : "工作树";
  const create = () => {
    if (view === "stash")
      ask({
        title: "贮藏当前改动",
        message:
          "将当前暂存区与工作区的改动保存到共享贮藏栈。该记录标记为当前用户所有，之后可以应用或弹出。",
        fields: [
          {
            key: "message",
            label: "说明",
            placeholder: "例如：切换任务前保存",
          },
          {
            key: "untracked",
            label: "同时包含未跟踪文件",
            type: "checkbox",
            initial: "true",
          },
        ],
        action: (v) => ({
          kind: "stash-save",
          message: v.message,
          untracked: v.untracked === "true",
        }),
      });
    else if (view === "tags")
      ask({
        title: "新建标签",
        message: `为当前 HEAD ${data.status.branch.oid?.slice(0, 8)} 打标签。暂时只创建本地标签，可以随后单独推送。`,
        fields: [
          {
            key: "name",
            label: "标签名",
            required: true,
            placeholder: "v1.0.0",
          },
          { key: "message", label: "附注（留空为轻量标签）", type: "textarea" },
        ],
        action: (v) => ({
          kind: "tag-create",
          name: v.name,
          message: v.message,
          target: data.status.branch.oid || "HEAD",
        }),
      });
    else
      ask({
        title: "新建手动工作树",
        message:
          "从指定基点创建新分支与独立工作目录。ash 自动选择 .worktrees 下的空目录；这份工作树由你管理，不绑定任务。",
        fields: [
          { key: "name", label: "新分支名", required: true },
          {
            key: "target",
            label: "起始分支或提交",
            initial: data.status.branch.oid || "HEAD",
            required: true,
          },
        ],
        action: (v) => ({
          kind: "worktree-add",
          name: v.name,
          target: v.target,
        }),
      });
  };
  return (
    <section className="gwb-page scroll-col">
      <div className="gwb-section-head">
        <div>
          <h2>{title}</h2>
          <p>
            {view === "stash"
              ? "共享贮藏栈；他人的记录可应用，不能弹出或删除。"
              : view === "tags"
                ? "为值得保留的版本命名，按需发布到远端。"
                : "选择正在操作的目录，区分任务工作树与手动工作树。"}
          </p>
        </div>
        <button
          className="gwb-primary ui-btn primary"
          disabled={w.blocked || (view !== "stash" && !data.status.branch.oid)}
          onClick={create}
        >
          <Plus size={14} />
          {view === "stash" ? "贮藏改动" : `新建${title}`}
        </button>
      </div>
      {view === "stash" && (
        <Stashes projectId={projectId} workbench={w} ask={ask} />
      )}
      {view === "tags" && (
        <div className="gwb-ref-section">
          {data.refs
            .filter((r) => r.kind === "tag")
            .map((row) => (
              <div
                className="gwb-ref-row branch-row ui-selectable"
                key={row.name}
              >
                <Tag size={18} />
                <div className="gwb-ref-info gwb-tag-info">
                  <strong>{row.name}</strong>
                  <span>{row.subject}</span>
                  <code>{row.sha.slice(0, 8)}</code>
                </div>
                <div className="gwb-row-actions">
                  <button
                    onClick={() =>
                      openGitWorkbench({
                        projectId,
                        root: data.root,
                        view: "history",
                        ref: `refs/tags/${row.name}`,
                      })
                    }
                  >
                    历史
                  </button>
                  <button
                    disabled={w.blocked || !data.remotes.length}
                    onClick={() =>
                      ask({
                        title: "推送标签",
                        message: `将 ${row.name} 发布到选定远端。只推送这一个标签。`,
                        fields: [
                          {
                            key: "remote",
                            label: "远端",
                            type: "select",
                            initial: data.remotes[0],
                            options: data.remotes.map((name) => ({
                              value: name,
                              label: name,
                            })),
                          },
                        ],
                        action: (v) => ({
                          kind: "tag-push",
                          name: row.name,
                          sha: row.sha,
                          remote: v.remote,
                        }),
                      })
                    }
                  >
                    推送
                  </button>
                  <button
                    className="gwb-danger mini-btn tone-danger"
                    disabled={w.blocked}
                    onClick={() =>
                      ask({
                        title: "删除本地标签",
                        message: `移除本地标签 ${row.name}，原引用会保留备份，不删除提交或远端标签。`,
                        typed: row.name,
                        danger: true,
                        action: () => ({
                          kind: "tag-delete",
                          name: row.name,
                          sha: row.sha,
                        }),
                      })
                    }
                  >
                    删除
                  </button>
                  <WorkbenchMenu
                    label={`删除远端标签 ${row.name}`}
                    disabled={w.blocked || !data.remotes.length}
                    items={data.remotes.map((remote) => ({
                      label: `从 ${remote} 删除远端标签…`,
                      danger: true,
                      onClick: () =>
                        ask({
                          title: "删除远端标签",
                          danger: true,
                          typed: `${remote}/${row.name}`,
                          message: `从 ${remote} 删除服务器上的标签 ${row.name}。仅当远端标签仍指向本地看到的 ${row.sha.slice(0, 8)} 时执行；影响所有协作者。本地标签继续保留。`,
                          action: () => ({
                            kind: "remote-delete-ref",
                            remote,
                            name: row.name,
                            refKind: "tag",
                            sha: row.sha,
                          }),
                        }),
                    }))}
                  />
                </div>
              </div>
            ))}
          {!data.refs.some((r) => r.kind === "tag") && (
            <div className="gwb-empty">还没有标签</div>
          )}
        </div>
      )}
      {view === "worktrees" && (
        <div className="gwb-worktree-grid">
          {data.worktrees.map((row) => (
            <article
              className={`gwb-worktree-card wt-card${row.path === data.repo ? " is-main" : ""}`}
              key={row.path}
            >
              <header className="wt-head">
                <TreeStructure size={18} />
                <strong className="wt-path">{row.path}</strong>
                <em className="task-chip">
                  {row.managed
                    ? "任务"
                    : row.path === data.repo
                      ? "项目主仓"
                      : "手动"}
                </em>
              </header>
              <div className="wt-meta">
                <code className="ref-chip">{row.branch || "游离 HEAD"}</code>
                {row.taskTitle && (
                  <span className="task-chip">{row.taskTitle}</span>
                )}
              </div>
              <div className="gwb-worktree-meta">
                <span>HEAD {row.head?.slice(0, 8) || "暂无提交"}</span>
                {row.locked && <b>已锁定</b>}
                {row.path === data.root && <b>正在浏览</b>}
              </div>
              <footer>
                <button
                  disabled={w.busy || row.path === data.root}
                  onClick={() =>
                    openGitWorkbench({ projectId, root: row.path })
                  }
                >
                  打开工作树
                </button>
                {row.taskId ? (
                  <button onClick={() => openTask(row.taskId!)}>
                    任务验收 / 释放工作区
                  </button>
                ) : (
                  row.path !== data.repo && (
                    <>
                      <button
                        disabled={w.blocked}
                        onClick={() =>
                          void w.run({
                            kind: row.locked
                              ? "worktree-unlock"
                              : "worktree-lock",
                            path: row.path,
                          })
                        }
                      >
                        {row.locked ? "解锁" : "锁定"}
                      </button>
                      <button
                        className="gwb-danger mini-btn tone-danger"
                        disabled={
                          w.blocked ||
                          row.locked ||
                          row.path === data.root ||
                          !row.head
                        }
                        onClick={() =>
                          ask({
                            title: "移除手动工作树",
                            message: `将移除目录 ${row.path}。Git 会拒绝删除含未提交改动或未跟踪文件的工作树；分支与提交继续保留。`,
                            typed: row.path,
                            danger: true,
                            action: () => ({
                              kind: "worktree-remove",
                              path: row.path,
                              sha: row.head!,
                            }),
                          })
                        }
                      >
                        移除
                      </button>
                    </>
                  )
                )}
              </footer>
            </article>
          ))}
        </div>
      )}
    </section>
  );
}
