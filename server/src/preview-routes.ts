// 预览的手动开关。目前只有一个动作：**把「打开预览」这一站按原样再跑一次**。
//
// 它跟线上其它端点的区别值得说一句：这条路**不推线**。游标、验证轮数、失败策略一律
// 不动——用户点它的场合恰恰是「线卡在原地不动，可我想再看一眼页面」。为什么会有这种
// 场合，见 `workflow-steps.ts` 的 `restartTaskPreview`。
//
// 一个请求可能挂**两分钟**（预览的就绪超时），这是刻意的：起没起来只能等它自己说，
// 提前返回一句「已开始」就等于骗人——用户点开地址是 404 才发现没起来。
import type { Hono } from "hono";
import { handoffBlockReasonById } from "./handoff-guard.js";
import { restartTaskPreview } from "./workflow-steps.js";
import { previewState } from "./preview-public.js";
import { actorOf } from "./auth/context.js";
import { requireTaskAccess } from "./auth/visibility.js";
import { workspacePreviewInput, workspacePreviewLaunch } from "./preview-workspace.js";
import { readPreviewLog, stopPreview } from "./preview.js";

const STATUS = { gone: 404, nostep: 400, busy: 409, failed: 502 } as const;

export function mountPreviewRoutes(api: Hono): void {
  api.get("/tasks/:id/preview", async (c) => {
    await requireTaskAccess(actorOf(c), c.req.param("id"));
    c.header("cache-control", "no-store");
    if (c.req.query("launch") === "1") return c.json(await workspacePreviewLaunch(c.req.param("id")));
    if (c.req.query("log") === "1") {
      const log = readPreviewLog(c.req.param("id"), 20_000);
      return c.json({ text: log?.text ?? "", exists: !!log });
    }
    return c.json(previewState(c.req.param("id")));
  });
  api.delete("/tasks/:id/preview", async (c) => {
    await requireTaskAccess(actorOf(c), c.req.param("id"));
    return c.json({ stopped: await stopPreview(c.req.param("id"), "用户在预览工作区取消启动") });
  });
  api.post("/tasks/:id/preview/restart", async (c) => {
    // 重开预览会在任务工作区里跑启动命令——接力出去的「历史存档」不给开。
    const handedOff = await handoffBlockReasonById(c.req.param("id"));
    if (handedOff) return c.json({ error: handedOff, handoff: true }, 409);
    // 只有一站预览时前端可以不传 stepId；传了就按 id 认，别猜。
    const body = (await c.req.json().catch(() => ({}))) as { stepId?: unknown };
    const stepId = typeof body.stepId === "string" ? body.stepId : null;
    let input;
    try { input = workspacePreviewInput(body); }
    catch (error) { return c.json({ error: error instanceof Error ? error.message : String(error) }, 400); }
    const result = await restartTaskPreview(c.req.param("id"), stepId, input);
    if (!result.ok) return c.json({ error: result.reason }, STATUS[result.code]);
    return c.json(result);
  });
}
