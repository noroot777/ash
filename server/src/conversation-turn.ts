import type { AgentType, SessionRole } from "@ash/shared";
import type { MonitorWakeData } from "@ash/shared/monitor-wake";
import { bus } from "./bus.js";
import { writeTurn } from "./transcript.js";

export type UserTurnOrigin = { bySystem?: boolean; monitorWake?: MonitorWakeData };

export function recordUserConversationTurn(input: UserTurnOrigin & {
  taskId: string;
  sessionId: string;
  role: SessionRole;
  agentType: AgentType;
  out: NodeJS.WritableStream;
  text: string;
  at: string;
}): void {
  writeTurn(input.out, {
    t: "user",
    agent: input.agentType,
    text: input.text,
    ...(input.bySystem ? { by: "system" as const } : {}),
    ...(input.bySystem && input.monitorWake ? { monitorWake: input.monitorWake } : {}),
  }, input.at);
  bus.publish({
    type: "conversation.turn",
    taskId: input.taskId,
    sessionId: input.sessionId,
    role: input.role,
    agentType: input.agentType,
    text: input.text,
    at: input.at,
    ...(input.bySystem ? { bySystem: true as const } : {}),
    ...(input.bySystem && input.monitorWake ? { monitorWake: input.monitorWake } : {}),
  });
}
