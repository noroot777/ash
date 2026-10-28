/* 「用户能读到多少输出」的唯一口径。
 *
 * 为什么要有这么一张表：贴底跟随靠「内容版本变没变」决定要不要把视口带下去，而内容版本
 * 是由这里算出的规模求和得来的。规模漏算哪一处，那一处的新输出就会长出屏幕而没人跟 ——
 * 这条路上栽过两次：
 *   ① 只看最后一行 —— 可新文字常追加在**前面**那条还没结束的回复上（末尾压着旁注）。
 *   ② 只数段落个数 —— 可连续思考是拼进**已有那条** event 的 detail 里的
 *      （executionTrace.ts 的 appendExecutionEvent），段落个数一动不动。
 *
 * 所以这里不再手写「markdown.length + segments.length」这种就手挑几个字段的算法，改成
 * 按结构逐字段登记：每张表都写成 `Record<keyof T, …>`，给结构**新增字段时会编译不过**，
 * 逼着下一个人当场回答「这个字段算不算用户能读到的内容」。
 *
 * 判据只有一条：**它变了，屏幕上用户能读到的东西变不变**。
 *   - 算：正文、思考与工具的原文、附件、结论/提示这类会被渲染出来的字。
 *   - 不算：身份、时刻、用量、折叠状态、会话元信息 —— 它们要么不渲染，要么渲染成不随
 *     阅读推进的角标。把它们算进来，复制按钮闪一下、账目数字刷新就会把人拽到底。
 */
import { isVisibleExecutionEvent } from "@ash/shared/native-work";
import type { ExecutionEvent } from "../lib/executionTrace.ts";
import type { AgentContentSegment } from "./conversationSegments.ts";
import type { ConversationItem } from "./conversationModel.ts";

/** 每个字段一条「它贡献多少可读内容」。可选字段也必须登记（`-?`），漏一个就编译不过。 */
type SizeTable<T> = { [K in keyof Required<T>]-?: (value: NonNullable<Required<T>[K]>) => number };

const sum = <T>(items: readonly T[], size: (item: T) => number): number => {
  let total = 0;
  for (const item of items) total += size(item);
  return total;
};

/** 按登记表把一个对象上所有「算数」的字段加起来。 */
const sized = <T extends object>(table: SizeTable<T>, keys: readonly (keyof T)[], value: T): number => {
  let total = 0;
  for (const key of keys) {
    const field = value[key];
    if (field === undefined || field === null) continue;
    total += (table[key] as (input: unknown) => number)(field);
  }
  return total;
};

const EXECUTION_EVENT_SIZE: SizeTable<ExecutionEvent> = {
  kind: () => 0,
  label: (value) => value.length,
  // 连续思考就是往这里拼 —— 第 4 轮审查漏的正是它。
  detail: (value) => value.length,
  at: () => 0,
  /* 子智能体那一格:只有 `type === "call"` 且没有 parentId 的才渲染成一行入口
     (shared 的 isVisibleExecutionEvent),那一行的字由上面的 label/detail 带出;
     卡片里的内容在子智能体抽屉里,由 NativeAgentConversation 自己的信号跟。 */
  nativeWork: () => 0,
};
const EXECUTION_EVENT_KEYS = Object.keys(EXECUTION_EVENT_SIZE) as (keyof ExecutionEvent)[];

/* 一条执行过程贡献多少可读的字。**不渲染的就是 0**:子智能体那条线会往同一串 events 里
   塞 activity / result / agent 通知,以及带 parentId 的嵌套调用 —— 它们在这个表面上压根
   不画出来(ExecutionTrace 的三个入口都先 filter 一道 `isVisibleExecutionEvent`),屏幕上
   一个字没变,算进规模就成了「没有新文字也自己跳到底」(审查第 5 轮 F1)。

   这道闸按**单条**设,不设在底下那个求和上:这样不论谁拿着一条 event 来问「它算多少字」,
   答案都跟屏幕一致;只拦聚合入口的话,下一个人新开一个单条调用点就绕过去了。

   注意闸只挡**不进 DOM** 的那些。用户自己把「执行过程」折起来不算:那些字还在 DOM 里、
   展开就能读,折叠期间来的新思考仍要推进版本,否则第 4 轮那条又会回来。 */
export const executionEventSize = (event: ExecutionEvent): number =>
  isVisibleExecutionEvent(event) ? sized(EXECUTION_EVENT_SIZE, EXECUTION_EVENT_KEYS, event) : 0;

/** 一串执行过程里有多少可读的字。 */
export const executionEventsSize = (events: readonly ExecutionEvent[]): number =>
  sum(events, executionEventSize);

const SEGMENT_SIZE: SizeTable<AgentContentSegment> = {
  id: () => 0,
  markdown: (value) => value.length,
  events: executionEventsSize,
  attachments: (value) => value.length,
  /* 来源标注不进 DOM:它只决定「这张图画在正文哪一句」,画出来的字由 markdown 那一格
     带出(配上之后正文里的目的地被改写成站内地址,长度变化也在 markdown 里)。 */
  attachmentSources: () => 0,
  // 等待状态只换折叠条那一行字,高度一个像素都不变 —— 算进规模就是「屏幕没动却自己跳到底」。
  // 它翻位时那条提示事件本来也会同时进 events,真正的新内容在那儿算过了。
  awaiting: () => 0,
};
const SEGMENT_KEYS = Object.keys(SEGMENT_SIZE) as (keyof AgentContentSegment)[];

export const segmentContentSize = (segment: AgentContentSegment): number =>
  sized(SEGMENT_SIZE, SEGMENT_KEYS, segment);

type AgentItem = Extract<ConversationItem, { kind: "agent" }>;
type UserItem = Extract<ConversationItem, { kind: "user" }>;
type EventItem = Extract<ConversationItem, { kind: "event" }>;

const AGENT_SIZE: SizeTable<AgentItem> = {
  kind: () => 0,
  id: () => 0,
  sessionId: () => 0,
  label: () => 0,
  at: () => 0,
  endedAt: () => 0,
  markerEndedAt: () => 0,
  interrupted: () => 0,
  showSessionMeta: () => 0,
  continuation: () => 0,
  session: () => 0,
  run: () => 0,
  reviewer: () => 0,
  // 这三样渲染成尾栏上的角标，不随阅读推进；算进来等于让账目刷新把人拽到底。
  usage: () => 0,
  sessionUsage: () => 0,
  sessionContext: () => 0,
  markdown: (value) => value.length,
  // 执行过程(思考/工具)挂在每个 segment 上,不在条目这一层。
  segments: (value) => sum(value, segmentContentSize),
};
const AGENT_KEYS = Object.keys(AGENT_SIZE) as (keyof AgentItem)[];

const USER_SIZE: SizeTable<UserItem> = {
  kind: () => 0,
  id: () => 0,
  at: () => 0,
  sessionId: () => 0,
  isAnswer: () => 0,
  bySystem: () => 0,
  monitorWake: (value) => value ? JSON.stringify(value).length : 0,
  text: (value) => value.length,
  attachments: (value) => value.length,
};
const USER_KEYS = Object.keys(USER_SIZE) as (keyof UserItem)[];

const EVENT_SIZE: SizeTable<EventItem> = {
  kind: () => 0,
  id: () => 0,
  at: () => 0,
  sessionId: () => 0,
  tone: () => 0,
  variant: () => 0,
  verify: () => 0,
  aside: () => 0,
  text: (value) => value.length,
};
const EVENT_KEYS = Object.keys(EVENT_SIZE) as (keyof EventItem)[];

/** 这一条会话条目里，用户能读到多少字。 */
export function conversationItemSize(item: ConversationItem): number {
  if (item.kind === "agent") return sized(AGENT_SIZE, AGENT_KEYS, item);
  if (item.kind === "user") return sized(USER_SIZE, USER_KEYS, item);
  return sized(EVENT_SIZE, EVENT_KEYS, item);
}
