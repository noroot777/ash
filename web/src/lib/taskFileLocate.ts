import { useEffect, useSyncExternalStore } from "react";
import { api } from "./api.ts";
import { createTaskFileLocator, type TaskFileTarget } from "./taskFileLocator.ts";

// 会话正文里提到的路径「是不是工作区里真有的文件」——要不要把它画成可点的链接，只认这一问。
//
// 字符串长得像不像路径只能粗筛：`api.taskFileRawUrl`、`Node.js`、`origin/main` 都长得像，
// 照形状画成链接就是一堆点了报「文件不存在」的假入口。所以每个候选都去服务端问一次
// （`POST /tasks/:id/file/locate`），问的时候攒成一批：一条长会话里能有上百处路径，
// 渲染同一屏的那些在同一个 30ms 窗口里一起发出去。
//
// 缓存、过期和「挂着的过期了要重查」都在 taskFileLocator.ts，这里只接上 HTTP、页面可见性和 React。

export type { TaskFileTarget };

const locator = createTaskFileLocator({
  locate: async (taskId, paths) => (await api.locateTaskFiles(taskId, paths)).entries,
  timers: {
    setTimeout: (callback, ms) => window.setTimeout(callback, ms),
    clearTimeout: (handle) => window.clearTimeout(handle),
  },
  visible: () => document.visibilityState === "visible",
});

if (typeof document !== "undefined") {
  document.addEventListener("visibilitychange", () => locator.revisit());
}

/**
 * 这条路径在工作区里是什么：文件 / 目录（带归一后的相对路径）、`null` = 不在、
 * `undefined` = 还没问到。挂着的这段时间里答案会自己刷新（见 taskFileLocator）。
 */
export function useTaskFileTarget(taskId: string | null, path: string | null): TaskFileTarget | null | undefined {
  const entry = useSyncExternalStore(locator.subscribe, () => (taskId && path ? locator.peek(taskId, path) : undefined));
  useEffect(() => (taskId && path ? locator.watch(taskId, path) : undefined), [taskId, path]);
  return entry?.value;
}

/** 点下去的那一刻还没问到时用：不等攒批，马上问。 */
export const locateTaskFile = (taskId: string, path: string) => locator.locateNow(taskId, path);
