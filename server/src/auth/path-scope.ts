// 「这条路径这个人能不能用」——项目登记/克隆/MCP 三个入口共用的一份钳制(§七)。
//
// 为什么单独一个文件而不是直接调 mode.ts 的 pathClampError:那两个原语只认「home 与
// candidate」,而调用点手上只有一个 actor。把「actor → 他的目录 → 钳制」这段合成一步,
// 才不会出现某个入口忘了查用户、拿 rootDir 当 home 用的情况。
//
// 三条硬规矩,任何入口都不许绕:
//  ① 实例管理员不受钳制(§七:他能选根目录之外的任意路径,这是刻意的 —— 他本来就
//     能碰到这台机器上的一切)。
//  ② 普通用户只能用 `rootDir/<他的目录名>` 之内、且**不是那个目录本身**的路径。
//  ③ realpath 之后再钳一次:一条指向外面的软链就是现成的越狱通道。
//
// 判据是**三态**,别退回二态:「算不出这个人的目录」曾经和「不用钳」共用一个 null,
// 于是一个 `ownerUserId` 为空的存量任务 —— `agentActor` 明确写着「不给管理员权限」——
// 反而拿到了**不受钳制**的路径能力:根目录之外建项目、克隆、建目录全通(第 1 轮审查
// P1)。身份算不出来时唯一安全的答案是拒绝,不是放行。
import { eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { users } from "../db/schema.js";
import { expandHome } from "../git.js";
import type { Actor } from "./context.js";
import { isAdminActor } from "./context.js";
import { isMultiUser, realPathClampError, userHomeDir } from "./mode.js";

/** 这个 actor 的路径钳制范围。**三态**,理由见文件头。 */
export type PathScope =
  /** 自用模式 / 实例管理员:整台机器随便走(§七)。 */
  | { clamp: "none" }
  /** 普通用户:只能在自己那个目录里。 */
  | { clamp: "home"; home: string }
  /** 算不出他的目录:一律不给。**不是**「不钳」。 */
  | { clamp: "deny"; reason: string };

/**
 * 「这个人的路径边界在哪」——**只此一份**。项目登记 / 克隆 / 改路径 / 路径体检 /
 * 建目录 / 目录浏览全从这里取,免得某个入口自己算一遍、又把「查不到人」算成放行。
 */
export async function pathScopeOf(actor: Actor): Promise<PathScope> {
  if (!(await isMultiUser())) return { clamp: "none" };
  if (isAdminActor(actor)) return { clamp: "none" };
  if (!actor.userId) {
    // 到这里只剩两种:没归属账号的回合凭证(转多人之前建的存量任务),和匿名。
    // 两种都没有「他的目录」可言 —— 而这台机器上除了根目录还有别人的东西。
    return {
      clamp: "deny",
      reason: "这条凭证没有对应的账号目录，用不了本机路径。存量任务请让实例管理员把它归到一个人名下再试",
    };
  }
  const user = (await db.select({ dirName: users.dirName }).from(users).where(eq(users.id, actor.userId))).at(0);
  if (!user) return { clamp: "deny", reason: "找不到你的账号，请重新登录" };
  return { clamp: "home", home: await userHomeDir(user.dirName) };
}

/**
 * 返回一句给用户看的拒绝理由,或 null 表示放行。
 * 空路径放行 —— 「先建项目、回头再补路径」是既有的正常用法,不该被多人模式拦掉。
 */
export async function projectPathRejection(actor: Actor, repoPath: string): Promise<string | null> {
  const raw = (repoPath ?? "").trim();
  if (!raw) return null;
  const scope = await pathScopeOf(actor);
  if (scope.clamp === "none") return null;
  if (scope.clamp === "deny") return scope.reason;
  return realPathClampError(scope.home, expandHome(raw));
}

/** 路由里的常用形状:被拒就抛 403(错误对象带 status,交给各路由的 catch 落地)。 */
export async function requireProjectPath(actor: Actor, repoPath: string): Promise<void> {
  const rejection = await projectPathRejection(actor, repoPath);
  if (rejection) throw Object.assign(new Error(rejection), { status: 403 });
}
