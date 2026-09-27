// AI 协助（preview-assist.ts）的三个端点：开一个、问进度、取消。
//
// 单独一个文件而不是塞进 project-routes.ts：那份是项目表自己的 CRUD，这三条是一台
// 「短命作业」的控制面，两者的生命周期和权限判据都不一样（这里每一条都要项目管理员）。
import type { Hono } from "hono";
import { eq } from "drizzle-orm";
import { previewLaunchOf } from "@ash/shared/preview";
import type { AgentType } from "@ash/shared";
import { db } from "./db/index.js";
import { projects } from "./db/schema.js";
import { actorOf, authErrorResponse, ownerIdOf } from "./auth/context.js";
import { requireProjectAdmin } from "./auth/visibility.js";
import { expandHome, projectHealthLight } from "./git.js";
import { id } from "./util.js";
import { ASSIST_INSTANCE } from "./preview-assist-jobs.js";
import { cancelPreviewAssist, previewAssistState, startPreviewAssist } from "./preview-assist.js";

const str = (value: unknown): string | null => (typeof value === "string" && value.trim() ? value.trim() : null);

export function mountPreviewAssistRoutes(api: Hono): void {
  api.get("/projects/:id/preview/assist", async (c) => {
    try {
      await requireProjectAdmin(actorOf(c), c.req.param("id"));
      c.header("cache-control", "no-store");
      // instance:「我是哪一台 ash」。前端拿它把「重启吞了」和「终态过期了」分开 —— 两种
      // 情况服务端回的都是 job: null（见 preview-assist-jobs.ts 的 ASSIST_INSTANCE）。
      return c.json({ job: previewAssistState(c.req.param("id")), instance: ASSIST_INSTANCE });
    } catch (error) {
      const mapped = authErrorResponse(error);
      if (mapped) return c.json(mapped.body, mapped.status);
      throw error;
    }
  });

  api.post("/projects/:id/preview/assist", async (c) => {
    const projectId = c.req.param("id");
    try {
      await requireProjectAdmin(actorOf(c), projectId);
      const row = (await db.select().from(projects).where(eq(projects.id, projectId))).at(0);
      if (!row) return c.json({ error: "项目不存在" }, 404);
      const health = projectHealthLight(row.repoPath);
      if (!health.exists) return c.json({ error: "项目目录不存在，请先保存有效的项目目录" }, 409);
      const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
      // 脚本和启动范围取**页面上此刻的值**而不是库里已保存的那份：用户正是因为存疑才点的
      // 这颗按钮，拿旧值去判就等于对着另一份配置验。
      const job = await startPreviewAssist({
        projectId,
        cwd: expandHome(row.repoPath),
        mode: previewLaunchOf(body.launch),
        currentScript: typeof body.script === "string" ? body.script : (row.previewCommand ?? ""),
        // 页面自报的身份：新建的作业原样带上它，页面回头才认得出「这一份是我点的」。没带就
        // 生成一个 —— 那种调用方（curl、脚本）反正也不会回来认领。
        claim: str(body.claim) ?? id(),
        executorId: str(body.executorId),
        agentType: str(body.agentType) as AgentType | null,
        model: str(body.model),
        reasoningEffort: str(body.reasoningEffort),
        owner: ownerIdOf(actorOf(c)),
      });
      return c.json({ job, instance: ASSIST_INSTANCE });
    } catch (error) {
      const mapped = authErrorResponse(error);
      if (mapped) return c.json(mapped.body, mapped.status);
      return c.json({ error: error instanceof Error ? error.message : String(error) }, 500);
    }
  });

  api.delete("/projects/:id/preview/assist", async (c) => {
    try {
      await requireProjectAdmin(actorOf(c), c.req.param("id"));
      return c.json({ canceled: cancelPreviewAssist(c.req.param("id")), job: previewAssistState(c.req.param("id")), instance: ASSIST_INSTANCE });
    } catch (error) {
      const mapped = authErrorResponse(error);
      if (mapped) return c.json(mapped.body, mapped.status);
      throw error;
    }
  });
}
