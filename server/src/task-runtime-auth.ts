import type { Context } from "hono";
import { eq } from "drizzle-orm";
import { db } from "./db/index.js";
import { tasks } from "./db/schema.js";
import { actorOf, isAccountHolder } from "./auth/context.js";
import { agentActor } from "./auth/middleware.js";
import { requireTaskAccess } from "./auth/visibility.js";
import { NAVI_HEADERS, requestHeader } from "./request-headers.js";

export async function runtimeCaller(c: Context, taskId: string) {
  await requireTaskAccess(actorOf(c), taskId);
  const source = requestHeader(c, NAVI_HEADERS.sourceTaskId);
  const turn = requestHeader(c, NAVI_HEADERS.turnToken);
  const claimed = !!source || !!turn || actorOf(c).kind === "agent";
  const authorize = async () => {
    await requireTaskAccess(actorOf(c), taskId);
    if (!claimed) {
      if (!isAccountHolder(actorOf(c))) throw new Error("只有任务用户或当前执行回合可以操作此浏览器和服务");
      return;
    }
    if (!turn || source !== taskId || (await agentActor(c))?.taskId !== taskId) throw new Error("回合身份无效或已结束，不能操作其他任务的浏览器和服务");
    const task = (await db.select().from(tasks).where(eq(tasks.id, taskId))).at(0);
    if (!task?.activeDirectionToken || task.activeDirectionToken !== requestHeader(c, NAVI_HEADERS.directionToken)) throw new Error("方向身份已过期，请使用最新 directionToken 重试");
  };
  await authorize();
  return { agent: claimed, authorize };
}
