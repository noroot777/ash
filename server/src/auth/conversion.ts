// 自用 → 多人的存量数据处置(§十三)。
//
// 原则两条,都在这个文件里落地:
//  ① 存量资源(项目、随手记、供应商、执行器、起手式、审查者、模式预设、任务、日程)
//     **全部归初始管理员**。
//  ② **项目路径一律不动** —— 不往根目录搬,不动磁盘上的仓库。转换是一次数据库操作,
//     不是一次文件迁移。
//
// 实现方式是「把隐式本地用户实名化」:自用模式下所有归属列都是 null,转换时一次
// UPDATE 把 null 填成管理员 id。这样读写点只有一套归属逻辑,不必到处写 `if (multi)`。
import { isNull, sql } from "drizzle-orm";
import { db } from "../db/index.js";
import {
  agents,
  llmProviders,
  notes,
  projects,
  reviewerProfiles,
  schedules,
  tasks,
  teamPresets,
  workflows,
} from "../db/schema.js";
import { addProjectMember } from "./visibility.js";

/** 转换前的盘点结果:向导要把这些逐条摆给用户看。 */
export interface ConversionPreflight {
  /** 没挂供应商的执行器 —— 多人模式下不可派发(宿主订阅被抹去,§八)。 */
  unbackedExecutors: { id: string; name: string; type: string; reason: string }[];
  counts: Record<string, number>;
}

export async function conversionPreflight(): Promise<ConversionPreflight> {
  const { cliSpec } = await import("../executors/catalog/index.js");
  const rows = await db.select().from(agents);
  const unbackedExecutors = rows
    .map((row) => {
      const hasRelay = (() => {
        try {
          return !!cliSpec(row.type as never).exec.relay;
        } catch {
          return false;
        }
      })();
      if (!hasRelay) {
        return {
          id: row.id,
          name: row.name,
          type: row.type,
          reason: `${row.type} 还没接供应商注入（relay），多人模式下无法派发`,
        };
      }
      if (!row.providerId) {
        return {
          id: row.id,
          name: row.name,
          type: row.type,
          reason: "没有挂供应商：多人模式下宿主机的 CLI 订阅被隔离，必须自带 key",
        };
      }
      return null;
    })
    .filter((x): x is NonNullable<typeof x> => !!x);

  const counts: Record<string, number> = {
    projects: (await db.select({ id: projects.id }).from(projects)).length,
    tasks: (await db.select({ id: tasks.id }).from(tasks)).length,
    notes: (await db.select({ id: notes.id }).from(notes)).length,
    executors: rows.length,
    providers: (await db.select({ id: llmProviders.id }).from(llmProviders)).length,
    workflows: (await db.select({ id: workflows.id }).from(workflows)).length,
    reviewers: (await db.select({ id: reviewerProfiles.id }).from(reviewerProfiles)).length,
    teamPresets: (await db.select({ id: teamPresets.id }).from(teamPresets)).length,
  };
  return { unbackedExecutors, counts };
}

/**
 * 把所有还没有归属的存量行认领给某个用户,并把他登记成每个存量项目的项目管理员。
 * 幂等:再跑一遍匹配 0 行就是空转。
 */
export async function claimExistingDataFor(userId: string): Promise<Record<string, number>> {
  const claimed: Record<string, number> = {};
  const take = async (label: string, run: () => Promise<{ rowsAffected?: number } | unknown>) => {
    const result = (await run()) as { rowsAffected?: number };
    claimed[label] = result?.rowsAffected ?? 0;
  };

  await take("projects", () =>
    db.update(projects).set({ ownerUserId: userId }).where(isNull(projects.ownerUserId)));
  await take("tasks", () =>
    db.update(tasks).set({ ownerUserId: userId }).where(isNull(tasks.ownerUserId)));
  await take("notes", () =>
    db.update(notes).set({ ownerUserId: userId }).where(isNull(notes.ownerUserId)));
  await take("executors", () =>
    db.update(agents).set({ ownerUserId: userId }).where(isNull(agents.ownerUserId)));
  await take("providers", () =>
    db.update(llmProviders).set({ ownerUserId: userId }).where(isNull(llmProviders.ownerUserId)));
  await take("workflows", () =>
    db.update(workflows).set({ ownerUserId: userId }).where(isNull(workflows.ownerUserId)));
  await take("reviewers", () =>
    db.update(reviewerProfiles).set({ ownerUserId: userId }).where(isNull(reviewerProfiles.ownerUserId)));
  await take("teamPresets", () =>
    db.update(teamPresets).set({ ownerUserId: userId }).where(isNull(teamPresets.ownerUserId)));
  await take("schedules", () =>
    db.update(schedules).set({ ownerUserId: userId }).where(isNull(schedules.ownerUserId)));

  // 存量项目要显式登记成员行:实例管理员本来就看得见一切,但他日后被降级成普通用户
  // 时不该连自己建的项目都进不去。
  for (const project of await db.select({ id: projects.id }).from(projects)) {
    await addProjectMember({ projectId: project.id, userId, role: "admin", addedBy: userId });
  }
  return claimed;
}

/** 排查用:还有多少行没有归属(转换后应当为 0)。 */
export async function unownedRowCount(): Promise<number> {
  const rows = await db.all<{ n: number }>(sql`
    SELECT
      (SELECT COUNT(*) FROM projects WHERE owner_user_id IS NULL)
      + (SELECT COUNT(*) FROM tasks WHERE owner_user_id IS NULL)
      + (SELECT COUNT(*) FROM notes WHERE owner_user_id IS NULL) AS n
  `);
  return rows.at(0)?.n ?? 0;
}
