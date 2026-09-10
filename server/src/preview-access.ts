import { randomBytes } from "node:crypto";
import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import type { Hono } from "hono";
import { getCookie } from "hono/cookie";
import type { Actor } from "./auth/context.js";
import { currentListeningPort } from "./listening-port.js";
import { REPO_DIR } from "./paths.js";
import { alive, readAnyPreview } from "./preview-store.js";
import { previewBase } from "./preview-public.js";
import { rewritePreviewUrl } from "./preview-proxy-rewrite.js";
import { rememberCookie, type PreviewCookieJar } from "./preview-cookies.js";

/**
 * `jar` 是这一趟预览自己的 cookie 罐子（存在服务端，规矩和缘由都在 preview-cookies.ts）。
 *
 * 它挂在 grant 上而不是全局表里，是为了让寿命跟着「这一次打开预览」走：grant 一没，会话
 * 一起没，不会渗到下一次打开、更不会让别人从任务页点开就坐进你登录好的那个会话。
 *
 * **一张 grant 有两个 token，罐子只认其中一个。** 地址栏里那个（`nav`）是 bearer 凭证：谁
 * 拿到地址谁就能看这个预览（有意为之），但它**不带罐子**；真正能用罐子的是 `content`，它
 * 只出现在「已认领的客户端」拿到的那份页面内容里（改写后的 src/href、注入的桥接脚本），
 * 从不进地址栏。这么分是因为沙箱文档发出的子资源一个 cookie 都带不回来（见
 * preview-cookies.ts 开头），认领 cookie 只在导航请求上验得了 —— 只按「像不像导航」判的话，
 * 拿到地址的人绕开导航直接发 XHR/WebSocket 就照样借走你的会话。改成「钥匙不在地址栏里」
 * 之后，这件事不再取决于我们判得准不准：他手上那串根本开不了罐子。
 *
 * `client` 是认领这张凭证的客户端暗号：第一个用 `nav` 开页面的客户端认领它（种一个 HttpOnly
 * cookie），之后再有客户端拿同一个地址开页面，就分叉出一张新 grant 配空罐子。`forks` 记着
 * 分出去的那些，多到一定数量就回收最早的：应用里的同源 iframe 在明文 http 下跟顶层导航长得
 * 一模一样（见 preview-proxy.ts 的 looksLikeNavigation），每加载一次就要分一张。
 *
 * ## 预览的是这台 ash 自己时，罐子里先放一条你的会话
 *
 * 代理一个 cookie 都不转，所以预览里的 ash 前端开屏就是未登录态，只能让用户**在预览页里粘
 * 一次 key**。那个动作才是这条链上最危险的一步：key 是长期凭证、能外带、从任何机器都登得
 * 进来，2026-09-09 已经真发生过一次。所以反过来做——`open` 的时候由代理把**打开预览的这个
 * 人当前那条 ash 会话**放进罐子（用户 2026-09-10 拍板的 A 档）。
 *
 * 代价说在明处：预览页里那份代码（agent 写的分支代码）能借这条通道用你的身份调 ash 的 API。
 * 换来的是用户不必再交出 key，而且页面**拿不到 cookie 本身**（罐子在服务端，发回浏览器的那
 * 份改了名且 HttpOnly，`document.cookie` 还被注入的桥挡着），登出即失效（`canUsePreview`
 * 每次都拿 `grant.session` 复核）。
 *
 * 口子卡死在两处，少一处都会变成「把你的 ash 会话送给一个陌生上游」：
 *  · **只对这台 ash 自己的仓库播种**（项目的 repoPath == REPO_DIR）。别的项目的上游不是 ash，
 *    收到 `ash_session` 记一行访问日志就能从任何地方登进来。
 *  · **分叉不继承**（`forkGrant` 一律配空罐子）。分叉的触发条件是「另一个客户端拿同一个地址
 *    开页面」，而地址是可以被复制走的 —— 跟着复制就等于把会话交给拿到链接的人。
 */
interface PreviewGrant {
  taskId: string; gen: string; actor: Actor; expires: number; session?: string; turn?: string; keyHash?: string | null;
  jar: PreviewCookieJar; client: string | null; nav: string; content: string | null; forks: string[];
}
const grants = new Map<string, PreviewGrant>();
const GRANT_LIFE = 8 * 60 * 60_000;
const GRANT_LIMIT = 1000;
/** 一张凭证同时留着的分叉上限，多了就回收最早的（见上面的说明）。 */
export const FORK_LIMIT = 16;

/** 一张 grant 占着两个 token，收的时候两个一起收，别留下半张。 */
function dropGrant(token: string): void {
  const grant = grants.get(token);
  grants.delete(token);
  if (!grant) return;
  grants.delete(grant.nav);
  if (grant.content) grants.delete(grant.content);
}

export function grantFor(token: string): PreviewGrant | null {
  const grant = grants.get(token);
  if (!grant || grant.expires <= Date.now()) { dropGrant(token); return null; }
  return grant;
}

/**
 * 第一个用地址栏那个 token 开页面的客户端认领这张凭证：给它一个暗号（种成 cookie，之后的
 * 导航靠它证明还是同一个客户端），同时开出这张 grant 的内容 token —— 页面内容从这一刻起
 * 改写到内容 token 上，罐子也只认它。
 */
export function claimGrant(grant: PreviewGrant): string {
  grant.client = randomBytes(16).toString("hex");
  grant.content = randomBytes(24).toString("hex");
  grants.set(grant.content, grant);
  return grant.client;
}

/** 给「另一个客户端」分一张授权相同、罐子全新的凭证。 */
export function forkGrant(token: string): string | null {
  const grant = grantFor(token);
  if (!grant) return null;
  if (grants.size >= GRANT_LIMIT) dropGrant(grants.keys().next().value!);
  const next = randomBytes(24).toString("hex");
  grants.set(next, { ...grant, jar: new Map(), client: null, nav: next, content: null, forks: [] });
  grant.forks.push(next);
  while (grant.forks.length > FORK_LIMIT) dropGrant(grant.forks.shift()!);
  return next;
}

/** 两条路径指的是不是同一个地方（软链、末尾斜杠都算平）。 */
function samePlace(a: string, b: string): boolean {
  const real = (p: string) => { try { return realpathSync(p); } catch { return resolve(p); } };
  return real(a) === real(b);
}

/**
 * 被预览的仓库就是**这台 ash 自己**吗 —— 播不播那条会话就看它（缘由见文件顶部）。
 * 判仓库而不是判「预览模式」：模式是页面上选的，而「/api 打回本机 4317」这件事只有 ash
 * 自己的 `scripts/dev.mjs` 干得出来；别的项目哪怕也选「只启动前端」，上游也是它自己的东西。
 */
async function previewsOwnRepo(taskId: string): Promise<boolean> {
  const { projectOfTask } = await import("./auth/visibility.js");
  const projectId = await projectOfTask(taskId);
  if (!projectId) return false;
  const { db } = await import("./db/index.js");
  const { projects } = await import("./db/schema.js");
  const { eq } = await import("drizzle-orm");
  const row = (await db.select().from(projects).where(eq(projects.id, projectId))).at(0);
  return !!row?.repoPath && samePlace(row.repoPath, REPO_DIR);
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
    const { SESSION_COOKIE } = await import("./auth/middleware.js");
    const grant: PreviewGrant = {
      taskId, gen: record.gen, actor, expires: Date.now() + GRANT_LIFE,
      session: getCookie(c, SESSION_COOKIE), turn: c.req.header("x-ash-turn-token"),
      keyHash: actor.kind === "user" && c.req.header("authorization") ? (await getUser(actor.userId!))?.keyHash : undefined,
      jar: new Map(), client: null, nav: "", content: null, forks: [],
    };
    if (!(await canUsePreview(grant))) return c.text("预览不存在或无权访问", 404);
    // 预览的是这台 ash 自己 → 罐子里先放一条你的会话，省掉「在预览页里粘一次 key」那个
    // 真正危险的动作。为什么这么换、口子卡在哪两处，见文件顶部。
    if (grant.session && await previewsOwnRepo(taskId)) {
      rememberCookie(grant.jar, `${SESSION_COOKIE}=${grant.session}; Path=/`, "/");
    }
    for (const [token, value] of grants) if (value.expires <= Date.now() || readAnyPreview(value.taskId)?.gen !== value.gen) dropGrant(token);
    if (grants.size >= GRANT_LIMIT) dropGrant(grants.keys().next().value!);
    const token = randomBytes(24).toString("hex");
    grant.nav = token;
    grants.set(token, grant);
    c.header("cache-control", "no-store");
    c.header("referrer-policy", "no-referrer");
    const view = { ...record, proxyToken: token };
    return c.redirect(rewritePreviewUrl(target.pathname + target.search, previewBase(view, service.id), view), 302);
  });
}
