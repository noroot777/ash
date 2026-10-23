// 验收前置命令的三个只读/控制端点。编排在 accept-gate.ts，这里只是把它接到 HTTP 上。
//
// 单独一个文件而不是塞进 task-accept.ts：那边已经 690 行，而这三条路由跟验收主流程
// 没有共享状态 —— 它们只认 taskId。
import type { Hono } from "hono";
import { acceptGateLogText } from "./accept-gate-process.js";
import { acceptGateState, cancelAcceptGate } from "./accept-gate.js";

export function mountAcceptGateRoutes(api: Hono): void {
  // 验收台要的那一份：这个项目设没设门禁、上一次跑成什么样、那次结果对现在这棵树还作不作数。
  api.get("/tasks/:id/accept-gate", async (c) => c.json(await acceptGateState(c.req.param("id"))));

  // 整份日志。几十 MB 的回归输出不塞进状态接口（那个接口每隔几秒就要拉一次），
  // 要看全文的人点一下单独取。
  api.get("/tasks/:id/accept-gate/log", async (c) => {
    const state = await acceptGateState(c.req.param("id"));
    const run = state.running ?? state.latest;
    if (!run) return c.json({ error: "这个任务还没跑过验收前置命令" }, 404);
    return c.text(acceptGateLogText(run.logPath) || "（日志为空）");
  });

  // 不想等了：收掉它。取消是用户自己的动作，所以留下的是 canceled 而不是 failed ——
  // 两者下一步完全不同（红了要去修，取消了只是这次不跑）。
  api.post("/tasks/:id/accept-gate/cancel", async (c) => {
    const gate = await cancelAcceptGate(c.req.param("id"));
    if (!gate) return c.json({ error: "当前没有正在跑的验收前置命令" }, 409);
    return c.json({ canceled: true, gate });
  });
}
