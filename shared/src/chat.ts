import type { AgentType, TaskListItem } from "./index.ts";
import type { WorkflowDef } from "./workflow.ts";
import { parseAttachmentText } from "./attachments.ts";

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
  kind?: "chat" | "assistant" | "side";
  parentTaskId?: string | null;
  /** 侧聊列表才有：这一场的第一句话（{@link sideChatTitle}），界面拿它当这一场的名字。 */
  title?: string;
}

/**
 * 侧聊里带着主会话选文发出去的一条，正文是这个固定格式（web 的 sideChatMessageBody 拼，
 * 智能体读的就是它）：先是那一段选文（每行加 `> `），再是你问的那句。
 */
export const SIDE_QUOTE_HEAD = "【主会话选文，仅作参考】";
export const SIDE_QUESTION_HEAD = "【当前问题】";

export function sideChatBody(question: string, quote: string | null): string {
  if (!quote) return question;
  return `${SIDE_QUOTE_HEAD}\n${quote.split(/\r\n|\r|\n/u).map((line) => `> ${line}`).join("\n")}\n\n${SIDE_QUESTION_HEAD}\n${question}`;
}

/** 把上面那个格式拆回「那一段选文」和「你问的那句」；不是这个格式的原样当问题。 */
export function splitSideChatBody(body: string): { quote: string | null; question: string } {
  if (!body.startsWith(`${SIDE_QUOTE_HEAD}\n`)) return { quote: null, question: body };
  const marker = `\n\n${SIDE_QUESTION_HEAD}\n`;
  const at = body.indexOf(marker);
  if (at < 0) return { quote: null, question: body };
  const quote = body.slice(SIDE_QUOTE_HEAD.length + 1, at).split("\n").map((line) => line.replace(/^> ?/u, "")).join("\n");
  return { quote, question: body.slice(at + marker.length) };
}

/** 一场侧聊的名字：第一句话问的那句（去掉选文和附件），截到第一个句末标点或 40 个字。 */
export function sideChatTitle(body: string): string {
  const question = parseAttachmentText(splitSideChatBody(body).question).body;
  const line = question.split("\n").map((part) => part.trim()).find(Boolean) ?? "";
  const sentence = /^.*?[。！？!?]/u.exec(line)?.[0] ?? line;
  return [...sentence].length > 40 ? `${[...sentence].slice(0, 40).join("")}…` : sentence;
}

export type ChatMessageStatus = "queued" | "running" | "done" | "failed" | "stopped";

/**
 * 一条聊天回复的「执行过程」里的一行(工具 / 思考 / 异常)。形状跟主会话那份
 * (web 的 `lib/executionTrace.ts` `ExecutionEvent`)对齐，两边共用同一个折叠块组件，
 * 标签也用同一套词(思考 → 「思考过程」，异常 → 直接拿报错当标签)。
 */
export interface ChatTraceEvent {
  kind: "tool" | "thinking" | "error" | "notice";
  label: string;
  detail?: string;
}

/**
 * 一条回复能记多少执行过程。上限**不是**产品策略（侧聊本身不限步数），纯粹因为这份记录
 * 跟着**每一次**房间快照走（SSE 每秒一整份），不封顶时一次跑飞的咨询就能把快照撑成几 MB。
 * 所以按「一次深入调研跑几百步也记得下」定档，而不是按「咨询该跑多少步」定档。
 * 撞上限不静默：`ChatTraceLog` 会补一行说明，别让用户以为它只干了这么点事。
 */
export const CHAT_TRACE_LIMITS = { events: 600, detail: 800, total: 120_000 } as const;

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
  /** 这条回复跑过的工具/思考/异常，跑的中途就随快照流出来，跑完仍留在原地。 */
  trace?: ChatTraceEvent[];
  /** 智能体回复：回应的是哪一条用户消息。加这一列之前的老回复为 null。 */
  replyTo?: string | null;
  forwardError?: string | null;
  forward?: {
    messageId: string;
    taskId: string;
    text: string;
    status: "queued" | "delivering" | "sent" | "canceled" | "unavailable";
  };
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
