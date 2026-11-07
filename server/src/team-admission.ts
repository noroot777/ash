// 往一个任务名下加任务（建执行者、子任务、审查）与它的验收互斥（team-acceptance-hold.ts 文件头：团队验收期间成员集合
// 不能长）。所有建任务的路都经过 createTasks（task-store.ts），所以在那里占：落库那一下占着「加成员」的位（acceptance-lock.ts
// beginAdmitting），验收开不了；验收已经在进行就不建。派活另外占一段更长的（team/dispatch.ts：连摘牌、起跑一起）。
//
// 占哪几位只看挂靠关系（parentId / reviewOf 和它们的 parentId），**不看 mode**：挂靠关系建了就不会变，mode 却能改 ——
// 按 mode 只给团队占位的话，排队落库期间普通任务改成团队、开始验收，空名单照样落库，团队盖了「已验收」新执行者却在跑
// （第 2 轮审查实测）。代价是普通任务验收（几秒到尾段跑完）期间也建不了它的子任务 / 审查，跟团队一样等它结束。
import { inArray } from "drizzle-orm";
import { beginAdmitting } from "./acceptance-lock.js";
import { db } from "./db/index.js";
import { tasks } from "./db/schema.js";

export class TeamAcceptingError extends Error {
  constructor() {
    super("挂靠的任务正在验收（或在更新工作区），结束后再建它名下的执行者、子任务或审查");
  }
}

/** 加任务时要占住的那几位：新任务挂靠的任务（parentId / reviewOf），连同它们各自的上级（团队执行者的调度台）。 */
export async function admissionKeysOf(refs: (string | null | undefined)[]): Promise<string[]> {
  const ids = [...new Set(refs.filter((ref): ref is string => !!ref))];
  if (!ids.length) return [];
  const rows = await db.select({ parentId: tasks.parentId }).from(tasks).where(inArray(tasks.id, ids));
  return [...new Set([...ids, ...rows.flatMap((row) => row.parentId ? [row.parentId] : [])])];
}

/** 占住这几位的「加成员」位：同步，要么全占上、要么一个不占。有谁正在验收就返回 null；否则返回释放函数。 */
export function admitMembers(keys: readonly string[]): (() => void) | null {
  const releases: (() => void)[] = [];
  for (const key of keys) {
    const release = beginAdmitting(key);
    if (!release) {
      for (const taken of releases) taken();
      return null;
    }
    releases.push(release);
  }
  return () => { for (const release of releases) release(); };
}
