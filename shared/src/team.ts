import type { AgentType, Group, Task, TaskStatus } from "./index.ts";

// Team execution configuration. Reviewer fields intentionally mirror the
// lead/worker naming scheme: a stale reviewerExecutorId is resolved by the
// server through the same executor-profile fallback as the other two roles.
export interface TeamConfig {
  lead: AgentType;
  worker: AgentType;
  leadExecutorId?: string | null;
  workerExecutorId?: string | null;
  leadModel?: string | null;
  leadReasoningEffort?: string | null;
  workerModel?: string | null;
  workerReasoningEffort?: string | null;
  // Missing means enabled, preserving automatic review for older team rows.
  review?: boolean;
  reviewerAgentType?: AgentType;
  reviewerExecutorId?: string | null;
  reviewerModel?: string | null;
  reviewerReasoningEffort?: string | null;
  leadExecutorLabel?: string | null;
  workerExecutorLabel?: string | null;
  reviewerExecutorLabel?: string | null;
}

export type ReviewConclusion = "verified" | "verify_failed" | null;

export interface TaskReviewRound {
  round: number;
  reviewTaskId: string;
  reviewTaskStatus: TaskStatus;
  conclusion: ReviewConclusion;
  reportMarkdown: string;
  screenshots: string[];
}

export interface TaskReviewInfo {
  reviewRequested: boolean;
  rounds: TaskReviewRound[];
}

export interface ReviewDispatchInput {
  agentType?: AgentType;
  executorId?: string | null;
  model?: string | null;
  reasoningEffort?: string | null;
}

// Pure team-view derivations shared by web and mobile. They deliberately know
// nothing about either client's conversation model or rendering layer.

// Conversation markers, session metadata, and task fields can carry different
// parseable timestamp formats. Team feeds must compare instants, never strings.
export function timeMs(value?: string | null): number | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export type FeedRow<Item, BatchItem> =
  | { kind: "conv"; key: string; item: Item }
  | { kind: "batch"; key: string; batch: BatchItem };

export type MergeFeedOptions<Item, BatchItem> = {
  itemStartTime: (item: Item, index: number) => string | null | undefined;
  itemEndTime: (item: Item, index: number) => string | null | undefined;
  batchTime: (batch: BatchItem, index: number) => string | null | undefined;
  itemKey?: (item: Item, index: number) => string | number;
  batchKey?: (batch: BatchItem, index: number) => string | number;
};

// Merge timestamped cards into a conversation-like item stream. Items expose
// only their start/end boundaries through callbacks, so web and mobile can keep
// their own parsing models while sharing the ordering semantics.
export function mergeFeed<Item, BatchItem>(
  items: readonly Item[],
  batches: readonly BatchItem[],
  options: MergeFeedOptions<Item, BatchItem>,
): FeedRow<Item, BatchItem>[] {
  // Untimed items inherit the previous known end boundary so insertion points
  // remain monotonic instead of jumping around sparse historical transcripts.
  let known: number | null = null;
  const itemEnds = items.map((item, index) => (
    known = timeMs(options.itemEndTime(item, index)) ?? known
  ));
  // Invalid batch timestamps have no reliable insertion point and remain stable
  // at the end. Batches at the same instant preserve their input order.
  const sorted = batches
    .map((batch, index) => ({ batch, index, at: timeMs(options.batchTime(batch, index)) }))
    .sort((a, b) => {
      if (a.at === null) return b.at === null ? a.index - b.index : 1;
      if (b.at === null) return -1;
      return a.at - b.at || a.index - b.index;
    });
  const rows: FeedRow<Item, BatchItem>[] = [];
  const itemKey = options.itemKey ?? ((_item: Item, index: number) => index);
  const batchKey = options.batchKey ?? ((_batch: BatchItem, index: number) => index);
  let batchIndex = 0;
  const flushThrough = (upTo: number | null) => {
    if (upTo === null) return;
    while (
      batchIndex < sorted.length
      && sorted[batchIndex]!.at !== null
      && sorted[batchIndex]!.at! <= upTo
    ) {
      const { batch, index } = sorted[batchIndex++]!;
      rows.push({ kind: "batch", key: `b:${batchKey(batch, index)}`, batch });
    }
  };

  items.forEach((item, index) => {
    // A client can mount after historical transcript rows were intentionally
    // omitted. Cards clearly older than the first visible row belong before it.
    if (index === 0) flushThrough(timeMs(options.itemStartTime(item, index)));
    // A dispatch created during an item belongs after that item. Therefore each
    // insertion is decided against the previous item's end, not the current start.
    if (index > 0) flushThrough(itemEnds[index - 1] ?? null);
    rows.push({ kind: "conv", key: `c:${itemKey(item, index)}`, item });
  });

  // Cards newer than the last known boundary, plus invalid timestamps, stay at
  // the end in stable order.
  while (batchIndex < sorted.length) {
    const { batch, index } = sorted[batchIndex++]!;
    rows.push({ kind: "batch", key: `b:${batchKey(batch, index)}`, batch });
  }
  return rows;
}

export type Batch = {
  key: string;
  workers: Task[];
  serial: boolean;
  at: string;
  group?: Group;
};

export function workersOf(all: Task[], leadId: string): Task[] {
  return all
    .filter((task) => task.parentId === leadId)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

export function batchesOf(workers: Task[], groups: Group[] = []): Batch[] {
  const byGroup = new Map<string, Task[]>();
  for (const worker of workers) {
    const key = worker.groupId ?? `solo:${worker.id}`;
    const batch = byGroup.get(key);
    if (batch) batch.push(worker);
    else byGroup.set(key, [worker]);
  }
  const groupById = new Map(groups.map((group) => [group.id, group]));
  return [...byGroup.entries()]
    .map(([key, batchWorkers]) => ({
      key,
      workers: batchWorkers,
      serial: batchWorkers.some((worker) => !!worker.queueId),
      at: batchWorkers.reduce(
        (earliest, worker) => (worker.createdAt < earliest ? worker.createdAt : earliest),
        batchWorkers[0]!.createdAt,
      ),
      group: groupById.get(key),
    }))
    .sort((a, b) => a.at.localeCompare(b.at));
}

// Prefer the explicit owner backlink. Worker group ids remain a compatibility
// fallback for data created before ownerTaskId was returned to clients.
export function teamGroupsOf(groups: Group[], leadId: string, workers: Task[]): Group[] {
  const workerGroupIds = new Set(workers.map((worker) => worker.groupId).filter((id): id is string => !!id));
  return groups
    .filter((group) => group.ownerTaskId === leadId || workerGroupIds.has(group.id))
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

export type WorkerHaltStats = {
  interrupted: number;
  completed: number;
  waiting: number;
  running: number;
};

export function workerHaltStats(workers: Task[]): WorkerHaltStats {
  return {
    interrupted: workers.filter((worker) => worker.status === "paused" && !worker.question).length,
    completed: workers.filter((worker) => worker.status === "done").length,
    waiting: workers.filter((worker) => worker.status === "backlog" || worker.status === "queued").length,
    running: workers.filter((worker) => worker.status === "running").length,
  };
}

const ACTIVE_WORKER_STATUSES = new Set<TaskStatus>(["running", "queued", "paused"]);

// Settled is presentation-only: the lead is not speaking and no worker is live,
// queued, or paused. It is intentionally independent from whether a group was halted.
export function isTeamSettled(leadLive: boolean, workers: Task[]): boolean {
  return !leadLive && !workers.some((worker) => ACTIVE_WORKER_STATUSES.has(worker.status));
}

// 团队从没开过台 ⟺ 还停在 backlog。开过之后调度台只在 running(忙)/idle(闲)之间
// 摆动(重启后 reconcileInterrupted 也一律置 idle),而 idle 说句话就会 --resume 接回
// 同一会话 —— 所以「运行」按钮只服务第一次开工,不再兼职做「接回」。
export function teamNeverStarted(status: TaskStatus): boolean {
  return status !== "running" && status !== "idle";
}

export type CountBucket = {
  label: string;
  status: TaskStatus;
  awaitingAnswer?: boolean;
  n: number;
};

export function statusCounts(workers: Task[]): CountBucket[] {
  const count = (pick: (task: Task) => boolean) => workers.filter(pick).length;
  const asking = (task: Task) => !!task.question;
  const buckets: CountBucket[] = [
    { label: "等答复", status: "paused", awaitingAnswer: true, n: count(asking) },
    { label: "干活", status: "running", n: count((task) => !asking(task) && task.status === "running") },
    {
      label: "排队",
      status: "queued",
      n: count((task) => !asking(task) && (task.status === "queued" || task.status === "backlog")),
    },
    { label: "暂停", status: "paused", n: count((task) => !asking(task) && task.status === "paused") },
    { label: "挂了", status: "failed", n: count((task) => task.status === "failed") },
    { label: "完成", status: "done", n: count((task) => task.status === "done") },
    { label: "取消", status: "canceled", n: count((task) => task.status === "canceled") },
  ];
  return buckets.filter((bucket) => bucket.n > 0);
}

export type Waiting = { task: Task; since: string | null };

export function waitingWorkers(workers: Task[]): Waiting[] {
  return workers
    .filter((worker) => !!worker.question)
    .map((worker) => ({ task: worker, since: worker.endedAt ?? worker.startedAt ?? null }))
    .sort((a, b) => (a.since ?? "").localeCompare(b.since ?? ""));
}

export function agentMix(workers: Pick<Task, "executorLabel" | "agentType">[]): string {
  const counts = new Map<string, number>();
  for (const worker of workers) {
    const label = worker.executorLabel?.trim() || worker.agentType?.trim() || "—";
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  return [...counts.entries()].map(([label, count]) => `${label}×${count}`).join(" · ");
}
