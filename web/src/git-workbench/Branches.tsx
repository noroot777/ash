import { useState } from "react";
import { GitBranch, Plus } from "@phosphor-icons/react";
import type { GitRef } from "@ash/shared/git-workbench";
import type { AskAction } from "./ActionDialog.tsx";
import type { Workbench } from "./useWorkbench.ts";
import { openGitWorkbench } from "./navigation.ts";
import { RemoteSettings } from "./RemoteSettings.tsx";

export function Branches({
  projectId,
  workbench: w,
  ask,
  openTask,
}: {
  projectId: string;
  workbench: Workbench;
  ask: AskAction;
  openTask: (taskId: string) => void;
}) {
  const data = w.data!;
  const [search, setSearch] = useState("");
  const current = data.status.branch.head;
  const rows = data.refs.filter(
    (r) =>
      r.kind !== "tag" &&
      r.name.toLocaleLowerCase().includes(search.toLocaleLowerCase()),
  );
  const newBranch = () =>
    ask({
      title: "新建分支",
      message: `从当前 HEAD ${data.status.branch.oid?.slice(0, 8) || "（暂无提交）"} 创建本地分支。`,
      fields: [
        {
          key: "name",
          label: "新分支名",
          placeholder: "feature/…",
          required: true,
        },
        { key: "checkout", label: "创建后切换到此分支", type: "checkbox" },
      ],
      action: (v) => ({
        kind: "branch-create",
        name: v.name,
        target: data.status.branch.oid || "HEAD",
        checkout: v.checkout === "true",
      }),
    });
  const act = (row: GitRef, action: string) => {
    if (w.blocked) return;
    const task = data.worktrees.find(
      (tree) => tree.branch === row.name && tree.taskId,
    );
    if (task?.taskId && action === "merge") {
      openTask(task.taskId);
      return;
    }
    if (action === "remote-delete") {
      const remote = data.remotes.find((name) =>
        row.name.startsWith(`${name}/`),
      );
      if (!remote) return;
      const name = row.name.slice(remote.length + 1);
      ask({
        title: "删除远端分支",
        danger: true,
        typed: row.name,
        message: `从 ${remote} 删除服务器上的分支 ${name}。只有远端仍处于 ${row.sha.slice(0, 8)} 时才会执行，远端新增提交时拒绝删除。此操作影响其他协作者。`,
        action: () => ({
          kind: "remote-delete-ref",
          remote,
          name,
          sha: row.sha,
          refKind: "branch",
        }),
      });
      return;
    }
    if (action === "merge")
      ask({
        title: `合并 ${row.name}`,
        message: `将 ${row.name}（${row.sha.slice(0, 8)}）合入当前分支 ${current || "HEAD"}。若出现冲突，工作台会保留现场供你处理。原 HEAD 会自动备份。`,
        fields: [
          {
            key: "strategy",
            label: "合并方式",
            type: "select",
            initial: "ff",
            options: [
              { value: "ff", label: "优先快进，否则创建合并提交" },
              { value: "no-ff", label: "始终创建合并提交" },
              { value: "squash", label: "压缩为暂存改动，稍后手动提交" },
            ],
          },
        ],
        action: (v) => ({
          kind: "merge",
          target: row.sha,
          strategy: v.strategy as "ff" | "no-ff" | "squash",
        }),
      });
    else if (action === "rebase")
      ask({
        title: `变基到 ${row.name}`,
        danger: true,
        message: `把当前分支 ${current || "HEAD"} 独有的提交重放到 ${row.name}（${row.sha.slice(0, 8)}）之后。这会改写提交哈希，原 HEAD 会自动备份。`,
        action: () => ({ kind: "rebase", target: row.sha }),
      });
    else if (action === "rename")
      ask({
        title: "重命名分支",
        message: `重命名本地分支 ${row.name}。不会重命名远端分支。`,
        fields: [
          { key: "name", label: "新名称", initial: row.name, required: true },
        ],
        action: (v) => ({
          kind: "branch-rename",
          name: row.name,
          next: v.name,
          sha: row.sha,
        }),
      });
    else if (action === "delete" || action === "force-delete")
      ask({
        title: action === "delete" ? "删除已合并分支" : "强制删除分支",
        danger: true,
        typed: action === "force-delete" ? row.name : undefined,
        message: `删除本地分支 ${row.name}。${action === "delete" ? "Git 会拒绝删除尚未合并的分支。" : "尚未合并的提交将失去此分支引用。请先为需要保留的提交打标签或创建备份分支。"}远端分支保持原样。`,
        action: () => ({
          kind: "branch-delete",
          name: row.name,
          sha: row.sha,
          force: action === "force-delete",
        }),
      });
    else if (action === "upstream")
      ask({
        title: "设置上游分支",
        message: `设置 ${row.name} 的跟踪分支，影响后续拉取和推送。`,
        fields: [
          {
            key: "target",
            label: "远端分支",
            type: "select",
            initial: row.upstream,
            options: [
              { value: "", label: "取消上游跟踪" },
              ...data.refs
                .filter((r) => r.kind === "remote" && !r.name.endsWith("/HEAD"))
                .map((r) => ({ value: r.name, label: r.name })),
            ],
          },
        ],
        action: (v) => ({ kind: "upstream", name: row.name, target: v.target }),
      });
    else if (action === "track")
      ask({
        title: "检出远端分支",
        message: `从 ${row.name} 建立本地分支并切换过去，之后可设置上游。`,
        fields: [
          {
            key: "name",
            label: "本地分支名",
            initial: row.name.split("/").slice(1).join("/"),
            required: true,
          },
        ],
        action: (v) => ({
          kind: "branch-create",
          name: v.name,
          target: row.sha,
          checkout: true,
        }),
      });
  };
  return (
    <section className="gwb-page">
      <div className="gwb-section-head">
        <div>
          <h2>分支</h2>
          <p>明确来源与目标，再改变历史。</p>
        </div>
        <button
          className="gwb-primary"
          disabled={w.blocked || !data.status.branch.oid}
          onClick={newBranch}
        >
          <Plus size={14} />
          新建分支
        </button>
      </div>
      <input
        className="gwb-search"
        aria-label="搜索工作台分支"
        placeholder="搜索本地和远端分支…"
        value={search}
        onChange={(event) => setSearch(event.target.value)}
      />
      {(["branch", "remote"] as const).map((kind) => (
        <section className="gwb-ref-section" key={kind}>
          <h3>
            {kind === "branch" ? "本地分支" : "远端跟踪分支"}
            <span>{rows.filter((r) => r.kind === kind).length}</span>
          </h3>
          {rows
            .filter((r) => r.kind === kind)
            .map((row) => {
              const worktree = data.worktrees.find(
                (tree) => tree.branch === row.name,
              );
              const active = kind === "branch" && current === row.name;
              return (
                <div
                  className={`gwb-ref-row${active ? " is-current" : ""}`}
                  key={row.name}
                >
                  <GitBranch size={17} />
                  <div className="gwb-ref-info">
                    <strong>
                      {row.name}
                      {active && <em>当前</em>}
                      {worktree?.taskId && <em>任务分支</em>}
                    </strong>
                    <span>
                      <code>{row.sha.slice(0, 8)}</code> {row.subject}
                    </span>
                    {row.upstream && <small>跟踪 {row.upstream}</small>}
                    {worktree && (
                      <small>{worktree.taskTitle || worktree.path}</small>
                    )}
                  </div>
                  <div className="gwb-row-actions">
                    {kind === "branch" && !active && !worktree && (
                      <button
                        disabled={w.blocked}
                        onClick={() =>
                          ask({
                            title: `切换到 ${row.name}`,
                            message: `当前工作区将切换到 ${row.name}。切换前要求工作区干净，不会自动贮藏改动。`,
                            action: () => ({
                              kind: "checkout",
                              name: row.name,
                            }),
                          })
                        }
                      >
                        切换
                      </button>
                    )}
                    {worktree && !active && (
                      <button
                        onClick={() =>
                          openGitWorkbench({ projectId, root: worktree.path })
                        }
                      >
                        打开工作树
                      </button>
                    )}
                    <button
                      onClick={() =>
                        openGitWorkbench({
                          projectId,
                          root: data.root,
                          view: "history",
                          ref: `refs/${kind === "branch" ? "heads" : "remotes"}/${row.name}`,
                        })
                      }
                    >
                      历史
                    </button>
                    <select
                      aria-label={`${row.name} 分支操作`}
                      value=""
                      disabled={w.blocked}
                      onChange={(event) => act(row, event.target.value)}
                    >
                      <option value="">操作…</option>
                      {!active && (
                        <>
                          <option value="merge">
                            {worktree?.taskId ? "打开任务验收" : "合入当前分支"}
                          </option>
                          <option value="rebase">当前分支变基到这里</option>
                        </>
                      )}
                      {kind === "branch" ? (
                        <>
                          <option value="upstream">设置上游</option>
                          {!worktree?.managed && (
                            <option value="rename">重命名</option>
                          )}
                          {!worktree && (
                            <>
                              <option value="delete">删除已合并分支</option>
                              <option value="force-delete">强制删除…</option>
                            </>
                          )}
                        </>
                      ) : (
                        !row.name.endsWith("/HEAD") && (
                          <>
                            <option value="track">检出为本地分支</option>
                            <option value="remote-delete">删除远端分支…</option>
                          </>
                        )
                      )}
                    </select>
                  </div>
                </div>
              );
            })}
          {!rows.some((r) => r.kind === kind) && (
            <p className="gwb-muted-empty">没有符合条件的分支</p>
          )}
        </section>
      ))}
      <RemoteSettings workbench={w} ask={ask} />
    </section>
  );
}
