import { randomBytes } from "node:crypto";
import type { Hono } from "hono";
import { getCookie } from "hono/cookie";
import type { Actor } from "./auth/context.js";
import { currentListeningPort } from "./listening-port.js";
import { alive, readAnyPreview } from "./preview-store.js";
import { previewBase } from "./preview-public.js";
import { rewritePreviewUrl } from "./preview-proxy-rewrite.js";

interface PreviewGrant { taskId: string; gen: string; actor: Actor; expires: number; session?: string; turn?: string; keyHash?: string | null }
const grants = new Map<string, PreviewGrant>();
const GRANT_LIFE = 8 * 60 * 60_000;

export function grantFor(token: string): PreviewGrant | null {
  const grant = grants.get(token);
  if (!grant || grant.expires <= Date.now()) { grants.delete(token); return null; }
  return grant;
}

export async function canUsePreview(grant: PreviewGrant): Promise<boolean> {
  const { isMultiUser } = await import("./auth/mode.js");
  const { projectOfTask, canSeeProject } = await import("./auth/visibility.js");
  const project = await projectOfTask(grant.taskId);
  if (!project) return false;
  if (!(await isMultiUser())) return true;
  if (grant.actor.kind === "agent") {
    const { db } = await import("./db/index.js");
    const { tasks } = await import("./db/schema.js");
    const { eq } = await import("drizzle-orm");
    const source = (await db.select().from(tasks).where(eq(tasks.id, grant.actor.taskId ?? ""))).at(0);
    return !!source && !!grant.turn && source.activeTurnToken === grant.turn && source.projectId === project && await canSeeProject(grant.actor, project);
  }
  if (grant.actor.kind !== "user" || !grant.actor.userId) return false;
  const { getUser, resolveSession } = await import("./auth/store.js");
  const user = await getUser(grant.actor.userId);
  if (grant.session && (await resolveSession(grant.session))?.id !== user?.id) return false;
  if (grant.keyHash !== undefined && grant.keyHash !== user?.keyHash) return false;
  return !!user && user.status === "active" && await canSeeProject({ ...grant.actor, role: user.role === "admin" ? "admin" : "member" }, project);
}

export function mountPreviewOpenRoutes(api: Hono): void {
  api.get("/tasks/:id/preview/open/:serviceId", async (c) => {
    const { actorOf } = await import("./auth/context.js");
    const { requireTaskAccess } = await import("./auth/visibility.js");
    const taskId = c.req.param("id");
    await requireTaskAccess(actorOf(c), taskId);
    const record = readAnyPreview(taskId);
    const service = record?.services?.find((s) => s.id === c.req.param("serviceId"));
    if (!record?.proxyToken || !record.gen || !service?.url || service.status !== "ready" || !alive(service.pid)) return c.text("预览不存在或已关闭", 404);
    // 记录里的地址是从预览日志里认出来的，认错了就可能不是一个能解析的 URL（真出过：日志
    // 里写的是「/api 打到 http://127.0.0.1:4317。」，句号被一起收了进来）。不挡的话
    // `new URL` 在这儿抛，Hono 兜底成一句 Internal Server Error —— 用户既不知道坏在哪，
    // 也不知道重开一次预览就好了。
    let target: URL;
    try { target = new URL(service.url); } catch { return c.text("预览记录里的地址不合法，请关掉预览重开一次。", 502); }
    // 代理永远打回环上的 `service.port`，所以这个端口等于 ash 自己监听的那个 = 预览指到了
    // ash 本尊：代理自己转给自己，用户点开预览看到的是自己这台 ash（未登录态，因为代理按
    // 设计不转 cookie）。判读那侧已经不认自己的端口了（preview-log.ts 的 `excluded`），这里
    // 是**兜底**：存量记录、手填的服务端口照样能绕过判读，而这条路一旦走通，用户面对的就是
    // 一个长得跟 ash 一模一样、却要他重新粘 key 的页面。
    const self = currentListeningPort();
    if (self !== null && service.port === self) return c.text("预览记录指到了 ash 自己，请关掉预览重开一次。", 502);
    const actor = actorOf(c);
    const { getUser } = await import("./auth/store.js");
    const grant: PreviewGrant = {
      taskId, gen: record.gen, actor, expires: Date.now() + GRANT_LIFE,
      session: getCookie(c, "ash_session"), turn: c.req.header("x-ash-turn-token"),
      keyHash: actor.kind === "user" && c.req.header("authorization") ? (await getUser(actor.userId!))?.keyHash : undefined,
    };
    if (!(await canUsePreview(grant))) return c.text("预览不存在或无权访问", 404);
    for (const [token, value] of grants) if (value.expires <= Date.now() || readAnyPreview(value.taskId)?.gen !== value.gen) grants.delete(token);
    if (grants.size >= 1000) grants.delete(grants.keys().next().value!);
    const token = randomBytes(24).toString("hex");
    grants.set(token, grant);
    c.header("cache-control", "no-store");
    c.header("referrer-policy", "no-referrer");
    const view = { ...record, proxyToken: token };
    return c.redirect(rewritePreviewUrl(target.pathname + target.search, previewBase(view, service.id), view), 302);
  });
}
