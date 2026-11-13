// 落盘重建 + 实时增量 → 排好序的一串条目（buildConversationItems 的前半段）。
//
// 每条落盘会话先拆成两截（conversationIdentity）：老记录那一截照旧交给 conversationPersistedTurns，
// 带身份那一截交给 conversationAssembler。会话之间按时刻排序；实时事件按到达顺序逐条分派 —— 带身份的
// 进归并器（跟落盘那一路同一份状态，同一套归属与去重），没身份的交给 conversationLiveTurns 的老读法。
import type { ContextUsage, Session } from "@ash/shared";
import type { ConversationItem, PersistedConversation, TimelineEntry } from "./conversationModel.ts";
import { createAssembler } from "./conversationAssembler.ts";
import { splitPersistedSession } from "./conversationIdentity.ts";
import { appendLiveEntry, timelineAfterPersistedTurns } from "./conversationLiveTurns.ts";
import { appendPersistedSession } from "./conversationPersistedTurns.ts";
import { markSegmentsAwaiting } from "./conversationSegments.ts";
import type { PersistedTurnTimes } from "./conversationTurnParts.ts";

type AgentItem = Extract<ConversationItem, { kind: "agent" }>;

const timeOf = (item: ConversationItem): number => {
  const parsed = item.at ? Date.parse(item.at) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : Number.MAX_SAFE_INTEGER;
};

export function assembleTimeline(
  persisted: PersistedConversation[],
  sessions: Session[],
  timeline: TimelineEntry[],
): { items: ConversationItem[]; liveContext: Map<string, ContextUsage> } {
  const assembler = createAssembler(sessions);
  const persistedTurns: PersistedTurnTimes = new Map();
  const ordered = [...persisted].sort((left, right) => left.session.startedAt.localeCompare(right.session.startedAt));
  // 每条排进来的条目带一个排序时刻。老记录照旧用它自己的时刻；带身份那一截是**按号排好的**，时刻只拿来跟
  // 别的会话穿插 —— 取「不早于前一条」，同一条会话里的先后就不会被时刻（落盘时刻常有几毫秒的颠倒）打乱。
  const placed: { item: ConversationItem; time: number }[] = [];
  for (const conversation of ordered) {
    const split = splitPersistedSession(conversation, persistedTurns);
    const legacy: ConversationItem[] = [];
    appendPersistedSession(legacy, { session: split.session, segments: split.legacySegments, trace: split.legacyTrace }, persistedTurns);
    for (const item of legacy) placed.push({ item, time: timeOf(item) });
    const recorded: ConversationItem[] = [];
    assembler.persisted(split, recorded);
    let floor = Number.NEGATIVE_INFINITY;
    for (const item of recorded) {
      const own = timeOf(item);
      floor = Math.max(floor, own === Number.MAX_SAFE_INTEGER ? floor : own);
      placed.push({ item, time: floor });
    }
  }
  assembler.endPersisted();

  // Sessions are reusable and can overlap: an older Claude session may resume
  // after a newer @codex session has already finished. Grouping by session would
  // pin that new Claude turn above Codex forever after refresh, so establish the
  // persisted timeline by each turn's own timestamp before live arrivals append.
  placed.sort((left, right) => left.time - right.time);
  const items = placed.map(({ item }) => item);

  const liveContext = new Map<string, ContextUsage>();
  // 老读法那一路要先筛掉「落盘那份已经有了」的重复拷贝（按文字与时刻猜，只给没身份的）。
  const legacyEntries: TimelineEntry[] = [];
  const claimed = new Set<TimelineEntry>();
  {
    // 先过一遍认出哪些归身份那一路：认的时候它们已经按到达顺序进了归并器。
    for (const entry of timeline) {
      if (assembler.live(entry, items, liveContext)) claimed.add(entry);
      else legacyEntries.push(entry);
    }
  }
  const kept = new Set(timelineAfterPersistedTurns(legacyEntries, persistedTurns));
  for (const entry of legacyEntries) if (kept.has(entry)) appendLiveEntry(items, entry, sessions, liveContext);
  assembler.settle();

  /* 「这条会话**此刻**还卡在上游等回话」是**服务端给的一位事实**(`Session.awaitingUpstream`,
     判据见 server/src/session-waiting.ts),落在这条会话最后那颗气泡上 —— 折叠条读的就是
     末段(见 markSegmentsAwaiting)。
     为什么不自己从 trace 的末条推:**那两份文件的缓冲进度不一样**。正文攒在
     `pendingTraceText` 里,要等下一条非 text 事件或回合收口才落 `.trace.jsonl`,而 `.md`
     是边流边写。于是一场「重试过、随后正常答完」的回合,刷新时 `.md` 已经是完整答复、
     trace 却还停在那条提示上,读者照它反推就会在答案上方永久挂着「正在重试」——正是这个
     任务要修的那个现象,只是换到了重建这一路(第 5 轮审查 F2)。
     直播那一路的来源是事件顺序(conversationLiveTurns 边到边记),刷新之后再到达的输出会
     照常把这一位覆盖回去;还没恢复的则一直挂着,这正是要的 sticky。 */
  for (const { session } of ordered) {
    if (!session.awaitingUpstream) continue;
    const latest = placed.map(({ item }) => item)
      .findLast((item): item is AgentItem => item.kind === "agent" && item.sessionId === session.id);
    if (latest) markSegmentsAwaiting(latest.segments);
  }
  return { items, liveContext };
}
