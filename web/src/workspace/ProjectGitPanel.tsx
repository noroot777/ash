import { useMemo, useState } from "react";
import { GitBranch, MagnifyingGlass, Terminal, Warning } from "@phosphor-icons/react";
import { api } from "../lib/api.ts";
import { useProjectGit } from "./useProjectGit.ts";
import { ProjectGitActions } from "./ProjectGitActions.tsx";
import { ProjectGitBranchList } from "./ProjectGitBranchList.tsx";
import { branchLabel, dirtyText } from "./projectGitModel.ts";

// 项目**主仓**的 git 浮层：切分支 / 更新 / 拉取 / 推送。挂在侧栏项目名右边的分支下拉上。
//
// 为什么不做进任务的「改动」面板：那个面板的尺度是**一个任务的工作目录**，回退到主仓时
// 它整个转成只读（`ScmInspector.tsx`）。把主仓的写操作塞进去，等于让同一块界面在两种
// 尺度之间来回跳——用户分不清此刻改的是自己的 worktree 还是所有任务共用的那份仓库。
//
// 按钮和分支行拆在 `ProjectGitActions` / `ProjectGitBranchList`；判据在 `projectGitModel.ts`，
// 跟服务端那道硬门禁是同一套措辞。命令面板 `/git` 只读，不在那儿开第二个操作面。

export function ProjectGitPanel({
  projectId,
  onChanged,
  onOpenTerminal,
}: {
  projectId: string;
  onChanged: () => void;
  onOpenTerminal: (() => void) | null;
}) {
  const git = useProjectGit(projectId, true);
  const { state } = git;
  const [search, setSearch] = useState("");

  const rows = useMemo(() => {
    const query = search.trim().toLocaleLowerCase();
    const all = state?.branches ?? [];
    return query ? all.filter((row) => row.name.toLocaleLowerCase().includes(query)) : all;
  }, [search, state]);

  const checkout = async (branch: string) => {
    if (await git.run("checkout", () => api.projectGitCheckout(projectId, branch))) onChanged();
  };

  const dirty = dirtyText(state);

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
        <ProjectGitActions projectId={projectId} git={git} onChanged={onChanged} />
      </header>

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
        onCheckout={(branch) => void checkout(branch)}
      />

      <p className="project-git-panel__note">
        这里改的是项目主仓，所有任务共用它：切换分支会改变新建任务的默认 base 分支，也会改变
        没有独立 worktree 的任务看到的内容。已经建好的 worktree 不受影响。
      </p>
    </div>
  );
}
