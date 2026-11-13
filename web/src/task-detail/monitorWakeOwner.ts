// 「这一次叫醒是不是这一段等的那条哨兵」——比较只此一处（monitorWakeTurns 用它认归属）。
//
// 一段（monitorWakeTurns 文件头）攒下它认领的哨兵：段里每个回合挂的，以及并进来、或开这一段的那几次
// 叫醒点过名的。认同一条哨兵分三档，哪档有数据用哪档：
//
//   1. 哨兵 id。叫醒事件自己带着（`monitorWake.events[].monitorId`）；回合挂哨兵那一头现在还拿不到 id
//      （`start_monitor` 的入参里没有，时间线上的「哨兵已起」记录也还没带）——等那一头带上，在
//      `monitorStarts` 里把 id 填进 `MonitorStart.id` 就接上了，这里不用改。
//   2. 描述。回合里那次调用的描述（没写描述的，服务端拿命令顶上）和叫醒事件的 `source`，空白归一后相同。
//      一条描述只顶**一条**还没对上身份的哨兵：它第一次叫醒时就绑定到那个 id，之后只按 id 认——
//      描述相同、id 不同的另一条哨兵（同名重开的、更早那一段挂的）不归这一段。
//   3. 都没有：更老的叫醒没有结构化来源（只剩一段【哨兵事件】原文），这一段里挂过哨兵就算。
import type { ConversationItem } from "./conversationModel.ts";
import type { MonitorWakeInput } from "./monitorWakeModel.ts";
import { ashMcpTool } from "../lib/executionTrace.ts";

type AgentItem = Extract<ConversationItem, { kind: "agent" }>;

/** 一个回合里挂上的一条哨兵。 */
export type MonitorStart = { id?: string; source: string };

/**
 * 一段认领的哨兵：认得出身份的（`ids`），以及挂上了、还没对上身份的那几条（`unbound`：描述 → 条数）。
 * `any`：这一段挂过或认领过哨兵（给没有结构化来源的老叫醒用）。
 */
export type MonitorClaims = { ids: Set<string>; unbound: Map<string, number>; any: boolean };

export const emptyClaims = (): MonitorClaims => ({ ids: new Set(), unbound: new Map(), any: false });

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
    else if (start.source) claims.unbound.set(start.source, (claims.unbound.get(start.source) ?? 0) + 1);
  }
}

/** 认领这次叫醒里的哨兵：按描述对上的那条从「还没对上身份」里划掉，绑定成 id。 */
export function claimWake(claims: MonitorClaims, wake: MonitorWakeInput): void {
  claims.any = true;
  for (const event of wake.events) {
    if (claims.ids.has(event.monitorId)) continue;
    const source = normalized(event.source);
    const left = claims.unbound.get(source) ?? 0;
    if (left > 1) claims.unbound.set(source, left - 1);
    else claims.unbound.delete(source);
    claims.ids.add(event.monitorId);
  }
}

export function ownsWake(claims: MonitorClaims, wake: MonitorWakeInput): boolean {
  if (!wake.events.length) return claims.any;
  return wake.events.some((event) => claims.ids.has(event.monitorId) || claims.unbound.has(normalized(event.source)));
}
