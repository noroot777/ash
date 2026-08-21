import { useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowClockwise,
  ArrowUp,
  ArrowsClockwise,
  GitBranch,
  GitCommit,
  Warning,
  WarningCircle,
} from "@phosphor-icons/react";
import type { ScmChange, ScmGroupId } from "../lib/api.ts";
import { HoverTip, useHoverTip } from "../components/HoverTip.tsx";
import { useDismissable } from "../lib/useDismissable.ts";
import { ConfirmDialog } from "../task-detail/ConfirmDialog.tsx";
import { ROOT_SOURCE_LABEL } from "../files/fileModel.ts";
import { ScmChangeGroup } from "./ScmChangeGroup.tsx";
import { ScmCommittedChanges } from "./ScmCommittedChanges.tsx";
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
      : action.kind === "push"
        ? "推送"
        : "改动暂存区";
  const consequence = action.kind === "push"
    ? "推送可能刚好撞上 agent 的新提交，远端收到哪一个 HEAD 会变得不可预测。"
    : "提交可能收进它写到一半的文件，丢弃可能抹掉它刚写出来、还没提交的成果。";
  return {
    action,
    // 具体是谁在跑由后端那句 `reason` 说（可能是共用这个目录的兄弟任务），标题只管定性。
    title: "有任务正在这个工作目录里运行",
    message: `${reason}\n\n继续会在 agent 干活的同时${verb}：${consequence}`,
    confirmLabel: `仍然${verb}`,
    danger: true,
    force: true,
  };
}

/**
 * 分支栏右上角那两颗图标：推送/发布 + 刷新。
 *
 * 推送原先是一颗独占一整行的带字宽按钮。这一栏本来就窄（分支名 + 上游 + 一行工作目录
 * 路径），那颗按钮把「这是干什么用的」放大成了整个面板最显眼的东西——而它其实是偶尔才
 * 按一次的动作。收成图标挨着刷新放，说明交给指上去的提示，措辞反而比按钮上那几个字更全
 * （推几个提交、推到哪儿、为什么此刻按不动）。
 *
 * **按不动时不用 `disabled`**：Chrome 不给 disabled 元素发 mouseenter，那样恰恰是最需要
 * 解释的两种情形（没配远端、正在推）指上去什么都不出。改用 `aria-disabled` + 点击时直接
 * 返回——语义一样是「不可用」，但事件照发。
 */
function BranchTools({
  branch,
  remotes,
  pushing,
  refreshing,
  onPush,
  onRefresh,
  showPush,
}: {
  branch: { head: string | null; detached: boolean; upstream: string | null; ahead: number | null };
  remotes: string[];
  pushing: boolean;
  refreshing: boolean;
  onPush: (remote: string | null) => void;
  onRefresh: () => void;
  showPush: boolean;
}) {
  const pushTip = useHoverTip();
  const refreshTip = useHoverTip();
  const [picking, setPicking] = useState(false);
  const picker = useRef<HTMLDivElement>(null);
  const pushButton = useRef<HTMLButtonElement>(null);
  useDismissable({
    enabled: picking,
    containerRef: picker,
    onClose: () => setPicking(false),
    restoreFocusRef: pushButton,
  });

  const publish = !branch.upstream;
  const defaultRemote = remotes.includes("origin") ? "origin" : remotes[0] ?? "";
  // 远端不止一个时不替用户猜。原先那个下拉框跟着宽按钮一起没了，改成点开这颗图标再选。
  const picks = publish && remotes.length > 1;
  const blocked = pushing
    ? "正在推送…"
    : branch.detached
      ? "当前是游离 HEAD，没有可推送的分支"
      : !branch.head
        ? "没有可推送的分支"
        : publish && remotes.length === 0
          ? "这个仓库没有配置 Git 远端，暂时不能发布分支"
          : null;
  const pushLabel = blocked ?? (publish
    ? (picks ? "发布分支到…（选择远端）" : `发布分支到 ${defaultRemote}`)
    : (branch.ahead ?? 0) > 0
      ? `推送 ${branch.ahead} 个提交到 ${branch.upstream}`
      : `推送到 ${branch.upstream}`);

  return (
    <span className="scm-branch__tools">
      {showPush && (
        <button
          ref={pushButton}
          type="button"
          className="scm-branch__push"
          aria-label={pushLabel}
          aria-disabled={!!blocked}
          aria-expanded={picks ? picking : undefined}
          {...pushTip.anchorProps}
          onClick={() => {
            if (blocked) return;
            if (picks) { pushTip.hide(); setPicking((open) => !open); return; }
            onPush(publish ? defaultRemote : null);
          }}
        >
          {pushing ? <ArrowsClockwise size={13} className="is-spinning" /> : <ArrowUp size={13} weight="bold" />}
        </button>
      )}
      <button
        type="button"
        className="scm-branch__refresh"
        aria-label="刷新 git 状态"
        aria-disabled={refreshing}
        {...refreshTip.anchorProps}
        onClick={() => { if (!refreshing) onRefresh(); }}
      >
        <ArrowClockwise size={13} />
      </button>
      {picking && (
        <div className="scm-branch__remotes" ref={picker} role="menu" aria-label="选择要发布到的远端">
          <p>发布这条分支到</p>
          {remotes.map((name) => (
            <button
              key={name}
              type="button"
              role="menuitem"
              onClick={() => { setPicking(false); onPush(name); }}
            >
              {name}
            </button>
          ))}
        </div>
      )}
      <HoverTip at={pushTip.at}>{pushLabel}</HoverTip>
      <HoverTip at={refreshTip.at}>{refreshing ? "正在刷新…" : "刷新 git 状态"}</HoverTip>
    </span>
  );
}

function BranchBar({
  branch,
  rootPath,
  rootSource,
  remotes,
  onPush,
  onRefresh,
  refreshing,
  pushing,
  frozen,
}: {
  branch: { head: string | null; detached: boolean; upstream: string | null; ahead: number | null; behind: number | null };
  rootPath: string;
  rootSource: keyof typeof ROOT_SOURCE_LABEL;
  remotes: string[];
  onPush: (remote: string | null) => void;
  onRefresh: () => void;
  refreshing: boolean;
  pushing: boolean;
  frozen: boolean;
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
      <BranchTools
        branch={branch}
        remotes={remotes}
        pushing={pushing}
        refreshing={refreshing}
        onPush={onPush}
        onRefresh={onRefresh}
        showPush={!frozen}
      />
      <small className="scm-branch__root">{ROOT_SOURCE_LABEL[rootSource]} · {rootPath}</small>
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
        remotes={scm.overview.remotes ?? []}
        onPush={(remote) => void perform({ kind: "push", remote })}
        refreshing={scm.loading || scm.busy}
        onRefresh={() => void scm.refresh()}
        pushing={scm.busy}
        frozen={!!frozen}
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
        <p className="scm-banner is-warning">
          <WarningCircle size={13} />
          {readOnly}
        </p>
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

      {!readOnly && (
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

      {clean ? (
        <p className="scm-hint">工作区干净，没有未提交的改动。这个任务改了什么，看下面「已提交的改动」。</p>
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
              onStage: writable((paths: string[]) => void perform({ kind: "stage", paths })),
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
              onUnstage: writable((paths: string[]) => void perform({ kind: "unstage", paths })),
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
            actions={{
              onOpen: (change) => onOpenDiff({ path: change.path, source: "untracked", origPath: null }),
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
