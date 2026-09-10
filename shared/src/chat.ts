import type { AgentType, TaskListItem } from "./index.ts";
import type { WorkflowDef } from "./workflow.ts";

export interface AssistantResult {
  matches: { taskId: string; reason: string }[];
  queries: string[];
  workflow?: { name: string; description: string; def: WorkflowDef };
  workflowId?: string;
  workflowAvailable?: boolean;
}

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
  kind?: "chat" | "assistant";
}

export type ChatMessageStatus = "queued" | "running" | "done" | "failed" | "stopped";

export interface ChatMessage {
  id: string;
  roomId: string;
  role: "user" | "agent" | "system";
  memberId: string | null;
  author: string;
  body: string;
  mentions: string[];
  status: ChatMessageStatus;
  taskId: string | null;
  createdAt: string;
  assistant?: AssistantResult;
}

export interface ChatSnapshot {
  room: ChatRoom;
  messages: ChatMessage[];
  tasks: TaskListItem[];
  context?: ChatContextStatus;
}

export interface ChatContextStatus {
  status: "idle" | "compacting" | "failed" | "stopped";
  error: string | null;
  hasSummary: boolean;
  clearedAt: string | null;
}

export const isChatClearCommand = (body: string): boolean => /^\/clear$/iu.test(body.trim());

/** 召唤全体成员的保留名。成员名与别名同长时成员优先，所以老群里叫 all 的成员仍按成员匹配。 */
export const ALL_MENTION_ALIASES = ["all", "所有人"] as const;
/** 别名按大小写不敏感匹配，但成员名一直是大小写敏感的，所以只在这里展开字母的两种写法。 */
const ALL_MENTION_SOURCES = [{ source: "[aA][lL][lL]", length: 3 }, { source: "所有人", length: 3 }];

export const isAllMention = (value: string): boolean => (ALL_MENTION_ALIASES as readonly string[]).includes(value.trim().toLowerCase());

export function mentionedMembers(body: string, members: ChatMember[]): ChatMember[] {
  const prose = body.replace(/```[\s\S]*?(?:```|$)/gu, "").replace(/`[^`\n]*`/gu, "").replace(/^\s*>.*$/gmu, "");
  if (!members.length) return [];
  const alternatives = [
    ...members.map((member) => ({ length: member.name.length, source: member.name.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&") })),
    ...ALL_MENTION_SOURCES,
  ].sort((left, right) => right.length - left.length);
  const matched = new Set<string>();
  let everyone = false;
  const isWord = (value: string) => /[\p{L}\p{N}_·-]/u.test(value) && !/\p{Script=Han}/u.test(value);
  for (const match of prose.matchAll(new RegExp(`@(${alternatives.map((entry) => entry.source).join("|")})`, "gu"))) {
    const before = [...prose.slice(0, match.index)].at(-1) ?? "";
    const after = [...prose.slice(match.index + match[0].length)][0] ?? "";
    if (isWord(before) || before === "." || isWord(after)) continue;
    if (members.some((member) => member.name === match[1])) matched.add(match[1]!);
    else everyone = true;
  }
  return everyone ? members : members.filter((member) => matched.has(member.name));
}
