// IM 通道（飞书）在进程内「以绑定的那个人的身份」调用 ash 自己的 HTTP 路由。
//
// 为什么走完整的路由栈而不是直接调 service 函数：鉴权、可见性、个人面这几道闸都挂在
// `/api/*` 的中间件上（index.ts），而 `actorOf()` 取不到身份时兜底成**管理员**
// （context.ts）—— 直接调 service，哪次忘了设身份就静默拿到全部权限。
//
// 身份绑在 **Request 对象本身**上（模块私有的 WeakMap），不看请求里的任何字节：
//   · 外部请求伪造不了：每个真实请求的 Request 都是 node-server 现造的，不可能在这张表里，
//     头、cookie、URL、正文都不参与判定 —— 不靠穷举「哪些头算可疑」。
//   · 不放进 Hono 的 env：env 对所有 handler 可见，有人写一句 `app.fetch(x, c.env)` 身份就
//     跟到另一个请求上去了；`getConnInfo` 读 env.incoming，自己造的 env 进去还会直接抛错。
//   · 不用 AsyncLocalStorage：它会顺着异步链扩散到请求里拉起的后台工作，之后那些工作里的
//     任何一次进程内派发都会继承 im 身份。
// 代价：**复制过的 Request 会丢身份**（`new Request(req)`、`req.clone()`、`app.request(req, init)`）。
// 所以 dispatchAsIm 只直接调 fetch(req)，Request 在函数里造、在函数里用完，不流出去。
//
// 白名单做在服务端这道闸里，不只靠通道层：自用模式下终端、目录选择、`PATCH /settings`
// 对任何身份都放行，通道代码哪天多调了一条路由，这里是最后一道。
import { and, eq } from "drizzle-orm";
import type { Context, Next } from "hono";
import { db } from "../db/index.js";
import { imBindings } from "../db/schema-im.js";
import { setActor, SINGLE_USER_ID, type Actor } from "./context.js";
import { isMultiUser } from "./mode.js";
import { getUser } from "./store.js";

export interface ImPrincipal {
  channel: "feishu";
  appId: string;
  openId: string;
}

export interface ImCall {
  method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
  path: `/api/${string}`;
  body?: unknown;
}

export type AppFetch = (req: Request) => Response | Promise<Response>;

const principals = new WeakMap<Request, ImPrincipal>();

/** 唯一入口：造请求、登记身份、派发，一步做完。 */
export async function dispatchAsIm(fetch: AppFetch, principal: ImPrincipal, call: ImCall): Promise<Response> {
  const req = new Request(`http://ash.internal${call.path}`, {
    method: call.method,
    headers: call.body === undefined ? {} : { "content-type": "application/json" },
    body: call.body === undefined ? undefined : JSON.stringify(call.body),
  });
  principals.set(req, { ...principal });
  return fetch(req);
}

export function imPrincipalOf(req: Request): ImPrincipal | undefined {
  return principals.get(req);
}

/**
 * 通道用得到的全部路由（方法 + 路径）。新功能要多调一条，就在这里加一行并写清用途。
 * 刻意不在名单里的：reclaim-turn / kill-cua / 删会话片段（真人专属）、verify-override（不可逆
 * 地一路推进到合并）、/settings、/host*、/open-local、终端、接力、执行器与供应商。
 */
const IM_ROUTES: ReadonlyArray<readonly [ImCall["method"], RegExp]> = [
  ["GET", /^\/api\/tasks\/[^/]+$/],
  ["GET", /^\/api\/tasks\/[^/]+\/sessions$/],
  ["GET", /^\/api\/sessions\/[^/]+\/notices$/],
  ["GET", /^\/api\/tasks\/[^/]+\/free-workflow$/],
  ["GET", /^\/api\/projects$/],
  // /tasks 列出一个项目的任务
  ["GET", /^\/api\/tasks$/],
  // 决策卡上的按钮
  ["POST", /^\/api\/tasks\/[^/]+\/(?:answer|accept|retry)$/],
  ["POST", /^\/api\/tasks\/[^/]+\/free-workflow\/review\/dispute\/resolution$/],
  ["POST", /^\/api\/tasks\/[^/]+\/gate$/],
  // 回复卡片 = 回复任务；/new 建任务并开跑；/stop 停任务
  ["POST", /^\/api\/tasks\/[^/]+\/(?:reply|run|stop)$/],
  ["POST", /^\/api\/tasks$/],
  // 单聊进助手房间、群进项目群聊房间
  ["GET", /^\/api\/chats$/],
  ["POST", /^\/api\/chats$/],
  ["GET", /^\/api\/chats\/[^/]+$/],
  ["POST", /^\/api\/chats\/[^/]+\/(?:messages|stop)$/],
  // 飞书里发来的图片/文件转存
  ["POST", /^\/api\/uploads$/],
];

export function imRouteAllowed(method: string, path: string): boolean {
  return IM_ROUTES.some(([m, re]) => m === method && re.test(path));
}

const FORBIDDEN_HEADERS = [
  "cookie", "authorization", "x-ash-source-task-id", "x-ash-turn-token",
  "x-ash-direction-token", "x-ash-human-action-token",
];

/**
 * authGate 在判模式之前先调这里：Request 登记过 im 身份就只走这一支，不许再落到
 * agent / 自用模式 / cookie 任何一支。返回 null = 不是 im 请求。
 */
export async function imGate(c: Context, next: Next): Promise<Response | void | null> {
  const principal = imPrincipalOf(c.req.raw);
  if (!principal) return null;
  const path = new URL(c.req.url).pathname;
  if (!imRouteAllowed(c.req.method, path)) {
    return c.json({ error: "这个操作不能经飞书发起，请在 ash 页面上操作" }, 403);
  }
  if (FORBIDDEN_HEADERS.some((name) => c.req.header(name))) {
    return c.json({ error: "IM 通道请求不应携带其它凭证" }, 403);
  }
  const actor = await imActorFor(principal);
  if (!actor) return c.json({ error: "飞书绑定已失效，请在 ash 网页上重新绑定" }, 403);
  // 验收只放「照常验收」：跳过前置命令、确认未验证都是绕过用户自己设的闸，只能在网页上点。
  if (c.req.method === "POST" && /\/accept$/.test(path)) {
    const body = await c.req.json().catch(() => ({})) as Record<string, unknown>;
    if (body && typeof body === "object" && ("gate" in body || "confirmUnverified" in body)) {
      return c.json({ error: "跳过验收前置命令、确认未验证只能在 ash 页面上操作" }, 403);
    }
  }
  setActor(c, actor);
  await next();
}

/** 绑定 → 身份。多人模式下要求账号仍是 active；自用模式下就是机主。 */
export async function imActorFor(principal: ImPrincipal): Promise<Actor | null> {
  const binding = (await db.select().from(imBindings).where(and(
    eq(imBindings.channel, principal.channel),
    eq(imBindings.appId, principal.appId),
    eq(imBindings.openId, principal.openId),
  ))).at(0);
  if (!binding) return null;
  if (!(await isMultiUser())) {
    return { kind: "im", userId: SINGLE_USER_ID, role: "member", name: "飞书·本机", imOpenId: principal.openId };
  }
  if (!binding.userId) return null;
  const user = await getUser(binding.userId);
  if (!user || user.status !== "active") return null;
  // role 写死 member：实例管理员绑定的飞书也拿不到管理员权限（isAdminActor 对 im 恒 false，
  // 这里是第二道）。可见性按这个人作为项目成员的那一份算。
  return { kind: "im", userId: user.id, role: "member", name: `飞书·${user.name}`, imOpenId: principal.openId };
}
