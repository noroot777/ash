// 验收这一条线的 HTTP 入口。
//
// 单独一个文件而不是跟编排挤在 task-accept.ts 里:那边是「合并 → 清理 → 盖章」那套
// 分阶段守卫的本体,这里只做一件事 —— 把请求体里认得出的几个值挑出来交给它。两者唯一
// 的接触面是 acceptTask 的签名。
import type { Hono } from "hono";
import { eq } from "drizzle-orm";
import { db } from "./db/index.js";
import { tasks } from "./db/schema.js";
import { acceptTask } from "./task-accept.js";
import { mountAcceptGateRoutes } from "./accept-gate-routes.js";
import { mountBranchPlanRoutes } from "./task-branch-routes.js";
import { mountPendingMergeRoutes } from "./task-accept-pending.js";
import { unexecutedVerification } from "./task-accept-verification.js";

export function mountTaskAcceptanceRoutes(api: Hono): void {
  mountBranchPlanRoutes(api, acceptTask);
  // 验收前置命令的查看/取消（跑起来之后用户唯一的两个动作）。
  mountAcceptGateRoutes(api);
  // 「合并后不提交」那一档的收尾（核对现场 / 现在提交 / 重新合一次），自成一套退路。
  mountPendingMergeRoutes(api);
  api.get("/tasks/:id/acceptance-check", async c => {
    const task = (await db.select().from(tasks).where(eq(tasks.id, c.req.param("id")))).at(0);
    if (!task) return c.json({ error: "not found" }, 404);
    return c.json({ verification: await unexecutedVerification(task) });
  });
  api.post("/tasks/:id/accept", async (c) => {
    const input = await c.req.json<{ confirmUnverified?: unknown; commit?: unknown; gate?: unknown }>().catch(() => null);
    // commit 只认真正的布尔：别的一律当「没传」= 跟项目设置走。含糊的真值转换在这儿
    // 就是替用户决定要不要在他的目标分支上产生提交。
    const commit = typeof input?.commit === "boolean" ? input.commit : undefined;
    // 验收前置命令的额外指令。认不出的值一律当没传（照常：有新鲜结果就复用，没有就跑）——
    // 「跳过门禁」是放弃一道用户自己定的放行条件，不接受从含糊输入里推出来。
    const gate = input?.gate === "skip" || input?.gate === "rerun" ? input.gate : undefined;
    const result = await acceptTask(c.req.param("id"), "human", { confirmUnverified: input?.confirmUnverified === true, commit, acceptGate: gate });
    if (result.accepted) return c.json(result);
    const { httpStatus, ...body } = result;
    return httpStatus === 404 ? c.json(body, 404) : c.json(body, 409);
  });
}
