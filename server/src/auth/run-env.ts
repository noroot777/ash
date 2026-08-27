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
import { cliConfigEnvFor } from "./user-cli.js";
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
 * 「谁的活」——派生任务的归属继承(§八 三条规则之一)。
 * 父任务没有归属(存量/自用)时返回 null,与不写这一列等价。
 */
export async function inheritOwner(parentTaskId: string | null | undefined): Promise<string | null> {
  if (!parentTaskId) return null;
  const row = (await db.select({ owner: tasks.ownerUserId }).from(tasks).where(eq(tasks.id, parentTaskId))).at(0);
  return row?.owner ?? null;
}
