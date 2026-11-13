import type { ContextUsage, Session, SessionRole, TokenUsage, TurnInterruption, TurnOutcome } from "@ash/shared";
import type { MonitorWakeData } from "@ash/shared/monitor-wake";
import { addUsage, usageTotal } from "@ash/shared/usage";
import type { SessionTraceEntry } from "../lib/api.ts";
import type { ConversationEventTone, ConversationEventVariant } from "./conversationNotes.ts";
import type { TimelineNotice } from "@ash/shared/timeline-notice";
import { applyVerifySpans, reviewerKey } from "./conversationReviewer.ts";
import { markSystemResumes, type ResumeNote } from "./turnCause.ts";
import type { AgentContentSegment } from "./conversationSegments.ts";
import type { LiveAgentEvent } from "./conversationTurnParts.ts";
import { latestTurnStart } from "./conversationTurnParts.ts";
import { assembleTimeline } from "./conversationTimeline.ts";
import { contentVersion } from "../lib/useStickToBottom.ts";
import { conversationItemSize } from "./conversationContentSize.ts";
export { conversationToMarkdown } from "./conversationMarkdown.ts";
// 分段那一族住在 conversationSegments:这里转出去,别处 import 的路径不用跟着改。
export type { AgentAuxEvent, AgentContentSegment, AttachmentSource } from "./conversationSegments.ts";
// 直播增量在 conversationLiveTurns、两路共用的小件在 conversationTurnParts;LiveAgentEvent
// 是公开类型,仍从这里转出去。
export type { LiveAgentEvent } from "./conversationTurnParts.ts";

// seq / turnStartedAt：服务端播出的那一句在盘上的身份（老服务端没有）；clientKey：页面发这一句时起的凭据，
// 先画出来的那份和服务端播回来、落盘的那份凭它认成同一句（见 useConversation 的 mergeUserTimeline）。
export type TimelineEntry =
  | { kind: "user"; id: string; text: string; attachments: string[]; at: string; isAnswer?: boolean; bySystem?: boolean; monitorWake?: MonitorWakeData; answerIds?: string[]; sessionId?: string; sessionRole?: string; source?: "optimistic" | "server"; seq?: number; turnStartedAt?: string | null; clientKey?: string }
  | { kind: "server"; id: string; event: LiveAgentEvent };

/** 落盘气泡出自哪条会话的哪几段 / 哪段执行过程（删除消息拿它指名，见 server/src/conversation-redact.ts）。 */
export type ConversationSource =
  // answerId：这段答复对的是哪条问答记录（问答卡认出来的那条，见 QuestionHistory.tsx）。
  | { sessionId: string; index: number; fingerprint: string; answerId?: string }
  // entangled：这段时间里夹着别的气泡的步子，删不开（见 conversationTraceSources 的 traceSpanSource）。
  | { sessionId: string; trace: { from: string; to: string; fingerprint: string }; entangled?: true }
  // 带身份的、只有执行过程的气泡：那个回合里号落在前后两句输入之间的每一步（见 conversationAssembler）。
  | { sessionId: string; steps: { turnStartedAt: string; after: number | null; until: number | null; fingerprint: string } };
// deleted：已删除的段排版时仍占原位（回合起止靠它推），buildConversationItems 收尾前拿掉。
export type PersistedOrigin = { sources?: ConversationSource[]; deleted?: true };

export type ConversationItem =
  | PersistedOrigin & {
      kind: "agent";
      id: string;
      sessionId: string;
      label: string;
      /**
       * 说这一回合的是哪家 CLI（头像画它的标）；label 是执行器名，可能是自定义的。
       * 必填：每个拼 agent 条目的地方都得给，漏了编译不过（少给一处，那一路的头像就退回首字母）。
       */
      agentType: string | null;
      /**
       * 说这一回合的会话是什么角色（reviewer = 审查者另开的那条）。直播里会话行可能还没到，
       * 就取 agent.event 自带的那份。跟 `reviewer` 是两回事：那是徽标，会被 applyVerifySpans
       * 按审查区间补上轮次；这个是归属事实，排完版也不变。「这条会话是不是任务自己的」只问它。
       */
      sessionRole: SessionRole | null;
      at?: string | null;
      /**
       * 这颗气泡属于哪一回合：服务端给这一回合的身份（trace 挂的、实时事件带的那个起点）。
       * 实时那一路取事件自带的（见 conversationLiveTurns 的 liveTurnStart），落盘那一路取它
       * 领到的那组 trace 的；都没有就是不知道，由会话行推。
       *
       * 跟 `at` 不是一回事：`at` 是画在气泡上的时刻，会被插话改写；团队调度台的落盘气泡按
       * 用户说话那一刻编号，回合却从投递那一刻起算，两者差着一截。
       */
      turnStartedAt?: string | null;
      endedAt?: string | null;
      markerEndedAt?: string | null;
      /**
       * 这一轮**没有自己收口**：收口时刻是拿下一条真人插话推出来的（引导打断）。
       *
       * 原生引导不结束回合 —— 真人的话直接投进正在跑的会话，agent 接着说，.md 上却已经
       * 被那条 sentinel 切成了两段。上半截于是白得一个「结束时刻」，看着像一条说完的回复，
       * 还挂出「派生新任务」。派生要拿**整条回复**当上下文，半截不算（用户 2026-09-16 报的）。
       *
       * 判据是「自己收过口没有」：服务端记的 agentEnd（markerEndedAt）、或直播那一路的回合
       * 边界事件。两样都没有、收口纯靠下一条真人插话推断的，就是这里说的半截。
       */
      interrupted?: boolean;
      /**
       * 这颗气泡是带身份的记录拼成的（conversationAssembler）：归哪一回合、从哪一刻起、到哪一刻收口、
       * 是不是被插话打断的半截，全是服务端给的事实，下面那几轮按插话时刻推起止的猜法不碰它。
       */
      recorded?: true;
      showSessionMeta?: boolean;
      /** 上一条说话的还是同一个会话、中间只隔着旁注：接着上一段说，不再重报头像和执行器名。 */
      continuation?: boolean;
      /** 这一回合是哨兵叫醒的、叫醒的那条哨兵不归前面那一段（比如等的时候你插过话），另起的一回合，见 monitorWakeTurns。 */
      wokenByMonitor?: boolean;
      /** 这一回合是系统续跑起的头（见 turnCause）。reason=null：老记录没写缘由。 */
      resumeCause?: { reason: ResumeNote["reason"] };
      /** 这一回合自己的结局（服务端按回合交出来的，见 turnFailure 的 turnFailed）。缺省/null = 不知道。 */
      turnOutcome?: TurnOutcome | null;
      /** 同一回合怎么断的（`Session.turnInterruptions` 里这一回合那份），跟 `turnOutcome` 一起带。 */
      turnInterruption?: TurnInterruption;
      /**
       * 上面两样是按哪个回合起点查的（落盘那一路，见 turnFailure 的 persistedTurnFacts）。跟 `turnStartedAt`
       * 不是一回事：那一位只认服务端给这颗气泡的身份，没有就留空让别处由会话行推；这一位永远有值，三样同出一处。
       */
      turnKey?: string;
      session?: Session;
      run?: { model: string | null; reasoningEffort: string | null };
      /**
       * 这一回合是**审查者**在说话：就地验证轮带轮次号（`{ round: 2 }`），自由派审的
       * 独立审查回合没有轮次（`{ round: null }`，靠会话的 reviewer 身份认出来）。
       * undefined = 普通执行回合。
       *
       * 就地验证是搭在被验任务自己身上的旁路回合、还常复用同一条会话，所以它跟上一条
       * 「我在做需求」的气泡本来长得一模一样（同执行器自审时连名字都一样）。
       */
      reviewer?: { round: number | null };
      /** 这一回合的 token 用量。null = 这家 CLI 不报账、或这轮跑在本功能之前。 */
      usage?: TokenUsage | null;
      /** 整条会话至今的累计用量。只挂在本会话最后一条气泡上（尾栏显示会话信息的那条）。 */
      sessionUsage?: TokenUsage | null;
      /** 整条会话此刻的上下文水位（跟累计用量是两回事）。同样只挂在那条气泡上。 */
      sessionContext?: ContextUsage | null;
      markdown: string;
      segments: AgentContentSegment[];
    }
  | PersistedOrigin & {
      kind: "user";
      id: string;
      text: string;
      attachments: string[];
      at?: string;
      isAnswer?: boolean;
      bySystem?: boolean;
      monitorWake?: MonitorWakeData;
      /** 这句承载的问答答复（记录 id，见 shared/session-output.ts 的 ConvSeg）。 */
      answerIds?: string[];
      /**
       * 这条输入喂进了**哪条会话**（同 event 那一路）。真人在输入框里打的字没有它（还没落到
       * 任何一条会话上），系统代写的那些一律有。
       *
       * 审查泳道靠它分「这条哨兵自动输入是喂给审查者的，还是喂给执行者的」—— 自由派审另开
       * 一条 reviewer 会话，两者在时间线上长得一模一样，分不开就会把执行者的新输入折进审查卡
       * 的折叠区里藏掉（见 conversationReviewLanes 的 closeBefore）。
       */
      sessionId?: string;
      /** 那条会话的角色（直播事件自带，落盘那一路取自会话行）。收件人是不是审查者，按它答
       *  （conversationReviewer 的 monitorWakeFedReviewer），不再从「谁先说过话」反推。 */
      sessionRole?: string;
    }
  | PersistedOrigin & {
      kind: "event";
      id: string;
      text: string;
      at?: string;
      /** 这条旁注是写在哪条会话上的。验证区间靠它认「时间线走到别人家了」（见 conversationReviewer）。 */
      sessionId?: string;
      tone?: ConversationEventTone;
      variant?: ConversationEventVariant;
      /** 这条旁注在讲验证轮的事（开始 / 未通过 / 打回修复）：跟审查者的气泡同一套配色。 */
      verify?: boolean;
      /**
       * 这条只是**任务时间线的一条记录**（预约审查、验收阶段更新、预览起停…），不是会话
       * 里的一个回合 —— agent 从没见过这些字，它落在哪一秒也纯属偶然，多半正砸在某个回合
       * 说到一半的地方。
       *
       * 所以它**不许当回合边界用**：不切气泡（见 conversationPersistedTurns 的 mergeTurnChunk）、不定回合的起止
       * 时刻（见 at / endedAt 两轮）。拿它当边界的后果是一条回复被劈成两半，上半截平白得
       * 到一个「结束时刻」于是提前折叠、还挂上「派生新任务」——而那半截根本不是一条完整
       * 回复（用户 2026-09-14 反馈）。
       *
       * 来源：服务端 appendTaskTimeline 写的 `aside` 标；老会话没有这个标，落盘那一路改按
       * trace 的回合分组推（见 conversationPersistedTurns 的 notePlacement）。
       */
      aside?: boolean;
      /** 服务端给的「这是哪一类事」（shared/src/timeline-notice.ts）。老记录、非时间线旁注没有。 */
      notice?: TimelineNotice;
      /** 直播那一路的异常回合边界：这一回合怎么断的（结尾 done 事件带的，见 Session.turnInterruptions）。 */
      interruption?: TurnInterruption;
      /** 这条是系统续跑的开头（「〔系统〕继续（从中断处）」），连同缘由（见 turnCause）。 */
      resume?: ResumeNote;
      /** 缘由已经写在它起头的那一回合头上了：不再作为一条记录出现。 */
      onTurnHead?: true;
    };

export type PersistedConversation = { session: Session; output: string; trace?: SessionTraceEntry[] };

/* 这条会话的内容版本:贴底逻辑靠它区分「真来了新内容」和「界面只是闪了一下」。
   规模走 `conversationItemSize` 那张逐字段登记表 —— 正文、思考与工具原文、附件全算,
   身份/时刻/用量不算,新增字段编译不过。

   求和是**全部条目**而不是只看最后一条:正在飞的那一轮常被末尾的旁注(「审查已预约」
   那类)挡在后面,新文字由 appendAgentText 追加回前面那条气泡 —— 只盯最后一行就会
   眼看着它长出屏幕也不跟。 */
export const conversationTailKey = (items: readonly ConversationItem[]) =>
  contentVersion(items, conversationItemSize, (item) => item.id);

export type ConversationEventItem = Extract<ConversationItem, { kind: "event" }>;
type SessionRunBounds = {
  endedAt: string | null;
  nextStartedAt: string | null;
  turnStartedAt: string | null;
};

function inferredRunEnd(itemAt: string | null | undefined, bounds?: SessionRunBounds): string | null {
  if (!bounds) return null;
  if (bounds.endedAt) return bounds.endedAt;
  // A reusable session can resume after another @-mentioned agent opened a
  // later session. Its current turn must stay live; the later session start is
  // only a safe legacy end fallback for older turns on this session row.
  const itemTime = itemAt ? Date.parse(itemAt) : Number.NaN;
  const turnTime = bounds.turnStartedAt ? Date.parse(bounds.turnStartedAt) : Number.NaN;
  if (Number.isFinite(itemTime) && Number.isFinite(turnTime) && itemTime >= turnTime) return null;
  return bounds.nextStartedAt;
}

/**
 * 推断出来的收口时刻不能早于回合起点 —— 一条回合不可能在开始之前就结束了。
 *
 * `markerEndedAt` 是服务端记下的事实，不受这一条约束；下面那几档（下一次插话、下一颗气泡、
 * 会话边界）全是**推断**，一旦时间线的排布出了岔子就会推出个负的用时。症状很响：气泡显示
 * 「0s 用时」、当场折叠、还挂出「派生新任务」，而它根本不是一条完整回复（用户 2026-09-14、
 * 2026-09-15 各报过一次，根因各不相同）。宁可让它继续显示成「还在飞」——真结束自有
 * markerEndedAt / 回合边界事件来报。
 */
function endsAfterStart(at: string | null | undefined, endedAt: string | null): boolean {
  if (!endedAt) return false;
  const start = at ? Date.parse(at) : Number.NaN;
  const end = Date.parse(endedAt);
  return !Number.isFinite(start) || !Number.isFinite(end) || end >= start;
}

/**
 * 这条时间线项目算不算「插话」—— 能给相邻回合定起止时刻的那种。
 *
 * 真人回复、系统发给 agent 的话、回合边界都算；任务时间线旁注（aside）不算：它不开也
 * 不收一个回合，拿它定起止，一条还在跑的回合会平白得到一个结束时刻（于是提前折叠、
 * 还挂上「派生新任务」）。
 */
function isTurnInterjection(item: ConversationItem | null | undefined): boolean {
  if (!item) return false;
  if (item.kind === "user") return true;
  return item.kind === "event" && !item.aside;
}


export function buildConversationItems(
  persisted: PersistedConversation[],
  sessions: Session[],
  timeline: TimelineEntry[],
): ConversationItem[] {
  // 落盘排好序 + 直播按到达追加；带身份的记录已经由归并器按身份归位、定好起止（conversationTimeline）。
  const { items, liveContext } = assembleTimeline(persisted, sessions, timeline);

  // 时间线到这里才排完（落盘排好序 + 直播按到达追加），身份也才补得齐。必须排在下面
  // 那轮 continuation 判定之前：那一轮拿 reviewer 当断点用。
  applyVerifySpans(items);
  // 审查者身份到这里才补齐：系统续跑认领回合要避开审查者那一侧。
  markSystemResumes(items);

  const orderedSessions = [...sessions].sort((left, right) => left.startedAt.localeCompare(right.startedAt));
  const runBounds = new Map<string, SessionRunBounds>();
  orderedSessions.forEach((session, index) => {
    runBounds.set(session.id, {
      endedAt: session.endedAt,
      nextStartedAt: orderedSessions[index + 1]?.startedAt ?? null,
      turnStartedAt: latestTurnStart(session),
    });
  });

  let previousInterjectionAt: string | null = null;
  let previousItem: ConversationItem | null = null;
  const seenSessions = new Set<string>();
  for (const item of items) {
    // 任务时间线旁注整条跳过：回合的起止跟它无关（见 isTurnInterjection）。
    if (item.kind === "event" && item.aside) continue;
    const adjacentInterjectionAt = isTurnInterjection(previousItem) ? previousItem?.at ?? null : null;
    if (isTurnInterjection(item)) previousInterjectionAt = item.at ?? previousInterjectionAt;
    if (item.kind !== "agent") { previousItem = item; continue; }
    // 带身份的气泡：起点是服务端给的（conversationAssembler），下面这套推断只给老记录。
    if (item.recorded) { seenSessions.add(item.sessionId); previousItem = item; continue; }
    const firstTurn = !seenSessions.has(item.sessionId);
    seenSessions.add(item.sessionId);
    // 气泡自己记着回合就认自己的；会话行上的是**此刻最新**那一回合，拿它给上一回合的气泡
    // 补时间，下一回合一开始它就被标成了新回合的起点。
    const turnStartedAt = item.turnStartedAt ?? (item.session ? latestTurnStart(item.session) : null);
    item.at = firstTurn
      ? item.session?.startedAt ?? item.at
      : adjacentInterjectionAt
        ?? (item.at && item.at !== item.session?.startedAt ? item.at : null)
        ?? turnStartedAt
        ?? previousInterjectionAt
        ?? item.session?.startedAt;
    previousItem = item;
  }

  let nextInterjectionAt: string | null = null;
  // 同一条会话里紧挨着它的下一条发言的开始时刻。没有回合结束标记时(CLI 自己唤醒续跑
  // 的那些回合就没有)拿它当上界:再往下兜底的是整条会话的 endedAt,一串气泡就会同时以
  // 会话结束时刻收尾,用时排成一列越往下越短、末条 0s 的假数据。
  let nextAgentAt: string | null = null;
  // 下面那条插话是**真人**说的（引导），还是回合边界事件。两者都能给上一颗气泡收口，但
  // 只有后者证明那一轮是自己说完的 —— 前者只说明「说到一半被打断了」。
  let interjectedByUser = false;
  // 这颗气泡下面已经落过回合边界事件（直播那一路的「本回合结束」/「本轮执行结束」）。
  // 它们不带 at（收口时刻另有来源），所以得单独记一笔，不能靠 nextInterjectionAt 认。
  let closedBelow = false;
  let rightSessionId: string | undefined;
  const lastOfTurn = new Set<string>();
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index]!;
    // 旁注不收回合：一条还在飞的回合被它按上结束时刻，就会当场折叠、还挂出「派生新任务」
    //（用户 2026-09-14 反馈）。真回合结束自有 markerEndedAt / 回合边界事件来报。
    if (item.kind === "event" && item.aside) continue;
    if (item.kind === "event" && item.variant === "boundary") closedBelow = true;
    if (item.kind === "user" || item.kind === "event") {
      if (item.at) {
        nextInterjectionAt = item.at;
        interjectedByUser = item.kind === "user";
      }
    }
    if (item.kind !== "agent") continue;
    if (item.sessionId !== rightSessionId) {
      nextInterjectionAt = null;
      nextAgentAt = null;
      interjectedByUser = false;
      closedBelow = false;
      rightSessionId = item.sessionId;
    }
    if (item.recorded) {
      // 带身份的气泡：收口是服务端给的事实（conversationAssembler），只给它上面的老记录当个参照。
      nextAgentAt = item.at ?? nextAgentAt;
      closedBelow = false;
      continue;
    }
    // 老记录里有回合行的那一回合：最后一颗气泡的收口就是回合行上那一刻（`Session.turnEnds`），不用推。
    // 同一回合里在它之后、回合收口之前还有一句真人的话，说明它是被引导打断的前半截，那一刻不归它。
    const turnEnd = item.turnKey && !item.deleted && !lastOfTurn.has(`${item.sessionId}\0${item.turnKey}`)
      ? item.session?.turnEnds?.[item.turnKey] ?? null : null;
    if (item.turnKey && !item.deleted) lastOfTurn.add(`${item.sessionId}\0${item.turnKey}`);
    if (turnEnd && !(interjectedByUser && nextInterjectionAt && Date.parse(nextInterjectionAt) < Date.parse(turnEnd))) {
      item.markerEndedAt = turnEnd;
    }
    // 推断分三档，**挨个试**，谁先满足「不早于回合起点」就用谁：一条回合不可能在开始之前
    // 就结束了。直接把不合格的那档判成 null 会把本来还有的后两档也一起丢掉（真实数据里有
    // 会话复用造成的乱序气泡，第一档比起点早了十一分钟，后面的会话边界其实是对的）。
    const inferred = [
      nextInterjectionAt,
      nextAgentAt,
      inferredRunEnd(item.at, runBounds.get(item.sessionId)),
    ].find((candidate) => endsAfterStart(item.at, candidate)) ?? null;
    item.endedAt = item.markerEndedAt ?? inferred;
    // 收口全靠下一条真人插话推出来 = 这一轮是被引导打断的半截（见 interrupted）。
    item.interrupted = !item.markerEndedAt && !closedBelow && interjectedByUser
      && !!nextInterjectionAt && inferred === nextInterjectionAt;
    nextAgentAt = item.at ?? nextAgentAt;
    // 边界事件只给它正上方那一颗作数，再往上就是别的回合了。
    closedBelow = false;
  }

  // 删掉的那几段到这里才真正拿掉：上面推回合起止时它们还得占着原位。
  for (let index = items.length - 1; index >= 0; index -= 1) {
    if (items[index]!.deleted) items.splice(index, 1);
  }

  // 会话累计有两个来源：sessions 行是服务端账本（权威、跨刷新），但它要等下一次
  // 拉取才带上刚结束的这一轮；直播时客户端手上的"各轮之和"反而更新。取总量大的
  // 那个，数字就只会往前走，不会在回合结束的那一瞬先缩回去。
  const sessionTurnTotals = new Map<string, TokenUsage>();
  for (const item of items) {
    if (item.kind !== "agent" || !item.usage) continue;
    const previous = sessionTurnTotals.get(item.sessionId);
    sessionTurnTotals.set(item.sessionId, previous ? addUsage(previous, item.usage) : item.usage);
  }

  // 旁注（预约审查、验收阶段更新、合并&清理完成…）不该把一段连续的发言劈成两半：
  // 后面那截还是同一个会话在说话，就接着上一段排版，不再重报头像、执行器名和模型。
  // 打断续接的只有四种真断点：真人插话、回合边界事件、换了会话，以及**换了身份**。
  //
  // 身份那一条是给就地验证用的：验证轮是搭在被验任务身上的旁路回合、常复用同一条
  // 会话，中间只隔着一条「第 N 轮验证开始」的旁注 —— 按前三条判就成了「同一个人接着
  // 说」，于是审查者的发言连头像和名字都不重报，反而比不区分更糟。
  //
  // 两颗都记着回合、却不是同一回合的，同样不接：团队调度台被后台通知叫醒自己开的下一轮，
  // 中间一条输入、一条边界都没有，按上面几条判就会被画成「同一段话的下半截」。
  let continuedSessionId: string | null = null;
  let continuedReviewer: string | null = null;
  let continuedTurn: string | null = null;
  for (const item of items) {
    if (item.kind === "user") { continuedSessionId = null; continue; }
    if (item.kind === "event") {
      // 系统续跑起了新一回合：它头上要写起因，不能被画成上一段话的下半截。
      if (item.variant === "boundary" || item.onTurnHead) continuedSessionId = null;
      continue;
    }
    const turn = item.turnStartedAt ?? null;
    item.continuation = continuedSessionId === item.sessionId && continuedReviewer === reviewerKey(item)
      && (!turn || !continuedTurn || turn === continuedTurn);
    continuedSessionId = item.sessionId;
    continuedReviewer = reviewerKey(item);
    continuedTurn = turn;
  }

  const sessionMetaSeen = new Set<string>();
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index]!;
    if (item.kind !== "agent") continue;
    item.showSessionMeta = !sessionMetaSeen.has(item.sessionId);
    sessionMetaSeen.add(item.sessionId);
    if (!item.showSessionMeta) continue;
    const persistedUsage = item.session?.usage ?? null;
    const live = sessionTurnTotals.get(item.sessionId) ?? null;
    item.sessionUsage = !persistedUsage || (live && usageTotal(live) > usageTotal(persistedUsage)) ? live : persistedUsage;
    // 水位不比大小：直播时刚报的那条就是最新，会话行上那份要等下次拉取才跟上。
    item.sessionContext = liveContext.get(item.sessionId) ?? item.session?.context ?? null;
  }
  return items;
}
