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

export function supportsChat(type: AgentType): boolean {
  return type === "claude";
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
  if (!members.length) return [];
  const names = [...members].sort((left, right) => right.name.length - left.name.length)
    .map((member) => member.name.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"));
  const matched = new Set<string>();
  const isWord = (value: string) => /[\p{L}\p{N}_·-]/u.test(value) && !/\p{Script=Han}/u.test(value);
  for (const match of prose.matchAll(new RegExp(`@(${names.join("|")})`, "gu"))) {
    const before = [...prose.slice(0, match.index)].at(-1) ?? "";
    const after = [...prose.slice(match.index + match[0].length)][0] ?? "";
    if (!isWord(before) && before !== "." && !isWord(after)) matched.add(match[1]!);
  }
  return members.filter((member) => matched.has(member.name));
}
