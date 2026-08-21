import type { Group, Session, Task, TaskStatus } from "@ash/shared";
import { taskDisplayStatus } from "@ash/shared";
import { timeMs, type Batch, type FeedRow as SharedFeedRow } from "@ash/shared/team";
import type { ConversationItem } from "../task-detail/conversationModel.ts";

export type TeamFeedRow = SharedFeedRow<ConversationItem, Batch>;
export type LeadTurn = { from: number; to: number | null };

export type InboundMessage = {
  kind: "question" | "failed" | "done" | "note";
  title?: string;
  taskId?: string;
  body: string;
  raw: string;
};

const HALT_TEXT = "你按了「停止全组」";
const INBOUND_KIND: Record<string, InboundMessage["kind"]> = {
  执行者提问: "question",
  执行者失败: "failed",
  执行者完成: "done",
};
const INBOUND_HEAD = /^【(执行者提问|执行者失败|执行者完成)】「([\s\S]+?)」\(taskId=([^)]+)\)/;
const INBOUND_TAIL: Partial<Record<InboundMessage["kind"], RegExp>> = {
  question: /\n\n先调查/,
  failed: /。查它的会话与产物/,
  done: /。核查产物/,
};

export function parseInbound(text: string): InboundMessage[] | null {
  const rows = text.split("\n\n---\n\n").map((chunk) => {
    const raw = chunk.trim();
    const match = INBOUND_HEAD.exec(raw);
    if (!match) return { kind: "note" as const, body: raw, raw };
    const kind = INBOUND_KIND[match[1]!]!;
    let body = raw.slice(match[0].length).trim();
    const tail = INBOUND_TAIL[kind];
    if (tail) body = body.split(tail)[0]!.trim();
    if (kind === "question") body = body.replace(/^已暂停等你答复[,，]问题[:：]\s*/, "");
    return { kind, title: match[2], taskId: match[3], body, raw };
  });
  return rows.some((row) => row.kind !== "note") ? rows : null;
}

export function activeTeamHaltMarker(items: ConversationItem[]): boolean {
  let lastHalt = -1;
  items.forEach((item, index) => {
    if (item.kind === "event" && item.text.includes(HALT_TEXT)) lastHalt = index;
  });
  if (lastHalt < 0) return false;
  return !items.slice(lastHalt + 1).some((item) => item.kind === "user" || item.kind === "agent");
}

export function leadTurns(items: ConversationItem[]): LeadTurn[] {
  return items.flatMap((item) => {
    if (item.kind !== "agent") return [];
    const from = timeMs(item.at);
    return from === null ? [] : [{ from, to: timeMs(item.endedAt) }];
  });
}

export function teamFeedOptions() {
  return {
    itemStartTime: (item: ConversationItem) => item.at,
    itemEndTime: (item: ConversationItem) => item.kind === "agent" ? item.endedAt ?? item.at : item.at,
    batchTime: (batch: Batch) => batch.at,
    batchKey: (batch: Batch) => batch.key,
    itemKey: (item: ConversationItem) => item.id,
  };
}

export function executorLabel(task: Task): string {
  return task.executorLabel?.trim() || task.agentType || "执行者";
}

export function workerStatusText(task: Task, groupPaused = false): string {
  if (task.question) return "等答复";
  const display = taskDisplayStatus(task.status, task.stage, false).label;
  if (task.stage && task.status !== "failed" && task.status !== "canceled") {
    return `${display}${groupPaused ? " · 所属组已停止" : ""}`;
  }
  if (task.status === "queued" || task.status === "backlog") {
    if (groupPaused) return "未启动 · 所属组已停止";
    return task.queuePosition == null ? "待派" : `排队 · 第 ${task.queuePosition + 1} 位`;
  }
  if (task.status === "paused") {
    return groupPaused ? "已暂停 · 被停止全组打断" : `已暂停${task.resumePrompt ? " · 到检查点" : ""}`;
  }
  return `${display}${groupPaused ? " · 所属组已停止" : ""}`;
}

export function statusTone(task: Task): string {
  if (task.question) return "cyan";
  if (task.stage === "verify_failed" || task.status === "failed") return "red";
  if (task.stage === "verified" || task.stage === "awaiting_acceptance" || task.stage === "accepted") return "green";
  const tones: Record<TaskStatus, string> = {
    backlog: "gray",
    queued: "amber",
    running: "green",
    idle: "gray",
    awaiting_review: "amber",
    paused: "cyan",
    done: "green",
    failed: "red",
    canceled: "gray",
  };
  return tones[task.status];
}

export function teamLeadLabel(task: Task, session?: Session): string {
  return session?.executor?.trim() || task.team?.leadExecutorLabel?.trim() || task.team?.lead || task.executorLabel || "调度者";
}

export function teamWorkerLabel(task: Task): string {
  return task.team?.workerExecutorLabel?.trim() || task.team?.worker || "执行者";
}

export function teamReviewerLabel(task: Task): string {
  return task.team?.reviewerExecutorLabel?.trim()
    || task.team?.reviewerAgentType
    || task.team?.workerExecutorLabel?.trim()
    || task.team?.worker
    || "执行者";
}

export function pausedTeamGroups(groups: Group[]): Group[] {
  return groups.filter((group) => group.paused);
}
