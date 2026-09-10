import { randomBytes } from "node:crypto";
import type { Hono } from "hono";
import { getCookie } from "hono/cookie";
import type { Actor } from "./auth/context.js";
import { alive, readAnyPreview } from "./preview-store.js";
import { previewBase } from "./preview-public.js";
import { rewritePreviewUrl } from "./preview-proxy-rewrite.js";

/**
 * `jar` 是这一趟预览自己的 cookie 罐子，**存在服务端**。
 *
 * 被预览的应用登录后设的 cookie 本来是改写成 `ashpv_…` 发回浏览器的，但预览文档带
 * `CSP: sandbox`（没有 `allow-same-origin`），它的 origin 是 `null` —— 浏览器把它发出的
 * 每个请求都当成跨站，`SameSite=Lax` 的 cookie 一个都不带回来。实测（明文 http + 局域网
 * IP，也就是用户访问 ash 的常态）`Lax`/`Strict`/`None`/不写/`None; Secure` **五种写法全都
 * 回不来**：`None` 缺 `Secure` 会被浏览器直接丢掉，`Secure` 在非可信来源上同样被丢掉。
 * 于是预览里的应用永远保不住会话 —— ash 预览 ash 时的表现就是「粘贴 key 登录，下一个
 * 请求又回到登录页」。
 *
 * 所以 cookie 不再指望浏览器带回来，由代理自己记着、每次转发时自己贴上。罐子挂在 grant
 * 上而不是全局表里，是为了让它的寿命跟着「这一次打开预览」走：grant 一没，会话一起没，
 * 不会渗到下一次打开、更不会渗到别的任务。
 */
interface PreviewGrant { taskId: string; gen: string; actor: Actor; expires: number; session?: string; turn?: string; keyHash?: string | null; jar: Map<string, string> }
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
    const actor = actorOf(c);
    const { getUser } = await import("./auth/store.js");
    const grant: PreviewGrant = {
      taskId, gen: record.gen, actor, expires: Date.now() + GRANT_LIFE,
      session: getCookie(c, "ash_session"), turn: c.req.header("x-ash-turn-token"),
      keyHash: actor.kind === "user" && c.req.header("authorization") ? (await getUser(actor.userId!))?.keyHash : undefined,
      jar: new Map(),
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
