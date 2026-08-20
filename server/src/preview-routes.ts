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

const STATUS = { gone: 404, nostep: 400, busy: 409, failed: 502 } as const;

export function mountPreviewRoutes(api: Hono): void {
  api.post("/tasks/:id/preview/restart", async (c) => {
    // 重开预览会在任务工作区里跑启动命令——接力出去的「历史存档」不给开。
    const handedOff = await handoffBlockReasonById(c.req.param("id"));
    if (handedOff) return c.json({ error: handedOff, handoff: true }, 409);
    // 只有一站预览时前端可以不传 stepId；传了就按 id 认，别猜。
    const body = (await c.req.json().catch(() => ({}))) as { stepId?: unknown };
    const stepId = typeof body.stepId === "string" ? body.stepId : null;
    const result = await restartTaskPreview(c.req.param("id"), stepId);
    if (!result.ok) return c.json({ error: result.reason }, STATUS[result.code]);
    return c.json(result);
  });
}
