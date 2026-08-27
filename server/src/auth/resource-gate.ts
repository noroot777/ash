// 资源级的横切闸:`/api/tasks/:id/…`、`/api/groups/:id/…`、`/api/projects/:id/…`、
// `/api/queues/:id/…`、`/api/sessions/:id/…` 一律先过一遍可见性,再落到各自的路由(§十二)。
//
// **为什么是中间件而不是每条路由自己查**:任务这一条轴上的端点有几十个,分散在
// task-routes / task-run-routes / task-reply / task-answer / task-accept /
// task-diff-routes / task-session-routes / free-workflow-routes / duet / team …
// 十几个文件里,还在继续长。逐条加判断的做法一定会漏,而漏掉的那条就是横向越权 ——
// 「对称端点只改了一个」是本仓库已经吃过的亏(docs/incidents.md)。
//
// 这道闸只管**看得见看不见**这一层。「看得见但只有管理员能删」这类更细的判断仍留在
// 各自路由里(它们的文案更准),两者是叠加关系,不是替代。
//
// **闸不管的那一类,各自路由必须自己补**:创建型端点(`POST /tasks`、`POST /groups`、
// `POST /queues`、`POST /notes`)把 projectId/taskId 放在**请求体**里,路径上还没有 id,
// 这道闸看不见它们。凡是新增这样的端点,自己那条路里得有一句 `canSeeProject`。
import type { MiddlewareHandler } from "hono";
import { eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { groups, queueItems, sessions, tasks } from "../db/schema.js";
import { actorOf } from "./context.js";
import { isMultiUser } from "./mode.js";
import { canSeeProject } from "./visibility.js";

/** `/api/tasks/abc/reply` → `["tasks", "abc", "reply"]` */
function segmentsOf(pathname: string): string[] {
  return pathname.replace(/^\/api\/?/, "").split("/").filter(Boolean);
}

// 这些第二段不是 id,而是同级的集合端点(如 `/tasks/follow-ups`、`/tasks/bodies`)。
// 它们自己做批量过滤,这里放过 —— 否则会拿 "follow-ups" 当 taskId 去查库。
const NOT_AN_ID = new Set(["follow-ups", "bodies", "batch", "check", "resolve", "search", "archived"]);

async function projectOfTask(taskId: string): Promise<string | null> {
  const row = (await db.select({ projectId: tasks.projectId }).from(tasks).where(eq(tasks.id, taskId))).at(0);
  return row?.projectId ?? null;
}

async function projectOfGroup(groupId: string): Promise<string | null> {
  const row = (await db.select({ projectId: groups.projectId }).from(groups).where(eq(groups.id, groupId))).at(0);
  return row?.projectId ?? null;
}

/**
 * 队列没有自己的项目列 —— 它的项目就是成员任务的项目(同 queue 必须同 group,
 * 所以取第一个成员即可)。空队列查不出项目,交给业务路由报它的 404。
 */
async function projectOfQueue(queueId: string): Promise<string | null> {
  const item = (await db.select({ taskId: queueItems.taskId }).from(queueItems).where(eq(queueItems.queueId, queueId))).at(0);
  return item ? await projectOfTask(item.taskId) : null;
}

/** 会话属于任务,任务属于项目。`/api/sessions/:id/output` 直接吐 agent 的完整 transcript。 */
async function projectOfSession(sessionId: string): Promise<string | null> {
  const row = (await db.select({ taskId: sessions.taskId }).from(sessions).where(eq(sessions.id, sessionId))).at(0);
  return row ? await projectOfTask(row.taskId) : null;
}

export function resourceGate(): MiddlewareHandler {
  return async (c, next) => {
    if (!c.req.path.startsWith("/api/")) return next();
    if (!(await isMultiUser())) return next();
    const actor = actorOf(c);
    // agent 回合的身份已经被 middleware.ts 绑到具体任务上了,但它照样要过这一关:
    // 一个 agent 拿自己的 turn token 去打别人任务的端点,同样是越权。
    const [kind, ident] = segmentsOf(c.req.path);
    if (!ident || NOT_AN_ID.has(ident)) return next();

    let projectId: string | null = null;
    if (kind === "tasks") projectId = await projectOfTask(ident);
    else if (kind === "groups") projectId = await projectOfGroup(ident);
    else if (kind === "projects") projectId = ident;
    // 队列与会话是**全局 id 路由**:路径里没有 task/project 段,所以第 1 轮审查前它们
    // 整个漏在闸外 —— 拿到 queueId 能读别人的任务标题、改别人的队列顺序,拿到
    // sessionId 能读完整 transcript。它们的项目要多跳一层才查得到,但判据同一份。
    else if (kind === "queues") projectId = await projectOfQueue(ident);
    else if (kind === "sessions") projectId = await projectOfSession(ident);
    else return next();

    // 资源不存在:交给业务路由去报 404(它知道该说「任务不存在」还是「分组不存在」)。
    if (!projectId) return next();
    if (await canSeeProject(actor, projectId)) return next();
    // 不存在与没权限回同一句话:否则挨个 id 试就成了一台存在性探测器。
    return c.json({ error: "not found" }, 404);
  };
}
