import { api } from "../lib/api.ts";
import { openGitWorkbench, type GitLocation } from "../git-workbench/navigation.ts";
import { useEffect, useMemo, useState } from "react";
import {
  ArrowSquareOut,
  ArrowsClockwise,
  Check,
  LockSimple,
  Warning,
  WarningCircle,
} from "@phosphor-icons/react";
import type { ScmChange, ScmGroupId } from "../lib/api.ts";
import { ConfirmDialog } from "../task-detail/ConfirmDialog.tsx";
import { ScmChangeGroup } from "./ScmChangeGroup.tsx";
import { ScmCommittedChanges } from "./ScmCommittedChanges.tsx";
import { ScmPartialBanner, ScmPathLine, ScmWhy } from "./ScmHead.tsx";
import { useFileListLayout } from "../lib/fileLayout.ts";
import { FileLayoutToggle } from "../components/FileLayoutToggle.tsx";
import { InspectorHeadActions } from "../inspector/headActions.tsx";
import { InspButton, InspGo, InspNone, InspNote, InspSec } from "../inspector/parts.tsx";
import {
  OPERATION_LABEL,
  diffSourceOf,
  pathsOf,
  useScmWorkspace,
  type ScmAction,
  type ScmDiffTarget,
} from "./scmModel.ts";
import { AutoTextarea } from "../components/AutoTextarea.tsx";

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

  if (scm.loading && !scm.overview) return <div className="scm-panel insp-pane"><InspNone>正在读取工作区状态…</InspNone></div>;
  if (!scm.overview || !status) {
    return (
      <div className="scm-panel insp-pane">
        <InspNone action={<InspButton size="sm" onClick={() => void scm.refresh()}>重试</InspButton>}>
          {scm.error ?? "读不到这个任务的工作目录"}
        </InspNone>
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
    <div className="scm-panel insp-pane">
      {/* 平铺 / 目录树挂在面板头上：清单再长、滚到哪儿都够得着，不用每一节各摆一颗。 */}
      <InspectorHeadActions>
        <FileLayoutToggle className="insp-tool scm-layout-toggle" size={14} />
      </InspectorHeadActions>
      <ScmPathLine
        branch={status.branch}
        rootPath={scm.overview.root.path}
        rootSource={scm.overview.root.source}
        notify={notify}
      />
      {readOnly && (
        <ScmWhy key={readOnly} icon={<LockSimple size={14} />} label="工作区只读">{readOnly}</ScmWhy>
      )}
      {running && (
        <ScmWhy icon={<Warning size={14} />} label="有任务正在这里运行">
          有任务正在这个工作目录里运行（可能是共用它的其它任务），智能体可能正在写这里。改动会随它变化，写操作需要额外确认。
        </ScmWhy>
      )}

      {scm.partial && <ScmPartialBanner notice={scm.partial} stale={!!scm.stale} onDismiss={scm.dismissPartial} />}
      {scm.stale && (
        // 不给「知道了」：这不是一条通知，是一个还没解除的状态。只有刷成功才算解除，
        // 所以出口只有「重试」一个。写操作同时被 `frozen` 冻住（见上面 readOnly 那段）。
        <div className="scm-banner is-danger">
          <InspNote
            tone="bad"
            icon={<WarningCircle weight="fill" />}
            action={(
              <InspButton size="sm" className="scm-banner__dismiss" disabled={scm.loading || scm.busy} onClick={() => void scm.refresh()}>
                重试
              </InspButton>
            )}
          >
            <p>{scm.stale}</p>
            <p>写操作已暂停，刷新成功后恢复。</p>
          </InspNote>
        </div>
      )}
      {status.operation && (
        <div className="scm-banner is-warning">
          <InspNote tone="warn" icon={<ArrowsClockwise />}>
            正在{OPERATION_LABEL[status.operation]}中途。先解决完冲突再提交，此时丢弃的含义也和平时不同。
          </InspNote>
        </div>
      )}
      {status.truncated && (
        <div className="scm-banner is-warning">
          <InspNote tone="warn" icon={<WarningCircle weight="fill" />}>改动条目太多，下面这份没有列全。</InspNote>
        </div>
      )}

      <p className="insp-clean scm-workspace-actions">
        {clean
          ? <><Check size={14} className="scm-clean-state" aria-hidden="true" /><span className="insp-cut">无未提交改动</span></>
          : <span className="insp-cut insp-faint">工作区改动</span>}
        <button
          type="button"
          className="insp-val is-end scm-workbench-entry"
          aria-label="打开此工作区的 Git 工作台"
          onClick={() => openWorkbench()}
        >
          Git 工作台 <ArrowSquareOut size={12} aria-hidden="true" />
        </button>
      </p>

      {!readOnly && !clean && (
        <section className="scm-commit">
          <AutoTextarea
            value={message}
            rows={2}
            placeholder={status.staged.length ? "提交信息（提交已暂存的改动）" : "提交信息（没有暂存内容时，提交全部改动）"}
            onChange={(event) => setMessage(event.target.value)}
          />
          <InspButton
            variant="pri"
            size="sm"
            className="scm-commit__submit"
            disabled={!canCommit || scm.busy || !!scm.stale}
            onClick={() => void perform({ kind: "commit", message, stagePaths: commitPaths })}
          >
            {status.staged.length ? `提交已暂存（${status.staged.length}）` : `暂存全部并提交（${commitPaths?.length ?? 0}）`}
          </InspButton>
          {/* 「只提交其中几个」是这个面板本来就有的能力：逐条 + 暂存，按钮随即从「暂存全部
              并提交」翻成「提交已暂存」。但逐条那颗 + 只在 hover 时浮出来、又是个纯图标，
              不说一句就等于没有——用户只会看见「暂存全部」这一条路。 */}
          {!clean && !status.staged.length && (
            <p className="insp-hint scm-commit__hint">只想提交其中几个：指到文件那一行，点右边的 + 逐个暂存。</p>
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
        <section className="scm-commits" aria-label="最近提交">
          <InspSec>最近提交</InspSec>
          {/* 每一条都点得开：跳 Git 工作台的历史视图，选中这条提交、右边直接是它的 diff。 */}
          <ul>
            {scm.overview.commits.slice(0, 8).map((commit) => (
              <li key={commit.sha}>
                <InspGo
                  aria-label={`在 Git 工作台打开提交 ${commit.shortSha} ${commit.subject}`}
                  meta={commit.author}
                  onClick={() => openWorkbench({ view: "history", commit: commit.sha })}
                >
                  <code className="insp-mono insp-faint">{commit.shortSha}</code> {commit.subject}
                </InspGo>
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
