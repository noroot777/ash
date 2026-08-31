// 派任务时按 `tasks.ownerUserId` 注入的那一组环境变量(§八)。
//
// 两件事,必须在**同一个地方**做,否则三条起跑路径(fresh run / resume / 团队常驻台)
// 会各漏一件:
//  ① 个人 CLI 配置目录(CLAUDE_CONFIG_DIR / CODEX_HOME)——「抹去宿主订阅」的载体。
//     **只在隔离档下注入**:实例开了「共用宿主机 CLI」(§八之二)时一个都不注,大家用
//     宿主机默认目录、烧同一份官方额度,那正是那一档的全部意义。
//  ② git 署名(GIT_AUTHOR_* / GIT_COMMITTER_*)——不注入的话多人协作的提交在 git log
//     里全是宿主机一个身份,归属清晰无从谈起(审查修订 B6)。**两档都注**:共用额度
//     不等于共用身份,提交署谁的名跟钱从哪出是两件事。
//
// 第三件事(server 自己环境里的出站凭证不透传)不在这里,而在
// `executors/spawn.ts` 的 `agentBaseEnv()` —— 它必须是**基座**,让供应商注入的 key
// 拼在它后面覆盖回来;放在这里会把 relay 的 key 一起删掉。
//
// 自用模式一律返回空对象:那条路的行为必须与本功能上线前逐字节一致。
import { eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { tasks, users } from "../db/schema.js";
import { cliConfigEnvFor, configDirEnvVar, userCliDir } from "./user-cli.js";
import { isHostCliIsolated, isMultiUser } from "./mode.js";

export type OwnerRunEnv = Record<string, string | undefined>;

/** 给一个**具体任务**算这组环境变量。agentType 决定注哪个配置目录变量。 */
export async function runEnvForTask(taskId: string, agentType: string): Promise<OwnerRunEnv> {
  if (!(await isMultiUser())) return {};
  const task = (await db.select({ owner: tasks.ownerUserId }).from(tasks).where(eq(tasks.id, taskId))).at(0);
  return runEnvForOwner(task?.owner ?? null, agentType);
}

export async function runEnvForOwner(ownerUserId: string | null, agentType: string): Promise<OwnerRunEnv> {
  if (!(await isMultiUser()) || !ownerUserId) return {};
  const env: OwnerRunEnv = (await isHostCliIsolated()) ? { ...cliConfigEnvFor(ownerUserId, agentType) } : {};
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
 * (`~/.claude`、`$CODEX_HOME`),即自用模式、共用宿主 CLI 的实例,和没有归属的存量任务。
 *
 * 谁要它:任务接力搬会话文件的两侧(`handoff-collect.ts` 找、`handoff-import-payload.ts`
 * 放)。**必须和上面注入的那一份同源**——2026-08-29 现场:导入侧把 transcript 写死进
 * `~/.claude/projects/…`,而多用户模式下起跑注入了 `CLAUDE_CONFIG_DIR`(它**整个取代**
 * `~/.claude`,不回落),于是文件在盘上、CLI 眼里却没有,`--resume` 换回一句
 * "No conversation found with session ID",回合 0.9 秒空转,任务按未完成记 failed。
 * 所以这里不另拼一次路径,直接读注入结果:判据只有一份,漂不了。
 *
 * ⚠ 这个答案**会随实例设置变**(管理员改「CLI 额度」那一下)。所以问「某条**旧**会话
 * 的文件在哪」不能调它,要调 `sessionCliConfigDir` —— 那条读的是会话行上记下来的
 * 当时那个目录。
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

/** 起跑时往 `sessions.cli_config_dir` 里记的值。`""` = 宿主机默认目录(见该列的说明)。 */
export async function cliConfigDirColumn(
  ownerUserId: string | null | undefined,
  agentType: string,
): Promise<string> {
  return (await cliConfigDirForOwner(ownerUserId, agentType)) ?? "";
}

/** 会话行上跟「文件在哪」有关的那两列。读侧只认这个形状,免得每处各查各的。 */
export interface SessionCliDirRow {
  /** 缺省/null 一律当「老行」处理:这一列上线前建的会话没有它。 */
  cliConfigDir?: string | null;
  runOwnerUserId: string | null;
}

/**
 * **老行**(这一列上线之前建的会话)当初写在哪个目录。
 *
 * 判据只能是**当时那条规则**:那时多人模式还没有「共用宿主 CLI」这一档,所以
 * **跑在某个归属人名下 = 一定注了个人配置目录**;`run_owner_user_id` 为空 = 没有
 * 归属人(自用模式,或多人转换之前的存量会话)= 宿主机默认目录。
 *
 * ⚠ **不能拿现在的设置现算**(第 1 轮审查 P1):管理员一改成共用,现算立刻回答
 * 「宿主机默认目录」,而盘上那份 transcript 还躺在 `data/user-cli/<uid>/` 里没动,
 * 于是老会话被判成「接得上」,再一次撞回这次改动本来要堵的 "No conversation found"。
 *
 * ⚠ 也**不能回落到任务的 `ownerUserId`**:自用转多人时存量任务会被整体划给初始
 * 管理员(§十三),那个字段因此对「这条会话当初跑在谁名下」毫无证明力 —— 拿它一问,
 * 转换前写在 `~/.claude` 的老会话会被说成写在管理员的个人目录里。只认 spawn 当时
 * 钉下的 `run_owner_user_id`,它跟 `cli_config_dir` 是同一批写入点,不会有一半的行。
 *
 * 不走 `cliConfigEnvFor`:那条路会 `mkdirSync` 建目录,而问「旧文件在哪」不该有副作用
 * (共用档下它会给每个碰到的用户凭空建出一套没人读的个人目录)。路径两边同源
 * (`userCliDir`),漂不了。
 */
function legacyCliConfigDir(runOwnerUserId: string | null, agentType: string): string | null {
  if (!runOwnerUserId) return null;
  if (!configDirEnvVar(agentType)) return null;
  return userCliDir(runOwnerUserId, agentType);
}

/**
 * **这条会话的文件当初写在哪个目录**。null = 宿主机默认目录。
 *
 * 权威是会话行上记下的 `cli_config_dir`,不是「按归属人现算一遍」——后者的答案会随
 * 实例设置漂移:管理员把「CLI 额度」从每人自带改成共用(§八之二),现算的结果立刻从
 * `data/user-cli/<uid>/claude` 变成宿主默认目录,而盘上的 transcript 一个字节都没动。
 * 拿新答案去找旧文件必然扑空,而扑空的表现正是 2026-08-29 那句 "No conversation found"。
 *
 * `cli_config_dir` 为空只有一种情形:这一列上线之前建的老行,交给 `legacyCliConfigDir`
 * 按**当时**的规则解释(见那上面)。注意 `""` **不是**空:它是「宿主机默认目录」这个
 * 明确答案,不能落进老行分支。
 */
export async function sessionCliConfigDir(
  row: SessionCliDirRow,
  agentType: string,
): Promise<string | null> {
  if (row.cliConfigDir == null) return legacyCliConfigDir(row.runOwnerUserId, agentType);
  return row.cliConfigDir || null;
}

/**
 * 「这条旧会话,这一轮还接得上吗」——判据是**两边的 CLI 配置目录是不是同一个**:
 * 它当初写在哪(会话行记着),这一轮会去哪(按这一轮跑的人现算)。
 *
 * 两个触发口,同一堵墙:
 *  · **换个人回复**(共享项目里 B 回复 A 的任务)—— transcript 躺在 A 的配置目录里,
 *    拿 A 的 session id 去 B 的 `CLAUDE_CONFIG_DIR` 里 `--resume`,CLI 只会回一句
 *    "No conversation found with session ID"(2026-08-29 接力事故的同源第二格)。
 *  · **实例把「CLI 额度」换了档**(§八之二)—— 每个人的配置目录整体挪了位置,盘上的
 *    文件没动。不比对「当初那个目录」的话,这里会一路放行,然后在 CLI 那头硬失败。
 *
 * 返回 false 时调用方的处置是既有那条:**另开一条会话行 + 在旧会话时间线里说明原因**,
 * 不是报错。自用模式两边恒为 null,判据永远成立,行为与本函数加入前逐字节一致。
 */
export async function sessionResumableHere(
  row: SessionCliDirRow,
  runOwnerUserId: string | null | undefined,
  agentType: string,
): Promise<boolean> {
  const was = await sessionCliConfigDir(row, agentType);
  const now = await cliConfigDirForOwner(runOwnerUserId ?? null, agentType);
  return was === now;
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
