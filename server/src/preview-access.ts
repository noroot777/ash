import { randomBytes } from "node:crypto";
import type { Hono } from "hono";
import { getCookie } from "hono/cookie";
import type { Actor } from "./auth/context.js";
import { alive, readAnyPreview } from "./preview-store.js";
import { previewBase } from "./preview-public.js";
import { rewritePreviewUrl } from "./preview-proxy-rewrite.js";
import type { PreviewCookieJar } from "./preview-cookies.js";

/**
 * `jar` 是这一趟预览自己的 cookie 罐子（存在服务端，规矩和缘由都在 preview-cookies.ts）。
 *
 * 它挂在 grant 上而不是全局表里，是为了让寿命跟着「这一次打开预览」走：grant 一没，会话
 * 一起没，不会渗到下一次打开、更不会让别人从任务页点开就坐进你登录好的那个会话。
 *
 * `client` 是**认领这张凭证的那个客户端**的暗号。地址里那 48 位 token 是 bearer 凭证：谁
 * 拿到地址谁就能看这个预览（有意为之）。但罐子里的**应用会话**不能跟着地址走 —— 否则把
 * 预览链接复制到另一个浏览器/profile，对方连登录都不用就坐进你登录好的会话里；预览 ash
 * 自己时，那份会话就是一份 ash 用户会话。所以第一个用它开页面的客户端把凭证认领走（种一个
 * HttpOnly cookie），之后再有客户端拿同一个地址开页面，就给它分叉出一张新凭证配空罐子。
 * `forks` 记着分出去的那些，多到一定数量就把最早的收回来：应用里的同源 iframe 在明文 http
 * 下跟顶层导航长得一模一样（见 preview-proxy.ts 的 looksLikeNavigation），每加载一次就要分
 * 一张，不回收的话 grants 表会被它挤爆。
 */
interface PreviewGrant { taskId: string; gen: string; actor: Actor; expires: number; session?: string; turn?: string; keyHash?: string | null; jar: PreviewCookieJar; client: string | null; forks: string[] }
const grants = new Map<string, PreviewGrant>();
const GRANT_LIFE = 8 * 60 * 60_000;
const GRANT_LIMIT = 1000;
/** 一张凭证同时留着的分叉上限，多了就回收最早的（见上面的说明）。 */
export const FORK_LIMIT = 16;

export function grantFor(token: string): PreviewGrant | null {
  const grant = grants.get(token);
  if (!grant || grant.expires <= Date.now()) { grants.delete(token); return null; }
  return grant;
}

/** 第一个开页面的客户端认领这张凭证，返回要种给它的暗号。 */
export function claimGrant(grant: PreviewGrant): string {
  const secret = randomBytes(16).toString("hex");
  grant.client = secret;
  return secret;
}

/** 给「另一个客户端」分一张授权相同、罐子全新的凭证。 */
export function forkGrant(token: string): string | null {
  const grant = grantFor(token);
  if (!grant) return null;
  if (grants.size >= GRANT_LIMIT) grants.delete(grants.keys().next().value!);
  const next = randomBytes(24).toString("hex");
  grants.set(next, { ...grant, jar: new Map(), client: null, forks: [] });
  grant.forks.push(next);
  while (grant.forks.length > FORK_LIMIT) grants.delete(grant.forks.shift()!);
  return next;
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
      jar: new Map(), client: null, forks: [],
    };
    if (!(await canUsePreview(grant))) return c.text("预览不存在或无权访问", 404);
    for (const [token, value] of grants) if (value.expires <= Date.now() || readAnyPreview(value.taskId)?.gen !== value.gen) grants.delete(token);
    if (grants.size >= GRANT_LIMIT) grants.delete(grants.keys().next().value!);
    const token = randomBytes(24).toString("hex");
    grants.set(token, grant);
    c.header("cache-control", "no-store");
    c.header("referrer-policy", "no-referrer");
    const view = { ...record, proxyToken: token };
    return c.redirect(rewritePreviewUrl(target.pathname + target.search, previewBase(view, service.id), view), 302);
  });
}
