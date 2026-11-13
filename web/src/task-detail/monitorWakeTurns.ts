// 哨兵住进回合里（docs/ui-ux-audit feed-7）。
//
// 哨兵每叫醒一次，会话正文里就多一条「ash 自动输入」，后面跟着它的回复。照原样排，一段
// 话被切成七八截，每截都重报一遍头像和名字。这里把它们**并回等它的那一回合**：
//
//   · 叫醒那一下变成执行过程里的一步（「等 哨兵「…」 · 3m · 来了 2 条」），点开是送回来的那几行；
//   · 它醒来说的话接在同一回合后面——收口时 turnFold 照「最后一次动手」切，前面那几段自然
//     收进执行过程，外面只留最后那段话。
//
// 归属按**段**、按**哨兵的身份**认：
//
//   · 一段 = 同一条执行会话上连续的执行回合，中间没有别的输入（你的话、答复、审查意见这类系统代写的
//     输入、团队调度台的执行者来信）、没有审查者发言、没有审查轮的起止、没有**异常**结束（回合自己的结局，
//     见 turnFailure 的 turnFailed；不知道结局时退到两路都认得出的那几条记录，endsTurnAbnormally）。回合正常
//     结束（暂停等哨兵、完成）不打断一段——直播那一路每个回合后面都有一条回合边界，落盘重建那一路
//     没有，拿它当打断，开着页面看和刷新以后看就是两个样子。
//   · 一段里任何一个回合挂的哨兵都归这一段（比较见 monitorWakeOwner）。一次叫醒里只要有一条哨兵归
//     这一段，这次叫醒连同它的回复就并进这一段最后那个回合；并进去的那几行回合边界不再是边界，一起拿掉。
//   · 都不归这一段（等的时候你插了话、你的话之前挂的那条哨兵），另起一回合、头上写「被哨兵叫醒」。
//     它自己开一段，认下这次叫醒里的哨兵，同一条哨兵后面的叫醒接着并进它。
//   · 叫醒的是审查那条会话（或审查者正在这条会话上说话），不并：它有自己的卡。
//
// 叫醒一到就进回合：回复还没来（CLI 正在起进程）时，它已经是那个回合执行过程里的一步，回合回到
// 「在跑」；回复来了接在后面。不单独画一张「自动输入」卡。
//
// 只改排法，不改数据：并出来的那一条带着原来几条的出处（删除照旧能定位），id 取最后并进来的那一截
// （派生按 id 在原始条目里截上下文，截到它才带得上醒来后说的话）。
import { ASH_MCP_SERVER_NAME } from "@ash/shared/mcp";
import type { AgentContentSegment, ConversationItem } from "./conversationModel.ts";
import { monitorWakeInput, monitorWakePreview, type MonitorWakeInput } from "./monitorWakeModel.ts";
import { claimStarts, claimWake, emptyClaims, ownsWake, type MonitorClaims } from "./monitorWakeOwner.ts";
import { endsTurnAbnormally, turnFailed } from "./turnFailure.ts";
import { MONITOR_WAKE_TOOL } from "../lib/toolPhrase.ts";
import { durationBetween } from "./utils.ts";

type AgentItem = Extract<ConversationItem, { kind: "agent" }>;
type UserItem = Extract<ConversationItem, { kind: "user" }>;
type EventItem = Extract<ConversationItem, { kind: "event" }>;

export type MonitorWakeFoldOptions = {
  /** 这条旁注其实是说给它听的一次输入（团队调度台的执行者来信）：跟你的话一样打断一段。 */
  isInput?: (item: EventItem) => boolean;
};

/** 一段：最后那个回合在 out 里的位置、哪条会话、认领了哪些哨兵。 */
type Run = { anchor: number; sessionId: string; claims: MonitorClaims };

export function foldMonitorWakes(items: readonly ConversationItem[], options: MonitorWakeFoldOptions = {}): ConversationItem[] {
  const out: ConversationItem[] = [];
  let run = null as Run | null;
  // 审查者刚在这条会话上说过话、之后还没有别的输入：这时喂进这条会话的叫醒是给审查者的（就地验证
  // 跟执行者共用会话，回复还没来时只能这样认）。
  let reviewerSession: string | null = null;
  const breaks = (item: EventItem) => endsTurnAbnormally(item) || !!item.verify || !!options.isInput?.(item);
  // 叫醒和它的回复之间只许隔着旁注（回执、时间线记录）；隔着回合边界、审查轮起止、来信就不算它的回复。
  const transparent = (item: ConversationItem | undefined) => item?.kind === "event" && item.variant !== "boundary" && !breaks(item);
  for (let index = 0; index < items.length; index += 1) {
    const item = items[index]!;
    if (item.kind === "agent") {
      out.push(item);
      if (item.reviewer) {
        run = null;
        reviewerSession = item.sessionId;
        continue;
      }
      if (reviewerSession === item.sessionId) reviewerSession = null;
      if (run?.sessionId === item.sessionId) run.anchor = out.length - 1;
      else run = { anchor: out.length - 1, sessionId: item.sessionId, claims: emptyClaims() };
      claimStarts(run.claims, item);
      if (turnFailed(item)) run = null;
      continue;
    }
    if (item.kind === "event") {
      out.push(item);
      if (breaks(item)) {
        run = null;
        if (item.verify) reviewerSession = null;
      }
      continue;
    }
    const wake = monitorWakeInput(item);
    if (!wake) {
      out.push(item);
      run = null;
      reviewerSession = null;
      continue;
    }
    let next = index + 1;
    while (transparent(items[next])) next += 1;
    const candidate = items[next];
    const answered = candidate?.kind === "agent" && sameSession(candidate.sessionId, item) ? candidate : null;
    if (item.sessionRole === "reviewer" || answered?.reviewer || (reviewerSession !== null && sameSession(reviewerSession, item))) {
      out.push(item);
      run = null;
      continue;
    }
    const reply = answered;
    const between = reply ? items.slice(index + 1, next) : [];
    const settledAt = reply ? null : laterInputAt(items, index, transparent);
    if (run && sameSession(run.sessionId, item) && ownsWake(run.claims, wake)) {
      dropBoundaries(out, run.anchor);
      out[run.anchor] = joinTurn(out[run.anchor] as AgentItem, item, wake, reply, settledAt);
      out.push(...between);
    } else {
      const woken = wokenTurn(item, wake, reply, settledAt, items);
      if (!woken) {
        out.push(item);
        run = null;
        continue;
      }
      out.push(...between, woken);
      run = { anchor: out.length - 1, sessionId: woken.sessionId, claims: emptyClaims() };
    }
    claimWake(run.claims, wake);
    if (reply) {
      claimStarts(run.claims, reply);
      index = next;
      if (turnFailed(reply)) run = null;
    }
  }
  return out;
}

function sameSession(sessionId: string, wake: UserItem): boolean {
  return !wake.sessionId || !sessionId || sessionId === wake.sessionId;
}

/**
 * 没有回复的那次叫醒，回合到哪一刻算收口：后面还有别的输入，就是那一刻（它没开口就被接走了）；后面什么
 * 都没有，就是还在跑——叫醒送进会话的那一刻 CLI 已经在起了，回复正在路上。
 */
function laterInputAt(items: readonly ConversationItem[], index: number, transparent: (item: ConversationItem) => boolean): string | null {
  const later = items.slice(index + 1).find((item) => !transparent(item));
  if (!later) return null;
  return later.at ?? items[index]!.at ?? null;
}

// 并进来的这几截之间，前一截收口时落的那条回合边界（直播那一路的「本回合结束」）已经不是边界了。
function dropBoundaries(out: ConversationItem[], anchor: number): void {
  for (let index = out.length - 1; index > anchor; index -= 1) {
    if (out[index]!.kind === "event" && (out[index] as EventItem).variant === "boundary") out.splice(index, 1);
  }
}

function joinTurn(host: AgentItem, wake: UserItem, input: MonitorWakeInput, reply: AgentItem | null, settledAt: string | null): AgentItem {
  const segments = [...withBreak(host.segments), wakeSegment(wake, input, waitedFrom(host, wake))];
  if (!reply) {
    return {
      ...host,
      endedAt: settledAt,
      markerEndedAt: null,
      interrupted: false,
      turnOutcome: null,
      sources: [...host.sources ?? [], ...wake.sources ?? []],
      segments,
    };
  }
  return {
    ...host,
    id: reply.id,
    endedAt: reply.endedAt,
    markerEndedAt: reply.markerEndedAt,
    interrupted: reply.interrupted,
    turnOutcome: reply.turnOutcome,
    usage: reply.usage ?? host.usage,
    sessionUsage: reply.sessionUsage ?? host.sessionUsage,
    sessionContext: reply.sessionContext ?? host.sessionContext,
    showSessionMeta: host.showSessionMeta || reply.showSessionMeta,
    sources: [...host.sources ?? [], ...wake.sources ?? [], ...reply.sources ?? []],
    markdown: [host.markdown, reply.markdown].filter((text) => text.trim()).join("\n\n"),
    segments: [...segments, ...reply.segments],
  };
}

/** 另起的那一回合。还没有回复时照这条会话别处的回合补上身份；整条会话一句话都没说过，就只能留着那条输入。 */
function wokenTurn(
  wake: UserItem, input: MonitorWakeInput, reply: AgentItem | null, settledAt: string | null, items: readonly ConversationItem[],
): AgentItem | null {
  if (reply) {
    return {
      ...reply,
      continuation: false,
      wokenByMonitor: true,
      sources: [...wake.sources ?? [], ...reply.sources ?? []],
      segments: [wakeSegment(wake, input, null), ...reply.segments],
    };
  }
  const same = (item: ConversationItem): item is AgentItem => item.kind === "agent" && !item.reviewer && sameSession(item.sessionId, wake);
  const at = items.indexOf(wake);
  const template = items.slice(0, at).findLast(same) ?? items.slice(at + 1).find(same);
  if (!template) return null;
  return {
    kind: "agent",
    id: `${wake.id}:turn`,
    sessionId: wake.sessionId ?? template.sessionId,
    label: template.label,
    agentType: template.agentType,
    session: template.session,
    run: template.run,
    at: wake.at,
    endedAt: settledAt,
    markerEndedAt: null,
    continuation: false,
    wokenByMonitor: true,
    usage: null,
    markdown: "",
    sources: wake.sources,
    segments: [wakeSegment(wake, input, null)],
  };
}

/**
 * 从哪一刻起等的：上一截自己收口的时刻。落盘那一路有收口标记；直播那一路的回合边界不带时刻，退到会话行
 * 记的结束时刻（那一截收口后会话行就写上了）。上一截的结束时刻若只是拿这次叫醒推出来的，不能当起点。
 */
function waitedFrom(host: AgentItem, wake: UserItem): string | null {
  if (host.markerEndedAt) return host.markerEndedAt;
  const sessionEnd = host.session?.endedAt;
  if (sessionEnd && wake.at && Date.parse(sessionEnd) <= Date.parse(wake.at)) return sessionEnd;
  return host.endedAt && host.endedAt !== wake.at ? host.endedAt : null;
}

// 两回合的正文拼成一篇时，中间得断成两段——否则上一回合的最后一句和醒来后的第一句会被
// markdown 粘成同一段话。
function withBreak(segments: AgentContentSegment[]): AgentContentSegment[] {
  const last = segments.at(-1);
  if (!last || !last.markdown || last.markdown.endsWith("\n\n")) return segments;
  return [...segments.slice(0, -1), { ...last, markdown: `${last.markdown.replace(/\n?$/, "\n")}\n` }];
}

function wakeSegment(wake: UserItem, input: MonitorWakeInput, waitedFrom: string | null): AgentContentSegment {
  const endedOnly = input.events.length > 0 && input.events.every((event) => event.kind === "ended");
  const count = input.eventCount;
  const output = input.events.map((event) => monitorWakePreview(event.body)).filter(Boolean).join("\n\n");
  return {
    id: `${wake.id}:wake`,
    markdown: "",
    attachments: wake.attachments,
    events: [{
      kind: "tool",
      label: `mcp__${ASH_MCP_SERVER_NAME}__${MONITOR_WAKE_TOOL}`,
      at: wake.at,
      detail: JSON.stringify({
        source: input.source ?? "哨兵",
        waited: durationBetween(waitedFrom, wake.at) ?? "",
        got: endedOnly ? "结束了" : count === null ? "" : `来了 ${count} 条`,
        output,
        raw: wake.text,
      }),
    }],
  };
}
