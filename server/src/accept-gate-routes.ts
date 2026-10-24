// 验收前置命令的三个只读/控制端点。编排在 accept-gate.ts，这里只是把它接到 HTTP 上。
//
// 单独一个文件而不是塞进 task-accept.ts：那边已经 690 行，而这三条路由跟验收主流程
// 没有共享状态 —— 它们只认 taskId。
import type { Hono } from "hono";
import { acceptGateLogText } from "./accept-gate-process.js";
import { acceptGateRunOf, acceptGateState, cancelAcceptGate, rehandOffAcceptGate } from "./accept-gate.js";

export function mountAcceptGateRoutes(api: Hono): void {
  // 验收台要的那一份：这个项目设没设门禁、上一次跑成什么样、那次结果对现在这棵树还作不作数。
  api.get("/tasks/:id/accept-gate", async (c) => c.json(await acceptGateState(c.req.param("id"))));

  // 整份日志。几十 MB 的回归输出不塞进状态接口（那个接口每隔几秒就要拉一次），
  // 要看全文的人点一下单独取。
  //
  // `?run=<id>` 指定某一次。已验收的那张回执要的是**本次验收凭据那一次**的日志，而那
  // 多半已经不是「最近一次」了（第 1 轮审查 F1）；不带就还是看现在/最近那一次。跨任务
  // 的 id 一律当不存在 —— 日志路径本身就是一条可以用来乱翻目录的线索。
  api.get("/tasks/:id/accept-gate/log", async (c) => {
    const taskId = c.req.param("id");
    const wanted = c.req.query("run");
    if (wanted) {
      const run = await acceptGateRunOf(taskId, wanted);
      if (!run) return c.json({ error: "这个任务名下没有这一次执行记录" }, 404);
      if (run.logAvailable === false) return c.json({ error: "这次运行的日志未迁入或已清理，当前机器不可查" }, 404);
      return c.text(acceptGateLogText(run.logPath) || "（日志为空）");
    }
    const state = await acceptGateState(taskId);
    const run = state.running ?? state.latest;
    if (!run) return c.json({ error: "这个任务还没跑过验收前置命令" }, 404);
    if (run.logAvailable === false) return c.json({ error: "这次运行的日志未迁入或已清理，当前机器不可查" }, 404);
    return c.text(acceptGateLogText(run.logPath) || "（日志为空）");
  });

  // 「再交给智能体去修」。红了的时候 ash 已经自动交过一次，这条是补救与再推一把：那一次
  // 可能没投递成功（回合被抢占），也可能 agent 那一轮跑完了还没修好。
  api.post("/tasks/:id/accept-gate/handoff", async (c) => {
    const result = await rehandOffAcceptGate(c.req.param("id"));
    if (!result.ok) return c.json({ error: result.error }, 409);
    return c.json({ handedOff: true, gate: result.gate });
  });

  // 不想等了：收掉它。取消是用户自己的动作，所以留下的是 canceled 而不是 failed ——
  // 两者下一步完全不同（红了要去修，取消了只是这次不跑）。
  api.post("/tasks/:id/accept-gate/cancel", async (c) => {
    let body: { runId?: unknown };
    try {
      const text = await c.req.text();
      const parsed: unknown = text ? JSON.parse(text) : {};
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("invalid body");
      body = parsed;
    } catch { return c.json({ error: "取消请求必须是 JSON 对象" }, 400); }
    if (body.runId !== undefined && (typeof body.runId !== "string" || !body.runId.trim())) {
      return c.json({ error: "runId 必须是非空字符串" }, 400);
    }
    return c.json(await cancelAcceptGate(c.req.param("id"), undefined, body.runId));
  });
}
