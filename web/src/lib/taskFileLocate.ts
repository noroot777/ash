import { useEffect, useSyncExternalStore } from "react";
import { api } from "./api.ts";
import type { TaskFileLocate } from "./apiTypes.ts";

// 会话正文里提到的路径「是不是工作区里真有的文件」——要不要把它画成可点的链接，只认这一问。
//
// 字符串长得像不像路径只能粗筛：`api.taskFileRawUrl`、`Node.js`、`origin/main` 都长得像，
// 照形状画成链接就是一堆点了报「文件不存在」的假入口。所以每个候选都去服务端问一次
// （`POST /tasks/:id/file/locate`），问的时候攒成一批：一条长会话里能有上百处路径，
// 渲染同一屏的那些在同一个 30ms 窗口里一起发出去。
//
// 答案按任务缓存在模块里，换个气泡、折叠块重挂都不用再问。「不在」只记一小会儿：agent
// 常常先说要写哪个文件、过一会儿才真写出来，记久了那处就永远点不了。

export type TaskFileTarget = NonNullable<TaskFileLocate["entries"][string]>;

type Known = { value: TaskFileTarget | null; at: number };

const HIT_TTL = 5 * 60_000;
const MISS_TTL = 20_000;
const BATCH_WINDOW = 30;
/** 跟服务端 `MAX_LOCATE_PATHS` 同一个数：多了就拆成几批。 */
const BATCH_SIZE = 200;
const MAX_KNOWN = 5000;

const known = new Map<string, Known>();
const queued = new Map<string, Set<string>>();
const inflight = new Map<string, Promise<void>>();
const listeners = new Set<() => void>();
let flushTimer = 0;

const keyOf = (taskId: string, path: string) => `${taskId}\u0000${path}`;
const fresh = (entry: Known | undefined) =>
  !!entry && Date.now() - entry.at < (entry.value ? HIT_TTL : MISS_TTL);
const emit = () => { for (const listener of listeners) listener(); };

function settle(taskId: string, paths: readonly string[], entries: TaskFileLocate["entries"] | null) {
  if (known.size > MAX_KNOWN) known.clear();
  const at = Date.now();
  for (const path of paths) {
    known.set(keyOf(taskId, path), { value: entries?.[path] ?? null, at });
    inflight.delete(keyOf(taskId, path));
  }
  emit();
}

function flush() {
  window.clearTimeout(flushTimer);
  flushTimer = 0;
  for (const [taskId, paths] of queued) {
    const list = [...paths];
    for (let at = 0; at < list.length; at += BATCH_SIZE) {
      const chunk = list.slice(at, at + BATCH_SIZE);
      // 问不成（网络断了、服务端还是没有这条接口的老版本）就当「不在」：画成普通代码，
      // 过一会儿再问——比画一个点不开的链接强。
      const done = api.locateTaskFiles(taskId, chunk)
        .then(({ entries }) => settle(taskId, chunk, entries), () => settle(taskId, chunk, null));
      for (const path of chunk) inflight.set(keyOf(taskId, path), done);
    }
  }
  queued.clear();
}

function want(taskId: string, path: string) {
  const key = keyOf(taskId, path);
  if (fresh(known.get(key)) || inflight.has(key)) return;
  const paths = queued.get(taskId) ?? new Set<string>();
  paths.add(path);
  queued.set(taskId, paths);
  if (!flushTimer) flushTimer = window.setTimeout(flush, BATCH_WINDOW);
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/**
 * 这条路径在工作区里是什么：文件 / 目录（带归一后的相对路径）、`null` = 不在、
 * `undefined` = 还没问到。
 */
export function useTaskFileTarget(taskId: string | null, path: string | null): TaskFileTarget | null | undefined {
  const key = taskId && path ? keyOf(taskId, path) : null;
  const entry = useSyncExternalStore(subscribe, () => (key ? known.get(key) : undefined));
  useEffect(() => {
    if (taskId && path) want(taskId, path);
  }, [taskId, path]);
  return entry?.value;
}

/** 点下去的那一刻还没问到时用：不等攒批，马上问。 */
export async function locateTaskFile(taskId: string, path: string): Promise<TaskFileTarget | null> {
  const key = keyOf(taskId, path);
  const entry = known.get(key);
  if (fresh(entry)) return entry!.value;
  want(taskId, path);
  if (queued.size) flush();
  await inflight.get(key);
  return known.get(key)?.value ?? null;
}
