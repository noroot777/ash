// SSE 事件的可见性过滤(§十二 —— 计划把这一条点名成验收基准)。
//
// 全局事件流是最容易漏的那个面:它不是「一条查询加个 where」,而是一条已经建立好的
// 长连接,后端广播什么它就推什么。不过滤的话,共享同一台 ash 的两个人里,任何一个人
// 的任务标题、提问原文、agent 正文都会实时推给另一个人 —— 界面上看不到那个任务,
// 但 DevTools 的 Network 面板里一条不落。
//
// 判据只有一条:**事件所属任务的项目,这个人看不看得见**。与列表页共用
// visibility.ts 的同一份 visibleProjectIds,不另写一套。
//
// 两处缓存,都是为了让「每条事件一次 DB 查询」不成立:
//  ① taskId → projectId:任务不会换项目,所以这条缓存只增不改。
//  ② actor → 可见项目集合:按秒失效。改成员后最多 3 秒才生效 —— 权限收紧的即时性
//     换掉的是每条事件一次 join,这个取舍在「相互信任的小团队」这个定位下是划算的。
import { eq } from "drizzle-orm";
import type { ServerEvent } from "@ash/shared";
import { db } from "../db/index.js";
import { tasks } from "../db/schema.js";
import type { Actor } from "./context.js";
import { isMultiUser } from "./mode.js";
import { visibleProjectIds } from "./visibility.js";

const projectOfTask = new Map<string, string>();

/** 任务建出来时顺手填缓存 —— 那条事件本身就带着 projectId。 */
export function rememberTaskProject(taskId: string, projectId: string): void {
  projectOfTask.set(taskId, projectId);
}

export function forgetTask(taskId: string): void {
  projectOfTask.delete(taskId);
}

async function projectIdOf(taskId: string): Promise<string | null> {
  const hit = projectOfTask.get(taskId);
  if (hit) return hit;
  const row = (await db.select({ projectId: tasks.projectId }).from(tasks).where(eq(tasks.id, taskId))).at(0);
  if (!row) return null;
  projectOfTask.set(taskId, row.projectId);
  return row.projectId;
}

/** 事件挂在哪个任务上。所有 ServerEvent 变体要么带 taskId,要么带整个 task。 */
function taskIdOf(ev: ServerEvent): string | null {
  if ("taskId" in ev && typeof ev.taskId === "string") return ev.taskId;
  if ("task" in ev && ev.task) {
    rememberTaskProject(ev.task.id, ev.task.projectId);
    return ev.task.id;
  }
  return null;
}

const VISIBLE_TTL_MS = 3_000;

/**
 * 给一条 SSE 连接造一个过滤器。返回的函数是**同步**的 —— 它必须能在 bus 的回调里
 * 直接判断:回调是同步的,await 一下事件就得先排队,顺序会乱。所以可见集合走后台
 * 定时刷新,判断本身只读内存。
 */
export function makeEventFilter(actor: Actor): {
  allow: (ev: ServerEvent) => boolean;
  refresh: () => Promise<void>;
  stop: () => void;
} {
  let visible: Set<string> | null = null; // null = 不设限
  let unrestricted = true;
  let stopped = false;

  const refresh = async () => {
    if (stopped) return;
    if (!(await isMultiUser())) {
      unrestricted = true;
      visible = null;
      return;
    }
    visible = await visibleProjectIds(actor);
    unrestricted = visible === null;
  };

  const timer = setInterval(() => void refresh().catch(() => {}), VISIBLE_TTL_MS);
  // Node 的定时器会拖住进程退出;这条只是缓存刷新,不该有这个副作用。
  timer.unref?.();

  return {
    allow(ev) {
      if (unrestricted) return true;
      const taskId = taskIdOf(ev);
      // 认不出归属的事件一律**不推**。宁可漏一条无害的广播,也好过默认放行 ——
      // 将来新增一种事件时,忘了在这里登记的后果是「少显示了点东西」而不是越权。
      if (!taskId) return false;
      const projectId = projectOfTask.get(taskId);
      if (!projectId) {
        // 缓存没命中就先放过、同时后台补齐。这一条事件的代价是可能漏推给正确的人
        // (下一条同任务的事件就对了),而不是错推给错误的人 —— 所以这里返回 false。
        void projectIdOf(taskId).catch(() => {});
        return false;
      }
      return !!visible?.has(projectId);
    },
    refresh,
    stop() {
      stopped = true;
      clearInterval(timer);
    },
  };
}
