// 派任务时按 `tasks.ownerUserId` 注入的那一组环境变量(§八)。
//
// 两件事,必须在**同一个地方**做,否则三条起跑路径(fresh run / resume / 团队常驻台)
// 会各漏一件:
//  ① 个人 CLI 配置目录(CLAUDE_CONFIG_DIR / CODEX_HOME)——「抹去宿主订阅」的载体。
//  ② git 署名(GIT_AUTHOR_* / GIT_COMMITTER_*)——不注入的话多人协作的提交在 git log
//     里全是宿主机一个身份,归属清晰无从谈起(审查修订 B6)。
//
// 第三件事(server 自己环境里的出站凭证不透传)不在这里,而在
// `executors/spawn.ts` 的 `agentBaseEnv()` —— 它必须是**基座**,让供应商注入的 key
// 拼在它后面覆盖回来;放在这里会把 relay 的 key 一起删掉。
//
// 自用模式一律返回空对象:那条路的行为必须与本功能上线前逐字节一致。
import { eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { tasks, users } from "../db/schema.js";
import { cliConfigEnvFor, configDirEnvVar } from "./user-cli.js";
import { isMultiUser } from "./mode.js";

export type OwnerRunEnv = Record<string, string | undefined>;

/** 给一个**具体任务**算这组环境变量。agentType 决定注哪个配置目录变量。 */
export async function runEnvForTask(taskId: string, agentType: string): Promise<OwnerRunEnv> {
  if (!(await isMultiUser())) return {};
  const task = (await db.select({ owner: tasks.ownerUserId }).from(tasks).where(eq(tasks.id, taskId))).at(0);
  return runEnvForOwner(task?.owner ?? null, agentType);
}

export async function runEnvForOwner(ownerUserId: string | null, agentType: string): Promise<OwnerRunEnv> {
  if (!(await isMultiUser()) || !ownerUserId) return {};
  const env: OwnerRunEnv = { ...cliConfigEnvFor(ownerUserId, agentType) };
  const user = (await db.select().from(users).where(eq(users.id, ownerUserId))).at(0);
  if (user) {
    const name = user.gitName.trim() || user.name;
    const email = user.gitEmail.trim() || `${user.dirName}@ash.local`;
    env.GIT_AUTHOR_NAME = name;
    env.GIT_AUTHOR_EMAIL = email;
    env.GIT_COMMITTER_NAME = name;
    env.GIT_COMMITTER_EMAIL = email;
  }
  return env;
}

/**
 * 这条任务的 CLI **实际**会去哪个目录找自己的会话历史。null = 宿主机默认目录
 * (`~/.claude`、`$CODEX_HOME`),即自用模式和没有归属的存量任务。
 *
 * 谁要它:任务接力搬会话文件的两侧(`handoff-collect.ts` 找、`handoff-import-payload.ts`
 * 放)。**必须和上面注入的那一份同源**——2026-08-29 现场:导入侧把 transcript 写死进
 * `~/.claude/projects/…`,而多用户模式下起跑注入了 `CLAUDE_CONFIG_DIR`(它**整个取代**
 * `~/.claude`,不回落),于是文件在盘上、CLI 眼里却没有,`--resume` 换回一句
 * "No conversation found with session ID",回合 0.9 秒空转,任务按未完成记 failed。
 * 所以这里不另拼一次路径,直接读注入结果:判据只有一份,漂不了。
 */
export async function cliConfigDirForOwner(
  ownerUserId: string | null | undefined,
  agentType: string,
): Promise<string | null> {
  // 没有归属人 = 宿主机默认目录,这个答案与实例模式无关。提前返回不只是省一次查询:
  // 它让「不碰库」的调用方(纯函数级回归、启动早期)不会因为一次 app_settings 查询而炸。
  if (!ownerUserId) return null;
  const key = configDirEnvVar(agentType);
  if (!key) return null;
  return (await runEnvForOwner(ownerUserId, agentType))[key] ?? null;
}

/**
 * 「这条旧会话,这一轮还接得上吗」——判据是**两边的 CLI 配置目录是不是同一个**。
 *
 * CLI 的 transcript 躺在**开它的那个人**的配置目录里(多人模式一人一份),拿 A 的
 * session id 去 B 的 `CLAUDE_CONFIG_DIR` 里 `--resume`,CLI 只会回一句 "No conversation
 * found with session ID" —— 与 2026-08-29 那次接力事故同一个现场,只是触发口从「搬机器」
 * 换成了「换个人回复」(共享项目里 B 回复 A 的任务)。所以选 `prev` 时不能只看
 * agentType+role,还要看这一列。
 *
 * 自用模式两边恒为 null,判据永远成立,行为与本函数加入前逐字节一致。
 */
export async function sameCliConfigDir(
  a: string | null | undefined,
  b: string | null | undefined,
  agentType: string,
): Promise<boolean> {
  if ((a ?? null) === (b ?? null)) return true;
  return (await cliConfigDirForOwner(a, agentType)) === (await cliConfigDirForOwner(b, agentType));
}

/**
 * 「谁的活」——派生任务的归属继承(§八 三条规则之一)。
 * 父任务没有归属(存量/自用)时返回 null,与不写这一列等价。
 */
export async function inheritOwner(parentTaskId: string | null | undefined): Promise<string | null> {
  if (!parentTaskId) return null;
  const row = (await db.select({ owner: tasks.ownerUserId }).from(tasks).where(eq(tasks.id, parentTaskId))).at(0);
  return row?.owner ?? null;
}
