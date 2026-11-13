import { memo, useMemo, useRef, useState, type ReactNode } from "react";
import { File, Gavel, ShieldCheck } from "@phosphor-icons/react";
import type { Session, TaskListItem } from "@ash/shared";
import type { FreeReviewRun } from "@ash/shared";
import type { TaskCreationOrigin } from "@ash/shared/task-origin";
import type { ConversationItem, ConversationSource } from "./conversationModel.ts";
import { conversationTailKey } from "./conversationModel.ts";
import { annotationBatchDisplayText } from "@ash/shared/page-annotation-display";
import { ConversationScrollControls } from "../components/ConversationScrollControls.tsx";
import { AgentTurnBody } from "../components/AgentTurnBody.tsx";
import { AgentIcon, hasAgentIcon } from "../components/AgentIcon.tsx";
import { CopyButton } from "../components/CopyButton.tsx";
import { ImagePreviewGroup } from "../components/ImagePreview.tsx";
import { MarkdownBody } from "../components/MarkdownBody.tsx";
import { MessageText } from "../components/MessageText.tsx";
import { LiveStrip } from "../components/LiveStrip.tsx";
import { runActivityCopy, runActivityPhase, runActivityTail } from "@ash/shared/run-activity";
import { MessageAttachments } from "./Attachments.tsx";
import { conversationFeedRows, reviewLaneMessageRoles, type ReviewLaneMessageRole } from "./conversationReviewLanes.ts";
import { conversationDebateRows } from "./conversationDebateRows.ts";
import { conversationSystemRows, laneReceipts, type ConversationFootnoteRow, type TurnReceipt } from "./conversationSystemRows.ts";
import { DebateLane } from "./DebateLane.tsx";
import { ReviewerLane } from "./ReviewerLane.tsx";
import { laneRoundOpener } from "./reviewLaneLinks.ts";
import type { ConversationReviewLane } from "./conversationReviewLanes.ts";
import type { ReviewTarget } from "../review/reviewTarget.ts";
import { CommandReply, SystemAuthoredMessage } from "./SystemNotice.tsx";
import { isReviewSystemPrompt } from "./systemNoticeModel.ts";
import { isPreviewLifecycleNotice, noticeView, type NoticeContext } from "./timelineNoticeCopy.ts";
import { FootnoteLine } from "./FootnoteLine.tsx";
import { ReviewVerdict } from "./ReviewVerdict.tsx";
import { footnoteKey, receiptsKey, type FootnotePart, type TurnFootnote } from "./turnFootnote.ts";
import { crashedTurns } from "./turnFailure.ts";
import { QuestionDock } from "./QuestionDock.tsx";
import { useJustEnded } from "./useJustEnded.ts";
import { conversationKeys } from "./conversationKeys.ts";
import {
  ReceiptReviewContext, TurnReceiptLog, TurnReceiptsToggle, TurnReceipts, useTurnReceipts, type ReceiptReview,
} from "./TurnReceipts.tsx";
import { openDisputeIn } from "../free-workflow/freeReviewCopy.ts";
import { RetryCta } from "./RetryCta.tsx";
import type { ReviewRetryAction, TurnRetryAction } from "./turnRetry.ts";
import { durationBetween, formatInstant, parseAttachmentText } from "./utils.ts";
import { AnsweredQuestionMessage, QuestionHistoryProvider, QuestionHistoryRemainder } from "./QuestionHistory.tsx";
import { isQuestionAnswer, type QuestionRecord } from "@ash/shared/questions";
import { canForkReply } from "./conversationFork.ts";
import { MonitorWakeReply } from "./MonitorWakeInput.tsx";
import { monitorWakeInput, monitorWakeReplyIds } from "./monitorWakeModel.ts";
import { foldMonitorWakes } from "./monitorWakeTurns.ts";
import { mergeNoticeItems, useRejectionNotices } from "./useRejectionNotices.ts";
import { ReclaimTurnSwitch } from "./ReclaimTurnSwitch.tsx";
import { DeleteMessageButton, MessageDeleteProvider, type DeletableItem } from "./MessageDelete.tsx";
import { TurnActions } from "./TurnActions.tsx";
import { ReuseInputButton, type ReusableInput } from "./ReuseInput.tsx";
import { conversationInputAnchor, conversationInputs, REQUIREMENT_INPUT_ID, requirementAuthor } from "./conversationInputs.ts";

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

const AgentMessage = memo(AgentMessageView, sameSettledTurn);

function AgentMessageView({
  item,
  taskId,
  hideTime,
  laneRole,
  onFork,
  onAskSideChat,
  wakeReply,
  taskActive,
  receipts,
  footnote,
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
  /**
   * 这一回合的尾注（验收了、这一轮没办成……那一句小灰字），摆在正文下面、
   * 回合尾那排操作上面。`key` 是它的签名：收口的回合只在它变了时重画。
   */
  footnote?: { node: ReactNode; key: string };
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
  // 认得出是哪家的就画那家的标，认不出（自定义 CLI）才退回执行器名的首字母。
  const branded = !reviewer && hasAgentIcon(item.agentType);
  const head = showIdentity || showBadge || !!meta;
  // 看着它收口的那一下：尾栏淡入一次、约两秒后收回，过程摘要那一行淡入（run-5）。
  const justEnded = useJustEnded(live);
  return (
    <article
      className={`task-message task-message--agent${item.continuation ? " is-continuation" : ""}${reviewer ? " is-reviewer" : ""}${laneRole ? " is-lane-owned" : ""}${live ? " is-live" : ""}${justEnded ? " is-just-ended" : ""}`}
    >
      {/* 卡头左边已经有一颗同样的盾：卡里每条发言再挂一颗，只是把同一个身份画两遍。 */}
      {!laneRole && (
        <span className={`task-message-avatar${branded ? " is-branded" : ""}`} aria-hidden="true">
          {item.continuation ? "" : reviewer ? <ShieldCheck size={13} weight="fill" /> : branded ? <AgentIcon agent={item.agentType} size={16} /> : item.label.slice(0, 1).toUpperCase()}
        </span>
      )}
      <div className="task-message-content">
        {head && (
          <header className="turn-head">
            {showIdentity && <b>{item.label}</b>}
            {showIdentity && item.wokenByMonitor && <span className="turn-cause">被哨兵叫醒</span>}
            {showBadge && <ReviewerBadge round={reviewer.round} />}
            {meta && <span className="turn-meta">{meta}</span>}
            {/* 删除紧跟在那一句后面，跟它一起指到才出；还在说的那一回合删不了，按钮自己会缺席。 */}
            {!live && <DeleteMessageButton item={item} />}
          </header>
        )}
        {wakeReply && <MonitorWakeReply />}
        <AgentTurnBody segments={item.segments} running={!item.endedAt} taskId={taskId} since={live ? item.at : undefined} />
        {footnote?.node}
        {/* 跑着的这一回合还没说完，尾上的操作等它收口再出（run-5）。「N 条记录」是那一排里的一颗，
            摊开的流水在它下面。 */}
        {!live && <TurnActions item={item} removeInMenu={!head} markdown={item.markdown} usage={item.usage} onFork={onFork} onAskSideChat={onAskSideChat}
          records={receipts?.length ? <TurnReceiptsToggle count={receipts.length} open={log.open} onToggle={log.toggle} logId={log.logId} /> : undefined} />}
        {!live && receipts && <TurnReceiptLog receipts={receipts} open={log.open} logId={log.logId} />}
        {/* 还在说的那一回合没有尾栏，记录先单独挂在正文下面（同样指到才出）。 */}
        {live && receipts && receipts.length > 0 && <TurnReceipts receipts={receipts} />}
      </div>
    </article>
  );
}

type AgentMessageProps = Parameters<typeof AgentMessageView>[0];

/**
 * 已经收口的回合不跟着别人的事件重渲（docs/ui-ux-audit 08 的两条工程前提之一）。会话每来一条
 * 事件，整份条目都会重新拼一遍、每一条都是新对象；还在说的那一回合要跟着变，说完的那些只在
 * 它自己真的变了时才重画（重读回来补上了执行过程、被删了一截、旁边多了回执）。回调只认有没有：
 * 它们闭包里拿的都是稳定的 setter / 派发函数。
 */
export function sameSettledTurn(prev: AgentMessageProps, next: AgentMessageProps): boolean {
  if (prev.item === next.item && prev.taskActive === next.taskActive) return shallowRest(prev, next);
  const settled = (props: AgentMessageProps) => !!props.item.endedAt || !props.taskActive;
  if (!settled(prev) || !settled(next)) return false;
  const a = prev.item;
  const b = next.item;
  return a.id === b.id && a.endedAt === b.endedAt && a.markdown === b.markdown && a.label === b.label && a.agentType === b.agentType
    && sameSegments(a.segments, b.segments)
    && a.continuation === b.continuation && a.wokenByMonitor === b.wokenByMonitor
    && a.reviewer?.round === b.reviewer?.round && a.run?.model === b.run?.model && a.run?.reasoningEffort === b.run?.reasoningEffort
    && sameJson(a.sources, b.sources) && sameJson(a.usage, b.usage) && a.session?.exitStatus === b.session?.exitStatus
    && shallowRest(prev, next);
}

/**
 * 段落比内容，不比条数：重读回来的同一回合，工具详情、附件路径、配对的那份拷贝可能换了而条数
 * 不变（第 1 轮审查）。逐项比一遍远比重画这一回合便宜。
 */
function sameSegments(left: AgentMessageProps["item"]["segments"], right: AgentMessageProps["item"]["segments"]): boolean {
  if (left === right) return true;
  if (left.length !== right.length) return false;
  return left.every((segment, index) => {
    const other = right[index]!;
    return segment === other || (segment.id === other.id && segment.markdown === other.markdown && segment.awaiting === other.awaiting
      && segment.attachments.join("\n") === other.attachments.join("\n")
      && sameJson(segment.attachmentSources, other.attachmentSources)
      && segment.events.length === other.events.length
      && segment.events.every((event, at) => {
        const twin = other.events[at]!;
        return event === twin || (event.kind === twin.kind && event.label === twin.label && event.detail === twin.detail
          && event.at === twin.at && sameJson(event.nativeWork, twin.nativeWork));
      }));
  });
}

const sameJson = (left: unknown, right: unknown) => left === right || JSON.stringify(left) === JSON.stringify(right);

function shallowRest(prev: AgentMessageProps, next: AgentMessageProps): boolean {
  return prev.taskId === next.taskId && prev.hideTime === next.hideTime && prev.laneRole === next.laneRole
    && prev.wakeReply === next.wakeReply && prev.taskActive === next.taskActive
    && !!prev.onFork === !!next.onFork && !!prev.onAskSideChat === !!next.onAskSideChat
    // 记录与尾注比的是摆出来的全部内容（含记录里那几轮审查晚到的身份、报告、附言），不只条数。
    && receiptsKey(prev.receipts) === receiptsKey(next.receipts)
    && prev.footnote?.key === next.footnote?.key;
}

function UserMessage({
  item,
  preserveSystemStyle = false,
  onReuse,
}: {
  item: Extract<ConversationItem, { kind: "user" }>;
  preserveSystemStyle?: boolean;
  onReuse?: (input: ReusableInput) => void;
}) {
  if (item.isAnswer || isQuestionAnswer(item.text)) return <AnsweredQuestionMessage text={item.text} id={item.id} at={item.at} deletable={item} />;
  const bySystem = !!item.bySystem;
  const reviewPrompt = isReviewSystemPrompt(item.text);
  if (bySystem && (!preserveSystemStyle || monitorWakeInput(item)) && !reviewPrompt) {
    return <SystemAuthoredMessage item={item} />;
  }
  return <UserBubble id={item.id} author={bySystem ? "系统" : "你"} text={item.text} attachments={item.attachments} at={item.at} bySystem={bySystem} deletable={item} onReuse={onReuse} />;
}

/**
 * 原始需求：任务正文画成会话的第一颗气泡。它是任意一段需求文字，不是会话里的协议消息——
 * 正文碰巧以「【答复】」开头也不当答复卡、不当系统代写，直接走普通气泡；谁说的照任务来源写，
 * 没有删除（它不在会话正文里）。
 */
function RequirementMessage({ requirement, onReuse }: {
  requirement: { text: string; at?: string | null; origin?: TaskCreationOrigin | null };
  onReuse?: (input: ReusableInput) => void;
}) {
  return <UserBubble id={REQUIREMENT_INPUT_ID} author={requirementAuthor(requirement.origin)} text={requirement.text} attachments={[]} at={requirement.at ?? undefined} onReuse={onReuse} />;
}

function UserBubble({ id, author, text, attachments, at, bySystem = false, deletable, onReuse }: {
  /** 条目 id：左侧输入导航按它找到这颗气泡。 */
  id: string;
  author: string;
  text: string;
  attachments: readonly string[];
  at?: string;
  bySystem?: boolean;
  deletable?: DeletableItem;
  /** 放回对话框改了再发。系统代写的、页面批注批次（截图与页面数据放不回文字框）不给。 */
  onReuse?: (input: ReusableInput) => void;
}) {
  // 刚发出去的那一句上移 4px 淡入（run-1）；页面打开时已经在的不动。
  const [fresh] = useState(() => !!at && Date.now() - Date.parse(at) < 5000);
  const parsed = parseAttachmentText(text);
  const displayBody = annotationBatchDisplayText(parsed.body) ?? parsed.body;
  const paths = [...parsed.paths, ...attachments];
  const reusable = !bySystem && displayBody === parsed.body && (!!parsed.body || paths.length > 0);
  return (
    <article className={`task-message task-message--user${bySystem ? " is-system-authored" : ""}${fresh ? " is-fresh" : ""}`}>
      <div className="task-user-bubble" {...conversationInputAnchor(id)}>
        <header>
          <b>{author}</b>
          {at && <time>{formatInstant(at)}</time>}
          {displayBody && (
            <CopyButton value={displayBody} ariaLabel="复制这条回复" icon />
          )}
          {onReuse && reusable && <ReuseInputButton onReuse={() => onReuse({ source: id, text: parsed.body, paths })} />}
          {deletable && <DeleteMessageButton item={deletable} />}
        </header>
        {displayBody && (bySystem ? <MarkdownBody text={displayBody} /> : <MessageText text={displayBody} />)}
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
  reviewRetry,
  turnRetry,
  questionHistory,
  liveQuestionHistory,
  historyReady = true,
  bodyReady = true,
  onDeleteMessage,
  onReuseInput,
}: {
  task: TaskListItem;
  /**
   * 原始需求（任务正文、创建时刻、谁建的）。会话正文里没有它，这里在最顶上补画第一颗气泡，
   * 左侧输入导航也靠它排出第一格；列表项不带正文，拿不到就既不画也不排。
   */
  requirement?: { text: string; at?: string | null; origin?: TaskCreationOrigin | null } | null;
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
  onOpenReviewPanel?: (target?: ReviewTarget) => void;
  /** 此刻能「继续本轮审查」的那一轮和那个动作（审查格主按钮同一份）。不给 = 尾注上不挂。 */
  reviewRetry?: ReviewRetryAction | null;
  /** 此刻能「重试这一回合」的那条会话和那个动作（turnRetry.ts）。不给 = 失败那句话后面不挂。 */
  turnRetry?: TurnRetryAction | null;
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
  /** 你发的那几句（含原始需求）放回对话框改了再发。不给就不出这颗键（没有对话框的视图）。 */
  onReuseInput?: (input: ReusableInput) => void;
}) {
  const scroll = useRef<HTMLDivElement>(null);
  // 被挡回的用户操作合进同一条任务历史。正文读到手之后**无条件合** —— 「有没有正文」跟「这段历史该不该
  // 可见」没有关系,上一版拿它当判据,任务一跑出正文第一次被拒的记录就再也显示不出来
  // (第 2 轮审查 F4)。合流之后它和会话正文里的 aside 旁注走同一套渲染。
  const { items: noticeItems, remedy: turnRemedy, reload: reloadNotices } = useRejectionNotices(task.id);
  // 哨兵叫醒那几下并回等它的那一回合（feed-7，见 monitorWakeTurns）。
  const items = useMemo(
    () => foldMonitorWakes(bodyReady ? mergeNoticeItems(feedItems, noticeItems) : feedItems),
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
  // 一轮异常结束：那一回合尾注里的一句（刷新以后从会话行认出来的，见 turnFailure）。
  const crashed = crashedTurns(items);
  // 一整场辩论折成一行，排在回执归属之前 —— 反过来的话，那七条「轮到 X 发言」会先被
  // conversationSystemRows 收进某一回合的记录里，辩论就再也认不出自己的边界了。
  // 认老记录里「跑了一条命令」那一句的成败时，拿这个任务工作流里写的命令逐字对。
  const noticeContext: NoticeContext = {
    commands: task.workflow?.steps.flatMap((step) => step.kind === "command" ? [step.p.cmd] : []),
  };
  const { rows, receipts, footnotes } = conversationSystemRows(
    conversationDebateRows(conversationFeedRows(items, { reviews }), { reviews }),
    { failures: crashed, context: noticeContext },
  );
  // 审查卡里（正在跑的那张、审查结论气泡下面摊开的那一轮、记录里点开的那一轮）的旁注同样记在审查者
  // 那一回合上（见 laneReceipts）。
  const shownLanes: ConversationReviewLane[] = [
    ...rows.flatMap((row) => row.kind === "review-lane" ? [row] : row.kind === "verdict" ? [row.lane] : []),
    ...[...receipts.values(), ...rows.flatMap((row) => row.kind === "footnote" ? [row.receipts] : [])]
      .flatMap((list) => list.flatMap((receipt) => receipt.lane ? [receipt.lane] : [])),
  ];
  const lanes = new Map(shownLanes.map((lane) => [lane.id, laneReceipts(lane)] as const));
  const laneViews = [...lanes.values()];
  const receiptsOf = (id: string) => receipts.get(id) ?? laneViews.find((lane) => lane.receipts.has(id))?.receipts.get(id);
  const footnoteOf = (id: string) => footnotes.get(id) ?? laneViews.find((lane) => lane.footnotes.has(id))?.footnotes.get(id);
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
  const lastDisputeId = [...items].reverse().find((item) => item.kind === "event" && noticeView(item).dispute)?.id ?? null;
  const disputeEventId = onOpenReviewPanel && openDisputeIn(reviews) ? lastDisputeId : null;
  // 尾注里「等你裁定」那一句的点只说现在：裁定过的（或者后来又驳回过一次的）就不再是要你拍板的事。
  // 拿不到审查记录的视图不知道裁没裁，照位置判。
  const disputeOpen = (part: FootnotePart) => part.kind === "event" && part.item?.id === lastDisputeId
    && (reviews == null || !!openDisputeIn(reviews));
  const settleDisputes = (footnote: TurnFootnote | undefined): TurnFootnote | undefined => footnote && {
    ...footnote,
    parts: footnote.parts.map((part) => part.view.dispute && !disputeOpen(part) ? { ...part, view: { ...part.view, tone: "neutral" as const } } : part),
  };
  const ruleAction = disputeEventId ? (
    <button type="button" className="system-event-cta" onClick={() => onOpenReviewPanel!()}>
      <Gavel size={11} weight="fill" aria-hidden="true" />去裁定
    </button>
  ) : null;
  // 「这一轮审查为什么没结论」那句尾注后面挂「继续本轮审查」：那句话点名了这个动作。只挂在此刻
  // 还能续的那一轮（同一场、同一轮）**最后一条**这样的尾注上 —— 续过了（round.retry 没了）、
  // 另开了新链，`reviewRetry` 就换了人或者没了，这颗也就跟着不出。
  const retryEventId = reviewRetry ? [...items].reverse().find((item) => item.kind === "event"
    && item.notice?.kind === "review.no_verdict"
    && item.notice.runId === reviewRetry.review.runId && item.notice.round === reviewRetry.review.round)?.id ?? null : null;
  // 普通回合崩了、此刻能重试：「重试这一回合」挂在**那一回合**（会话里最后一条气泡，且就是要重跑的
  // 那条会话）尾注里说它没办成的那半句后面 —— 直播那一路是异常回合边界，刷新以后是从会话行补出来的
  // 那一句，两路都归「failure」这件事。那半句被别的几件事挤出了尾注（一回合最多三句），就挂在最后一句后面：
  // 能重试时页面上一定要有这个入口。
  const lastAgent = [...items].reverse().find((item) => item.kind === "agent");
  const retryTurnFootnoteId = turnRetry && lastAgent?.kind === "agent" && lastAgent.session?.id === turnRetry.sessionId
    ? `footnote:${lastAgent.id}` : null;
  const turnRetryPartOf = (footnote: TurnFootnote) => footnote.id !== retryTurnFootnoteId ? null
    : footnote.parts.findLast((part) => part.view.topic === "failure") ?? footnote.parts.at(-1) ?? null;
  const isRetryable = (part: FootnotePart, footnote: TurnFootnote) => (part.kind === "event" && !!retryEventId && part.item?.id === retryEventId)
    || turnRetryPartOf(footnote) === part;
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

  const keys = conversationKeys(items);
  const renderItem = (
    item: ConversationItem,
    preserveSystemStyle = false,
    laneRole?: ReviewLaneMessageRole,
  ) => {
    if (item.kind === "agent") {
      const footnote = settleDisputes(footnoteOf(item.id));
      return (
        <AgentMessage
          key={keys.get(item.id) ?? item.id}
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
          footnote={footnote?.parts.length
            ? { node: renderFootnote(footnote), key: footnoteKey(footnote, footnote.parts.some(isRuled) ? "rule" : footnote.parts.some((part) => isRetryable(part, footnote)) ? "retry" : "") }
            : undefined}
        />
      );
    }
    if (item.kind === "user") {
      return <UserMessage key={keys.get(item.id) ?? item.id} item={item} preserveSystemStyle={preserveSystemStyle} onReuse={onReuseInput} />;
    }
    // 辩论兜底那一路不经过 conversationSystemRows，预览开关那几种老记录在这里同样拿掉。
    if (isPreviewLifecycleNotice(item.text)) return null;
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
    // 走到这里的只有归属之外单独摆的那几条（辩论兜底以外不会发生）：同一种小灰字。
    const view = noticeView(item, noticeContext);
    if (view.tier === "reply") return <CommandReply key={item.id} item={item} view={view} />;
    return renderFootnote({ id: item.id, live: false, parts: [{ kind: "event", id: item.id, at: item.at, view, item }] }, "standalone");
  };
  // 「去裁定」挂在等你裁定的那半句后面（只有此刻还挂着的那一条）。
  const isRuled = (part: FootnotePart) => part.kind === "event" && !!disputeEventId && part.item?.id === disputeEventId;
  // 审查结论那一轮就地摊开时的经过：卡里的旁注照样记在审查者那一回合上。
  const renderLaneRows = (lane: ConversationReviewLane) => {
    const roles = reviewLaneMessageRoles(lane);
    return lanes.get(lane.id)!.rows.map((entry) => entry.kind === "item"
      ? renderItem(entry.item, true, roles.get(entry.item.id))
      : entry.kind === "reply"
        ? <CommandReply key={entry.id} item={entry.item} view={entry.view} />
        : renderFootnoteRow(entry));
  };
  const renderFootnote = (footnote: TurnFootnote, placement?: "standalone" | "trailing") => (
    <FootnoteLine key={footnote.id} footnote={footnote} placement={placement}
      actionFor={(part) => isRuled(part) ? ruleAction
        : turnRetry && turnRetryPartOf(footnote) === part ? <RetryCta label="重试这一回合" run={turnRetry.run} />
          : isRetryable(part, footnote) && reviewRetry ? <RetryCta label="继续本轮审查" run={reviewRetry.run} /> : null} />
  );
  // 「N 条记录」里那一轮审查点开去哪儿：跟审查结论那颗气泡同一套。
  const receiptReview: ReceiptReview = {
    taskId: task.id,
    reviewOpener: (lane) => laneRoundOpener(lane, task.workflowMode, onOpenReviewPanel),
    renderLane: renderLaneRows,
  };
  // 前面没有回合可挂的那几句：留在原处，同一种小灰字；它们的记录跟在后面。
  const renderFootnoteRow = (row: ConversationFootnoteRow) => row.footnote.parts.length ? (
    <div className="footnote-row" key={row.id}>
      {renderFootnote(settleDisputes(row.footnote)!, "standalone")}
      <TurnReceipts receipts={row.receipts} />
    </div>
  ) : <TurnReceipts key={row.id} receipts={row.receipts} standalone />;

  return (
    <QuestionHistoryProvider key={task.id} taskId={task.id} history={questionHistory} live={liveQuestionHistory}
      messages={items.flatMap((item) => item.kind === "user" ? [item] : [])}>
    <MessageDeleteProvider onDelete={onDeleteMessage}>
    <ReceiptReviewContext.Provider value={receiptReview}>
    <ImagePreviewGroup isolated>
      <div className="conversation-scroll-region task-conversation-wrap">
        <div className="task-conversation" ref={scroll}>
          {requirement && inputs[0]?.id === REQUIREMENT_INPUT_ID && <RequirementMessage requirement={requirement} onReuse={onReuseInput} />}
          {rows.map((row) => {
            if (row.kind === "item") return renderItem(row.item);
            if (row.kind === "system-action") {
              return <SystemAuthoredMessage key={row.id} item={row.item} related={row.related} />;
            }
            if (row.kind === "footnote") return renderFootnoteRow(row);
            if (row.kind === "reply") return <CommandReply key={row.id} item={row.item} view={row.view} />;
            if (row.kind === "verdict") {
              return (
                <ReviewVerdict key={row.id} lane={row.lane} live={row.live} taskId={task.id}
                  onOpenRound={laneRoundOpener(row.lane, task.workflowMode, onOpenReviewPanel)} renderLane={renderLaneRows}
                  trailing={renderFootnote(settleDisputes(row.footnote)!, "trailing")} />
              );
            }
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
            // 收了口的审查轮不在这里（它是上面那颗审查结论气泡）；走到这里的是还在跑的那张卡。
            return (
              <ReviewerLane key={row.id} taskId={task.id} lane={row} onOpenRound={laneRoundOpener(row, task.workflowMode, onOpenReviewPanel)}>
                {renderLaneRows(row)}
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
        <ConversationScrollControls scrollRef={scroll} resetKey={task.id} tailKey={conversationTailKey(items)} inputs={inputs} revealReady={bodyReady} />
      </div>
      <QuestionDock>{dock}</QuestionDock>
    </ImagePreviewGroup>
    </ReceiptReviewContext.Provider>
    </MessageDeleteProvider>
    </QuestionHistoryProvider>
  );
}
