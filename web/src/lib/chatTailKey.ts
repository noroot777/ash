import { contentVersion } from "./useStickToBottom.ts";

/* 群聊/侧聊/助手共用同一种消息。回复是流式来的:body 一边长、status 从 queued/running
   翻成终态,两样都要推动版本,否则正在打字的那一条长出屏幕也不会跟。
   规模取全部消息求和 —— 并发回复时在长的未必是最后一条。 */
export const chatTailKey = (messages: readonly { id: string; body: string; status: string }[] | undefined) =>
  contentVersion(messages ?? [], (message) => message.body.length, (message) => `${message.id}:${message.status}`);
