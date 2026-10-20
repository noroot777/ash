import { eq } from "drizzle-orm";
import { db } from "./db/index.js";
import { tasks } from "./db/schema.js";

// 清掉指向「已经被删掉的东西」的悬空引用 —— 删执行器 profile、删分组这类管理动作的善后。
//
// 这个文件存在的全部理由是那句**没写出来的**赋值:它不碰 updatedAt。
//
// 诱惑在于 `updated_at` 看着像一列数据库审计字段:行确实被改了,盖个时间戳天经地义。
// 但产品里它是**任务的「最后活动时间」**,还同时是三样东西的判据:
//   · 侧栏/手机列表的排序键(更新时间倒序);
//   · 普通模式的 24 小时折叠闸(web/src/workspace/taskTreeModel.ts 的 previewTasksByAge)
//     —— 到这一步它已经不是「排在哪」,而是**这一行看不看得见**;
//   · 未读事件键 `${status}:${updatedAt}:${endedAt}`(web/src/lib/useTaskReadState.ts)
//     —— 它一变,早就看过的终态集体退回未读。
// 用户删掉一个执行器 profile,跟那条七月的任务有没有进展毫无关系。顺手推进它的后果是
// 几百条历史任务同时跳回列表最前、解除折叠、集体亮起未读点 —— 而且删除本身没有任何
// 界面回声,等人发现时已经没人记得点过什么。
//
// 判据跟 task-routes.ts 里 `starOnly` 那条豁免是同一条:**与任务活动正交的写入不推进
// 最后活动时间**。那边管的是手动软记号(星标),这边管的是系统替你做的引用清理。
const REF_COLUMNS = {
  executorId: tasks.executorId,
  groupId: tasks.groupId,
} as const;

export type TaskRefKey = keyof typeof REF_COLUMNS;

// 返回被清掉的任务 id —— 调用方想记日志或发事件时用得上,不用再查一遍。
export async function detachTaskRefs(key: TaskRefKey, value: string): Promise<string[]> {
  const rows = await db
    .update(tasks)
    .set({ [key]: null } as Record<TaskRefKey, null>)
    .where(eq(REF_COLUMNS[key], value))
    .returning({ id: tasks.id });
  return rows.map((row) => row.id);
}
