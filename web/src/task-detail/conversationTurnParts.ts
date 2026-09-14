// 「落盘那一路」和「直播那一路」都要用的几件小东西。放这儿只是为了两边共用同一份判据,
// 别在这里堆逻辑:结构在 conversationModel(落盘 + 收口),直播增量在 conversationLiveTurns。
import type { ServerEvent, Session } from "@ash/shared";

export type LiveAgentEvent = Extract<ServerEvent, { type: "agent.event" }>;

/** 同一条 user/system 回合在 .md 里落过的时刻们（直播那份重复拷贝靠它认出来）。 */
export type PersistedTurnTimes = Map<string, number[]>;

export type AgentRun = { model: string | null; reasoningEffort: string | null };

export const compactTurnText = (text: string) => text.replace(/\s+/g, "");

export function turnKey(kind: "user" | "system", text: string, sessionId?: string): string {
  return `${kind}\0${sessionId ?? ""}\0${compactTurnText(text)}`;
}

export function recordPersistedTurn(
  turns: PersistedTurnTimes,
  kind: "user" | "system",
  text: string,
  at: string | undefined,
  sessionId?: string,
): void {
  const time = at ? Date.parse(at) : Number.NaN;
  if (!Number.isFinite(time)) return;
  const key = turnKey(kind, text, sessionId);
  turns.set(key, [...(turns.get(key) ?? []), time]);
}

export function sessionRun(session: Session | undefined): AgentRun | undefined {
  if (!session || (session.model === undefined && session.reasoningEffort === undefined)) return undefined;
  return {
    model: session.model?.trim() || null,
    reasoningEffort: session.reasoningEffort?.trim() || null,
  };
}

export function agentLabel(session: Session | undefined, event?: LiveAgentEvent): string {
  if (session?.executor) return session.executor;
  return event?.agentType ?? session?.agentType ?? "执行者";
}

export function latestTurnStart(session: Session): string | null {
  if (!("turnStartedAt" in session)) return null;
  return typeof session.turnStartedAt === "string" ? session.turnStartedAt : null;
}
