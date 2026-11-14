// 任务「看过没有」的记录形状(server/src/db/schema-task-reads.ts 写了为什么要进库)。
// server 的 GET/PUT /api/task-reads 和 web 的 lib/taskReadSync.ts 共用这一份形状、校验、合并规则和轮次算法。
//
// **新旧只认 round**：看的那一刻任务停在的时刻(任务数据自己的时间戳，见 taskReadRound)。它在每台设备上
// 是同一个数，所以两边能拿它比 —— 设备的钟(各台不一样)、请求到达的先后(断网重试、慢响应会颠倒)都不作数。
// 一个任务的 round 只增不减，于是合并就是「各条取 round 大的那份」：先发后到的旧响应、迟到的旧重试，
// 拿到哪边都盖不掉已经记下的新一轮。
import { timeMs } from "./team.ts";

export type TaskReadEntry = {
  /** 看的那一刻任务停在哪一轮(web readEventForTask)，round 相同时用它判是不是同一轮。 */
  event: string;
  /** 那一轮的时刻，epoch 毫秒(taskReadRound)。 */
  round: number;
};

export type TaskReads = Record<string, TaskReadEntry>;

/** GET 的回执；owner = 服务端认的「这是谁的那份」(自用模式空串)，web 按它分账号缓存。 */
export type TaskReadsSnapshot = { owner: string; reads: TaskReads };
/** PUT 的回执；rejected = 不存在或看不见的任务，web 把它们从自己那份里去掉，别一直重送。 */
export type TaskReadsWriteResult = TaskReadsSnapshot & { rejected: string[] };

/** 一个人最多记这么多条，留 round 最新的那些(两端按同一个数裁，裁出来的是同一批)。 */
export const TASK_READS_MAX = 500;
const EVENT_MAX_LEN = 200;
const TASK_ID_MAX_LEN = 100;

type RoundSource = { mode?: string | null; parentId?: string | null; updatedAt: string; endedAt?: string | null };

/**
 * 一个任务此刻的轮次。团队调度台看它和执行者里最晚的 updatedAt(活都写在执行者身上)，其余看
 * updatedAt / endedAt 里晚的那个。服务端拿库里那份再算一遍给上传的 round 封顶。
 */
export function taskReadRound(task: RoundSource, workers: Pick<RoundSource, "updatedAt">[] = []): number {
  if (task.mode === "team" && !task.parentId) {
    return [task, ...workers].reduce((latest, item) => Math.max(latest, timeMs(item.updatedAt) ?? 0), 0);
  }
  return Math.max(timeMs(task.updatedAt) ?? 0, timeMs(task.endedAt) ?? 0);
}

const isEntry = (value: unknown): value is TaskReadEntry =>
  !!value
  && typeof value === "object"
  && typeof (value as TaskReadEntry).event === "string"
  && (value as TaskReadEntry).event.length <= EVENT_MAX_LEN
  && typeof (value as TaskReadEntry).round === "number"
  && Number.isFinite((value as TaskReadEntry).round)
  && (value as TaskReadEntry).round >= 0;

/** 从一份不可信的 JSON 里挑出形状对的那几条(手改过的 localStorage、请求体、响应体都走这里)。 */
export function parseTaskReads(raw: unknown): TaskReads {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out: TaskReads = {};
  for (const [taskId, value] of Object.entries(raw)) {
    if (!taskId || taskId.length > TASK_ID_MAX_LEN || !isEntry(value)) continue;
    out[taskId] = { event: value.event, round: value.round };
  }
  return out;
}

/** b 是不是不旧于 a(同一轮也算：同一轮的两份是同一件事)。 */
export const notOlderRead = (a: TaskReadEntry | undefined, b: TaskReadEntry): boolean => !a || b.round >= a.round;

/** 合成一份：各条取 round 大的那份(同一轮取 incoming)，再裁到上限。 */
export function mergeTaskReads(base: TaskReads, incoming: TaskReads): TaskReads {
  const merged: TaskReads = { ...base };
  for (const [taskId, entry] of Object.entries(incoming)) {
    if (notOlderRead(merged[taskId], entry)) merged[taskId] = entry;
  }
  return trimTaskReads(merged);
}

export function trimTaskReads(reads: TaskReads): TaskReads {
  const entries = Object.entries(reads);
  if (entries.length <= TASK_READS_MAX) return reads;
  return Object.fromEntries(
    entries.sort((a, b) => b[1].round - a[1].round || (a[0] < b[0] ? -1 : 1)).slice(0, TASK_READS_MAX),
  );
}
