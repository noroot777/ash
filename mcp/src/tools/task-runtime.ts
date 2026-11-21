import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { call, fail, ok } from "../runtime.js";
import type { BrowserObservation } from "@navi/shared/task-runtime";

const identity = {
  taskId: z.string().min(1),
  directionToken: z.string().min(1).describe("最新用户方向附带的 directionToken"),
};

export function registerTaskRuntimeTools(server: McpServer): void {
  server.registerTool("start_dev_service", {
    description: "在当前任务工作区启动托管 Web 服务，用于开发验证和完成后的用户预览。健康检查通过才返回就绪；已有用户预览优先复用，返回 owner:user 及其实际命令和地址，不停止或替换；智能体托管服务返回 owner:agent，同命令复用。服务独立于智能体进程，完成后保持运行，任务页面可打开、看日志、停止。使用 $PORT 等动态端口，避免 shell 后台进程随会话退出。",
    inputSchema: { ...identity, command: z.string().min(1), name: z.string().max(80).optional() },
  }, async ({ taskId, directionToken, ...body }) => {
    try { return ok(await call("POST", `/tasks/${encodeURIComponent(taskId)}/runtime/service`, body, directionToken)); }
    catch (error) { return fail(error); }
  });
  server.registerTool("stop_dev_service", {
    description: "停止当前任务中由智能体托管的服务和在途启动，并关闭共享浏览器；借用的用户预览保持运行，不会停止或取消。保留日志、最后画面与操作记录。不影响其他任务。",
    inputSchema: identity,
  }, async ({ taskId, directionToken }) => {
    try { return ok(await call("DELETE", `/tasks/${encodeURIComponent(taskId)}/runtime/service`, undefined, directionToken)); }
    catch (error) { return fail(error); }
  });
  server.registerTool("browser_action", {
    description: "操作 navi 任务侧栏里的同一个共享浏览器，用户能看到页面与操作，并可接管。先 start_dev_service，再 open。snapshot 返回正文、可操作 ref；click/fill/select 使用最新 ref，导航后重新取。后续操作带返回的 id；用户接管时拒绝智能体修改。screenshot=true 返回当前页面图像。只访问任务托管服务，不依赖 Codex 桌面客户端。关闭浏览器不停止服务。",
    inputSchema: { ...identity,
      action: z.enum(["open", "snapshot", "navigate", "click", "fill", "select", "press", "scroll", "resize", "reload", "back", "forward", "close"]),
      id: z.string().optional(), path: z.string().optional(), ref: z.string().optional(), text: z.string().optional(),
      value: z.string().optional(), key: z.string().optional(), direction: z.enum(["up", "down"]).optional(),
      width: z.number().int().optional(), height: z.number().int().optional(), screenshot: z.boolean().optional(),
    },
  }, async ({ taskId, directionToken, ...body }) => {
    try {
      const result = await call("POST", `/tasks/${encodeURIComponent(taskId)}/runtime/browser`, body, directionToken) as BrowserObservation;
      const { image, ...text } = result;
      const content: Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }> = ok(text).content;
      if (image) content.push({ type: "image", data: image, mimeType: "image/png" });
      return { content };
    } catch (error) { return fail(error); }
  });
}
