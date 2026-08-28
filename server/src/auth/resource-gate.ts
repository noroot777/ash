// 资源级的横切闸:`/api/tasks/:id/…`、`/api/groups/:id/…`、`/api/projects/:id/…`、
// `/api/queues/:id/…`、`/api/sessions/:id/…`、`/api/scheduled-messages/:id/…`
// 一律先过一遍可见性,再落到各自的路由(§十二)。
//
// **为什么是中间件而不是每条路由自己查**:任务这一条轴上的端点有几十个,分散在
// task-routes / task-run-routes / task-reply / task-answer / task-accept /
// task-diff-routes / task-session-routes / free-workflow-routes / duet / team …
// 十几个文件里,还在继续长。逐条加判断的做法一定会漏,而漏掉的那条就是横向越权 ——
// 「对称端点只改了一个」是本仓库已经吃过的亏(docs/incidents.md)。
//
// 判断一条路由属不属于这道闸,看的是**第一段**:凡是 `/api/<集合>/<id>/…` 形状、而那个
// id 又能一路查回项目的,都该在下面的 `PROJECT_OF` 里有一行。新开这样一个集合就顺手加
// 一行 ——
// 「全局 id 路由整个漏在闸外」这个洞已经被审出来两次了(queues/sessions、scheduled-messages)。
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
import { groups, scheduledMessages, sessions, tasks } from "../db/schema.js";
import { actorOf } from "./context.js";
import { isMultiUser } from "./mode.js";
import { canSeeProject, projectOfQueue } from "./visibility.js";

/** `/api/tasks/abc/reply` → `["tasks", "abc", "reply"]` */
function segmentsOf(pathname: string): string[] {
  return pathname.replace(/^\/api\/?/, "").split("/").filter(Boolean);
}

// 这些第二段不是 id,而是同级的集合端点(如 `/tasks/follow-ups`、`/projects/clone`)。
// 它们自己做批量过滤或自带鉴权,这里放过 —— 否则会拿 "follow-ups" 当 taskId 去查库。
//
// **漏一条的后果不对称**:tasks / groups / queues / sessions / scheduled-messages 那五个
// 要查库才拿得到项目,查不到就 `return next()` 落回业务路由,漏了也看不出来;而 `projects`
// 那一段是**直接拿 ident 当 projectId** 的,于是漏掉的字面量会被当成「一个你看不见的
// 项目」而 404 —— `/api/projects/clone` 就这样对普通成员整个不可用(第 1 轮审查 P1)。
//
// 靠通读维护不住,所以 `test:multi-user-git` 会把 `api.routes` 里所有这种形状枚举出来,
// 逐条比对这张表;新加一条 `/projects/xxx` 而忘了登记,那条测试直接红。
export const NOT_AN_ID = new Set([
  "follow-ups", "bodies", "batch", "check", "resolve", "search", "archived", "clone", "outbound-state",
]);

async function projectOfTask(taskId: string): Promise<string | null> {
  const row = (await db.select({ projectId: tasks.projectId }).from(tasks).where(eq(tasks.id, taskId))).at(0);
  return row?.projectId ?? null;
}

async function projectOfGroup(groupId: string): Promise<string | null> {
  const row = (await db.select({ projectId: groups.projectId }).from(groups).where(eq(groups.id, groupId))).at(0);
  return row?.projectId ?? null;
}

/** 会话属于任务,任务属于项目。`/api/sessions/:id/output` 直接吐 agent 的完整 transcript。 */
async function projectOfSession(sessionId: string): Promise<string | null> {
  const row = (await db.select({ taskId: sessions.taskId }).from(sessions).where(eq(sessions.id, sessionId))).at(0);
  return row ? await projectOfTask(row.taskId) : null;
}

/**
 * 定时消息也属于任务。`/api/scheduled-messages/:mid` 与 `…/:mid/steer` 同样是全局 id
 * 路由 —— 列表端点在 `/tasks/:id/…` 下、被闸挡得好好的,而这两条改写端点整个漏在闸外:
 * 拿到(或试出)一个 mid 就能取消、引导别人项目里待发的消息(第 1 轮审查 P1)。
 */
async function projectOfScheduledMessage(messageId: string): Promise<string | null> {
  const row = (await db
    .select({ taskId: scheduledMessages.taskId })
    .from(scheduledMessages)
    .where(eq(scheduledMessages.id, messageId))).at(0);
  return row ? await projectOfTask(row.taskId) : null;
}

/**
 * 「这个集合的 id 怎么查回项目」。一个集合一行 —— 新开一个 `/api/<集合>/<id>/…` 形状的
 * 集合就在这里加一行(队列与会话这类**全局 id 路由**当年整个漏在闸外,就是因为判据散在
 * 一串 if/else 里,加的人看不见自己漏了谁)。
 *
 * 这张表同时是「哪些集合归这道闸管」的**唯一**来源:`test:multi-user-git` 按它枚举
 * `api.routes`,逐条比对 NOT_AN_ID。写成 if/else 链的话那张枚举表就得抄第二份。
 */
const PROJECT_OF: Record<string, (ident: string) => Promise<string | null>> = {
  tasks: projectOfTask,
  groups: projectOfGroup,
  // 项目自己就是项目:**不查库**。所以 NOT_AN_ID 漏一条,受伤的只会是这一段。
  projects: async (ident) => ident,
  // 队列与会话是**全局 id 路由**:路径里没有 task/project 段,所以第 1 轮审查前它们
  // 整个漏在闸外 —— 拿到 queueId 能读别人的任务标题、改别人的队列顺序,拿到
  // sessionId 能读完整 transcript。它们的项目要多跳一层才查得到,但判据同一份。
  queues: projectOfQueue,
  sessions: projectOfSession,
  "scheduled-messages": projectOfScheduledMessage,
};

/** 归这道闸管的集合。导出给回归测试按它枚举路由表。 */
export const GATED_KINDS = new Set(Object.keys(PROJECT_OF));

export function resourceGate(): MiddlewareHandler {
  return async (c, next) => {
    if (!c.req.path.startsWith("/api/")) return next();
    if (!(await isMultiUser())) return next();
    const actor = actorOf(c);
    // agent 回合的身份已经被 middleware.ts 绑到具体任务上了,但它照样要过这一关:
    // 一个 agent 拿自己的 turn token 去打别人任务的端点,同样是越权。
    const [kind, ident] = segmentsOf(c.req.path);
    if (!ident || NOT_AN_ID.has(ident)) return next();

    const resolve = PROJECT_OF[kind];
    if (!resolve) return next();
    const projectId = await resolve(ident);

    // 资源不存在:交给业务路由去报 404(它知道该说「任务不存在」还是「分组不存在」)。
    if (!projectId) return next();
    if (await canSeeProject(actor, projectId)) return next();
    // 不存在与没权限回同一句话:否则挨个 id 试就成了一台存在性探测器。
    return c.json({ error: "not found" }, 404);
  };
}
