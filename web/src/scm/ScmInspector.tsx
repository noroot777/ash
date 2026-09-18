import { api } from "../lib/api.ts";
import { openGitWorkbench, type GitLocation } from "../git-workbench/navigation.ts";
import { useEffect, useMemo, useState } from "react";
import {
  ArrowUpRight,
  ArrowsClockwise,
  CaretRight,
  CheckCircle,
  GitBranch,
  GitCommit,
  LockSimple,
  Warning,
  WarningCircle,
} from "@phosphor-icons/react";
import type { ScmChange, ScmGroupId } from "../lib/api.ts";
import { ConfirmDialog } from "../task-detail/ConfirmDialog.tsx";
import { ROOT_SOURCE_LABEL } from "../files/fileModel.ts";
import { ScmChangeGroup } from "./ScmChangeGroup.tsx";
import { ScmCommittedChanges } from "./ScmCommittedChanges.tsx";
import { useFileListLayout } from "../lib/fileLayout.ts";
import { FileLayoutToggle } from "../components/FileLayoutToggle.tsx";
import {
  OPERATION_LABEL,
  diffSourceOf,
  pathsOf,
  useScmWorkspace,
  type ScmAction,
  type ScmDiffTarget,
  type ScmPartialNotice,
} from "./scmModel.ts";

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

/**
 * 「上一次操作改到一半停下了」的横幅。
 *
 * 两种情形都会到这里：分批跑的批量操作中途失败（git 给不了跨调用的事务，前面那些已经
 * 真的生效了——丢弃未跟踪文件时它们已经从磁盘上没了），以及提交时预暂存成功但 commit
 * 被拒（文件留在索引里，下一次提交会把它们带上）。这种结果不能只靠一条飘过去的提示
 * 交代：横幅留在面板上，直到用户自己按「知道了」，或者下一次写操作成功。
 *
 * 主文案直接用后端那句话——发生了什么只有它说得准，前端按动作名硬拼准会拼错。
 *
 * 「下面的列表已经是实际结果」这句要看 `stale`：补刷也失败时列表并不是实际结果，那句话
 * 会把用户按回错误的判断上，此时交给下面的 stale 横幅说实话。
 */
function PartialBanner({ notice, stale, onDismiss }: { notice: ScmPartialNotice; stale: boolean; onDismiss: () => void }) {
  const sample = notice.done.slice(0, 3).join("、");
  return (
    <p className="scm-banner is-danger">
      <WarningCircle size={13} />
      <span className="scm-banner__body">
        <span>{notice.message}</span>
        {!stale && <span>下面的列表已经是实际结果。</span>}
        {notice.done.length > 0 && (
          <code>已生效：{sample}{notice.done.length > 3 ? ` 等 ${notice.done.length} 个` : ""}</code>
        )}
      </span>
      <button type="button" className="scm-banner__dismiss" onClick={onDismiss}>知道了</button>
    </p>
  );
}

interface PendingConfirm {
  action: ScmAction;
  title: string;
  message: string;
  confirmLabel: string;
  danger: boolean;
  force: boolean;
}

/** 有任务在这个目录里跑时的二次确认。把「谁在写、写坏了会怎样」说完整，而不是一句「确定吗」。 */
function forceConfirm(action: ScmAction, reason: string): PendingConfirm {
  const verb = action.kind === "commit"
    ? "提交"
    : action.kind === "discard"
      ? "丢弃"
      : "改动暂存区";
  return {
    action,
    // 具体是谁在跑由后端那句 `reason` 说（可能是共用这个目录的兄弟任务），标题只管定性。
    title: "有任务正在这个工作目录里运行",
    message: `${reason}\n\n继续会在 agent 干活的同时${verb}：提交可能收进它写到一半的文件，丢弃可能抹掉它刚写出来、还没提交的成果。`,
    confirmLabel: `仍然${verb}`,
    danger: true,
    force: true,
  };
}

// 分支栏。右上角只剩平铺/树切换——推送和刷新都撤了：推送归 Git 工作台（下面「Git 工作台」
// 那颗入口点得到），状态每 5 秒自己轮询一次，读失败时另有横幅带「重试」。
function BranchBar({
  branch,
  rootPath,
  rootSource,
}: {
  branch: { head: string | null; detached: boolean; upstream: string | null; ahead: number | null; behind: number | null };
  rootPath: string;
  rootSource: keyof typeof ROOT_SOURCE_LABEL;
}) {
  return (
    <header className="scm-branch">
      <div className="scm-branch__identity">
        <span className="scm-branch__name">
          <GitBranch size={15} />
          <b>{branch.detached ? "游离 HEAD" : branch.head ?? "（无分支）"}</b>
        </span>
        {branch.upstream && (
          <span className="scm-branch__upstream">
            <span>{branch.upstream}</span>
            {(branch.ahead ?? 0) > 0 && <i>↑{branch.ahead}</i>}
            {(branch.behind ?? 0) > 0 && <i>↓{branch.behind}</i>}
          </span>
        )}
      </div>
      <span className="scm-branch__tools">
        <FileLayoutToggle className="scm-layout-toggle" />
      </span>
      <div className="scm-branch__root">
        <span>{ROOT_SOURCE_LABEL[rootSource]}</span>
        <code><bdi dir="ltr">{rootPath}</bdi></code>
      </div>
    </header>
  );
}

export function ScmInspector({
  taskId,
  activeDiff,
  onOpenDiff,
  onOpenReview,
  notify,
}: {
  taskId: string;
  activeDiff: ScmDiffTarget | null;
  onOpenDiff: (target: ScmDiffTarget) => void;
  onOpenReview?: () => void;
  notify: (message: string) => void;
}) {
  const scm = useScmWorkspace(taskId);
  const [message, setMessage] = useState("");
  const [confirm, setConfirm] = useState<PendingConfirm | null>(null);
  const [confirmBusy, setConfirmBusy] = useState(false);
  // 平铺还是目录树。全局一份偏好，几处文件清单共用（见 `lib/fileLayout.ts`）。
  const [fileLayout] = useFileListLayout();

  const status = scm.overview?.status ?? null;
  const running = scm.overview?.taskRunning ?? false;
  // 只读时**不渲染**写按钮，而不是渲染出来再让用户吃 409：后端那两档（归档冻结、独立
  // 工作区还没建出来）不是「确认一下就能干」，点几次都不会成。理由原样摆在横幅上。
  //
  // 「列表可能是旧的」同样要冻住写操作，理由不同但同样硬：面板上的每一次点击都是**按
  // 列表内容下的判断**（勾这行暂存、按那行丢弃、看着「暂存全部并提交（7）」按下去），
  // 列表一落后于磁盘，作用的就是另一批文件。见 `scmModel.ts` 的 stale 注释。
  const readOnly = scm.overview?.readOnly ?? null;
  const frozen = readOnly ?? scm.stale;
  const writable = <T,>(handler: T): T | undefined => (frozen ? undefined : handler);
  // 确认框是**冻结前**那份列表上下的判断（「丢弃这 3 个文件」里的这 3 个）。冻结一旦
  // 生效，它就不能留在屏幕上等人按：撤掉，让用户先刷新，再照新列表重新点一次。
  useEffect(() => {
    if (frozen) setConfirm(null);
  }, [frozen]);
  const activeGroup = useMemo<ScmGroupId | null>(() => {
    // `branch` 那一档在下面「已提交的改动」里高亮，跟上面这几组工作区分组无关：
    // 同名文件很可能两边都在，不排除它就会两处一起亮。
    if (!activeDiff || activeDiff.source === "branch") return null;
    if (activeDiff.source === "staged") return "staged";
    if (activeDiff.source === "untracked") return "untracked";
    return status?.merge.some((change) => change.path === activeDiff.path) ? "merge" : "unstaged";
  }, [activeDiff, status]);

  /**
   * 跳 Git 工作台。这个面板只拿得到 taskId，projectId 得现查一次任务——所以顶上那颗入口
   * 和下面「最近提交」的每一行都走这里，别各写一份异步。
   */
  const openWorkbench = (where: Omit<GitLocation, "projectId" | "taskId"> = {}) => {
    void api.task(taskId)
      .then((task) => openGitWorkbench({ projectId: task.projectId, taskId, ...where }))
      .catch((error: Error) => notify(error.message));
  };

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
  // 「暂存全部并提交」的那个数字必须是**真会被提交的份数**：嵌套 Git 仓库列得出、下不了手
  // （后端一律摘出去），算进去就是承诺 7 个、实际进去 6 个。所以这里先把它们剔掉，数字和
  // 送上去的清单同源。
  const commitPaths = status.staged.length
    ? undefined
    : pathsOf([...status.unstaged, ...status.untracked].filter((change) => !change.nested));
  const canCommit = message.trim().length > 0 && (status.staged.length > 0 || (commitPaths?.length ?? 0) > 0);

  return (
    <div className="scm-panel">
      <BranchBar
        branch={status.branch}
        rootPath={scm.overview.root.path}
        rootSource={scm.overview.root.source}
      />

      {scm.partial && <PartialBanner notice={scm.partial} stale={!!scm.stale} onDismiss={scm.dismissPartial} />}
      {scm.stale && (
        // 不给「知道了」：这不是一条通知，是一个还没解除的状态。只有刷成功才算解除，
        // 所以出口只有「重试」一个。写操作同时被 `frozen` 冻住（见上面 readOnly 那段）。
        <p className="scm-banner is-danger">
          <WarningCircle size={13} />
          <span className="scm-banner__body">
            <span>{scm.stale}</span>
            <span>写操作已暂停，刷新成功后恢复。</span>
          </span>
          <button
            type="button"
            className="scm-banner__dismiss"
            disabled={scm.loading || scm.busy}
            onClick={() => void scm.refresh()}
          >
            重试
          </button>
        </p>
      )}
      {readOnly && (
        <details className="scm-readonly" key={readOnly}>
          <summary>
            <LockSimple size={13} />
            <strong>工作区只读</strong>
            <span>原因与操作指引</span>
            <CaretRight size={11} className="scm-readonly__caret" />
          </summary>
          <p>{readOnly}</p>
        </details>
      )}
      {status.operation && (
        <p className="scm-banner is-warning">
          <ArrowsClockwise size={13} />
          正在{OPERATION_LABEL[status.operation]}中途。先解决完冲突再提交，此时丢弃的含义也和平时不同。
        </p>
      )}
      {running && (
        <p className="scm-banner">
          <WarningCircle size={13} />
          有任务正在这个工作目录里运行（可能是共用它的其它任务），agent 可能正在写这里。改动会随它变化，写操作需要额外确认。
        </p>
      )}
      {status.truncated && (
        <p className="scm-banner is-warning">
          <WarningCircle size={13} />
          改动条目太多，下面这份没有列全。
        </p>
      )}

      <div className="scm-workspace-actions">
        {clean ? (
          <span className="scm-clean-state"><CheckCircle size={13} />无未提交改动</span>
        ) : (
          <span className="scm-workspace-actions__label">工作区改动</span>
        )}
        <button
          type="button"
          className="scm-workbench-entry"
          aria-label="打开此工作区的 Git 工作台"
          onClick={() => openWorkbench()}
        >
          Git 工作台 <ArrowUpRight size={12} />
        </button>
      </div>

      {!readOnly && !clean && (
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
            disabled={!canCommit || scm.busy || !!scm.stale}
            onClick={() => void perform({ kind: "commit", message, stagePaths: commitPaths })}
          >
            <GitCommit size={13} />
            {status.staged.length ? `提交已暂存（${status.staged.length}）` : `暂存全部并提交（${commitPaths?.length ?? 0}）`}
          </button>
          {/* 「只提交其中几个」是这个面板本来就有的能力：逐条 + 暂存，按钮随即从「暂存全部
              并提交」翻成「提交已暂存」。但逐条那颗 + 只在 hover 时浮出来、又是个纯图标，
              不说一句就等于没有——用户只会看见「暂存全部」这一条路。 */}
          {!clean && !status.staged.length && (
            <p className="scm-commit__hint">只想提交其中几个：把鼠标移到文件那一行，点右侧的 + 逐个暂存，这颗按钮会变成「提交已暂存」。</p>
          )}
        </section>
      )}

      {!clean && (
        <div className="scm-groups">
          <ScmChangeGroup
            group="merge"
            title="冲突"
            changes={status.merge}
            activePath={activeDiff?.path ?? null}
            activeGroup={activeGroup}
            layout={fileLayout}
            hint="解决冲突后暂存，即等于标记为已解决。冲突文件不提供丢弃。"
            actions={{
              onOpen: (change) => onOpenDiff({ path: change.path, source: diffSourceOf("merge"), origPath: null, kind: change.kind }),
              onStage: writable((paths: string[]) => void perform({ kind: "stage", paths })),
            }}
          />
          <ScmChangeGroup
            group="staged"
            title="已暂存"
            changes={status.staged}
            activePath={activeDiff?.path ?? null}
            activeGroup={activeGroup}
            layout={fileLayout}
            actions={{
              onOpen: (change) => onOpenDiff({ path: change.path, source: "staged", origPath: change.origPath, kind: change.kind }),
              onUnstage: writable((paths: string[]) => void perform({ kind: "unstage", paths })),
            }}
          />
          <ScmChangeGroup
            group="unstaged"
            title="更改"
            changes={status.unstaged}
            activePath={activeDiff?.path ?? null}
            activeGroup={activeGroup}
            layout={fileLayout}
            actions={{
              onOpen: (change) => onOpenDiff({ path: change.path, source: "unstaged", origPath: null, kind: change.kind }),
              onStage: writable((paths: string[]) => void perform({ kind: "stage", paths })),
              onDiscard: writable((changes: ScmChange[]) => askDiscard(changes, "unstaged")),
            }}
          />
          <ScmChangeGroup
            group="untracked"
            title="未跟踪"
            changes={status.untracked}
            activePath={activeDiff?.path ?? null}
            activeGroup={activeGroup}
            layout={fileLayout}
            actions={{
              onOpen: (change) => onOpenDiff({ path: change.path, source: "untracked", origPath: null, kind: change.kind }),
              onStage: writable((paths: string[]) => void perform({ kind: "stage", paths })),
              onDiscard: writable((changes: ScmChange[]) => askDiscard(changes, "untracked")),
            }}
          />
        </div>
      )}

      <ScmCommittedChanges
        taskId={taskId}
        revision={scm.overview.commits[0]?.sha ?? null}
        activeDiff={activeDiff}
        onOpenDiff={onOpenDiff}
        onOpenReview={onOpenReview}
      />

      {scm.overview.commits.length > 0 && (
        <section className="scm-commits">
          <header><GitCommit size={13} />最近提交</header>
          {/* 每一条都点得开：跳 Git 工作台的历史视图，选中这条提交、右边直接是它的 diff。
              这份清单原先是纯展示的死胡同——看见了想看内容，只能自己去工作台再找一遍。 */}
          <ul>
            {scm.overview.commits.slice(0, 8).map((commit) => (
              <li key={commit.sha}>
                <button
                  type="button"
                  aria-label={`在 Git 工作台打开提交 ${commit.shortSha} ${commit.subject}`}
                  onClick={() => openWorkbench({ view: "history", commit: commit.sha })}
                >
                  <code>{commit.shortSha}</code>
                  <span>{commit.subject}</span>
                  <small>{commit.author}</small>
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}

      {confirm && !frozen && (
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
