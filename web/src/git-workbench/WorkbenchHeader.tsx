import {
  ArrowClockwise,
  ArrowDown,
  ArrowLeft,
  ArrowUp,
  CaretRight,
  GitBranch,
  Lock,
  Plus,
  Sparkle,
} from "@phosphor-icons/react";
import type { GitView } from "@ash/shared/git-workbench";
import type { Workbench } from "./useWorkbench.ts";
import type { AskAction } from "./ActionDialog.tsx";
import { WorkbenchMenu } from "./WorkbenchMenu.tsx";
import { openGitWorkbench } from "./navigation.ts";

export function WorkbenchHeader({
  projectId,
  projectName,
  view,
  workbench: w,
  ask,
  push,
  assist,
  onExit,
}: {
  projectId: string;
  projectName: string;
  view: GitView;
  workbench: Workbench;
  ask: AskAction;
  push: (force?: boolean) => void;
  assist?: () => void;
  onExit: () => void;
}) {
  const data = w.data;
  const branch = data?.status.branch;
  const managed = data?.worktrees.some(
    (tree) => tree.path === data.root && tree.managed,
  );
  return (
    <header className="gwb-header topbar">
      <div className="top-left">
        <button className="logo" aria-label="退出 Git 工作台" onClick={onExit}>
          <GitBranch size={16} />
        </button>
        <WorkbenchMenu
          className="repo-name"
          label="选择工作树"
          disabled={w.busy || !data}
          items={(data?.worktrees || []).map((tree) => ({
            label: `${tree.branch || "游离 HEAD"} · ${tree.path === data?.repo ? "项目主仓" : tree.taskTitle || "手动工作树"}`,
            onClick: () =>
              openGitWorkbench({ projectId, root: tree.path, view }),
          }))}
        >
          <b>{projectName}</b>
          <i>{data?.root || "正在读取工作目录…"}</i>
        </WorkbenchMenu>
        <WorkbenchMenu
          className="branch-pill"
          label="当前分支"
          disabled={!data}
          items={[
            ...(data?.refs
              .filter((ref) => ref.kind === "branch")
              .map((ref) => ({
                label: ref.name,
                icon: <GitBranch size={14} />,
                disabled:
                  w.blocked ||
                  ref.name === branch?.head ||
                  !!data.worktrees.find((tree) => tree.branch === ref.name),
                onClick: () =>
                  ask({
                    title: `切换到 ${ref.name}`,
                    message: "切换前要求工作区干净；未提交的改动可先贮藏。",
                    action: () => ({ kind: "checkout", name: ref.name }),
                  }),
              })) || []),
            {
              label: "新建分支…",
              separator: true,
              icon: <Plus size={14} />,
              disabled: w.blocked,
              onClick: () =>
                ask({
                  title: "新建分支",
                  message: "从当前提交创建本地分支。",
                  fields: [{ key: "name", label: "分支名", required: true }],
                  action: (v) => ({
                    kind: "branch-create",
                    name: v.name,
                    target: branch?.oid || "HEAD",
                    checkout: false,
                  }),
                }),
            },
          ]}
        >
          <GitBranch size={14} />
          <b>
            {branch?.head ||
              (branch?.oid ? `游离 @ ${branch.oid.slice(0, 8)}` : "尚无提交")}
          </b>
          <CaretRight size={12} />
        </WorkbenchMenu>
      </div>
      <span className="flex-1" />
      <div className="gwb-sync sync-group">
        <button
          className="top-btn"
          aria-label="获取"
          disabled={w.blocked || !data?.remotes.length}
          onClick={() => void w.run({ kind: "fetch", remote: "" })}
        >
          <ArrowClockwise size={14} />
          <span>拉取引用</span>
        </button>
        <WorkbenchMenu
          className="top-btn"
          label="拉取"
          disabled={w.blocked || !branch?.upstream}
          items={[
            {
              label: "仅快进 · 分叉时停止",
              onClick: () => void w.run({ kind: "pull", strategy: "ff-only" }),
            },
            {
              label: "拉取并合并",
              onClick: () => void w.run({ kind: "pull", strategy: "merge" }),
            },
            ...(!managed
              ? [
                  {
                    label: "拉取并变基",
                    onClick: () =>
                      void w.run({ kind: "pull", strategy: "rebase" as const }),
                  },
                ]
              : []),
          ]}
        >
          <ArrowDown size={14} />
          <span>拉取</span>
          {!!branch?.behind && <em className="top-badge">{branch.behind}</em>}
        </WorkbenchMenu>
        <button
          className="top-btn"
          aria-label={branch?.upstream ? "推送" : "发布"}
          disabled={w.blocked || !data?.remotes.length || !branch?.oid}
          onClick={() => push()}
        >
          <ArrowUp size={14} />
          <span>{branch?.upstream ? "推送" : "发布"}</span>
          {!!branch?.ahead && <em className="top-badge">{branch.ahead}</em>}
        </button>
      </div>
      <div className="top-right">
        {(data?.busy || w.busy) && (
          <span className="lock-chip">
            <Lock size={13} />
            仓库正在操作
          </span>
        )}
        {assist && (
          <button className="top-btn" onClick={assist} disabled={w.busy}>
            <Sparkle size={14} />
            <span>AI 协助</span>
          </button>
        )}
        <WorkbenchMenu
          label="工作台选项"
          className="top-btn"
          items={[
            {
              label: "刷新 Git 工作台",
              icon: <ArrowClockwise size={14} />,
              disabled: w.loading || w.busy,
              onClick: () => void w.refresh(),
            },
            {
              label: "保护强推…",
              disabled:
                w.blocked ||
                !branch?.upstream ||
                !data?.refs.some(
                  (ref) =>
                    ref.kind === "remote" && ref.name === branch.upstream,
                ),
              danger: true,
              onClick: () => push(true),
            },
            {
              label: "返回 ash",
              icon: <ArrowLeft size={14} />,
              separator: true,
              onClick: onExit,
            },
          ]}
        />
      </div>
    </header>
  );
}
