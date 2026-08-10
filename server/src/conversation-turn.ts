import type { AgentType, SessionRole } from "@harness/shared";
import { bus } from "./bus.js";
import { writeTurn } from "./transcript.js";

export function recordUserConversationTurn(input: {
  taskId: string;
  sessionId: string;
  role: SessionRole;
  agentType: AgentType;
  out: NodeJS.WritableStream;
  text: string;
  at: string;
  bySystem?: boolean;
}): void {
  writeTurn(input.out, {
    t: "user",
    agent: input.agentType,
    text: input.text,
    ...(input.bySystem ? { by: "system" as const } : {}),
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
  });
}
