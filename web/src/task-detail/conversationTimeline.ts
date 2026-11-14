// 落盘重建 + 实时增量 → 排好序的一串条目（buildConversationItems 的前半段）。
//
// 每条落盘会话先拆成两截（conversationIdentity）：老记录那一截照旧交给 conversationPersistedTurns，
// 带身份那一截交给 conversationAssembler。会话之间按时刻排序；实时事件按到达顺序逐条分派 —— 带身份的
// 进归并器（跟落盘那一路同一份状态，同一套归属与去重），没身份的交给 conversationLiveTurns 的老读法；
// 两路交错的先后照到达顺序，不按来路重排。
import type { ContextUsage, Session } from "@ash/shared";
import type { ConversationItem, PersistedConversation, TimelineEntry } from "./conversationModel.ts";
import { createAssembler } from "./conversationAssembler.ts";
import { liveInput, splitPersistedSession, type IdentityRecord } from "./conversationIdentity.ts";
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
  const splits = ordered.map((conversation) => splitPersistedSession(conversation, persistedTurns));
  const early = earlyInputs(splits, sessions, timeline);
  for (const split of splits) {
    const legacy: ConversationItem[] = [];
    appendPersistedSession(legacy, { session: split.session, segments: split.legacySegments, indices: split.legacyIndices, trace: split.legacyTrace }, persistedTurns);
    for (const item of legacy) placed.push({ item, time: timeOf(item) });
    const recorded: ConversationItem[] = [];
    assembler.persisted(split, recorded, early.get(split.session.id));
    let floor = Number.NEGATIVE_INFINITY;
    for (const item of recorded) {
      const own = timeOf(item);
      floor = Math.max(floor, own === Number.MAX_SAFE_INTEGER ? floor : own);
      placed.push({ item, time: floor });
    }
  }

  // Sessions are reusable and can overlap: an older Claude session may resume
  // after a newer @codex session has already finished. Grouping by session would
  // pin that new Claude turn above Codex forever after refresh, so establish the
  // persisted timeline by each turn's own timestamp before live arrivals append.
  placed.sort((left, right) => left.time - right.time);
  const items = placed.map(({ item }) => item);

  /* 「这条会话**此刻**还卡在上游等回话」是**服务端给的一位事实**(`Session.awaitingUpstream`,
     判据见 server/src/session-waiting.ts),落在这条会话最后那颗气泡上 —— 折叠条读的就是
     末段(见 markSegmentsAwaiting)。
     为什么不自己从 trace 的末条推:**那两份文件的缓冲进度不一样**。正文攒在
     `pendingTraceText` 里,要等下一条非 text 事件或回合收口才落 `.trace.jsonl`,而 `.md`
     是边流边写。于是一场「重试过、随后正常答完」的回合,刷新时 `.md` 已经是完整答复、
     trace 却还停在那条提示上,读者照它反推就会在答案上方永久挂着「正在重试」——正是这个
     任务要修的那个现象,只是换到了重建这一路(第 5 轮审查 F2)。
     这一位属于快照,所以落在快照铺完、实时增量到来**之前**:之后到达的输出照常把它覆盖回去
     (直播那一路的来源是事件顺序,conversationLiveTurns 边到边记);还没恢复的则一直挂着,这正是
     要的 sticky。读的是此刻的会话列表(`sessions`),快照里那份可能已经过时。 */
  // 带身份那一路的气泡要到收尾才排版（见 conversationAssembler），这一位交给它在排完以后落。
  const awaitingRecorded = new Set<ConversationItem>();
  for (const { session } of ordered) {
    const awaiting = sessions.find((current) => current.id === session.id)?.awaitingUpstream ?? session.awaitingUpstream;
    if (!awaiting) continue;
    const latest = items.findLast((item): item is AgentItem => item.kind === "agent" && item.sessionId === session.id);
    if (latest?.recorded) awaitingRecorded.add(latest);
    else if (latest) markSegmentsAwaiting(latest.segments);
  }

  const liveContext = new Map<string, ContextUsage>();
  // 先整串分好两路（老读法那一路要先整体筛掉「落盘那份已经有了」的重复拷贝，按文字与时刻猜，只给没身份的），
  // 再按到达顺序逐条交出去。
  const claims = assembler.router();
  const identity = new Set(timeline.filter(claims));
  const kept = new Set(timelineAfterPersistedTurns(timeline.filter((entry) => !identity.has(entry)), persistedTurns));
  for (const entry of timeline) {
    if (identity.has(entry)) assembler.live(entry, items, liveContext);
    else if (kept.has(entry)) appendLiveEntry(items, entry, sessions, liveContext);
  }
  assembler.settle(awaitingRecorded);
  return { items, liveContext };
}

/**
 * 实时那一路已经到了、号却落在快照里面的输入，按会话分好。output 与 trace 是分两次读的：先读到的 output 里
 * 还没有那句插话，后读到的 trace 里却已经有它之后的步骤 —— 那句插话只在实时那一路。它得跟快照一起按号铺，
 * 不然它之后的步骤先被归进它前面那颗气泡（见 conversationAssembler 的 persisted）。
 */
function earlyInputs(splits: ReturnType<typeof splitPersistedSession>[], sessions: Session[], timeline: TimelineEntry[]): Map<string, IdentityRecord[]> {
  const latest = new Map<string, number>();
  for (const split of splits) {
    const last = split.records.at(-1)?.seq;
    if (last !== undefined) latest.set(split.session.id, last);
  }
  const early = new Map<string, IdentityRecord[]>();
  for (const entry of timeline) {
    if (entry.kind !== "user") continue;
    const record = liveInput(entry, sessions);
    const last = record && latest.get(record.sessionId);
    if (!record || last === undefined || last === null || record.seq > last) continue;
    early.set(record.sessionId, [...early.get(record.sessionId) ?? [], record]);
  }
  return early;
}
