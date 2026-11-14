// 任务「看过没有」的记录形状(server/src/db/schema-task-reads.ts 写了为什么要进库)。
// server 的 GET/PUT /api/task-reads 和 web 的 lib/taskReadSync.ts 共用这一份形状、校验、轮次算法和覆盖判据。
//
// 两个数，各管一件事，别混用：
//  · **round**(这一份)：看的那一刻任务停在的时刻(任务数据自己的时间戳，见 taskReadRound)。它在每台设备上
//    是同一个数，管「看过的是不是新一轮」：一个任务的 round 只增不减，记下的 round 不小于任务此刻的 round
//    就算看过(coversRead)。同一毫秒里的两种状态算同一轮。
//  · **rev**(服务端每个人一个计数，每写一次加一)：管「这份回执是不是过期的」。先发后到的旧回执 rev 小，
//    前端整份不认。
// 留哪几条(满额裁剪)两个都不看，看的是「最近一次看到它」—— 刚看过的旧任务不能因为任务本身老就被挤掉。

import { timeMs } from "./team.ts";

export type TaskReadEntry = {
  /** 看的那一刻任务停在哪一轮的样子(web readEventForTask)，留作排查。 */
  event: string;
  /** 那一轮的时刻，epoch 毫秒(taskReadRound)。 */
  round: number;
};

export type TaskReads = Record<string, TaskReadEntry>;

/** GET 的回执。owner = 服务端认的「这是谁的那份」(自用模式空串)；rev 见文件头。 */
export type TaskReadsSnapshot = { owner: string; rev: number; reads: TaskReads };
/** PUT 的回执；rejected = 不存在或看不见的任务。 */
export type TaskReadsWriteResult = TaskReadsSnapshot & { rejected: string[] };
/** PUT 的请求体。owner = 这批记录是谁看的；跟这次请求认证出来的人对不上，服务端 409、一条不写。 */
export type TaskReadsWrite = { owner: string; reads: TaskReads };

/** 一个人最多记这么多条，留最近看到的那些。 */
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

/** 记下的 stored 已经看到 mark 这一轮(或更新的一轮)了吗。新旧只认 round，两端都用这一条。 */
export const coversRead = (stored: TaskReadEntry | undefined, mark: TaskReadEntry): boolean =>
  !!stored && stored.round >= mark.round;

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
