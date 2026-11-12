// 哨兵住进回合里（docs/ui-ux-audit feed-7）。
//
// 哨兵每叫醒一次，会话正文里就多一条「ash 自动输入」，后面跟着它的回复。照原样排，一段
// 话被切成七八截，每截都重报一遍头像和名字。这里把它们**并回等它的那一回合**：
//
//   · 叫醒那一下变成执行过程里的一步（「等 哨兵「…」 · 3m · 来了 2 条」），点开是送回来的那几行；
//   · 它醒来说的话接在同一回合后面——收口时 turnFold 照「最后一次动手」切，前面那几段自然
//     收进执行过程，外面只留最后那段话。
//
// 不并的三种，叫醒另起一回合、头上写「被哨兵叫醒」：
//   · 等的时候你插过话（真人的话、审查意见、答复这类非哨兵输入都算）——你的话和它的回答
//     是另一回合，之后的叫醒不并进答你的那一回合；
//   · 中间隔着回合边界（异常结束之类）；
//   · 叫醒的是审查那条会话（或这一回合本身是审查者在说），它有自己的卡。
//
// 只改排法，不改数据：并出来的那一条带着原来几条的出处（删除照旧能定位），没有回复的叫醒
// （刚送进去、它还没开口）原样留着，由 ConversationFeed 照旧画那张折叠卡。
import { ASH_MCP_SERVER_NAME } from "@ash/shared/mcp";
import type { AgentContentSegment, ConversationItem } from "./conversationModel.ts";
import { monitorWakeInput, monitorWakePreview, type MonitorWakeInput } from "./monitorWakeModel.ts";
import { MONITOR_WAKE_TOOL } from "../lib/toolPhrase.ts";
import { ashMcpTool } from "../lib/executionTrace.ts";
import { durationBetween } from "./utils.ts";

type AgentItem = Extract<ConversationItem, { kind: "agent" }>;
type UserItem = Extract<ConversationItem, { kind: "user" }>;

export function foldMonitorWakes(items: readonly ConversationItem[]): ConversationItem[] {
  const out: ConversationItem[] = [];
  // 最近那一回合在 out 里的位置；-1 = 后面来的叫醒没有可并的回合。
  let anchor = -1;
  // 有哨兵在等着（某一回合挂过哨兵、还没等到它结束）。这时你发的话是「等的时候插话」，
  // 答你的那一回合不是等哨兵的那一回合，之后的叫醒不并进它。
  let waiting = false;
  let interjected = false;
  for (let index = 0; index < items.length; index += 1) {
    const item = items[index]!;
    if (item.kind === "agent") {
      out.push(item);
      anchor = item.reviewer || interjected ? -1 : out.length - 1;
      interjected = false;
      if (startsMonitor(item)) waiting = true;
      continue;
    }
    if (item.kind === "event") {
      out.push(item);
      if (item.variant === "boundary" || item.verify) anchor = -1;
      continue;
    }
    const wake = monitorWakeInput(item);
    if (!wake || item.sessionRole === "reviewer") {
      out.push(item);
      anchor = -1;
      if (!wake && waiting) interjected = true;
      continue;
    }
    if (wake.events.length && wake.events.every((event) => event.kind === "ended")) waiting = false;
    // 叫醒之后它的回复：中间只许隔着旁注（回执、时间线记录），隔着别的就不算它的回复。
    let next = index + 1;
    while (next < items.length && items[next]!.kind === "event" && (items[next] as { variant?: string }).variant !== "boundary") next += 1;
    const candidate = items[next];
    const reply = candidate?.kind === "agent" && !candidate.reviewer && sameSession(candidate, item) ? candidate : null;
    if (!reply) {
      out.push(item);
      anchor = -1;
      continue;
    }
    const between = items.slice(index + 1, next);
    const host = anchor >= 0 ? out[anchor] as AgentItem : null;
    if (host && sameSession(host, item)) {
      out[anchor] = joinTurn(host, item, wake, reply);
      out.push(...between);
    } else {
      out.push(...between, {
        ...reply,
        continuation: false,
        wokenByMonitor: true,
        sources: [...item.sources ?? [], ...reply.sources ?? []],
        segments: [wakeSegment(item, wake, null), ...reply.segments],
      });
      anchor = out.length - 1;
    }
    if (startsMonitor(reply)) waiting = true;
    interjected = false;
    index = next;
  }
  return out;
}

function startsMonitor(item: AgentItem): boolean {
  return item.segments.some((segment) => segment.events.some((event) =>
    event.kind === "tool" && ashMcpTool(event.label) === "start_monitor"));
}

function sameSession(agent: AgentItem, wake: UserItem): boolean {
  return !wake.sessionId || !agent.sessionId || agent.sessionId === wake.sessionId;
}

function joinTurn(host: AgentItem, wake: UserItem, input: MonitorWakeInput, reply: AgentItem): AgentItem {
  const markdown = [host.markdown, reply.markdown].filter((text) => text.trim()).join("\n\n");
  return {
    ...host,
    endedAt: reply.endedAt,
    interrupted: reply.interrupted,
    usage: reply.usage ?? host.usage,
    sessionUsage: reply.sessionUsage ?? host.sessionUsage,
    sessionContext: reply.sessionContext ?? host.sessionContext,
    showSessionMeta: host.showSessionMeta || reply.showSessionMeta,
    sources: [...host.sources ?? [], ...wake.sources ?? [], ...reply.sources ?? []],
    markdown,
    segments: [
      ...withBreak(host.segments),
      wakeSegment(wake, input, host.endedAt ?? null),
      ...reply.segments,
    ],
  };
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
