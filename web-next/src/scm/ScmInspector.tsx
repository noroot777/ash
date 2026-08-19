import { useMemo, useState } from "react";
import {
  ArrowClockwise,
  ArrowsClockwise,
  GitBranch,
  GitCommit,
  Warning,
  WarningCircle,
} from "@phosphor-icons/react";
import type { ScmChange, ScmDiffSource, ScmGroupId } from "../lib/api.ts";
import { ConfirmDialog } from "../task-detail/ConfirmDialog.tsx";
import { ROOT_SOURCE_LABEL } from "../files/fileModel.ts";
import { ScmChangeGroup } from "./ScmChangeGroup.tsx";
import { OPERATION_LABEL, diffSourceOf, pathsOf, useScmWorkspace, type ScmAction } from "./scmModel.ts";

// 任务工作目录的「源代码管理」。
//
// 摆在 inspector 里、点条目在中间栏开 diff——和「文件」页签是同一套动线。它回答的问题
// 跟审查页不同：审查看的是**这条分支相对合入目标**改了什么（已经提交的部分），这里看的
// 是**此刻工作目录里还没落进提交的东西**。仓库约定「改完立即提交」，所以这一栏理想状态
// 下应该是空的；不空就说明 agent 停在了半路，值得看一眼。
//
// 两类确认框，都不能省：
//   ① **丢弃**不可逆（restore 覆盖回去、clean 直接删文件，都不进 reflog 也不进 stash）；
//   ② 任务**正在跑**时的任何写操作——agent 此刻就在这个目录里写文件，这时候提交会把它
//      写到一半的中间态提交进去。后端为此回 409 + needsForce，前端弹框说清后果再带 force。

const DISCARD_HINT = "丢弃不可逆：restore 覆盖回原样、clean 直接删文件，都不进 reflog 也不进 stash。";

interface PendingConfirm {
  action: ScmAction;
  title: string;
  message: string;
  confirmLabel: string;
  danger: boolean;
  force: boolean;
}

/** 任务正在跑时的二次确认。把「谁在写、写坏了会怎样」说完整，而不是一句「确定吗」。 */
function forceConfirm(action: ScmAction, reason: string): PendingConfirm {
  const verb = action.kind === "commit" ? "提交" : action.kind === "discard" ? "丢弃" : "改动暂存区";
  return {
    action,
    title: "任务正在运行",
    message: `${reason}\n\n继续会在 agent 干活的同时${verb}：提交可能收进它写到一半的文件，丢弃可能抹掉它刚写出来、还没提交的成果。`,
    confirmLabel: `仍然${verb}`,
    danger: true,
    force: true,
  };
}

function BranchBar({
  branch,
  rootPath,
  rootSource,
  onRefresh,
  refreshing,
}: {
  branch: { head: string | null; detached: boolean; upstream: string | null; ahead: number | null; behind: number | null };
  rootPath: string;
  rootSource: keyof typeof ROOT_SOURCE_LABEL;
  onRefresh: () => void;
  refreshing: boolean;
}) {
  return (
    <header className="scm-branch">
      <span className="scm-branch__name">
        <GitBranch size={13} />
        <b>{branch.detached ? "游离 HEAD" : branch.head ?? "（无分支）"}</b>
      </span>
      {branch.upstream && (
        <span className="scm-branch__upstream">
          {branch.upstream}
          {(branch.ahead ?? 0) > 0 && <i>↑{branch.ahead}</i>}
          {(branch.behind ?? 0) > 0 && <i>↓{branch.behind}</i>}
        </span>
      )}
      <button
        type="button"
        className="scm-branch__refresh"
        aria-label="刷新 git 状态"
        disabled={refreshing}
        onClick={onRefresh}
      >
        <ArrowClockwise size={13} />
      </button>
      <small className="scm-branch__root">{ROOT_SOURCE_LABEL[rootSource]} · {rootPath}</small>
    </header>
  );
}

export function ScmInspector({
  taskId,
  activeDiff,
  onOpenDiff,
  notify,
}: {
  taskId: string;
  activeDiff: { path: string; source: ScmDiffSource } | null;
  onOpenDiff: (target: { path: string; source: ScmDiffSource; origPath: string | null }) => void;
  notify: (message: string) => void;
}) {
  const scm = useScmWorkspace(taskId);
  const [message, setMessage] = useState("");
  const [confirm, setConfirm] = useState<PendingConfirm | null>(null);
  const [confirmBusy, setConfirmBusy] = useState(false);

  const status = scm.overview?.status ?? null;
  const running = scm.overview?.taskRunning ?? false;
  const activeGroup = useMemo<ScmGroupId | null>(() => {
    if (!activeDiff) return null;
    if (activeDiff.source === "staged") return "staged";
    if (activeDiff.source === "untracked") return "untracked";
    return status?.merge.some((change) => change.path === activeDiff.path) ? "merge" : "unstaged";
  }, [activeDiff, status]);

  /** 跑一次写操作；被 running 门禁挡下就换成 force 确认框，其它错误只报不吞。 */
  const perform = async (action: ScmAction, force = false) => {
    try {
      const outcome = await scm.run(action, force);
      if (outcome.ok) {
        if (action.kind === "commit") setMessage("");
        notify(outcome.message);
        setConfirm(null);
        return;
      }
      setConfirm(forceConfirm(action, outcome.error));
    } catch (reason) {
      notify(reason instanceof Error ? reason.message : String(reason));
      setConfirm(null);
    }
  };

  /** 丢弃一律先问。未跟踪文件走 deleteUntracked——「改回原样」和「把文件删掉」是两种后果。 */
  const askDiscard = (changes: ScmChange[], group: ScmGroupId) => {
    const untracked = group === "untracked";
    const paths = pathsOf(changes);
    const names = changes.length === 1 ? changes[0].path : `${changes.length} 个文件`;
    setConfirm({
      action: untracked
        ? { kind: "discard", paths: [], deleteUntracked: paths }
        : { kind: "discard", paths, deleteUntracked: [] },
      title: untracked ? "删除未跟踪文件" : "丢弃改动",
      message: untracked
        ? `将从磁盘上删除 ${names}。${DISCARD_HINT}`
        : `将把 ${names} 恢复成上次提交的样子。${DISCARD_HINT}`,
      confirmLabel: untracked ? "删除" : "丢弃",
      danger: true,
      force: false,
    });
  };

  if (scm.loading && !scm.overview) return <p className="scm-hint">正在读取工作区状态…</p>;
  if (!scm.overview || !status) {
    return (
      <div className="scm-empty">
        <Warning size={15} />
        <p>{scm.error ?? "读不到这个任务的工作目录"}</p>
        <button type="button" onClick={() => void scm.refresh()}>重试</button>
      </div>
    );
  }

  const clean = !status.merge.length && !status.staged.length && !status.unstaged.length && !status.untracked.length;
  const commitPaths = status.staged.length
    ? undefined
    : pathsOf([...status.unstaged, ...status.untracked]);
  const canCommit = message.trim().length > 0 && (status.staged.length > 0 || (commitPaths?.length ?? 0) > 0);

  return (
    <div className="scm-panel">
      <BranchBar
        branch={status.branch}
        rootPath={scm.overview.root.path}
        rootSource={scm.overview.root.source}
        refreshing={scm.loading || scm.busy}
        onRefresh={() => void scm.refresh()}
      />

      {status.operation && (
        <p className="scm-banner is-warning">
          <ArrowsClockwise size={13} />
          正在{OPERATION_LABEL[status.operation]}中途。先解决完冲突再提交，此时丢弃的含义也和平时不同。
        </p>
      )}
      {running && (
        <p className="scm-banner">
          <WarningCircle size={13} />
          任务正在运行，agent 可能正在写这个目录。改动会随它变化，写操作需要额外确认。
        </p>
      )}
      {status.truncated && (
        <p className="scm-banner is-warning">
          <WarningCircle size={13} />
          改动条目太多，下面这份没有列全。
        </p>
      )}

      <section className="scm-commit">
        <textarea
          value={message}
          rows={2}
          placeholder={status.staged.length ? "提交信息（提交已暂存的改动）" : "提交信息（没有暂存内容时，提交全部改动）"}
          onChange={(event) => setMessage(event.target.value)}
        />
        <button
          type="button"
          className="scm-commit__submit"
          disabled={!canCommit || scm.busy}
          onClick={() => void perform({ kind: "commit", message, stagePaths: commitPaths })}
        >
          <GitCommit size={13} />
          {status.staged.length ? `提交已暂存（${status.staged.length}）` : `暂存全部并提交（${commitPaths?.length ?? 0}）`}
        </button>
      </section>

      {clean ? (
        <p className="scm-hint">工作区干净，没有未提交的改动。</p>
      ) : (
        <div className="scm-groups">
          <ScmChangeGroup
            group="merge"
            title="冲突"
            changes={status.merge}
            activePath={activeDiff?.path ?? null}
            activeGroup={activeGroup}
            hint="解决冲突后暂存，即等于标记为已解决。冲突文件不提供丢弃。"
            actions={{
              onOpen: (change) => onOpenDiff({ path: change.path, source: diffSourceOf("merge"), origPath: null }),
              onStage: (paths) => void perform({ kind: "stage", paths }),
            }}
          />
          <ScmChangeGroup
            group="staged"
            title="已暂存"
            changes={status.staged}
            activePath={activeDiff?.path ?? null}
            activeGroup={activeGroup}
            actions={{
              onOpen: (change) => onOpenDiff({ path: change.path, source: "staged", origPath: change.origPath }),
              onUnstage: (paths) => void perform({ kind: "unstage", paths }),
            }}
          />
          <ScmChangeGroup
            group="unstaged"
            title="更改"
            changes={status.unstaged}
            activePath={activeDiff?.path ?? null}
            activeGroup={activeGroup}
            actions={{
              onOpen: (change) => onOpenDiff({ path: change.path, source: "unstaged", origPath: null }),
              onStage: (paths) => void perform({ kind: "stage", paths }),
              onDiscard: (changes) => askDiscard(changes, "unstaged"),
            }}
          />
          <ScmChangeGroup
            group="untracked"
            title="未跟踪"
            changes={status.untracked}
            activePath={activeDiff?.path ?? null}
            activeGroup={activeGroup}
            actions={{
              onOpen: (change) => onOpenDiff({ path: change.path, source: "untracked", origPath: null }),
              onStage: (paths) => void perform({ kind: "stage", paths }),
              onDiscard: (changes) => askDiscard(changes, "untracked"),
            }}
          />
        </div>
      )}

      {scm.overview.commits.length > 0 && (
        <section className="scm-commits">
          <header><GitCommit size={13} />最近提交</header>
          <ul>
            {scm.overview.commits.slice(0, 8).map((commit) => (
              <li key={commit.sha}>
                <code>{commit.shortSha}</code>
                <span>{commit.subject}</span>
                <small>{commit.author}</small>
              </li>
            ))}
          </ul>
        </section>
      )}

      {confirm && (
        <ConfirmDialog
          title={confirm.title}
          message={confirm.message}
          confirmLabel={confirm.confirmLabel}
          danger={confirm.danger}
          busy={confirmBusy}
          onClose={() => setConfirm(null)}
          onConfirm={async () => {
            setConfirmBusy(true);
            try {
              await perform(confirm.action, confirm.force);
            } finally {
              setConfirmBusy(false);
            }
          }}
        />
      )}
    </div>
  );
}
