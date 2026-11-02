import type { scheduledMessages } from "./db/schema.js";
import { HandoffError, type HandoffMessagePayload } from "./handoff-types.js";
import { id } from "./util.js";

export function exportHandoffMessage(message: typeof scheduledMessages.$inferSelect): HandoffMessagePayload {
  return {
    text: message.text, attachments: message.attachments, agent: message.agent, model: message.model,
    reasoningEffort: message.reasoningEffort, sessionRole: message.sessionRole,
    origin: message.origin, reviewRun: message.reviewRun, reviewRound: message.reviewRound,
    mode: message.mode, sendAt: message.sendAt, createdAt: message.createdAt,
  };
}

export function validateMessageOrigin(message: HandoffMessagePayload): void {
  if ((message.origin != null && typeof message.origin !== "string")
    || (message.reviewRun != null && typeof message.reviewRun !== "string")
    || (message.reviewRound != null && (!Number.isSafeInteger(message.reviewRound) || message.reviewRound < 1))) {
    throw new HandoffError("message 审查来源非法");
  }
}

export function importMessageOrigin(message: HandoffMessagePayload, notes: string[]) {
  const guarded = message.origin === undefined || message.origin?.startsWith("review-")
    || message.sessionRole === "reviewer" || !!message.reviewRun;
  if (guarded) {
    notes.push("待发送消息的审查来源无法在本机授权，已隔离并将在投递时取消；请重新派审或重新提交消息。");
    return { origin: `review-${message.origin?.startsWith("review-settlement:") ? "settlement" : "answer"}:handoff-${id()}`,
      reviewRun: null, reviewRound: message.reviewRound ?? null };
  }
  return { origin: message.origin ?? null, reviewRun: null, reviewRound: message.reviewRound ?? null };
}
