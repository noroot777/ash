import { randomBytes } from "node:crypto";
import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import type { Hono } from "hono";
import { getCookie } from "hono/cookie";
import type { Actor } from "./auth/context.js";
import { boundListeningPort, currentListeningPort } from "./listening-port.js";
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
 * ## 预览的是这台 ash 自己时：`/api` 单独走一跳，会话只活在那一跳上
 *
 * 代理一个 cookie 都不转，所以预览里的 ash 前端开屏就是未登录态，只能让用户**在预览页里粘
 * 一次 key**。那个动作才是这条链上最危险的一步：key 是长期凭证、能外带、从任何机器都登得
 * 进来，2026-09-09 已经真发生过一次。所以反过来做——由代理替他带上登录态（用户 2026-09-10
 * 拍板的 A 档）。
 *
 * **但绝不能把这条会话放进那个通用罐子。**通用罐子是发给「被预览的服务」的，而在这一档里
 * 那个服务是**任务分支自己启动的 vite**（`/api` 只是由它再转一跳回 4317）。分支里加一个
 * 中间件就能把原始 `ash_session` 记下来外带，之后脱离预览直接登进 ash —— 那就不是「借身份
 * 调一次 API」，而是交出一份可外带的凭证了（第 1 轮审查 P1）。
 *
 * 所以 `ownApi` 是一条**独立的路**：只有上游路径落在 `/api` 底下时才走，直接连本机 ash 的
 * 监听端口，绕开被预览的 dev server；会话装在它自己的罐子里，只在这一跳上出现。分支代码
 * 一个字都收不到，它能做的仅止于「让页面去调那些 API」—— 那正是用户认下的那份代价。
 *
 * 三个前提缺一不可，少一个就变成「把你的 ash 会话送给一个陌生上游」：
 *  · **仓库是这台 ash 自己的**（项目的 repoPath == REPO_DIR）；
 *  · **档位是「只启动前端」**（只有这一档的 `/api` 打回本机 ash；`full`/`test` 的 `/api` 是
 *    预览自己那套后端，接过来就是拿主库的数据冒充预览实例的数据）；
 *  · **分叉不继承**（`forkGrant` 一律配空的，`ownApi` 也置空）。分叉的触发条件就是「另一个
 *    客户端拿同一个地址开页面」，而地址是可以被复制走的。
 *
 * 端口取 `boundListeningPort()`（确知绑上了才有值），不取会退到 `PORT ?? 4317` 的那个——猜出来
 * 的 4317 上可能坐着另一台 ash。
 *
 * 剩下的代价说在明处：页面能借这条路用你的身份调 ash 的 API —— 包括那些会吐出凭证的端点
 * （`/api/auth/rotate-key` 换一把新 key 就是）。要再收窄只能给这一跳加白名单，那是另一件事。
 */
interface PreviewGrant {
  taskId: string; gen: string; actor: Actor; expires: number; session?: string; turn?: string; keyHash?: string | null;
  jar: PreviewCookieJar; client: string | null; nav: string; content: string | null; forks: string[];
  /** 见上面「`/api` 单独走一跳」。null = 这一档不成立，`/api` 跟别的路径一样走被预览的服务。 */
  ownApi: { port: number; jar: PreviewCookieJar } | null;
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
  grants.set(next, { ...grant, jar: new Map(), client: null, nav: next, content: null, forks: [], ownApi: null });
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
      jar: new Map(), client: null, nav: "", content: null, forks: [], ownApi: null,
    };
    if (!(await canUsePreview(grant))) return c.text("预览不存在或无权访问", 404);
    // 预览的是这台 ash 自己、而且是「只启动前端」那一档 → 给 `/api` 单独开一条直连本机 ash
    // 的路，把你这条会话放在**那条路自己的罐子**里。为什么不能放进通用罐子（分支启动的
    // dev server 会原样收到它）、三个前提为什么缺一不可，见文件顶部。
    const bound = boundListeningPort();
    if (grant.session && bound !== null && record.mode === "frontend" && await previewsOwnRepo(taskId)) {
      const jar: PreviewCookieJar = new Map();
      rememberCookie(jar, `${SESSION_COOKIE}=${grant.session}; Path=/`, "/");
      grant.ownApi = { port: bound, jar };
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
