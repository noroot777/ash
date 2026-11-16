// 任务的只读查询（追问、正文批量取、被挡回的操作、提问历史、换执行器预检、磁盘残留）。从 task-routes.ts
// 拆出来只是为了行数，由 `mountTaskRoutes` 一并挂载（见那里的说明）。
import { TASK_BATCH_LIMIT } from "@ash/shared";
import { eq, inArray } from "drizzle-orm";
import type { Hono } from "hono";
import { db } from "./db/index.js";
import { projects, tasks } from "./db/schema.js";
import { detectTaskWorkspace } from "./workspace-cleanup.js";
import { allFollowUpsOf, followUpsFor } from "./task-follow-up.js";
import { actorOf, ownerIdOf } from "./auth/context.js";
import { canSeeProject, visibleProjectIds, visibleTaskIds } from "./auth/visibility.js";
import { executorDowngradePreflight } from "./auth/dispatch-gate.js";
import { recentRejectionNotices } from "./user-action-rejection.js";
import { suspectTurns } from "./turn-lock-reclaim.js";

export function mountTaskReadRoutes(api: Hono): void {
  // 一次最多问这么多任务的追问 / 正文（判据和常量本体在 shared 的 TASK_BATCH_LIMIT）：
  // 追问每个都要摸一次盘，别让一个手抖的请求把整个进程钉在 I/O 上。
  // **超了返 400，不截断** —— 静默少返几行会被前端渲染成「还没读到」，一条永远不会
  // 消失的假状态；请求方分批才是对的做法。
  const overBatchLimit = (ids: string[]) =>
    ids.length > TASK_BATCH_LIMIT
      ? { error: `一次最多问 ${TASK_BATCH_LIMIT} 个任务，请分批`, limit: TASK_BATCH_LIMIT, requested: ids.length }
      : null;

// 侧边栏铺开时才拉：一批任务各自「我发的最后一条追问」（读的是会话 .md，不是库）。
// 用 POST 是因为要一次带上几十个 id，塞进 query 会顶到 URL 长度上限。
api.post("/tasks/follow-ups", async (c) => {
  const body = await c.req.json<{ taskIds?: unknown }>().catch(() => ({ taskIds: [] }));
  const ids = Array.isArray(body.taskIds) ? body.taskIds.filter((id): id is string => typeof id === "string") : [];
  const over = overBatchLimit(ids);
  if (over) return c.json(over, 400);
  return c.json(await followUpsFor(await visibleTaskIds(actorOf(c), ids)));
});

// 悬停铺开那一格时才拉：这一个任务我发过的全部追问，从旧到新（口径同上，读的也是会话 .md），
// 外加读没读全（TaskFollowUpList.complete）。
api.get("/tasks/:id/follow-ups", async (c) => {
  const taskId = c.req.param("id");
  const r = (await db.select({ projectId: tasks.projectId }).from(tasks).where(eq(tasks.id, taskId))).at(0);
  if (!r || !(await canSeeProject(actorOf(c), r.projectId))) return c.json({ error: "not found" }, 404);
  return c.json(await allFollowUpsOf(taskId));
});

// 正文批量取。跟上面那条同一个触发点（侧边栏铺开的「原始需求」列），同一套 id 上限，
// 只是这份数据在库里而不在会话文件里，所以另开一条而不是塞进 follow-ups —— 后者按
// 定义只有「追问过的任务」才有行，而正文是每个任务都有的。
//
// 列表接口（GET /tasks）不再带正文，所以需要正文的表面各自按需取：铺开走这条，详情
// 面走 GET /tasks/:id。
api.post("/tasks/bodies", async (c) => {
  const body = await c.req.json<{ taskIds?: unknown }>().catch(() => ({ taskIds: [] }));
  const ids = Array.isArray(body.taskIds) ? body.taskIds.filter((id): id is string => typeof id === "string") : [];
  if (!ids.length) return c.json([]);
  const over = overBatchLimit(ids);
  if (over) return c.json(over, 400);
  const visible = await visibleProjectIds(actorOf(c));
  const rows = (await db
    .select({ taskId: tasks.id, body: tasks.body, projectId: tasks.projectId })
    .from(tasks)
    .where(inArray(tasks.id, ids)))
    .filter((row) => visible === null || visible.has(row.projectId));
  return c.json(rows.map((row) => ({ taskId: row.taskId, body: row.body ?? "" })));
});

// 这个任务被挡回/没做到位的那些用户操作。前端**无条件**读它,按时间合进同一条任务历史 ——
// 不去问「对话流有没有正文」:从没跑过的任务没有会话时间线可写,而「有正文就不显示」会让
// 那条已经入库的记录再也显示不出来(第 2 轮审查 F4)。判据见 user-action-rejection.ts 文件头。
api.get("/tasks/:id/notices", async (c) => {
  const taskId = c.req.param("id");
  const r = (await db.select({ projectId: tasks.projectId }).from(tasks).where(eq(tasks.id, taskId))).at(0);
  if (!r || !(await canSeeProject(actorOf(c), r.projectId))) return c.json({ error: "not found" }, 404);
  // `remedy` 是**此刻**算出来的,不是存下来的:它回答的是「现在按那个开关有没有用」。
  // 存进库就会出现「当时卡着、现在早好了,按钮还挂在那里」的死按钮。
  const remedy = suspectTurns().some((t) => t.taskId === taskId) ? "reclaim-turn" as const : null;
  return c.json({ notices: await recentRejectionNotices(taskId), remedy });
});

api.get("/tasks/:id/question-history", async (c) => {
  const r = (await db.select({ projectId: tasks.projectId, history: tasks.questionHistory })
    .from(tasks).where(eq(tasks.id, c.req.param("id")))).at(0);
  if (!r || !(await canSeeProject(actorOf(c), r.projectId))) return c.json({ error: "not found" }, 404);
  return c.json(r.history ? JSON.parse(r.history) : []);
});

// 「我现在动它,会不会被换掉执行器」。前端在运行/重跑/回复/继续讨论之前问一次,拿到
// 非空就弹确认框(§八:不静默替换 —— 换执行器可能换模型档位,产出会变)。
// 返回的是**列表**:duet 有两位讨论者,各占一格(第 6 轮审查 P1)。自用模式恒为空数组。
api.get("/tasks/:id/executor-preflight", async (c) => {
  const taskId = c.req.param("id");
  const r = (await db.select({ projectId: tasks.projectId }).from(tasks).where(eq(tasks.id, taskId))).at(0);
  if (!r || !(await canSeeProject(actorOf(c), r.projectId))) return c.json({ error: "not found" }, 404);
  return c.json({ downgrades: await executorDowngradePreflight(taskId, ownerIdOf(actorOf(c))) });
});

// 这个任务在磁盘/仓库里还留着什么(worktree 目录、ash/<id8> 分支)。删除
// 确认框在打开时先问一次:有残留才提示「要不要连它们一起删」,没有就是一句普通
// 的确认。任务不在 worktree 模式下跑过也照查 —— useWorktree 后来被关掉、目录和
// 分支却还在,是最容易被漏掉的那种残留。
// children 一并探测：团队/duet 删除会连 children 行一起删，它们的 worktree/分支若不在
// 这里露脸，确认框就不会带清理参数，删完变成数据库里查无此任务的孤儿资源（审查实测：
// 父任务双 null、isolated child 有脏 worktree，请求根本不带清理参数）。
api.get("/tasks/:id/workspace", async (c) => {
  const tid = c.req.param("id");
  const t = (await db.select().from(tasks).where(eq(tasks.id, tid))).at(0);
  if (!t) return c.json({ error: "not found" }, 404);
  const project = (await db.select().from(projects).where(eq(projects.id, t.projectId))).at(0);
  const own = await detectTaskWorkspace(project?.repoPath, tid);
  const childRows = await db.select().from(tasks).where(eq(tasks.parentId, tid));
  const children = (await Promise.all(childRows.map(async (child) => ({
    taskId: child.id,
    title: child.title,
    ...(await detectTaskWorkspace(project?.repoPath, child.id)),
  })))).filter((entry) => entry.path || entry.branch);
  return c.json({ ...own, ...(children.length ? { children } : {}) });
});
}
