// 一条挂着开工请求、还没开工的任务此刻在等什么（前置之外的那一种）。页面上「在等」那一行、侧栏指上去那句读它
// （prerequisite-view.ts 摆进快照）。判据跟放行口（launch-request.ts releaseLaunch）走的是同一串：已经不再
// 自动起（交代还没写进时间线）→ 被按住 → 排在队列里 → 起不来正在退避 → 同组名额满了。都不是就是「马上开工」，
// 返回 null。
import { eq } from "drizzle-orm";
import { db } from "./db/index.js";
import { queueItems, type taskPrerequisiteLaunches, type tasks } from "./db/schema.js";
import { PARALLEL_LIMIT, runningInGroup } from "./launch-capacity.js";
import { holdText, taskHoldOf } from "./task-hold.js";

type TaskRow = typeof tasks.$inferSelect;
type LaunchRow = typeof taskPrerequisiteLaunches.$inferSelect;

const clock = (iso: string) => new Date(iso).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false });

export async function launchHoldup(row: TaskRow, launch: LaunchRow | null | undefined): Promise<string | null> {
  if (!launch?.requestedAt) return null;
  if (launch.giveUp) return launch.giveUp;
  const hold = await taskHoldOf(row);
  if (hold) return holdText(hold);
  if ((await db.select({ queueId: queueItems.queueId }).from(queueItems).where(eq(queueItems.taskId, row.id))).length) {
    return "排在队列里，轮到它就开工";
  }
  if (launch.retryAt && launch.retryAt > new Date().toISOString()) {
    return `第 ${launch.startFailures} 次没能开工，${clock(launch.retryAt)} 再试`;
  }
  const running = await runningInGroup(row.groupId ?? null);
  if (running >= PARALLEL_LIMIT) {
    return row.groupId ? `同组已有 ${running} 条在跑，空出来就开工` : `不在分组里的任务已有 ${running} 条在跑，空出来就开工`;
  }
  return null;
}
