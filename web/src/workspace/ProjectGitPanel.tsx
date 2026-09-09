import { useMemo, useState } from "react";
import { ArrowsClockwise, GitBranch, MagnifyingGlass, Terminal, Warning } from "@phosphor-icons/react";
import { api } from "../lib/api.ts";
import type { ProjectGitHandle } from "./useProjectGit.ts";
import { ProjectGitActions } from "./ProjectGitActions.tsx";
import { ProjectGitBranchList } from "./ProjectGitBranchList.tsx";
import { branchLabel, dirtyText, gitOpLabel } from "./projectGitModel.ts";

// 项目**主仓**的 git 浮层：切分支 / 更新 / 拉取 / 推送。挂在侧栏项目名右边的分支下拉上。
//
// 为什么不做进任务的「改动」面板：那个面板的尺度是**一个任务的工作目录**，回退到主仓时
// 它整个转成只读（`ScmInspector.tsx`）。把主仓的写操作塞进去，等于让同一块界面在两种
// 尺度之间来回跳——用户分不清此刻改的是自己的 worktree 还是所有任务共用的那份仓库。
//
// 按钮和分支行拆在 `ProjectGitActions` / `ProjectGitBranchList`；判据在 `projectGitModel.ts`，
// 跟服务端那道硬门禁是同一套措辞。命令面板 `/git` 只读，不在那儿开第二个操作面。
//
// 数据层（`git`）由 `ProjectGitContext` 持有并传进来：写操作不能随这块浮层一起卸载，否则
// 手一滑点到别处，跑着的 fetch / pull 就从界面上消失了。这里只是它的一块显示面。

export function ProjectGitPanel({
  git,
  canManage,
  onOpenTerminal,
}: {
  git: ProjectGitHandle;
  /** 项目管理员 / 实例管理员才动得了主仓，理由见 `projectGitModel.ts` 的 `roleBlocker`。 */
  canManage: boolean;
  onOpenTerminal: (() => void) | null;
}) {
  const { state } = git;
  const [search, setSearch] = useState("");

  const rows = useMemo(() => {
    const query = search.trim().toLocaleLowerCase();
    const all = state?.branches ?? [];
    return query ? all.filter((row) => row.name.toLocaleLowerCase().includes(query)) : all;
  }, [search, state]);

  const dirty = dirtyText(state);
  const { projectId } = git;

  return (
    <div className="project-git-panel" role="dialog" aria-label="项目 Git">
      <header className="project-git-panel__head">
        <span className="project-git-panel__branch">
          <GitBranch size={13} aria-hidden="true" />
          <b>{git.loading && !state ? "读取中…" : branchLabel(state)}</b>
          {state?.branch.upstream && (
            <small>
              {state.branch.upstream}
              {(state.branch.ahead ?? 0) > 0 && <i>↑{state.branch.ahead}</i>}
              {(state.branch.behind ?? 0) > 0 && <i>↓{state.branch.behind}</i>}
            </small>
          )}
        </span>
        <ProjectGitActions git={git} canManage={canManage} />
      </header>

      {/* 跑着的时候点外面不收浮层（`ProjectGitContext` 的 `closeOnOutside`）。这一行是那条
          规则的说明书——不然用户只会觉得「点了没反应」。 */}
      {git.busy && (
        <p className="project-git-panel__running" role="status">
          <ArrowsClockwise size={12} className="is-spinning" aria-hidden="true" />
          正在{gitOpLabel(git.busy)}…这期间点别处不会收起；按 Esc 可以先收着，操作照常跑完。
        </p>
      )}
      {state?.operation && (
        <p className="project-git-panel__warn">
          <Warning size={12} weight="fill" aria-hidden="true" />
          仓库停在 {state.operation} 中途，先到终端把它收尾或 abort。
        </p>
      )}
      {dirty && (
        <p className="project-git-panel__dirty">
          <span>主仓有改动：{dirty}</span>
          {onOpenTerminal && (
            <button type="button" onClick={onOpenTerminal}>
              <Terminal size={11} aria-hidden="true" />
              去终端看
            </button>
          )}
        </p>
      )}
      {git.error && <p className="project-git-panel__error">{git.error}</p>}
      {git.message && !git.error && <p className="project-git-panel__ok">{git.message}</p>}

      <label className="project-git-panel__search">
        <MagnifyingGlass size={12} aria-hidden="true" />
        <input
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder="搜索分支…"
          aria-label="搜索分支"
          autoFocus
        />
      </label>

      <ProjectGitBranchList
        rows={rows}
        state={state}
        busy={git.busy === "checkout"}
        loading={git.loading}
        canManage={canManage}
        onCheckout={(branch) => {
          if (projectId) void git.run("checkout", () => api.projectGitCheckout(projectId, branch));
        }}
      />

      <p className="project-git-panel__note">
        {canManage
          ? "这里改的是项目主仓，所有任务共用它：切换分支会改变新建任务的默认 base 分支，也会改变没有独立 worktree 的任务看到的内容。已经建好的 worktree 不受影响。"
          : "这里是项目主仓的只读视图。切分支 / 拉取 / 推送会改变所有人新建任务的默认 base，也会改变没有独立 worktree 的任务看到的内容，所以只有项目管理员能动。"}
      </p>
    </div>
  );
}
