// 任务「看过没有」的记录形状(server/src/db/schema-task-reads.ts 写了为什么要进库)。
// server 的 GET/PUT /api/task-reads 和 web 的 lib/taskReadSync.ts 共用这一份形状、校验和条数上限。

export type TaskReadEntry = {
  /** 看的那一刻任务停在哪一轮(web readEventForTask)。 */
  event: string;
  /** 看的那一刻，epoch 毫秒。 */
  readAt: number;
};

export type TaskReads = Record<string, TaskReadEntry>;

/** 一个人最多记这么多条，按 readAt 留最新的(从前 localStorage 那份是 300，进库后放宽)。 */
export const TASK_READS_MAX = 500;
const EVENT_MAX_LEN = 200;
const TASK_ID_MAX_LEN = 100;

const isEntry = (value: unknown): value is TaskReadEntry =>
  !!value
  && typeof value === "object"
  && typeof (value as TaskReadEntry).event === "string"
  && (value as TaskReadEntry).event.length <= EVENT_MAX_LEN
  && typeof (value as TaskReadEntry).readAt === "number"
  && Number.isFinite((value as TaskReadEntry).readAt);

/** 从一份不可信的 JSON 里挑出形状对的那几条(手改过的 localStorage、请求体都走这里)。 */
export function parseTaskReads(raw: unknown): TaskReads {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out: TaskReads = {};
  for (const [taskId, value] of Object.entries(raw)) {
    if (!taskId || taskId.length > TASK_ID_MAX_LEN || !isEntry(value)) continue;
    out[taskId] = { event: value.event, readAt: value.readAt };
  }
  return out;
}

export function trimTaskReads(reads: TaskReads): TaskReads {
  const entries = Object.entries(reads);
  if (entries.length <= TASK_READS_MAX) return reads;
  return Object.fromEntries(entries.sort((a, b) => b[1].readAt - a[1].readAt).slice(0, TASK_READS_MAX));
}
