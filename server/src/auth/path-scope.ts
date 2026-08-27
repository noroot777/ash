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
import { eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { users } from "../db/schema.js";
import { expandHome } from "../git.js";
import type { Actor } from "./context.js";
import { isAdminActor } from "./context.js";
import { isMultiUser, realPathClampError, userHomeDir } from "./mode.js";

/** 这个人的目录;自用模式、管理员、或身份不明时返回 null(= 不钳)。 */
export async function homeDirOf(actor: Actor): Promise<string | null> {
  if (!(await isMultiUser())) return null;
  if (isAdminActor(actor)) return null;
  if (!actor.userId) return null;
  const user = (await db.select({ dirName: users.dirName }).from(users).where(eq(users.id, actor.userId))).at(0);
  if (!user) return null;
  return userHomeDir(user.dirName);
}

/**
 * 返回一句给用户看的拒绝理由,或 null 表示放行。
 * 空路径放行 —— 「先建项目、回头再补路径」是既有的正常用法,不该被多人模式拦掉。
 */
export async function projectPathRejection(actor: Actor, repoPath: string): Promise<string | null> {
  const raw = (repoPath ?? "").trim();
  if (!raw) return null;
  const home = await homeDirOf(actor);
  if (!home) return null;
  return realPathClampError(home, expandHome(raw));
}

/** 路由里的常用形状:被拒就抛 403(错误对象带 status,交给各路由的 catch 落地)。 */
export async function requireProjectPath(actor: Actor, repoPath: string): Promise<void> {
  const rejection = await projectPathRejection(actor, repoPath);
  if (rejection) throw Object.assign(new Error(rejection), { status: 403 });
}
