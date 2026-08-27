// 「这次请求是谁发的」——多人模式的身份上下文。
//
// 三类调用方,判据完全不同,但都要收敛成同一个 Actor:
//  · **人**(web cookie / mobile Bearer):落在 users 表上,有实例角色。
//  · **agent**(MCP 回连,带回合凭证):不走用户会话,身份是「那个任务的 owner」。
//    见 docs/multi-user-plan.md §三。它没有 web 会话,也不该有 —— 一个 agent 拿到
//    的权限恰好是它那条任务的权限,多一分都是横向越权。
//  · **自用模式**:恒定的隐式本地用户(id 见 SINGLE_USER_ID)。这样归属列只有一套
//    逻辑,转多人时把它实名化即可,不必在每个读写点写 `if (multi)`。
//
// Actor 挂在 Hono 的 context vars 上,取用一律走 `actorOf(c)` —— 别在别处再解析一遍
// cookie/header,那就是第二份判据。
import type { Context } from "hono";
import type { UserRole } from "@ash/shared";

/**
 * 自用模式下那个隐式本地用户的 id。**不进 users 表**,归属列也一律写 null ——
 * 落成一个假 id 的话,转多人时还得再扫一遍全库把它改名。判据统一:
 * 「自用模式 = 归属列恒 null 且一律可见」。
 */
export const SINGLE_USER_ID = "__local__";

export type ActorKind = "single" | "user" | "agent" | "anonymous";

export interface Actor {
  kind: ActorKind;
  /** 自用模式为 SINGLE_USER_ID;agent 为它那条任务的 ownerUserId(可能是 null)。 */
  userId: string | null;
  role: UserRole;
  /** agent 身份专属:发起这次调用的任务。用于把创建动作钳制在它的项目/目录里。 */
  taskId?: string;
  /** 登录名(日志与错误文案用)。 */
  name: string;
}

export const SINGLE_ACTOR: Actor = {
  kind: "single",
  userId: SINGLE_USER_ID,
  role: "admin",
  name: "本机",
};

export const ANONYMOUS_ACTOR: Actor = {
  kind: "anonymous",
  userId: null,
  role: "member",
  name: "未登录",
};

// Hono 的 c.set/c.get 是无类型的字符串键。收敛成两个函数,别在调用点写裸字符串。
const ACTOR_KEY = "ashActor";

export function setActor(c: Context, actor: Actor): void {
  c.set(ACTOR_KEY as never, actor as never);
}

/**
 * 当前请求的身份。中间件一定会 set,所以正常路径上不会取到 undefined;
 * 兜底返回 SINGLE_ACTOR 是给「中间件之外挂的路由」(handoff 的签名链路)用的 ——
 * 那条路自带 ed25519 校验,不靠这里。
 */
export function actorOf(c: Context): Actor {
  return (c.get(ACTOR_KEY as never) as Actor | undefined) ?? SINGLE_ACTOR;
}

/** 多人模式下这次请求是不是实例管理员。自用模式恒 true。 */
export const isAdminActor = (actor: Actor): boolean =>
  actor.kind === "single" || actor.role === "admin";

/** 归属列该写什么。自用模式写 null(见 SINGLE_USER_ID 的注释)。 */
export const ownerIdOf = (actor: Actor): string | null =>
  actor.kind === "single" ? null : actor.userId;

export class AuthError extends Error {
  readonly status: 401 | 403;
  constructor(status: 401 | 403, message: string) {
    super(message);
    this.name = "AuthError";
    this.status = status;
  }
}

export const forbidden = (message: string) => new AuthError(403, message);
export const unauthorized = (message = "请先登录") => new AuthError(401, message);

/** 要求实例管理员,否则抛 403。路由里 `requireAdmin(actorOf(c))` 一行。 */
export function requireAdmin(actor: Actor): Actor {
  if (!isAdminActor(actor)) throw forbidden("只有实例管理员可以执行这个操作");
  return actor;
}

/** 把 AuthError 变成响应体。路由的 catch 里统一用。 */
export function authErrorResponse(error: unknown): { status: 401 | 403; body: { error: string } } | null {
  if (!(error instanceof AuthError)) return null;
  return { status: error.status, body: { error: error.message } };
}
