// 鉴权中间件:多人模式下所有请求的第一道闸(§三)。
//
// **覆盖面是正面清单,不是黑名单**(审查修订 C9):`/api/*`、`/mobile`、`/review`、
// preview 端点全部在闸内;豁口只有三类,写死在 PUBLIC_PATHS / 判定函数里。
//
// **CSRF 是这道闸的组成部分,不是可选加固**(审查修订 C8)。实测:Hono 的 `req.json()`
// 就是 `JSON.parse(await text())`,**不校验 content-type**(node_modules/hono/dist/
// request.js:117),所以一个 `text/plain` 的简单请求可以带着 cookie 免预检直达任何写
// 端点。三件套:
//   ① cookie 一律 `SameSite=Lax`(跨站导航之外的跨站请求根本带不上 cookie)
//   ② 写操作校验 `Origin` / `Sec-Fetch-Site`(照 dir-picker.ts:316-342 的现成先例)
//   ③ Bearer 认证的请求天然免疫(浏览器不会自动附加 Authorization 头),所以只对
//      cookie 身份做 ②
import type { Context, MiddlewareHandler, Next } from "hono";
import { getCookie } from "hono/cookie";
import { eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { tasks } from "../db/schema.js";
import { SINGLE_ACTOR, ANONYMOUS_ACTOR, setActor, type Actor } from "./context.js";
import { isMultiUser } from "./mode.js";
import { resolveSession, touchUser, findUserByKey } from "./store.js";

export const SESSION_COOKIE = "ash_session";

/** 无需登录就能打的接口。清单短、且每一条都要说得出理由。 */
const PUBLIC_API_PATHS = new Set([
  // 重启脚本与手机端探针:它们在拿到 key 之前就要判断「这台在不在」。
  "/api/health",
  // 前端的第一次分叉(要不要进向导/登录页)本身不能要求登录。
  "/api/auth/state",
  "/api/auth/login",
  "/api/auth/setup",
  // ── 机器对机器的接力端点 ────────────────────────────────────────────────
  // 它们由**对端的 ash 服务端**来调,拿不到本机的 cookie 也没有本机的 key,所以走
  // 不了这道闸;它们自己那套闸更严:ed25519 签名 + 来源机审批 + §十一 的用户级 key。
  // **必须逐条列**,不能放 `/api/handoff/` 整个前缀 —— 那底下还住着本机设置面
  // (来源审批、目标机清单、配对申请),放行整个前缀等于让局域网里任何未登录的人
  // 批准入站机器信任(第 1 轮审查 P0)。
  "/api/handoff/ping",
  "/api/handoff/import",
  "/api/handoff/return/ping",
  "/api/handoff/return/import",
]);

/**
 * 前缀豁口。三条,每条都说得出「为什么它到不了登录态」:
 *  · `/api/handoff/proxy/*` —— 同上,对端服务端来调,全部经 `requireApprovedPeer`
 *    验签且只能碰它自己交来的那条任务(handoff-remote.ts `ownedInboundTask`)。
 *  · 领取链接与项目邀请 —— 拿它换的就是登录本身,要求先登录是死结。
 */
const PUBLIC_API_PREFIXES = ["/api/handoff/proxy/", "/api/auth/claim/", "/api/auth/project-invite/"];

/**
 * 供应商 relay 的两条:Codex 协议转换与 Claude 1M 映射会把 CLI 的 `base_url` 指回本机 ash
 * (`openai-converter/common.ts` `protocolConverterBaseUrl`、`anthropic-context-1m.ts`
 * `anthropicContext1mBaseUrl`)。**发请求的是 CLI 子进程,它手上只有供应商 API key,不可能
 * 带 ash 的 cookie 或用户 key** —— 不放行,多人模式下这两条会先被这道闸拦成「请先登录」,
 * 根本到不了路由自己那道更严的闸(`secretsEqual(bearerToken(...), provider.apiKey)`),于是
 * 「多人模式只许派接了 relay 的 CLI」这条前提反过来被自己拦死(第 2 轮审查 P1)。
 *
 * 放行的是**路径形状**,不是「无需鉴权」:凭证换成了供应商自己的 API key。也正因为凭证在
 * 路由内校验,这里必须钉死到 `/v1` 那一段 —— 只放 `/api/llm-providers/:id/` 前缀会连带把
 * 供应商的增删改查(里面就装着 key)一起免登录。
 */
const PROVIDER_RELAY_PATH = /^\/api\/llm-providers\/[^/]+\/(?:convert|context-1m)\/v1(?:\/|$)/;

/**
 * SPA 壳:登录页、领取页本身要打得开。**壳内不得内嵌任何数据**(§三)——
 * index.html 是一份静态构建产物,数据一律走 `/api/*`,所以放行它不泄露任何东西。
 */
function isSpaShell(path: string): boolean {
  if (path.startsWith("/api/")) return false;
  if (path === "/mobile" || path.startsWith("/mobile/")) return false;
  if (path === "/review" || path.startsWith("/review/")) return false;
  return true;
}

/**
 * 免登录名单的判据本体。导出是为了让回归测试直接钉住它(`test:multi-user` ⑫):
 * 「哪几条能免登录」是这道闸唯一的软肋,靠通读维护不住 —— 曾经放行了
 * `/api/handoff/` 整个前缀,连带把来源审批也免登录了。
 */
export const isPublicApiPath = (path: string): boolean =>
  PUBLIC_API_PATHS.has(path)
  || PUBLIC_API_PREFIXES.some((p) => path.startsWith(p))
  || PROVIDER_RELAY_PATH.test(path);

// 写方法要过 CSRF 检查。GET/HEAD 在这套 API 里没有副作用(唯一的例外
// `/host/pick-directory` 是 POST,而且它自己另有一道同样的闸)。
const WRITE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/**
 * 跨站请求判定。两个信号,任一命中就拒:
 *  · `Sec-Fetch-Site`:浏览器自己盖的章,页面伪造不了。`same-origin`/`none` 放行。
 *  · `Origin`:老浏览器没有 Sec-Fetch-*,退而比对 host。
 * 两个头都没有 = 非浏览器调用方(curl / 手机端 / 测试),放行 —— 它们本来就不会
 * 被「用户浏览器里的另一个站点」驱动,CSRF 对它们不成立。
 */
export function crossSiteRejection(headers: {
  secFetchSite?: string | null;
  origin?: string | null;
  host?: string | null;
}): string | null {
  const site = (headers.secFetchSite ?? "").trim().toLowerCase();
  if (site) {
    return site === "same-origin" || site === "none"
      ? null
      : "跨站请求已被拒绝（写操作只接受本站发起）";
  }
  const origin = (headers.origin ?? "").trim();
  if (!origin) return null;
  let originHost: string;
  try {
    originHost = new URL(origin).host;
  } catch {
    return "Origin 头不是合法的地址";
  }
  const host = (headers.host ?? "").trim();
  if (!host) return "缺少 Host 头，无法判断请求来源";
  return originHost.toLowerCase() === host.toLowerCase()
    ? null
    : "跨站请求已被拒绝（写操作只接受本站发起）";
}

/**
 * agent 回连身份:MCP 带着 `x-ash-source-task-id` + `x-ash-turn-token` 来
 * (mcp/src/index.ts:81-84)。凭证对得上就按「那条任务的 owner」放行,**不走用户会话**
 * —— 一个 agent 的权限恰好是它那条任务的权限。
 *
 * 校验必须**同时**认 taskId 和 token:光有 token 无从查起(它不是全局唯一索引),
 * 光有 taskId 谁都能填。
 */
async function agentActor(c: Context): Promise<Actor | null> {
  const taskId = c.req.header("x-ash-source-task-id")?.trim();
  const token = c.req.header("x-ash-turn-token")?.trim();
  if (!taskId || !token) return null;
  const row = (
    await db
      .select({ owner: tasks.ownerUserId, turn: tasks.activeTurnToken })
      .from(tasks)
      .where(eq(tasks.id, taskId))
  ).at(0);
  if (!row || !row.turn || row.turn !== token) return null;
  const owner = row.owner ?? null;
  // owner 为空 = 转多人之前建的存量任务。按普通成员对待(它的项目可见集仍然生效),
  // 但不给管理员权限 —— 一个老任务不该因为「归属没填」就变成万能钥匙。
  return { kind: "agent", userId: owner, role: "member", taskId, name: `任务 ${taskId.slice(0, 8)}` };
}

/** Bearer key(mobile 每请求带一次,见 §三)。 */
async function bearerActor(c: Context): Promise<Actor | null> {
  const header = c.req.header("authorization") ?? "";
  const key = /^Bearer\s+(\S+)$/i.exec(header.trim())?.[1];
  if (!key) return null;
  const user = await findUserByKey(key);
  if (!user || user.status === "suspended") return null;
  void touchUser(user.id).catch(() => {});
  return {
    kind: "user",
    userId: user.id,
    role: user.role === "admin" ? "admin" : "member",
    name: user.name,
  };
}

async function cookieActor(c: Context): Promise<Actor | null> {
  const token = getCookie(c, SESSION_COOKIE) ?? "";
  if (!token) return null;
  const user = await resolveSession(token);
  if (!user) return null;
  void touchUser(user.id).catch(() => {});
  return {
    kind: "user",
    userId: user.id,
    role: user.role === "admin" ? "admin" : "member",
    name: user.name,
  };
}

/**
 * 闸本身。挂在 `app.route("/api", api)` **之前**(server/src/index.ts),所以它
 * 覆盖到的是**全部**路径,不只是 `/api` —— `/mobile`、`/review`、SPA 壳的分流在
 * 上面那几个判定函数里。
 */
export function authGate(): MiddlewareHandler {
  return async (c: Context, next: Next) => {
    const path = new URL(c.req.url).pathname;

    if (!(await isMultiUser())) {
      // 自用模式一行不拦(§二)。仍然 set 一个 actor,好让下游统一走 actorOf()。
      setActor(c, SINGLE_ACTOR);
      return next();
    }

    // 模式已经是 multi 却还没建出管理员(转换中途崩了)—— **这里不开任何后门**。
    // 补做首启走的是既有的免登录名单:`/api/auth/state` 决定要不要出向导、
    // `/api/auth/setup` 把管理员补出来(routes.ts 的 `resuming` 分支不查管理员身份),
    // SPA 壳照常渲染。曾经这里是「setActor(SINGLE_ACTOR) + next()」放行**全部路径**:
    // 那一刻库里已经装着真实的项目和任务,等于未登录访客拿到实例管理员的全部读写权
    // (审查 P0 实测:`GET /api/tasks` 200 回出别人的任务)。
    const actor = (await agentActor(c)) ?? (await cookieActor(c)) ?? (await bearerActor(c));

    if (actor) {
      // CSRF 只对 cookie 身份成立:Bearer 与回合凭证都要显式设头,浏览器不会替
      // 第三方站点自动附加(见文件顶部)。
      if (actor.kind === "user" && WRITE_METHODS.has(c.req.method) && !c.req.header("authorization")) {
        const rejection = crossSiteRejection({
          secFetchSite: c.req.header("sec-fetch-site"),
          origin: c.req.header("origin"),
          host: c.req.header("host"),
        });
        if (rejection) return c.json({ error: rejection }, 403);
      }
      setActor(c, actor);
      return next();
    }

    setActor(c, ANONYMOUS_ACTOR);
    if (isPublicApiPath(path)) return next();
    // 壳可以打开(登录页要渲染),数据一律不行。
    if (isSpaShell(path)) return next();
    if (path.startsWith("/api/")) {
      return c.json({ error: "请先登录", needsAuth: true }, 401);
    }
    // /mobile 与 /review 不是 SPA 壳:前者是手机 app 的静态站(它自己有 key 字段,
    // 但外框页与导出资源都得先登录才给),后者直接暴露待审视频文件。
    return c.text("请先登录 ash 后再访问（多人模式）", 401);
  };
}
