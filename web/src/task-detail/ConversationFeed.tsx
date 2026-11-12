import { Fragment, useMemo, useRef } from "react";
import { File, Gavel, ShieldCheck } from "@phosphor-icons/react";
import type { Session, TaskListItem } from "@ash/shared";
import type { FreeReviewRun } from "@ash/shared";
import type { ConversationItem, ConversationSource } from "./conversationModel.ts";
import { conversationTailKey } from "./conversationModel.ts";
import { annotationBatchDisplayText } from "@ash/shared/page-annotation-display";
import { ConversationScrollControls } from "../components/ConversationScrollControls.tsx";
import { AgentTurnBody } from "../components/AgentTurnBody.tsx";
import { CopyButton } from "../components/CopyButton.tsx";
import { ImagePreviewGroup } from "../components/ImagePreview.tsx";
import { MarkdownBody } from "../components/MarkdownBody.tsx";
import { LiveStrip } from "../components/LiveStrip.tsx";
import { runActivityCopy, runActivityPhase, runActivityTail } from "@ash/shared/run-activity";
import { MessageAttachments } from "./Attachments.tsx";
import { conversationFeedRows, reviewLaneMessageRoles, type ReviewLaneMessageRole } from "./conversationReviewLanes.ts";
import { conversationDebateRows } from "./conversationDebateRows.ts";
import { conversationSystemRows, laneReceipts, type TurnReceipt } from "./conversationSystemRows.ts";
import { DebateLane } from "./DebateLane.tsx";
import { ReviewerLane } from "./ReviewerLane.tsx";
import { NoticeLine, noticeTail, SystemAuthoredMessage } from "./SystemNotice.tsx";
import { isReviewSystemPrompt } from "./systemNoticeModel.ts";
import { noticeView, turnFailureView } from "./timelineNoticeCopy.ts";
import { crashedTurns } from "./turnFailure.ts";
import { QuestionDock } from "./QuestionDock.tsx";
import { liftCompactionMarkers } from "./compactionMarkers.ts";
import { TurnReceiptLog, TurnReceiptsToggle, TurnReceipts, useTurnReceipts } from "./TurnReceipts.tsx";
import { openDisputeIn } from "../free-workflow/freeReviewCopy.ts";
import { durationBetween, formatInstant, parseAttachmentText } from "./utils.ts";
import { AnsweredQuestionMessage, QuestionHistoryProvider, QuestionHistoryRemainder } from "./QuestionHistory.tsx";
import { isQuestionAnswer, type QuestionRecord } from "@ash/shared/questions";
import { canForkReply } from "./conversationFork.ts";
import { MonitorWakeReply } from "./MonitorWakeInput.tsx";
import { monitorWakeInput, monitorWakeReplyIds } from "./monitorWakeModel.ts";
import { foldMonitorWakes } from "./monitorWakeTurns.ts";
import { mergeNoticeItems, useRejectionNotices } from "./useRejectionNotices.ts";
import { ReclaimTurnSwitch } from "./ReclaimTurnSwitch.tsx";
import { DeleteMessageButton, MessageDeleteProvider } from "./MessageDelete.tsx";
import { TurnActions } from "./TurnActions.tsx";
import { conversationInputAnchor, conversationInputs } from "./conversationInputs.ts";

// 审查者的身份标：这一回合不是在做需求，是在验收刚才的产物。就地验证跑在被验任务
// 自己的会话里（常常还是同一个执行器），不标出来的话它跟上一条实现回合长得一模一样。
function ReviewerBadge({ round }: { round: number | null }) {
  return (
    <span className="verify-badge">
      <ShieldCheck size={11} weight="fill" aria-hidden="true" />
      审查者{round ? ` · 第 ${round} 轮` : ""}
    </span>
  );
}

function AgentMessage({
  item,
  taskId,
  hideTime,
  laneRole,
  onFork,
  onAskSideChat,
  wakeReply,
  taskActive,
  receipts,
}: {
  item: Extract<ConversationItem, { kind: "agent" }>;
  /** 这条发言是在哪个任务的工作目录里说的（正文里的图靠它去那个目录取），见 AgentTurnBody。 */
  taskId: string;
  /** 紧邻的旁注已经显示了同一个时间。 */
  hideTime?: boolean;
  /** 这条气泡在审查卡里的位置：卡头已经把身份（lead 还包括时间）说过一遍了。 */
  laneRole?: ReviewLaneMessageRole;
  onFork?: () => void;
  onAskSideChat?: (quote: string) => void;
  wakeReply?: boolean;
  /** 任务此刻在跑或排着。没有结束时刻的那一回合只有这时才算「还在说」——历史记录缺了结束时刻不算。 */
  taskActive: boolean;
  /** 记在这一回合上的回执（conversationSystemRows）。 */
  receipts?: readonly TurnReceipt[];
}) {
  const log = useTurnReceipts();
  const duration = durationBetween(item.at, item.endedAt);
  const reviewer = item.reviewer;
  const showIdentity = !item.continuation && !laneRole;
  // 轮次徽标只是卡头标题（「第 N 轮审查」）的复读，卡里一律不出。
  const showBadge = !!reviewer && !item.continuation && !laneRole;
  // 回合头只留名字（docs/ui-ux-audit feed-1）：模型、智能水平、时间、用时排成一句，
  // 指到这一回合才出现。审查卡头已经说过时间的那条（lead）不再说。
  const meta = [
    showIdentity && item.run ? item.run.model || "CLI 默认" : null,
    showIdentity && item.run ? item.run.reasoningEffort || "默认" : null,
    !hideTime && item.at && laneRole !== "lead" ? formatInstant(item.at) : null,
    duration && laneRole !== "lead" ? `${duration} 用时` : null,
  ].filter(Boolean).join(" · ");
  const live = !item.endedAt && taskActive;
  return (
    <article
      className={`task-message task-message--agent${item.continuation ? " is-continuation" : ""}${reviewer ? " is-reviewer" : ""}${laneRole ? " is-lane-owned" : ""}${live ? " is-live" : ""}`}
    >
      {/* 卡头左边已经有一颗同样的盾：卡里每条发言再挂一颗，只是把同一个身份画两遍。 */}
      {!laneRole && (
        <span className="task-message-avatar" aria-hidden="true">
          {item.continuation ? "" : reviewer ? <ShieldCheck size={13} weight="fill" /> : item.label.slice(0, 1).toUpperCase()}
        </span>
      )}
      <div className="task-message-content">
        {(showIdentity || showBadge || meta) && (
          <header className="turn-head">
            {showIdentity && <b>{item.label}</b>}
            {showIdentity && item.wokenByMonitor && <span className="turn-cause">被哨兵叫醒</span>}
            {showBadge && <ReviewerBadge round={reviewer.round} />}
            {meta && <span className="turn-meta">{meta}</span>}
          </header>
        )}
        {wakeReply && <MonitorWakeReply />}
        <AgentTurnBody segments={item.segments} running={!item.endedAt} taskId={taskId} since={live ? item.at : undefined} />
        {/* 跑着的这一回合还没说完，尾上的操作等它收口再出（run-5）。「N 条记录」是那一排里的一颗，
            摊开的流水在它下面。 */}
        {!live && <TurnActions item={item} markdown={item.markdown} onFork={onFork} onAskSideChat={onAskSideChat}
          records={receipts?.length ? <TurnReceiptsToggle count={receipts.length} open={log.open} onToggle={log.toggle} logId={log.logId} /> : undefined} />}
        {!live && receipts && <TurnReceiptLog receipts={receipts} open={log.open} logId={log.logId} />}
        {/* 还在说的那一回合没有尾栏，记录先单独挂在正文下面（同样指到才出）。 */}
        {live && receipts && receipts.length > 0 && <TurnReceipts receipts={receipts} />}
      </div>
    </article>
  );
}

function UserMessage({
  item,
  preserveSystemStyle = false,
}: {
  item: Extract<ConversationItem, { kind: "user" }>;
  preserveSystemStyle?: boolean;
}) {
  const parsed = parseAttachmentText(item.text);
  const displayBody = annotationBatchDisplayText(parsed.body) ?? parsed.body;
  if (item.isAnswer || isQuestionAnswer(item.text)) return <AnsweredQuestionMessage text={item.text} id={item.id} at={item.at} deletable={item} />;
  const paths = [...parsed.paths, ...item.attachments];
  const bySystem = !!item.bySystem;
  const reviewPrompt = isReviewSystemPrompt(item.text);
  if (bySystem && (!preserveSystemStyle || monitorWakeInput(item)) && !reviewPrompt) {
    return <SystemAuthoredMessage item={item} />;
  }
  return (
    <article className={`task-message task-message--user${bySystem ? " is-system-authored" : ""}`}>
      <div className="task-user-bubble" {...conversationInputAnchor(item.id)}>
        <header>
          <b>{bySystem ? "系统" : "你"}</b>
          {item.at && <time>{formatInstant(item.at)}</time>}
          {displayBody && (
            <CopyButton value={displayBody} ariaLabel="复制这条回复" icon />
          )}
          <DeleteMessageButton item={item} />
        </header>
        {displayBody && (bySystem ? <MarkdownBody text={displayBody} /> : <p>{displayBody}</p>)}
        <MessageAttachments paths={paths} />
      </div>
    </article>
  );
}

export function ConversationFeed({
  task,
  requirement,
  items: feedItems,
  loading,
  error,
  forkBlockedReason,
  footer,
  dock,
  onForkReply,
  onAskSideChat,
  reviews,
  onOpenReviewPanel,
  questionHistory,
  liveQuestionHistory,
  historyReady = true,
  bodyReady = true,
  onDeleteMessage,
}: {
  task: TaskListItem;
  /**
   * 原始需求（任务正文与创建时刻）。会话流里没有它的气泡，左侧输入导航靠它排出第一格；
   * 列表项不带正文，拿不到就只排追问。
   */
  requirement?: { text: string; at?: string | null } | null;
  items: ConversationItem[];
  sessions?: Session[];
  loading: boolean;
  error: Error | null;
  forkBlockedReason?: string | null;
  footer?: React.ReactNode;
  /**
   * 停在会话下方、不跟着滚的一条：待答复的提问卡走这里。
   * 跟 `footer` 的区别是它在滚动容器**外面**——问题一直在手边，
   * 也不会被「回到底部」那颗浮动按钮压住。
   */
  dock?: React.ReactNode;
  onForkReply?: (replyId: string) => void;
  /** 回合尾「更多」里的「在侧聊里问这一段」。不给就没有这一项（没有侧聊的视图）。 */
  onAskSideChat?: (quote: string) => void;
  /** 自由派审的落盘记录：折叠卡靠它反查报告的 runId（旁注里只有轮号）。 */
  reviews?: readonly FreeReviewRun[] | null;
  /**
   * 打开审查面板（那张裁定卡在里面）。不给就不出「去裁定」按钮——只读的会话视图、
   * 团队时间线都没有那块面板，给一颗点了没反应的按钮比不给更糟。
   *
   * `round`：会话里那一行审查结论被点了，要在审查格里展开的是哪一轮（合并结果审查没有
   * 轮号，给 null）；「去裁定」不带。
   */
  onOpenReviewPanel?: (round?: number | null) => void;
  questionHistory?: QuestionRecord[];
  liveQuestionHistory?: boolean;
  /**
   * 会话正文已经读完、且读的就是当前这个任务。
   * 「哪些问答记录还没在正文里出现」只有这时候才算得准——正文还没到位时
   * 每一条记录都像是没出现过，补渲染会把整段历史当成卡片糊在屏幕上。
   */
  historyReady?: boolean;
  /**
   * 这个任务的会话正文已经读完过一轮（读失败也算读完）。被挡回操作的记录走另一个接口、
   * 回来得比正文快得多；正文还没到手时把它们先铺出来，屏幕上就只剩那几条旁注，看着像
   * 「这个任务的全部历史」，还把「正在读取会话…」挤掉了。重读时不翻回 false。
   */
  bodyReady?: boolean;
  /** 删掉一条已落盘的消息。不给就一颗删除按钮都不出（正在跑、团队/研讨任务、只读视图）。 */
  onDeleteMessage?: (sources: ConversationSource[]) => Promise<void>;
}) {
  const scroll = useRef<HTMLDivElement>(null);
  // 被挡回的用户操作合进同一条任务历史。正文读到手之后**无条件合** —— 「有没有正文」跟「这段历史该不该
  // 可见」没有关系,上一版拿它当判据,任务一跑出正文第一次被拒的记录就再也显示不出来
  // (第 2 轮审查 F4)。合流之后它和会话正文里的 aside 旁注走同一套渲染。
  const { items: noticeItems, remedy: turnRemedy, reload: reloadNotices } = useRejectionNotices(task.id);
  // 哨兵叫醒那几下并回等它的那一回合（feed-7，见 monitorWakeTurns）。
  const items = useMemo(
    () => foldMonitorWakes(liftCompactionMarkers(bodyReady ? mergeNoticeItems(feedItems, noticeItems) : feedItems)),
    [bodyReady, feedItems, noticeItems],
  );
  const requirementText = requirement?.text;
  const requirementAt = requirement?.at;
  const inputs = useMemo(
    () => conversationInputs(requirementText === undefined ? null : { text: requirementText, at: requirementAt }, items),
    [items, requirementAt, requirementText],
  );
  const activityPhase = runActivityPhase(task.status, runActivityTail(items));
  const queuedCopy = task.status === "queued"
    ? runActivityCopy({ status: task.status, mode: task.mode, phase: activityPhase ?? undefined, queuePosition: task.queuePosition })
    : null;
  // 一整场辩论折成一行，排在回执归属之前 —— 反过来的话，那七条「轮到 X 发言」会先被
  // conversationSystemRows 收进某一回合的记录里，辩论就再也认不出自己的边界了。
  const { rows, receipts } = conversationSystemRows(conversationDebateRows(conversationFeedRows(items, { reviews }), { reviews }));
  // 审查进行中那张卡里的旁注同样记在审查者那一回合上（见 laneReceipts）。
  const lanes = new Map(rows.flatMap((row) => row.kind === "review-lane" ? [[row.id, laneReceipts(row)] as const] : []));
  const receiptsOf = (id: string) => receipts.get(id) ?? [...lanes.values()].find((lane) => lane.receipts.has(id))?.receipts.get(id);
  const wakeReplies = monitorWakeReplyIds(items);
  // 「执行者驳回了，现在由你裁定」那条旁注上挂一颗「去裁定」——那句话把出路列了出来，
  // 却没给任何能点的东西（用户 2026-09-24：「直接给个按钮不行吗」）。
  //
  // 两个条件都要：**此刻真的挂着一条待裁定的驳回**（`openDisputeIn`，与审查面板同一口径），
  // 以及**最后那条**这样的旁注。只认文本会在裁定完之后留下一颗按钮，指向一张已经不在的卡；
  // 只认状态则会给历史上每一次驳回都挂一颗，而其中只有最后一条还作数。
  //
  // 按钮只把人送到那张卡跟前，不在这里复制四个出口：每个出口都带自己的确认框和说明
  // （「作废」和「转出去」的差别就写在那些文字里），复制一份必然漂成两套说法。
  const disputeEventId = onOpenReviewPanel && openDisputeIn(reviews)
    ? [...items].reverse().find((item) => item.kind === "event" && noticeView(item).dispute)?.id ?? null
    : null;
  const ruleAction = disputeEventId ? (
    <button type="button" className="system-event-cta" onClick={() => onOpenReviewPanel!()}>
      <Gavel size={11} weight="fill" aria-hidden="true" />去裁定
    </button>
  ) : null;
  // 辩论条上的同一颗按钮：辩论就是为了裁定才开的，读完该能当场决定，而不是往上翻回
  // 那条旁注（用户 2026-09-27）。条件比旁注那颗更严一格——必须**这场辩论**辩的就是
  // 此刻待裁定的那条驳回，而且它已经说完了（还在跑时后端也会拒绝裁定）。
  const openDispute = onOpenReviewPanel ? openDisputeIn(reviews) : null;
  const resolvableDebateIds = new Set(
    (openDispute?.dispute?.debates ?? []).filter((debate) => debate.status !== "running").map((debate) => debate.id),
  );
  const hiddenTimes = new Set<string>();
  for (let index = 1; index < items.length; index += 1) {
    const item = items[index]!;
    const previous = items[index - 1]!;
    if (
      item.kind === "agent"
      && item.continuation
      && item.at
      && previous.kind === "event"
      && previous.variant === "note"
      && previous.at === item.at
    ) hiddenTimes.add(item.id);
  }

  const crashed = crashedTurns(items);
  const renderItem = (
    item: ConversationItem,
    preserveSystemStyle = false,
    laneRole?: ReviewLaneMessageRole,
  ) => {
    if (item.kind === "agent") {
      const failure = crashed.get(item.id);
      return (
        <Fragment key={item.id}>
        <AgentMessage
          item={item}
          // 审查会话、团队执行者的发言都挂在**自己那个任务**上，工作目录各是各的；
          // 会话行缺失（记录读不全）时才退到当前任务。
          taskId={item.session?.taskId ?? task.id}
          wakeReply={wakeReplies.has(item.id)}
          hideTime={hiddenTimes.has(item.id)}
          laneRole={laneRole}
          onFork={onForkReply && !loading && !error && !forkBlockedReason && canForkReply(item) ? () => onForkReply(item.id) : undefined}
          onAskSideChat={onAskSideChat}
          taskActive={task.status === "running" || task.status === "queued"}
          receipts={receiptsOf(item.id)}
        />
        {failure && <NoticeLine view={turnFailureView(failure)} />}
        </Fragment>
      );
    }
    if (item.kind === "user") {
      return <UserMessage key={item.id} item={item} preserveSystemStyle={preserveSystemStyle} />;
    }
    if (preserveSystemStyle) {
      return (
        <p
          className={`conversation-note${item.tone === "error" ? " is-error" : ""}${item.tone === "notice" ? " is-notice" : ""}${item.verify ? " is-verify" : ""}`}
          key={item.id}
        >
          {item.text}
          {item.at && <time>{formatInstant(item.at)}</time>}
          <DeleteMessageButton item={item} />
        </p>
      );
    }
    return renderNotice(item, noticeView(item));
  };
  // 常显的那一行（里程碑 / 出了岔子 / 等你裁定）。回执不走这里，它们记在回合上。
  const renderNotice = (item: Extract<ConversationItem, { kind: "event" }>, view: ReturnType<typeof noticeView>) => (
    <NoticeLine
      key={item.id}
      view={view}
      tail={noticeTail(view, item.at)}
      action={item.id === disputeEventId ? ruleAction : undefined}
      deletable={item}
    />
  );

  return (
    <QuestionHistoryProvider key={task.id} taskId={task.id} history={questionHistory} live={liveQuestionHistory}
      messages={items.flatMap((item) => item.kind === "user" ? [item] : [])}>
    <MessageDeleteProvider onDelete={onDeleteMessage}>
    <ImagePreviewGroup isolated>
      <div className="conversation-scroll-region task-conversation-wrap">
        <div className="task-conversation" ref={scroll}>
          {rows.map((row) => {
            if (row.kind === "item") return renderItem(row.item);
            if (row.kind === "system-action") {
              return <SystemAuthoredMessage key={row.id} item={row.item} related={row.related} />;
            }
            if (row.kind === "notice") return renderNotice(row.item, row.view);
            if (row.kind === "receipt-log") return <TurnReceipts key={row.id} receipts={row.receipts} standalone />;
            if (row.kind === "debate-lane") {
              return (
                <DebateLane
                  key={row.id}
                  row={row}
                  onResolve={
                    onOpenReviewPanel && row.candidate && resolvableDebateIds.has(row.candidate.debate.id)
                      ? () => onOpenReviewPanel()
                      : undefined
                  }
                  fallback={row.items.map((item) => renderItem(item, true))}
                />
              );
            }
            const roles = reviewLaneMessageRoles(row);
            return (
              <ReviewerLane key={row.id} taskId={task.id} lane={row} onOpenRound={onOpenReviewPanel}>
                {lanes.get(row.id)!.rows.map((entry) => entry.kind === "item"
                  ? renderItem(entry.item, true, roles.get(entry.item.id))
                  : entry.kind === "notice"
                    ? renderNotice(entry.item, entry.view)
                    : <TurnReceipts key={entry.id} receipts={entry.receipts} standalone />)}
              </ReviewerLane>
            );
          })}
          {/* 等它开口的那一段只有一行进行条（run-2）；排着队时字不动，原因指上去看。 */}
          {activityPhase && !loading && !error && (task.status === "queued"
            ? <LiveStrip still since={null} text={queuedCopy?.title ?? "排着队"} tip={queuedCopy?.detail} />
            : <LiveStrip since={task.liveSince} />)}
          {/* 正文一条都没读下来时这里是空的，但那不是「还没开始跑」——`forkBlockedReason`
              在场就说明读挂了，再劝用户点运行是把失败说成了空会话。 */}
          {!items.length && !loading && !error && !forkBlockedReason && !activityPhase && (
            <div className="task-conversation-empty">
              <File size={20} aria-hidden="true" />
              <p>点击「运行」开始，执行输出会实时显示在这里。</p>
            </div>
          )}
          {loading && !items.length && <p className="task-conversation-note">正在读取会话…</p>}
          {forkBlockedReason && <p className="task-conversation-error" role="status">{forkBlockedReason}</p>}
          {error && <p className="task-conversation-error">{error.message}</p>}
          {/* 回合占位占着不动时,界面上得真有那个开关 —— 不然诊断说了「手动放开」,用户
              却只能去点运行,而那条路只会继续被挡回。 */}
          {turnRemedy === "reclaim-turn" && <ReclaimTurnSwitch key={task.id} taskId={task.id} onDone={reloadNotices} />}
          {historyReady && <QuestionHistoryRemainder />}
          {footer}
        </div>
        <ConversationScrollControls scrollRef={scroll} resetKey={task.id} tailKey={conversationTailKey(items)} inputs={inputs} />
      </div>
      <QuestionDock>{dock}</QuestionDock>
    </ImagePreviewGroup>
    </MessageDeleteProvider>
    </QuestionHistoryProvider>
  );
}
