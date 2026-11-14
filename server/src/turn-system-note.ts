// 回合开头那几条〔系统〕提示(工作目录重建、基线换掉):落进会话正文(刷新后还在),
// 同时发一条一样的实时事件(开着的页面当场看见)。两件事总是一起做,拆成两句就会只做一半。
import type { AgentType, SessionRole } from "@ash/shared";
import { bus } from "./bus.js";
import { writeTurn } from "./transcript.js";

export type SystemNoteTarget = {
  out: NodeJS.WritableStream; taskId: string; sessionId: string; role: SessionRole; agentType: AgentType; at: string;
};

export function writeSystemNote(target: SystemNoteTarget, text: string): void {
  const { out, taskId, sessionId, role, agentType, at } = target;
  // 盘上那一行的身份（号 + 回合）实时事件原样带上，页面凭它认出这是同一条。
  const identity = writeTurn(out, { t: "system", agent: agentType, text }, at);
  bus.publish({ type: "agent.event", taskId, sessionId, role, agentType, ...identity, event: { kind: "system", text, at } });
}
