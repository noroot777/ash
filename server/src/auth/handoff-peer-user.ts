// 接力的**入站**用户层(§十一)。机器级 ed25519 签名保留,但降级为「传输信任」——
// 它回答的是「哪台机器可以连我」;这一层回答的是「那台机器上的**哪个人**在请求」。
//
// 判据只有一条:请求头里带的那把 key 是不是本机某个在用账号的 key。是 → 这次请求
// 按那个人的可见集与权限办;不是 → 按下面 `peerUserFor` 的四种组合处置。
//
// 四种组合(计划里的矩阵)在这一层收口,调用点不再各自判断:
//   本机单人  → 恒回 { kind: "single" }:本机没有用户概念,机器级配对即全部授权。
//   本机多人 + 带对的 key → { kind: "user", user }
//   本机多人 + 带错/过期的 key → 抛 401「这把 key 在本机不认」
//   本机多人 + 压根没带 key → 抛 401「在这台机器上没有账号,找管理员开通」
import type { Context } from "hono";
import type { Actor } from "./context.js";
import { SINGLE_ACTOR } from "./context.js";
import type { UserRow } from "./store.js";
import { countUsers, findUserByKey } from "./store.js";
import { HandoffError } from "../handoff-types.js";
import { isMultiUser } from "./mode.js";

/** 出站请求把「我在对端的 key」放这个头里。它是凭证,只走 header,不进 URL/日志。 */
export const PEER_USER_KEY_HEADER = "x-ash-peer-user-key";

export type PeerUser =
  | { kind: "single"; user: null }
  | { kind: "user"; user: UserRow };

/**
 * 这次入站接力请求代表谁。多人模式下没有有效 key 一律抛 401 —— 那正是计划要的
 * 「要在那台机器上做事,就得在那台机器上有账号」。
 */
export async function peerUserFor(c: Context): Promise<PeerUser> {
  if (!(await isMultiUser())) return { kind: "single", user: null };
  const key = c.req.header(PEER_USER_KEY_HEADER)?.trim() ?? "";
  if (!key) {
    throw new HandoffError(
      "对端是多人实例:接力必须带上「你在对端的账号 key」。去「设置 → 默认规则 → 接力目标机」补上它;还没有账号就找对端管理员开一个。",
      401,
    );
  }
  const user = await findUserByKey(key);
  if (!user) throw new HandoffError("这把 key 在对端机器上不认(可能已被重置或停用),找对端管理员重发。", 401);
  if (user.status === "suspended") throw new HandoffError("你在对端机器上的账号已被停用。", 403);
  return { kind: "user", user };
}

/**
 * 软版本:探活(`/handoff/ping`)用。没带 key 不抛错,只回 null —— ping 是配对入口,
 * 拦死它会让源机连「对端是多人实例、我需要一把 key」这句话都拿不到。
 */
export async function peerUserSoft(c: Context): Promise<PeerUser | null> {
  if (!(await isMultiUser())) return { kind: "single", user: null };
  const key = c.req.header(PEER_USER_KEY_HEADER)?.trim() ?? "";
  if (!key) return null;
  const user = await findUserByKey(key);
  if (!user || user.status === "suspended") return null;
  return { kind: "user", user };
}

/** 这次入站请求落地的任务归属谁(§八 三条继承规则之三:接力导入的记对端用户)。 */
export const peerOwnerId = (peer: PeerUser): string | null =>
  peer.kind === "user" ? peer.user.id : null;

/**
 * 把入站接力的身份变成普通 `Actor`,好让可见性判据(`auth/visibility.ts`)一字不改地
 * 复用。**必须走这一步**:接力如果自己拼一套「他能看哪些项目」,那就是第二份判据,
 * 而第二份判据迟早比第一份宽 —— 宽掉的那半格正是横向越权。
 */
export const peerActor = (peer: PeerUser): Actor =>
  peer.kind === "user"
    ? {
      kind: "user",
      userId: peer.user.id,
      role: peer.user.role as Actor["role"],
      name: peer.user.name,
    }
    : SINGLE_ACTOR;

/**
 * 出站请求里自报的实例模式标签(`single` / `multi:<人数>`)。对端拿它做**知情批准**:
 * 批一台多人实例 = 那台机器上所有人都能经这条路进来(§十一 多人→单人 那一格)。
 * 不是权限判据 —— 自报的东西没资格当判据,它只负责让点「批准」的人知道自己在批什么。
 */
export async function localModeTag(): Promise<string> {
  if (!(await isMultiUser())) return "single";
  return `multi:${await countUsers()}`;
}
