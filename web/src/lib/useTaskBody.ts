import { useEffect, useState } from "react";
import type { Task, TaskListItem } from "@ash/shared";
import { api } from "./api.ts";
import { useServerEvents } from "./events.ts";

// 正文缓存。列表接口不带正文（见 shared 的 TaskListItem），要正文的表面按需单取；同一个
// 任务来回切只在第一次付一次请求。
//
// **不按 updatedAt 作废**：任务跑起来时 updatedAt 每来一条状态事件就前进一次，拿它当
// 缓存键等于把「省下来的整份列表」换成「每秒一次的正文请求」。正文只会被显式改写
// （patchTask），而那一定会发一条带完整 Task 的 task.updated —— 用事件流校正是精确的，
// 也是免费的。
const cache = new Map<string, string>();

// 同一 tick 内所有要正文的组件合成一次请求。审查工作台一屏能挂十几张执行者卡，每张
// 各发一个 GET 就是把「一个大响应」换成「十几个小响应」——那不是省，是换个地方费。
const pending = new Map<string, ((body: string | null) => void)[]>();
let flushing = false;

function flush(): void {
  flushing = false;
  const ids = [...pending.keys()];
  const waiters = new Map(pending);
  pending.clear();
  if (!ids.length) return;
  api.taskBodies(ids)
    .then((rows) => {
      for (const row of rows) cache.set(row.taskId, row.body);
      for (const [id, callbacks] of waiters) {
        const body = cache.get(id);
        // 请求成功但这个 id 没回来 = 任务已经不在了；给 null 让调用方停在「还没读到」，
        // 不要拿空字符串冒充「这个任务没写正文」。
        for (const callback of callbacks) callback(body ?? null);
      }
    })
    .catch(() => {
      for (const callbacks of waiters.values()) for (const callback of callbacks) callback(null);
    });
}

function requestBody(taskId: string, onDone: (body: string | null) => void): void {
  const waiters = pending.get(taskId);
  if (waiters) { waiters.push(onDone); return; }
  pending.set(taskId, [onDone]);
  if (flushing) return;
  flushing = true;
  queueMicrotask(flush);
}

/**
 * 把一行列表任务补成完整任务。
 *
 * 正文还没到手时返回 null —— 调用方据此决定渲染什么，而不是先塞一个空字符串糊过去：
 * 空正文和「还没读到」在界面上是两句不同的话，混成一句就是在编。
 */
export function useTaskBody(task: TaskListItem | null): Task | null {
  const taskId = task?.id ?? null;
  const [body, setBody] = useState<string | null>(() => (taskId ? cache.get(taskId) ?? null : null));

  useEffect(() => {
    if (!taskId) { setBody(null); return; }
    const cached = cache.get(taskId);
    if (cached !== undefined) { setBody(cached); return; }
    let alive = true;
    setBody(null);
    requestBody(taskId, (loaded) => { if (alive) setBody(loaded); });
    return () => { alive = false; };
  }, [taskId]);

  useServerEvents((event) => {
    if (event.type !== "task.created" && event.type !== "task.updated") return;
    // 没缓存过的不主动占位：缓存只覆盖真正被看过的任务。
    if (cache.has(event.task.id)) cache.set(event.task.id, event.task.body);
    if (event.task.id === taskId) setBody(event.task.body);
  });

  return task && body !== null ? { ...task, body } : null;
}
