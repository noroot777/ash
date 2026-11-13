// 「这一次叫醒是不是这一段等的那条哨兵」——比较只此一处（monitorWakeTurns 用它认归属）。
//
// 一段（monitorWakeTurns 文件头）攒下它认领的哨兵：段里每个回合挂的，以及并进来、或开这一段的那几次
// 叫醒点过名的。认同一条哨兵分三档，哪档有数据用哪档：
//
//   1. 哨兵 id。叫醒事件自己带着（`monitorWake.events[].monitorId`）；回合挂哨兵那一头现在还拿不到 id
//      （`start_monitor` 的入参里没有，时间线上的「哨兵已起」记录也还没带）——等那一头带上，在
//      `monitorStarts` 里把 id 填进 `MonitorStart.id` 就接上了，这里不用改。
//   2. 描述。回合里那次调用的描述（没写描述的，服务端拿命令顶上）和叫醒事件的 `source`，空白归一后相同。
//   3. 都没有：更老的叫醒没有结构化来源（只剩一段【哨兵事件】原文），这一段里挂过哨兵就算。
import type { ConversationItem } from "./conversationModel.ts";
import type { MonitorWakeInput } from "./monitorWakeModel.ts";
import { ashMcpTool } from "../lib/executionTrace.ts";

type AgentItem = Extract<ConversationItem, { kind: "agent" }>;

/** 一个回合里挂上的一条哨兵。 */
export type MonitorStart = { id?: string; source: string };

/** 一段认领的哨兵。 */
export type MonitorClaims = { ids: Set<string>; sources: Set<string>; any: boolean };

export const emptyClaims = (): MonitorClaims => ({ ids: new Set(), sources: new Set(), any: false });

const normalized = (text: string) => text.replace(/\s+/g, " ").trim();

/**
 * 回合里挂了哪几条哨兵：ash 的 `start_monitor`，以及 claude 内置 `Monitor`——后者被服务端改道成同一份
 * 描述、命令的 ash 哨兵（server/src/claude-monitor-hook.ts），叫醒时报的就是这份描述。
 */
export function monitorStarts(item: AgentItem): MonitorStart[] {
  const out: MonitorStart[] = [];
  for (const segment of item.segments) {
    for (const event of segment.events) {
      if (event.kind !== "tool" || !(ashMcpTool(event.label) === "start_monitor" || event.label === "Monitor")) continue;
      out.push({ source: startSource(event.detail) });
    }
  }
  return out;
}

// 跟服务端定 description 的口径一致（monitor-create / claude-monitor-call）：描述，没有就是命令（ws 那种是地址）。
function startSource(detail: string | undefined): string {
  try {
    const input = JSON.parse(detail ?? "") as Record<string, unknown>;
    const text = (value: unknown) => typeof value === "string" ? value.trim() : "";
    const ws = input.ws && typeof input.ws === "object" ? input.ws as Record<string, unknown> : null;
    return normalized(text(input.description) || text(input.command) || (ws ? `ws: ${text(ws.url)}` : ""));
  } catch {
    return "";
  }
}

export function claimStarts(claims: MonitorClaims, item: AgentItem): void {
  for (const start of monitorStarts(item)) {
    claims.any = true;
    if (start.id) claims.ids.add(start.id);
    if (start.source) claims.sources.add(start.source);
  }
}

export function claimWake(claims: MonitorClaims, wake: MonitorWakeInput): void {
  claims.any = true;
  for (const event of wake.events) {
    claims.ids.add(event.monitorId);
    claims.sources.add(normalized(event.source));
  }
}

export function ownsWake(claims: MonitorClaims, wake: MonitorWakeInput): boolean {
  if (!wake.events.length) return claims.any;
  return wake.events.some((event) => claims.ids.has(event.monitorId) || claims.sources.has(normalized(event.source)));
}
