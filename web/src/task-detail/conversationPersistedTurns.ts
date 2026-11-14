// 落盘那一路：一条会话的 .md + trace 铺成气泡 —— 从 conversationModel.ts 拆出来（单文件 700 行的约定）。
// 直播那一路在 conversationLiveTurns。
//
// **只给老记录**：没有身份（`seq`）的那一截 —— 升级前写下的、团队调度台与 duet 的会话。带身份的由
// conversationAssembler 按身份归位，不走这里。下面那些按时刻切 trace、按旁注落点判并不并的推断，全是
// 因为老记录没有身份才不得不猜的，别再往上加。
import { ANSWER_PREFIX } from "@ash/shared";
import { segmentFingerprint, type ConvSeg } from "@ash/shared/session-output";
import { addUsage } from "@ash/shared/usage";
import { normalizeSessionNoteText } from "@ash/shared/session-notes";
import type { SessionTraceEntry } from "../lib/api.ts";
import type { Session } from "@ash/shared";
import type { ConversationItem, PersistedOrigin } from "./conversationModel.ts";
import { eventTone, isVerifyNote, verifyMark } from "./conversationNotes.ts";
import { reviewerKeyOf, reviewerOf, traceVerifyRound } from "./conversationReviewer.ts";
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
import type { PersistedTurnTimes } from "./conversationTurnParts.ts";
import { agentLabel, recordPersistedTurn, sessionRun } from "./conversationTurnParts.ts";
import { appendTraceFragments } from "./conversationTraceFragments.ts";
import { readSideEntries, segmentTraceWindow, strayTraceSources } from "./conversationTraceSources.ts";
import { persistedTurnFacts, tailTurnFacts } from "./turnFailure.ts";
import { resumeNoteOf } from "./turnCause.ts";

type AgentItem = Extract<ConversationItem, { kind: "agent" }>;

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
  target.turnStartedAt ??= chunk.turnStartedAt;
  target.markdown = [target.markdown, chunk.markdown].filter((text) => text.trim()).join("\n\n");
  target.segments.push(...chunk.segments);
  // 收口标记跟着后一截走：回合真正结束在哪一刻，只有最后那一截知道。
  target.markerEndedAt = chunk.markerEndedAt ?? target.markerEndedAt;
  target.usage = target.usage && chunk.usage ? addUsage(target.usage, chunk.usage) : chunk.usage ?? target.usage;
  target.run = target.run ?? chunk.run;
  // 回合事实整组跟着知道结局的那一截走（tailTurnFacts）：后一截认不出结局，就留着前一截的那一整组。
  Object.assign(target, tailTurnFacts(chunk.turnOutcome != null ? chunk : target));
  target.sources = [...target.sources ?? [], ...chunk.sources ?? []];
}

/**
 * 把一条落盘会话的老记录那一截（.md 的段 + 没有身份的 trace）铺成气泡，追加到 `items` 末尾。
 *
 * `segments` 是这条会话 .md 从头起的那一截（含删掉的段：序号是气泡的出处、回合边界按原位算，到
 * buildConversationItems 收尾再拿掉）。
 */
export function appendPersistedSession(
  items: ConversationItem[],
  // indices：每一段在整份 .md 里的原始序号（删除拿它指名）。带身份的段分走以后这里拿到的不再是整份，
  // 下标不能当序号用；缺省 = 拿到的就是整份。
  { session, segments, indices, trace }: { session: Session; segments: readonly ConvSeg[]; indices?: readonly number[]; trace: SessionTraceEntry[] },
  persistedTurns: PersistedTurnTimes,
): void {
  const origin = (index: number): PersistedOrigin => ({
    sources: [{ sessionId: session.id, index: indices?.[index] ?? index, fingerprint: segmentFingerprint(segments[index]!) }],
    ...(segments[index]!.deleted ? { deleted: true as const } : {}),
  });
  const sessionTrace = normalizedPersistedTrace(trace, session);
  const traceGroups = groupedTrace(sessionTrace);
  // 服务端读的时候接在末尾补出来的几条，删除出处的指纹不数它们（见 conversationTraceSources）。
  const readSide = readSideEntries(sessionTrace, session);
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
  // 插话一律是切点。**砸进回合中间的注记（trace 判 inside）只在前面有本回合正文、并且
  // 紧跟着的下一段就是本回合正文时才是切点**——不看它是哪一种记录：
  // - 紧跟着正文：那种情形下 parseSessionOutput 已经在 sentinel 处把正文切成了两段 agent，
  //   trace 不跟着切，前面那截（旁注常常正好落在 agent 刚吐出一两个字的时候）就会把整组
  //   trace 连同几百次工具调用一起领走，真正写正文的那一段一个事件都拿不到。
  // - 紧跟着的不是正文就不能切，哪怕再往后还有正文：切出来的那一截只有紧跟在切点后面的
  //   正文会来领（turnStartedAt 跟着切点走），这里却是又一条记录（两条记录夹着几步）、一条
  //   输入（等哨兵的那一回合就此收工，后面的正文是叫醒之后的新一轮），或者什么都没有。那一截
  //   没人认领，落进「无正文兜底气泡」凭空多出一颗，还排在真回合后面被当成「正在跑」；而直播
  //   那边旁注根本不拆气泡（见 appendAgent 跨旁注回捞当前回合），刷新前后就长得不一样了。
  //   不切，这几步就留在前面那截的那一组里，跟着它并进这一回合的气泡（删除出处见
  //   conversationTraceSources）。
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
        && verifyMark(normalizeSessionNoteText(segment.text), segment.notice)?.phase !== "start"
        && (midTurn || (placement === "unknown" && segment.aside))) {
        midTurnAt.add(segment.at);
      }
      if (midTurn
        ? proseSinceTurnStart && segments[index + 1]?.kind === "agent"
        : segments.slice(index + 1).some((later) => later.kind === "agent")) {
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
        sessionId: session.id,
        sessionRole: session.role,
        // 后端代写、占着真人回合的那种（验证打回、验收冲突）。照常渲染成 user 气泡，
        // 但「后续追问」不收它 —— 判据统一在 shared 的 isUserFollowUp。
        bySystem: segment.bySystem,
        monitorWake: segment.monitorWake,
        answerIds: segment.answerIds,
        ...origin(index),
      });
      turnStartedAt = segment.at ?? turnStartedAt;
      openTurn = null;
      acrossAside = false;
    } else if (segment.kind === "system") {
      recordPersistedTurn(persistedTurns, "system", segment.text, segment.at, session.id);
      // 旧版轮换文案落在用户 .md 里的原文带 Markdown 标记、措辞也不一样；旁注是纯文本
      // 渲染，不归一就会把星号原样露出来（@ash/shared/session-notes）。
      const text = normalizeSessionNoteText(segment.text);
      const resume = resumeNoteOf(text, segment.resume);
      items.push({
        kind: "event",
        id: `persisted:system:${session.id}:${index}`,
        text,
        at: segment.at,
        sessionId: session.id,
        // 服务端标了 notice 就照它的，别再去猜（见 conversationNotes 的 tone 注释）。
        tone: eventTone(text, segment.notice, segment.level),
        variant: "note",
        verify: isVerifyNote(text, segment.notice),
        aside: asideAt.has(segment.at ?? ""),
        ...(segment.notice ? { notice: segment.notice } : {}),
        ...(resume ? { resume } : {}),
        ...origin(index),
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
        agentType: session.agentType,
        sessionRole: session.role,
        at: turnStartedAt,
        turnStartedAt: traceEntries.at(-1)?.turnStartedAt ?? null,
        endedAt: null,
        markerEndedAt: segment.endedAt ?? null,
        ...persistedTurnFacts(session, traceEntries, turnStartedAt),
        session,
        run: traceRun(traceEntries) ?? sessionRun(session),
        reviewer: reviewerOf(traceVerifyRound(traceEntries), session?.role),
        usage: traceUsage(traceEntries),
        markdown: segment.text,
        segments: contentSegments(traceEntries, segment.text, `persisted:segment:${session.id}:${index}`),
        ...origin(index),
      };
      // 领到的步子落在这段正文的删除时间窗外（记录之后那几步）：另报成 trace 出处，删这颗
      // 气泡时一起删掉（见 conversationTraceSources）。
      if (!chunk.deleted) {
        chunk.sources!.push(...strayTraceSources(session.id, sessionTrace, readSide, traceEntries, segmentTraceWindow(segments, index)));
      }
      // 中间只隔着一条「那一刻回合还在飞」的旁注 —— 这就是同一回合的下半截，并回去。
      // 身份再核一道：同一条会话上换轮验证也算换人（reviewerKey），换了人就不是同一段
      // 话，哪怕旁注骗过了上面那道结构判据也粘不到一起。只有**自己带 run 事件**的那截
      // 才有资格报身份：回合起点才写 run，下半截通常一条都没有（就地验证的审查者在自己
      // 回合中间调 report_stage 就是这形状），拿它那份空身份去比就会把一个人的话劈成两
      // 半、后半截还丢掉模型信息。
      const ownIdentity = traceEntries.some((entry) => entry.event.kind === "run");
      const sameSpeaker = !ownIdentity || reviewerKeyOf(openTurn?.reviewer) === reviewerKeyOf(chunk.reviewer);
      // 删没删也得一样：并起来就分不开了，删掉的那半截会跟着留下来的一起显示。
      if (openTurn && acrossAside && sameSpeaker && !openTurn.deleted === !chunk.deleted) {
        mergeTurnChunk(openTurn, chunk);
      } else {
        items.push(chunk);
        openTurn = chunk;
      }
      acrossAside = false;
    }
  });
  // 没有正文、只剩执行过程的回合（conversationTraceFragments.ts）。
  appendTraceFragments(items, session, segments, traceGroups, consumedTrace, sessionTrace, readSide);
}
