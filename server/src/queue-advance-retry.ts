import { dbClient } from "./db/index.js";

export type QueueAdvanceRequest = { taskId: string; directionEpoch: number; resumePromptGeneration: number };
const deferred = new Map<string, { timer: ReturnType<typeof setTimeout>; request: QueueAdvanceRequest }>();

export function deferQueueAdvance(queueId: string, request: QueueAdvanceRequest): void {
  if (dbClient.closed) return;
  const existing = deferred.get(queueId);
  if (existing) {
    existing.request = request;
    return;
  }
  const timer = setTimeout(() => {
    const current = deferred.get(queueId)?.request;
    deferred.delete(queueId);
    if (dbClient.closed || !current) return;
    void import("./scheduler.js").then(({ advanceQueue }) => advanceQueue(queueId, current))
      .catch((error) => {
        console.error(`[ash] 续跑交接补推失败 queue=${queueId}:`, error);
        deferQueueAdvance(queueId, current);
      });
  }, 1_000);
  timer.unref?.();
  deferred.set(queueId, { timer, request });
}
