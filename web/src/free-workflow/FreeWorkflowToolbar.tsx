import { browserPreviewUrl } from "../lib/previewUrl.ts";
import { useEffect, useRef, useState } from "react";
import type { Task } from "@ash/shared";
import { MagnifyingGlass, MonitorPlay, SpinnerGap, StopCircle, Terminal } from "@phosphor-icons/react";
import { api } from "../lib/api.ts";
import type { Notify } from "../lib/notify.ts";
import { FreeReviewDialog } from "./FreeReviewDialog.tsx";
import { FreeReviewProgress } from "./FreeReviewProgress.tsx";
import { FreeReviewRepairButton } from "./FreeReviewRepairButton.tsx";
import { PreviewLogDialog } from "./PreviewLogDialog.tsx";
import { PreviewServiceLinks } from "./PreviewServiceLinks.tsx";
import { freeReviewView } from "./freeReviewCopy.ts";
import { useFreeWorkflowState } from "./useFreeWorkflowState.ts";

/** 这一颗预览按钮此刻在做的事：属于哪个任务、哪一次请求。 */
interface PreviewAction {
  taskId: string;
  kind: "opening" | "closing" | "canceling";
  token: number;
}

export function FreeWorkflowToolbar({ task, notify }: { task: Task; notify: Notify }) {
  const free = useFreeWorkflowState(task.id, task.workflowMode === "free");
  const [reviewOpen, setReviewOpen] = useState(false);
  const [logOpen, setLogOpen] = useState(false);
  const logTrigger = useRef<HTMLButtonElement>(null);
  /**
   * 这颗按钮此刻正在做的那件事。**三件事必须分开**：`opening` 是「起预览的请求挂着」
   * （可以取消），`closing` 是「关一个已经起来的预览」，`canceling` 是「取消一次启动」。
   * 只用一个 previewBusy 的话，关闭一个已就绪预览时按钮会翻成「启动中·点此取消」，
   * 而且照样能点 —— 用户对着一个正在关的预览，被告知它正在启动、还能再取消一次。
   */
  const [previewAction, setPreviewAction] = useState<PreviewAction | null>(null);
  // **动作是有主的**：它属于发起它的那个任务、那一次请求。
  //
  // 这个工具栏在切换任务时不会重新挂载（工作区渲染 TaskDetail 时没有按 id 给 key），
  // 所以一个纯本地的 previewAction 会跟着漂过去：A 的「打开预览」还挂着，用户切到 B，
  // B 的按钮就成了 A 遗留的「启动中·点此取消」——按下去发的是 `DELETE B`，把 B 自己的
  // 预览停掉，而 A 那趟照旧在跑。所以状态里带上 taskId，只有当前任务的动作才算数。
  const action = previewAction?.taskId === task.id ? previewAction.kind : null;
  const previewBusy = action !== null;
  // 一次请求的号码牌。回调回来时先对号：晚到的旧请求不能清掉别人的动作，也不能替
  // 别人的页面发通知、开窗口。
  const previewToken = useRef(0);
  const currentTask = useRef(task.id);
  useEffect(() => { currentTask.current = task.id; }, [task.id]);
  /** 起一次预览动作，返回这次的号码牌。 */
  const beginPreview = (kind: PreviewAction["kind"]): number => {
    previewToken.current += 1;
    const token = previewToken.current;
    setPreviewAction({ taskId: task.id, kind, token });
    return token;
  };
  /** 这次动作结束了 —— 只清自己那一次（别人的还在跑就别动）。 */
  const endPreview = (token: number) => {
    setPreviewAction((prev) => (prev && prev.token === token ? null : prev));
  };
  /** 用户还在发起这次动作的那个任务上吗。 */
  const stillHere = (taskId: string) => currentTask.current === taskId;
  /**
   * 这次请求的**所有副作用**（说话、开窗、重拉快照、动日志入口）都要先过这一关：
   * 人还在原地，而且没有更新的动作把它顶掉。
   *
   * 只拿 taskId 对不住同一个任务上的接力：POST 判定就绪之后还要 `await appendTaskTimeline`
   * 才回 200，而 DELETE 是**故意不抢那把锁**的（free-workflow-preview.ts），用户就在这
   * 段缝里点了取消 —— 记录和进程都收掉了，随后那个 200 却照旧宣告「预览已打开」，还弹开
   * 一个已经被停掉的地址。号码牌变了就说明这次已经不作数了。
   */
  const owns = (taskId: string, token: number) => stillHere(taskId) && previewToken.current === token;
  // 「这一轮我按过打开预览」——启动期间 hasLog 还没翻真（快照要等 POST 回来才重拉），
  // 但日志文件其实已经在长了。见 togglePreview 里那两行注释：亮起在 POST 之前，
  // 清回在 POST 有结论之后。
  //
  // **它跟动作一样是有主的。** 一个裸布尔值会被别人的 finally 关掉：A 的启动挂着，用户切到
  // B 也点了启动，A 那趟一回来就把 B 冷启动期间唯一的日志入口抹了 —— 而 B 接下来还要装
  // 六分钟依赖，那正是最需要看日志的时候。
  const [logArmed, setLogArmed] = useState<{ taskId: string; token: number } | null>(null);
  /** 这一档只对它自己那个任务算数：别的任务按过，跟这里没关系。 */
  const logArmedHere = logArmed?.taskId === task.id;
  // 日志窗是「此刻打开的那一扇」，换了任务就该关上（logArmed 认主，不用跟着清）。
  useEffect(() => {
    setLogOpen(false);
  }, [task.id]);
  const view = freeReviewView(free.state, task);
  const { latestRun, reviewing, stoppedRun, taskBusy, waiting, reservationArmed, reservationMode, repairing, stale } = view;
  const taskReady = task.status !== "backlog";
  // 等待答复/续跑期间**立即发起**的动作（派审/修复/打开预览）后端必拒（409），按钮同步
  // 禁用；「预约」不在其列——后端 reserveFreeReview 根本没有这道门禁，任务正等续跑时预约
  // 一轮「跑完就审」恰恰是该允许的。取消预约、关闭预览是控制类动作，同样不能锁死。
  // waiting / reservationMode 的定义在 freeReviewCopy.ts 里,和 Inspector 共用一份:
  // 两边各写一份的时候就漂过——底部那颗灰、侧栏那颗能点。
  // 接力出去的任务在本机是历史存档:派审/修复/开预览这些发起类动作后端一律 409,
  // 这里按同一口径锁死(取消预约、关预览是清理,照常可点)。
  const locked = task.stage === "accepted" || task.stage === "merged" || task.archived
    || task.handoff?.direction === "out";
  const reviewLabel = reviewing
    ? "审查中"
    : reservationArmed
      ? "已预约复审"
      : reservationMode
        ? "预约复审"
        : stale
          ? "审查新改动"
          : free.state?.reviews.some((run) => run.target?.kind !== "accepted_merge")
            ? (stoppedRun ? "直接再审" : "再审")
            : "派审查";
  // 未通过的意见只在结论**可证明仍然新鲜**时才是「当前待办」：stale（代码变过）和
  // unknown（缺锚点/工作区不可读）都不给修复入口——后端同样只在能核对时放行。

  // 启动那一段（装依赖最长 6 分钟 + 等就绪 2 分钟）**必须有一颗能点的取消**。
  //
  // POST 是同步等到就绪才回来的，所以这段时间里发起的那个页面 previewBusy 一直是 true；
  // 别的页面（或者刷新之后）则从快照里的 preview.starting 看到同一件事。两条路都要能点到
  // 关闭 —— 后端为此专门让 DELETE 不再跟 POST 抢那把锁（free-workflow-preview.ts），
  // 前端这颗按钮如果还是灰的，那套取消逻辑就等于不存在。
  // 「正在启动」= 服务端说它在启动，或者**我这一下正在起**（POST 还挂着）。关闭那一路
  // 不算，否则就是上面说的那种误报。
  const previewStarting = (free.state?.preview.starting ?? false) || action === "opening";
  const cancelPreview = async () => {
    if (action === "canceling" || action === "closing") return;
    const taskId = task.id;
    const token = beginPreview("canceling");
    try {
      const { stopped } = await api.stopFreePreview(taskId);
      if (owns(taskId, token)) notify(stopped ? "已取消启动预览" : "预览已经不在跑了");
    } catch (error) {
      if (owns(taskId, token)) notify(error instanceof Error ? error.message : "取消失败", { sticky: true });
    } finally {
      // 起预览那一路的 POST 还没回来（它要等到自己发现被取消），快照照样重拉：
      // 记录已经被删掉了，界面该立刻回到「打开预览」。
      const mine = owns(taskId, token);
      endPreview(token);
      if (mine) await free.reload(true).catch(() => undefined);
    }
  };

  const togglePreview = async () => {
    if (previewBusy) return;
    const taskId = task.id;
    const closing = !!free.state?.preview.running;
    const token = beginPreview(closing ? "closing" : "opening");
    try {
      if (closing) {
        await api.stopFreePreview(taskId);
        if (owns(taskId, token)) notify("预览已关闭");
      } else {
        // 这一行必须在 await 之前：启动会**同步等到就绪**（最长两分钟），而日志从
        // spawn 之前就在长。等 POST 回来才让「预览日志」出来，等于把最该看日志的那两
        // 分钟锁在门外 —— 用户守着一颗「处理中」，看不到 Maven 正在下什么、前端编到哪。
        setLogArmed({ taskId, token });
        const preview = await api.startFreePreview(taskId);
        // **人已经走了、或者这一次已经被顶掉了，就别再说话、更别开窗。** 启动能挂到八分钟：
        // 用户可能早切去了别的任务，也可能就在这个任务上按了取消（DELETE 不抢 POST 的锁，
        // 收得掉那条刚就绪的记录）。这两种情况下宣告「预览已打开」并弹开新标签页，指的都是
        // 一个此刻并不存在的预览。
        if (owns(taskId, token)) {
          const url = preview.url ? browserPreviewUrl(preview.url) : null;
          notify(url ? `预览已打开：${url}` : "预览已打开");
          if (url) window.open(url, "_blank", "noopener,noreferrer");
        }
      }
      if (owns(taskId, token)) await free.reload(true);
    } catch (error) {
      // 起失败也要 reload：日志文件这时已经落盘了，reload 之后 `hasLog` 才会翻真、
      // 「预览日志」那颗按钮才出得来 —— 否则用户手上只剩一句转瞬即逝的 toast。
      if (owns(taskId, token)) {
        // **这一句必须等用户自己收掉。** 起不来时后端报回来的是一整份东西：认出了哪几个
        // 服务、每个该怎么起、要前后端一起起该写成什么样——那是一段照着抄进「预览命令」
        // 的文字，两秒多就走的话，用户只知道「红了一下」，得再点一次才看得见。
        notify(error instanceof Error ? error.message : "预览操作失败", { sticky: true });
        await free.reload(true).catch(() => undefined);
      }
    } finally {
      endPreview(token);
      // 乐观那一档到此为止，交回给 `hasLog` —— 上面两条路都已经重拉过快照了。
      // **必须清**：有些失败发生在 spawn 之前（多候选时 resolvePreviewCommand 直接 409），
      // 那种情况下根本没有日志文件，留着这一档就是一颗点开只会说「还没有预览日志」的
      // 永久按钮 —— 而多候选恰恰是这个仓库没配预览命令时的默认形状。
      // **只清自己点亮的那一次**：别人（另一个任务、或这个任务后来的一次）正亮着的，
      // 轮不到这里替他关。
      setLogArmed((prev) => (prev && prev.token === token ? null : prev));
    }
  };

  if (task.workflowMode !== "free" || task.mode !== "single" || task.parentId || task.reviewOf) return null;
  return (
    <>
      <div className="free-workflow-toolbar" aria-label="自由工作流快捷操作">
        {repairing && <FreeReviewProgress compact kind={view.autoRereview ? "auto_rereview" : "task_running"} />}
        {stoppedRun && !taskBusy && view.freshness === "fresh" ? (
          <FreeReviewRepairButton
            taskId={task.id}
            run={stoppedRun}
            compact
            className="is-review is-repair"
            disabled={!taskReady || locked || waiting}
            onChanged={free.setState}
            notify={notify}
          />
        ) : null}
        <button type="button" className={`is-review${reviewing ? " is-busy" : ""}${reservationArmed ? " is-armed" : ""}`} data-state={reviewing ? "reviewing" : reservationArmed ? "armed" : latestRun?.status ?? "idle"} disabled={!taskReady || locked || !!reviewing || (waiting && !reservationMode)} onClick={() => setReviewOpen(true)}>
          {reviewing ? <SpinnerGap size={13} className="is-spinning" /> : <MagnifyingGlass size={13} weight="regular" />}
          <span>{reviewLabel}</span>
          {reservationArmed && <i className="free-review-armed-dot" aria-hidden="true" />}
        </button>
        {/* 启动中这颗是**可点的取消**，不是一颗灰着的「处理中」：那八分钟里用户唯一想做的
            就是「我不等了」，而后端此刻确实收得掉（记录、pid、装依赖的进程都在盘上）。 */}
        <button type="button" className={`is-preview${previewBusy ? " is-busy" : ""}`} data-state={action === "closing" ? "closing" : previewStarting ? "starting" : free.state?.preview.running ? "running" : "idle"} aria-pressed={!!free.state?.preview.running} disabled={!taskReady || taskBusy || locked || !!reviewing || action === "canceling" || action === "closing" || (waiting && !free.state?.preview.running)} onClick={() => void (previewStarting ? cancelPreview() : togglePreview())}>
          {previewBusy ? <SpinnerGap size={13} className="is-spinning" /> : free.state?.preview.running ? <StopCircle size={13} weight="regular" /> : <MonitorPlay size={13} weight="regular" />}
          <span>{action === "closing" ? "关闭中" : action === "canceling" ? "取消中" : previewStarting ? "启动中·点此取消" : free.state?.preview.running ? "关闭预览" : "打开预览"}</span>
        </button>
        {/* 日志入口按 hasLog 给，不按 running 给：预览**起不来**的那一次同样留下了日志，
            而那正是最需要看它的时候。读日志是只读动作，接力/验收锁死也照给。
            logArmed 是启动期间的那一档：hasLog 要等这次 POST 回来才翻真，可日志从
            spawn 之前就在长，最长两分钟。 */}
        {(free.state?.preview.hasLog || logArmedHere) && (
          <button ref={logTrigger} type="button" className="is-preview-log" data-testid="preview-log-open" onClick={() => setLogOpen(true)}>
            <Terminal size={13} weight="regular" /><span>预览日志</span>
          </button>
        )}
        {free.state?.preview.running && <PreviewServiceLinks key={task.id} services={free.state.preview.services ?? []} url={free.state.preview.url} />}
      </div>
      {logOpen && <PreviewLogDialog
        taskId={task.id}
        awaitingStart={action === "opening"}
        initialExpanded={(free.state?.preview.services?.length ?? 0) > 1 || (previewStarting && !free.state?.preview.services?.length)}
        onClose={() => { setLogOpen(false); logTrigger.current?.focus(); }}
        notify={notify}
      />}
      {reviewOpen && <FreeReviewDialog taskId={task.id} state={free.state} reservationMode={reservationMode} onChanged={free.setState} onClose={() => setReviewOpen(false)} notify={notify} />}
    </>
  );
}
