// 「个人面」资源的归属判据(§八)。
//
// 供应商、执行器、起手式、审查者、团队预设、随手记 —— 这几张表在多人模式下**逐人
// 隔离,互不可见**,连实例管理员也不例外(他管的是用户和实例设置,不是别人的 API key)。
//
// 与 visibility.ts 的分工:那份管「项目/任务」这条共享轴(成员表说了算),这份管
// 「我的东西」这条私有轴(ownerUserId 说了算)。两条轴互不替代 —— 一个共享项目里
// 的任务人人看得见,但它用的是谁的执行器,只有那个人自己看得见。
//
// **归属为 null 的行**:自用模式下一切都是 null,那是正常的隐式本地用户。多人模式下
// 转换时会被一次 UPDATE 认领掉(conversion.ts),所以理论上不该再有;万一还有(比如
// 转换后又从旧备份恢复了几行),只对实例管理员可见 —— 它不是任何人的私产,藏起来
// 只会让人以为数据丢了。
import type { Actor } from "./context.js";
import { isAdminActor, ownerIdOf } from "./context.js";
import { isMultiUser } from "./mode.js";

export interface Owned {
  ownerUserId: string | null;
}

/** null = 不设限(自用模式);否则是「只看这个 userId 的」。 */
export async function ownedScope(actor: Actor): Promise<string | null> {
  if (!(await isMultiUser())) return null;
  return actor.userId ?? "";
}

/** 建行时盖的归属戳。自用模式下是 null,与本功能上线前的库内容逐字节一致。 */
export function ownerStamp(actor: Actor): { ownerUserId: string | null } {
  return { ownerUserId: ownerIdOf(actor) };
}

export async function filterOwned<T extends Owned>(rows: T[], actor: Actor): Promise<T[]> {
  const scope = await ownedScope(actor);
  if (scope === null) return rows;
  const admin = isAdminActor(actor);
  return rows.filter((r) => r.ownerUserId === scope || (admin && r.ownerUserId === null));
}

export async function canUseOwned(row: Owned | null | undefined, actor: Actor): Promise<boolean> {
  if (!row) return false;
  const scope = await ownedScope(actor);
  if (scope === null) return true;
  return row.ownerUserId === scope || (isAdminActor(actor) && row.ownerUserId === null);
}

/**
 * 找不到与没权限**回同一句话**:否则挨个 id 试一遍就能问出「这个 id 存在但不是我的」,
 * 而资源 id 会出现在任务快照、导出的配置里 —— 那是现成的枚举面。
 */
export function notYours(kind: string): { error: string } {
  return { error: `${kind}不存在` };
}
