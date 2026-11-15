// 「派出的任务」格头那一对键的端点，和智能体调 run_task 碰上「名下全部停下」时的那道闸。
// 停 / 续本身在 dispatch-hold.ts；「被按住了吗」的判定在 task-hold.ts。
import type { Context, Hono } from "hono";
import { eq } from "drizzle-orm";
import { db } from "./db/index.js";
import { tasks } from "./db/schema.js";
import { actorOf } from "./auth/context.js";
import { holdDispatched, releaseDispatched } from "./dispatch-hold.js";
import { oweHeldStart } from "./dispatch-hold-owed.js";
import { publishTaskUpdated } from "./task-store.js";
import { dispatchHoldOf, dispatchHoldText } from "./task-hold.js";

type TaskRow = typeof tasks.$inferSelect;

/** 这次调用是智能体发的（MCP 带着它那一回合的身份，或者 agent 令牌）。 */
export function fromAgent(c: Context): boolean {
  return actorOf(c).kind === "agent" || c.req.header("x-ash-client") === "mcp";
}

/**
 * 智能体要起的这一条被上面派活的那条按住了：拒掉并记一笔欠账，「接着跑」时由那边起它 ——
 * 停着期间新派出去的任务建得出来，但不起跑。返回 null = 放行。
 */
export async function agentRunHold(c: Context, task: TaskRow): Promise<{ error: string; heldBy: string } | null> {
  if (task.mode !== "single" || !fromAgent(c)) return null;
  const hold = await dispatchHoldOf(task.id);
  if (!hold) return null;
  await oweHeldStart(task.id, hold.byTaskId);
  return { error: `${dispatchHoldText(hold)}，那一条接着跑之后它会自己起跑`, heldBy: hold.byTaskId };
}

export function mountDispatchHoldRoutes(api: Hono): void {
  // 全部停下 / 接着跑。归档了的派活人照样能按（归档不能把名下的任务永远按在那里）。
  // 团队调度台、讨论、团队执行者名下没有派出的任务（task-dispatch.ts canDispatch），一律 400。
  const holder = async (c: Context): Promise<TaskRow | Response> => {
    const row = (await db.select().from(tasks).where(eq(tasks.id, c.req.param("id")!))).at(0);
    if (!row) return c.json({ error: "not found" }, 404);
    if (row.mode !== "single" || row.parentId) return c.json({ error: "只有普通任务名下有派出的任务" }, 400);
    return row;
  };

  api.post("/tasks/:id/dispatched/hold", async (c) => {
    const row = await holder(c);
    if (row instanceof Response) return row;
    await holdDispatched(row.id);
    return c.json(await publishTaskUpdated(row.id));
  });

  api.post("/tasks/:id/dispatched/release", async (c) => {
    const row = await holder(c);
    if (row instanceof Response) return row;
    await releaseDispatched(row.id);
    return c.json(await publishTaskUpdated(row.id));
  });
}
