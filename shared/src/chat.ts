import type { AgentType, TaskListItem } from "./index.ts";

export interface ChatMember {
  id: string;
  name: string;
  agentType: AgentType;
  executorId: string | null;
  model: string | null;
  reasoningEffort: string | null;
}

export interface ChatRoom {
  id: string;
  projectId: string;
  name: string;
  members: ChatMember[];
  createdAt: string;
}

export type ChatMessageStatus = "queued" | "running" | "done" | "failed" | "stopped";

export interface ChatMessage {
  id: string;
  roomId: string;
  role: "user" | "agent";
  memberId: string | null;
  author: string;
  body: string;
  mentions: string[];
  status: ChatMessageStatus;
  taskId: string | null;
  createdAt: string;
}

export interface ChatSnapshot {
  room: ChatRoom;
  messages: ChatMessage[];
  tasks: TaskListItem[];
}

export function mentionedMembers(body: string, members: ChatMember[]): ChatMember[] {
  const prose = body.replace(/```[\s\S]*?(?:```|$)/gu, "").replace(/`[^`\n]*`/gu, "").replace(/^\s*>.*$/gmu, "");
  return members.filter((member) => {
    const name = member.name.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
    return new RegExp(`(?:^|\\s)@${name}(?=$|[\\s，。！？,:：;；.!?])`, "u").test(prose);
  });
}
