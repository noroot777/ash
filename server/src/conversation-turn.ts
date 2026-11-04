import type { AgentType, SessionRole } from "@ash/shared";
import type { MonitorWakeData } from "@ash/shared/monitor-wake";
import { bus } from "./bus.js";
import { writeTurn } from "./transcript.js";

export type UserTurnOrigin = { bySystem?: boolean; monitorWake?: MonitorWakeData };

/**
 * 这一句是不是**哨兵唤醒**。跟下面落转录的条件是同一份:回合记录上那一位
 * (`session_turns.monitor_wake`)和历史回填都按转录里的这一位认,两边口径不许漂。
 */
export const isMonitorWakeTurn = (origin: UserTurnOrigin): boolean => !!(origin.bySystem && origin.monitorWake);

export function recordUserConversationTurn(input: UserTurnOrigin & {
  taskId: string;
  sessionId: string;
  role: SessionRole;
  agentType: AgentType;
  out: NodeJS.WritableStream;
  text: string;
  at: string;
  /** 调用方给这一句的投递凭据（ContinueTaskOptions.deliveryKey），落盘供事后核对。 */
  eventKey?: string;
  /** 这一句承载的问答答复（ContinueTaskOptions.answerIds）：删除与问答卡按它认记录。 */
  answerIds?: readonly string[];
}): void {
  const answerIds = input.answerIds?.length ? { answerIds: [...input.answerIds] } : {};
  writeTurn(input.out, {
    t: "user",
    agent: input.agentType,
    text: input.text,
    ...(input.bySystem ? { by: "system" as const } : {}),
    ...(input.eventKey ? { eventKey: input.eventKey } : {}),
    ...answerIds,
    ...(isMonitorWakeTurn(input) ? { monitorWake: input.monitorWake } : {}),
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
    ...(isMonitorWakeTurn(input) ? { monitorWake: input.monitorWake } : {}),
    ...answerIds,
  });
}
