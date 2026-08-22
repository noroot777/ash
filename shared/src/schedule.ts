// 定时重跑(Schedule)与待发送消息(ScheduledMessage)的形状。纯类型模块 —— 从 index.ts
// 拆出来只是为了不让那个文件继续长,消费方仍从 "@ash/shared" 导入,路径不变。
import type { AgentType } from "./index.ts";

// Schedules attach to a Task. Once = fire at a timestamp then disable; cron =
// recurring 5-field expression in local time. The scheduler only enqueues.
export interface Schedule {
  id: string;
  taskId: string;
  kind: "once" | "cron";
  at: string | null;
  cron: string | null;
  enabled: boolean;
  lastRunAt: string | null;
  createdAt: string;
}

// 一条「待发送消息」：不是重跑任务（那是 Schedule），而是等条件到了用
// continueTask 把这句话送进任务**原来那个会话**。两种到期条件，也就是 mode：
//   • timed  = 定时发送：等 `sendAt` 这个时刻到了再发（任务此刻在忙就继续等）
//   • queued = 排队追问：不看时间，任务一空下来就发（运行中还想补一句时用）
// 两者共用同一张表、同一条投递链路和同一个取消入口——区别只有「什么时候算到期」
// 这一条，其余（附件、@指派的执行器/模型/思考强度、托盘展示、取消）完全一样。
// 一个任务可以同时挂多条，按 `sendAt` 升序依次投递，每次只发一条。
export type ScheduledMessageStatus = "pending" | "sent" | "canceled";
export type ScheduledMessageMode = "timed" | "queued";
export interface ScheduledMessage {
  id: string;
  taskId: string;
  text: string;
  attachments: string[];
  agent: AgentType | null;
  // @指派时一并选定的执行器/模型/思考强度；null = 按 agent 的默认执行器 / 跟随执行器。
  executorId: string | null;
  model: string | null;
  reasoningEffort: string | null;
  mode: ScheduledMessageMode;
  // timed：ISO 到期发送时间。queued：入队时刻（排队消息不看时间，只用它排先后）。
  sendAt: string;
  status: ScheduledMessageStatus;
  createdAt: string;
  sentAt: string | null;
}
