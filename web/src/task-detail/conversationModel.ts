import type { ContextUsage, Session, TokenUsage } from "@ash/shared";
import { ANSWER_PREFIX, parseSessionOutput } from "@ash/shared";
import { addUsage, usageTotal } from "@ash/shared/usage";
import { normalizeSessionNoteText } from "@ash/shared/session-notes";
import type { SessionTraceEntry } from "../lib/api.ts";
import type { ConversationEventTone, ConversationEventVariant } from "./conversationNotes.ts";
import { isVerifyNote, noteTone, verifyNoteOf } from "./conversationNotes.ts";
import { applyVerifySpans, reviewerKey, reviewerKeyOf, reviewerOf, traceVerifyRound } from "./conversationReviewer.ts";
import type { AgentContentSegment } from "./conversationSegments.ts";
import { contentSegments } from "./conversationSegments.ts";
import {
  groupedTrace,
  normalizedPersistedTrace,
  splitTraceGroupAt,
  takeTraceGroup,
  traceRun,
  traceTurnStartAt,
  traceUsage,
} from "./conversationTraceGroups.ts";
import type { LiveAgentEvent, PersistedTurnTimes } from "./conversationTurnParts.ts";
import { agentLabel, compactTurnText, latestTurnStart, recordPersistedTurn, sessionRun } from "./conversationTurnParts.ts";
import { appendLiveTimeline } from "./conversationLiveTurns.ts";
export { conversationToMarkdown } from "./conversationMarkdown.ts";
// 分段那一族住在 conversationSegments:这里转出去,别处 import 的路径不用跟着改。
export type { AgentAuxEvent, AgentContentSegment } from "./conversationSegments.ts";
// 直播增量在 conversationLiveTurns、两路共用的小件在 conversationTurnParts;LiveAgentEvent
// 是公开类型,仍从这里转出去。
export type { LiveAgentEvent } from "./conversationTurnParts.ts";

export type TimelineEntry =
  | { kind: "user"; id: string; text: string; attachments: string[]; at: string; isAnswer?: boolean; bySystem?: boolean; source?: "optimistic" | "server" }
  | { kind: "server"; id: string; event: LiveAgentEvent };

export type ConversationItem =
  | {
      kind: "agent";
      id: string;
      sessionId: string;
      label: string;
      at?: string | null;
      endedAt?: string | null;
      markerEndedAt?: string | null;
      showSessionMeta?: boolean;
      /** 上一条说话的还是同一个会话、中间只隔着旁注：接着上一段说，不再重报头像和执行器名。 */
      continuation?: boolean;
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
  | { kind: "user"; id: string; text: string; attachments: string[]; at?: string; isAnswer?: boolean; bySystem?: boolean }
  | {
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
       * 所以它**不许当回合边界用**：不切气泡（见下面的 mergeTurnChunk）、不定回合的起止
       * 时刻（见 at / endedAt 两轮）。拿它当边界的后果是一条回复被劈成两半，上半截平白得
       * 到一个「结束时刻」于是提前折叠、还挂上「派生新任务」——而那半截根本不是一条完整
       * 回复（用户 2026-09-14 反馈）。
       *
       * 来源：服务端 appendTaskTimeline 写的 `aside` 标；老会话没有这个标，落盘那一路改按
       * trace 的回合分组推（见 notePlacement）。
       */
      aside?: boolean;
    };

export type PersistedConversation = { session: Session; output: string; trace?: SessionTraceEntry[] };

export type ConversationEventItem = Extract<ConversationItem, { kind: "event" }>;
type AgentItem = Extract<ConversationItem, { kind: "agent" }>;
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

function conversationItemTime(item: ConversationItem): number {
  const parsed = item.at ? Date.parse(item.at) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : Number.MAX_SAFE_INTEGER;
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
 * 这条旁注落在了会话的什么位置 —— 判据是 trace 的回合分组。
 *
 * - `inside`：某一组的 `turnStartedAt` **严格早于**它、组里又还有它之后的事件 —— 砸进了
 *   一个正在进行的回合，上下两截 .md 正文是同一个人同一轮说的话。
 * - `boundary`：有一组正是从它这一刻（或之后）起头的 —— 那是真换了一轮。「第 N 轮验证
 *   开始」就是这形状（写完旁注才拉起验证回合），真正的回合起点（「继续（从中断处）」）
 *   时刻更是**恰好等于**某一组的 `turnStartedAt`。
 * - `unknown`：trace 一条都没有 —— 整条会话没落盘、或写盘失败（服务端把 trace 写失败当
 *   非致命处理）。读端不能把「trace 一定在」当成正确性前提，所以这一档交给调用方按服务端
 *   的 `aside` 标兜底。
 *
 * **必须在 splitTraceGroupAt 动手之前调用** —— 那一步会按旁注改写分组，之后再问就问不
 * 出「原本是同一组」了。
 */
function notePlacement(
  groups: Map<string, SessionTraceEntry[]>,
  at: string | undefined,
): "inside" | "boundary" | "unknown" {
  const time = Date.parse(at ?? "");
  if (!Number.isFinite(time)) return "unknown";
  let boundary = false;
  for (const [turnStartedAt, entries] of groups) {
    const start = Date.parse(turnStartedAt);
    if (!Number.isFinite(start)) continue;
    if (start >= time) { boundary = true; continue; }
    if (entries.some((entry) => Date.parse(entry.at) >= time)) return "inside";
  }
  return boundary ? "boundary" : "unknown";
}

/**
 * 把「被旁注劈开的下半截」并回上一颗气泡 —— 它们本来就是同一回合、同一个人说的一段话。
 *
 * 只把两截**接起来**，分段一个都不动：每一截的 events / 正文早已各自跟自己那一小组
 * trace 对齐过（见 contentSegments 的 alignedSegments），接在一起就是这一回合完整的交错
 * 结构，折叠（turnLayout）也才有得切 —— 否则「最后一次动手」只能在半截里找，整轮折不出
 * 结论。分段各自渲染成独立的块，接缝处不需要补空行；补的那一下只归 `markdown`（复制、
 * 派生快照读的是它），两截之间空一行才是一段话原来的样子。
 */
function mergeTurnChunk(target: AgentItem, chunk: AgentItem): void {
  target.markdown = [target.markdown, chunk.markdown].filter((text) => text.trim()).join("\n\n");
  target.segments.push(...chunk.segments);
  // 收口标记跟着后一截走：回合真正结束在哪一刻，只有最后那一截知道。
  target.markerEndedAt = chunk.markerEndedAt ?? target.markerEndedAt;
  target.usage = target.usage && chunk.usage ? addUsage(target.usage, chunk.usage) : chunk.usage ?? target.usage;
  target.run = target.run ?? chunk.run;
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

/** 把一条落盘会话（.md + trace）铺成气泡，追加到 `items` 末尾。 */
function appendPersistedSession(
  items: ConversationItem[],
  { session, output, trace = [] }: PersistedConversation,
  persistedTurns: PersistedTurnTimes,
): void {
  const segments = parseSessionOutput(output);
  const traceGroups = groupedTrace(normalizedPersistedTrace(trace, session));
  const consumedTrace = new Set<string>();
  // ── 一遍过认三件事：谁是旁注、哪条旁注要把上下两截并回一颗气泡、trace 从哪儿切开 ──
  //
  // 必须整个跑在切分**之前**：notePlacement 读的正是即将被改写的那份分组。
  //
  // 【谁是旁注】服务端的 aside 标覆盖全部 appendTaskTimeline 旁注（含落在两个回合之间的，
  // 比如「第 N 轮验证开始」），它只决定「不拿它定回合起止」。
  //
  // 【并不并】看它落在哪：
  // - inside  → 并。那一刻回合确实还在飞，是同一段话被劈成了两半。
  // - boundary→ 不并。trace 摆明了下一轮从这儿起头，并了就是把实现者和审查者的发言粘成
  //   一条（或把同一个人的两轮粘成一条）。
  // - unknown → 听服务端的 aside 标。trace 哑了（整条会话没落盘、写盘失败）时，标着
  //   aside 就说明这本来就不是回合边界；此时两截连 run 身份都读不出来，劈开只剩坏处：
  //   上半截平白得到结束时刻，于是提前折叠、还挂出「派生新任务」。老会话没这个标，无
  //   证据可依，维持老排法。
  //
  // 但 aside 标只说「不是回合起点」，**不说「回合还在飞」**，所以 trace 哑了的时候还要
  // 另外两样**跟 trace 各走各路**的证据把边界旁注挡在外面，否则审查者的结论会被并进被审
  // 的实现回合（第 2 轮审查报的）：
  //
  // - 上一段正文已经落了 agentEnd → 这一回合真收口了（服务端每个回合结束时写，见
  //   transcript.ts 的 writeTurnEnd），后面的话是新一轮。
  // - 这条旁注自己就是「第 N 轮验证/审查开始」那一类 → 它开的是**另一个人**的一轮
  //   （白名单在 conversationNotes，applyVerifySpans 拿同一份划审查区间）。
  //
  // agentEnd 那条证据只在**本回合起点之后 .md 里确实落过正文**时才算数：没落过的话它讲的
  // 是上一轮的事，对这一条旁注什么都没说。「回合开跑先连着跑几十分钟工具、一个字没吐」是
  // 常态，这时整份 .md 是空的，旁注会被当成「回合还没开始」，两截再也并不回去。
  //
  // 【切不切】先按 .md 里的 sentinel 把 trace 切成段，再逐段发放。切分必须整体跑在任何
  // agent 段认领之前：原生引导那一路插话前常常一个字都没吐（agent 正连着跑工具），既没有
  // .md 正文能顺手触发切分，等上一段领走整组之后也已经晚了。
  //
  // 插话一律是切点。**砸进回合中间的注记（trace 判 inside）只在它前后都有本回合正文时
  // 才是切点**：
  // - 后面有正文：那种情形下 parseSessionOutput 已经在 sentinel 处把正文切成了两段 agent，
  //   trace 不跟着切，前面那截（旁注常常正好落在 agent 刚吐出一两个字的时候）就会把整组
  //   trace 连同几百次工具调用一起领走，真正写正文的那一段一个事件都拿不到。
  // - 后面没正文就不能切：那一组 trace 会没人认领，落进「无正文兜底气泡」凭空多出一颗，
  //   而直播那边旁注根本不拆气泡（见 appendAgent 跨旁注回捞当前回合），刷新前后就长得
  //   不一样了。
  // - **前面**没有本回合正文同样不能切（用户 2026-09-16 报的）：切了一样凭空多出一颗兜底
  //   气泡，而且这回连 mergeTurnChunk 都救不回来 —— 上半截压根不是一颗气泡，没有并的对象。
  //   这正是「先连着跑几十分钟工具」那种回合的形状：旁注占了 .md 的第一行，等 agent 终于
  //   吐字，那段正文就被劈到了旁注下面 —— 用户看到的是「预约审查打断了正在跑的回合」，而且
  //   同一条会话会在吐字的那一瞬当场变形。不切则整组 trace 完整留给后面那段正文，旁注照旧
  //   排成这一回合的尾注，吐字前后长得一样。
  //
  // 真回合边界不受这条约束，它们**就是**新一轮的开头，前面没正文时那组 trace 本来就该单独
  // 成一颗气泡：真人插话、「继续（从中断处）」这类说给 agent 听的系统注记，以及**带着 aside
  // 标、却落在两个回合之间的**那种——「第 N 轮验证开始」就是（写完旁注才拉起验证回合，
  // trace 判 boundary）。所以这里认的是 trace 的 inside，不是服务端的 aside 标：拿标当判据
  // 会把这类真边界一起挡掉，审查者的正文退回普通气泡、连 reviewer 身份都丢了（第 1 轮审查报的）。
  const asideAt = new Set<string>();
  const midTurnAt = new Set<string>();
  const splitPoints = new Set<string>();
  let closedTurn = true;
  let proseSinceTurnStart = false;
  segments.forEach((segment, index) => {
    if (segment.kind === "agent") {
      closedTurn = !!segment.endedAt;
      proseSinceTurnStart = true;
      return;
    }
    if (segment.kind !== "system") {
      // 真人插话：一律是切点，也一律是新一轮的开头。
      if (segment.at) splitPoints.add(segment.at);
      closedTurn = true;
      proseSinceTurnStart = false;
      return;
    }
    const placement = notePlacement(traceGroups, segment.at);
    // **砸进某一回合中间**，判据只认 trace。服务端那个 aside 标管的是另一头：它覆盖全部
    // appendTaskTimeline 旁注，连落在两回合**之间**的「第 N 轮验证开始」都带标——拿标去判
    // 「切不切」，就会把那种真边界一起挡掉（第 1 轮审查报的）。
    const midTurn = placement === "inside";
    if (segment.at) {
      if (midTurn || segment.aside === true) asideAt.add(segment.at);
      if (!(closedTurn && proseSinceTurnStart)
        && verifyNoteOf(normalizeSessionNoteText(segment.text))?.phase !== "start"
        && (midTurn || (placement === "unknown" && segment.aside))) {
        midTurnAt.add(segment.at);
      }
      if (segments.slice(index + 1).some((later) => later.kind === "agent")
        && (!midTurn || proseSinceTurnStart)) {
        splitPoints.add(segment.at);
      }
    }
    // 只有「砸进回合中间」那种不开新一轮；其余的（trace 认下的边界、说给 agent 听的注记、
    // trace 哑了没话说的）都按新一轮起头算，两样证据一起归零。
    if (!midTurn) {
      closedTurn = true;
      proseSinceTurnStart = false;
    }
  });
  let splitFrom = session.startedAt;
  for (const segment of segments) {
    if (segment.kind === "agent" || !segment.at || !splitPoints.has(segment.at)) continue;
    splitTraceGroupAt(traceGroups, consumedTrace, splitFrom, segment.at);
    splitFrom = segment.at;
  }
  let turnStartedAt = session.startedAt;
  // 一段之后的下一个切点（不只看紧邻那一段）：它是这一段认领 trace 时的上界。
  const nextSplitAt = (index: number): string | undefined => {
    for (const later of segments.slice(index + 1)) {
      if (later.kind !== "agent" && later.at && splitPoints.has(later.at)) return later.at;
    }
    return undefined;
  };
  // 这一回合还没说完的那颗气泡（被旁注劈开的上半截），以及「中间只隔着旁注」这件事。
  let openTurn: AgentItem | null = null;
  let acrossAside = false;
  segments.forEach((segment, index) => {
    if (segment.kind === "user") {
      recordPersistedTurn(persistedTurns, "user", segment.text, segment.at);
      items.push({
        kind: "user",
        id: `persisted:user:${session.id}:${index}`,
        text: segment.text,
        attachments: [],
        at: segment.at,
        isAnswer: segment.text.startsWith(ANSWER_PREFIX),
        // 后端代写、占着真人回合的那种（验证打回、验收冲突）。照常渲染成 user 气泡，
        // 但「后续追问」不收它 —— 判据统一在 shared 的 isUserFollowUp。
        bySystem: segment.bySystem,
      });
      turnStartedAt = segment.at ?? turnStartedAt;
      openTurn = null;
      acrossAside = false;
    } else if (segment.kind === "system") {
      recordPersistedTurn(persistedTurns, "system", segment.text, segment.at, session.id);
      // 旧版轮换文案落在用户 .md 里的原文带 Markdown 标记、措辞也不一样；旁注是纯文本
      // 渲染，不归一就会把星号原样露出来（@ash/shared/session-notes）。
      const text = normalizeSessionNoteText(segment.text);
      items.push({
        kind: "event",
        id: `persisted:system:${session.id}:${index}`,
        text,
        at: segment.at,
        sessionId: session.id,
        // 服务端标了 notice 就照它的，别再去猜（见 conversationNotes 的 tone 注释）。
        tone: segment.level === "notice" ? "notice" : noteTone(text),
        variant: "note",
        verify: isVerifyNote(text),
        aside: asideAt.has(segment.at ?? ""),
      });
      // 回合起点跟着**切点**走：切过的地方 trace 已经另成一组，下半截要靠这个起点认领
      // 自己那几条事件。合并发生在气泡层面（见下面的 mergeTurnChunk），两者不冲突。
      // 没切的旁注一步都不能动它：那一组 trace 还是完整的一份，起点一挪，后面那段正文就
      // 拿着一个根本不存在的键去领，整组当场变成没人认领的兜底气泡。
      // 起点取 trace 里实际那一组、而不是 sentinel 自己那一刻：写旁注到真起跑之间隔着
      // 排队和拉起执行器，差出几秒是常态，照 sentinel 认就同样领不到（见 traceTurnStartAt）。
      const sentinelAt = segment.at;
      if (sentinelAt && splitPoints.has(sentinelAt)) {
        turnStartedAt = traceTurnStartAt(traceGroups, consumedTrace, sentinelAt, nextSplitAt(index)) ?? sentinelAt;
      }
      if (midTurnAt.has(segment.at ?? "")) acrossAside = !!openTurn;
      else { openTurn = null; acrossAside = false; }
    } else {
      const next = segments[index + 1];
      // 下一段的 trace 已经被上面切成独立一组了，这一段不许靠 ±2 秒兜底把它捞过来。
      // 判据跟切点保持同一份：agent 在切点之前一个字都没吐时，它自己那一组会被切空
      // 删掉，兜底就正好会挑中切点之后那一组。
      const boundary = next && next.kind !== "agent" && next.at && splitPoints.has(next.at)
        ? next.at
        : undefined;
      const traceEntries = takeTraceGroup(traceGroups, consumedTrace, turnStartedAt, boundary);
      const chunk: AgentItem = {
        kind: "agent",
        id: `persisted:agent:${session.id}:${index}`,
        sessionId: session.id,
        label: agentLabel(session),
        at: turnStartedAt,
        endedAt: null,
        markerEndedAt: segment.endedAt ?? null,
        session,
        run: traceRun(traceEntries) ?? sessionRun(session),
        reviewer: reviewerOf(traceVerifyRound(traceEntries), session?.role),
        usage: traceUsage(traceEntries),
        markdown: segment.text,
        segments: contentSegments(traceEntries, segment.text, `persisted:segment:${session.id}:${index}`),
      };
      // 中间只隔着一条「那一刻回合还在飞」的旁注 —— 这就是同一回合的下半截，并回去。
      // 身份再核一道：同一条会话上换轮验证也算换人（reviewerKey），换了人就不是同一段
      // 话，哪怕旁注骗过了上面那道结构判据也粘不到一起。只有**自己带 run 事件**的那截
      // 才有资格报身份：回合起点才写 run，下半截通常一条都没有（就地验证的审查者在自己
      // 回合中间调 report_stage 就是这形状），拿它那份空身份去比就会把一个人的话劈成两
      // 半、后半截还丢掉模型信息。
      const ownIdentity = traceEntries.some((entry) => entry.event.kind === "run");
      const sameSpeaker = !ownIdentity || reviewerKeyOf(openTurn?.reviewer) === reviewerKeyOf(chunk.reviewer);
      if (openTurn && acrossAside && sameSpeaker) {
        mergeTurnChunk(openTurn, chunk);
      } else {
        items.push(chunk);
        openTurn = chunk;
      }
      acrossAside = false;
    }
  });
  // A failed turn can contain only tools/errors and no assistant prose. Keep
  // its execution block visible instead of dropping the persisted trace.
  //
  // 另一类没有正文的组是**同一个回合的碎片**:常驻调度台被 CLI 自己唤醒续跑(后台监控
  // 回调)时,服务端补上回合起点之前落的 trace,每条事件都拿自己的时刻当回合起点(修在
  // server/src/team/session-consumer.ts,老数据仍是碎的)。一条条渲染就是一串「1 工具」
  // 的空气泡。它们的共同特征是**没有 run 事件** —— 真回合起点一定写 run —— 所以顺着
  // 时间粘回同一条,直到下一个 run 或下一段已经有正文的回合。
  // 正文的权威来源只有 .md:兜底气泡里的 text 事件多半已经被上面某条气泡渲染过了
  // （回合边界对不上时,同一段话会同时落在 .md 段落和无人认领的 trace 组里）。原样带
  // 上就是一段话连说两遍,所以只留执行过程。
  const persistedProse = segments
    .filter((segment) => segment.kind === "agent")
    .map((segment) => compactTurnText(segment.text))
    .join("\0");
  const withoutEchoedProse = (entries: SessionTraceEntry[]): SessionTraceEntry[] => entries.filter((entry) => {
    if (entry.event.kind !== "text") return true;
    const compact = compactTurnText(entry.event.text);
    return !!compact && !persistedProse.includes(compact);
  });
  let fragment: { turn: string; entries: SessionTraceEntry[] } | null = null;
  const flushFragment = (): void => {
    const pending = fragment;
    fragment = null;
    if (!pending) return;
    const entries = withoutEchoedProse(pending.entries);
    if (!entries.some((entry) => entry.event.kind !== "run" && entry.event.kind !== "usage")) return;
    const traceSegments = contentSegments(entries, "", `persisted:trace-segment:${session.id}:${pending.turn}`);
    items.push({
      kind: "agent",
      id: `persisted:trace:${session.id}:${pending.turn}`,
      sessionId: session.id,
      label: agentLabel(session),
      // 起点取第一条实质事件:被丢掉的复读正文往往比工具早好几分钟,拿组的 key 当起点
      // 会把「模型在写字」的时间算进这条执行过程的用时里。
      at: entries.find((entry) => entry.event.kind !== "usage")?.at ?? pending.turn,
      endedAt: null,
      markerEndedAt: null,
      session,
      run: traceRun(entries) ?? sessionRun(session),
      reviewer: reviewerOf(traceVerifyRound(entries), session?.role),
      usage: traceUsage(entries),
      markdown: traceSegments.map((segment) => segment.markdown).join(""),
      segments: traceSegments,
    });
  };
  for (const [traceTurn, entries] of traceGroups) {
    if (consumedTrace.has(traceTurn) || entries.some((entry) => entry.event.kind === "run")) flushFragment();
    if (consumedTrace.has(traceTurn)) continue;
    if (fragment) fragment.entries.push(...entries);
    else fragment = { turn: traceTurn, entries: [...entries] };
  }
  flushFragment();
}

export function buildConversationItems(
  persisted: PersistedConversation[],
  sessions: Session[],
  timeline: TimelineEntry[],
): ConversationItem[] {
  const items: ConversationItem[] = [];
  const persistedTurns: PersistedTurnTimes = new Map();
  const ordered = [...persisted].sort((left, right) =>
    left.session.startedAt.localeCompare(right.session.startedAt));
  for (const conversation of ordered) appendPersistedSession(items, conversation, persistedTurns);

  // Sessions are reusable and can overlap: an older Claude session may resume
  // after a newer @codex session has already finished. Grouping by session would
  // pin that new Claude turn above Codex forever after refresh, so establish the
  // persisted timeline by each turn's own timestamp before live arrivals append.
  items.sort((left, right) => conversationItemTime(left) - conversationItemTime(right));

  const liveContext = appendLiveTimeline(items, timeline, sessions, persistedTurns);

  // 时间线到这里才排完（落盘排好序 + 直播按到达追加），身份也才补得齐。必须排在下面
  // 那轮 continuation 判定之前：那一轮拿 reviewer 当断点用。
  applyVerifySpans(items);

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
    const firstTurn = !seenSessions.has(item.sessionId);
    seenSessions.add(item.sessionId);
    const turnStartedAt = item.session ? latestTurnStart(item.session) : null;
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
  let rightSessionId: string | undefined;
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index]!;
    // 旁注不收回合：一条还在飞的回合被它按上结束时刻，就会当场折叠、还挂出「派生新任务」
    //（用户 2026-09-14 反馈）。真回合结束自有 markerEndedAt / 回合边界事件来报。
    if (item.kind === "event" && item.aside) continue;
    if (item.kind === "user" || item.kind === "event") nextInterjectionAt = item.at ?? nextInterjectionAt;
    if (item.kind !== "agent") continue;
    if (item.sessionId !== rightSessionId) {
      nextInterjectionAt = null;
      nextAgentAt = null;
      rightSessionId = item.sessionId;
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
    nextAgentAt = item.at ?? nextAgentAt;
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
  let continuedSessionId: string | null = null;
  let continuedReviewer: string | null = null;
  for (const item of items) {
    if (item.kind === "user") { continuedSessionId = null; continue; }
    if (item.kind === "event") {
      if (item.variant === "boundary") continuedSessionId = null;
      continue;
    }
    item.continuation = continuedSessionId === item.sessionId && continuedReviewer === reviewerKey(item);
    continuedSessionId = item.sessionId;
    continuedReviewer = reviewerKey(item);
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
