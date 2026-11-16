// 有前置的任务怎么起跑：被要求起跑而前置没站齐时记下「等齐就起」，前置全部站稳的那一刻自动起跑，
// 起点按起跑那一刻全部前置的代码定（prerequisite-start-point.ts）。
//
// 起跑前那一问（`holdForPrerequisites`）住在 prerequisite-gate.ts：它回 null 就照原路起跑；回一个原因就不起，
// 而且这一次「被要求起跑」已经持久地记下了（`task_prerequisite_launches.requested_at`）。队列和前置
// 两边都放行才起：队列不放行时根本走不到闸上；走到闸上而前置没齐，队首就停着等。这份文件管的是「等齐之后」。
//
// 闸只管**第一次开工**：起点一旦按前置定下来（`launched_at`），之后的运行、续聊、重试都不再看前置 ——
// 代码已经在它手里了，前置后来再动也不打断它（页面上会说「开工后又有新提交」）。
//
// ## 「站稳了」的统一出口
//
// `notePrerequisiteProgress(前置 id)` 是唯一的出口：执行结算、审查结算（通过 / 轮数用尽）、用户裁定、
// 验收、删除都调它，事件总线上这条前置的状态 / 审查一变也调它。它做两件事：下游页面上那一格重发；
// 挂着「等齐就起」的下游重判一遍，齐了就起。判定本身幂等，多调几次不会多起一次（真正起跑还要过回合锁
// 与队列占位）。
//
// 重启之后：记账是持久的，开机补办扫一遍全部挂着的请求（重启期间站稳的就在这一趟起跑），之后每分钟
// 再扫一遍兜底 —— 哪个出口漏调了，最多晚一分钟。
//
// ## 起跑这一侧
//
// 前置失败、取消了：它不站稳，下游一直等，**不跳过**（跟队列透明跳过 failed 相反：下游要的是它的代码）。
// 齐了之后怎么起（分组暂停、同组名额、队列、停止撤回、起不来退避）跟一切自动开工是同一个放行口，住在
// launch-request.ts。
import { eq } from "drizzle-orm";
import { db } from "./db/index.js";
import { projects, tasks } from "./db/schema.js";
import { bus } from "./bus.js";
import { dependentEdges, launchRecord, prerequisiteEdges } from "./prerequisite-store.js";
import { withPrerequisiteLock } from "./prerequisite-gate.js";
import { alertLine, appendTaskTimeline } from "./task-timeline.js";
import { forgetStanding, isRepublishingView, republishPrerequisiteView } from "./prerequisite-view.js";
import { releaseLaunch } from "./launch-request.js";

export { holdForPrerequisites, type LaunchSource, type PrerequisiteHold } from "./prerequisite-gate.js";

// ── 放行 ─────────────────────────────────────────────────────────────────────

const pending = new Map<string, NodeJS.Timeout>();

/**
 * 「这条前置可能变了」的统一出口（见文件头）。短暂合并一下：一次结算往往连着发好几个事件。
 * 前置被删时调用方自己带上下游名单（删完就查不到谁建在它上面了）。
 */
export function notePrerequisiteProgress(prerequisiteId: string, dependents?: string[]): void {
  forgetStanding(prerequisiteId);
  const key = dependents ? `${prerequisiteId}:${dependents.join(",")}` : prerequisiteId;
  if (pending.has(key)) return;
  pending.set(key, setTimeout(() => {
    pending.delete(key);
    void progress(prerequisiteId, dependents).catch((error) => console.error(`[ash] 前置 ${prerequisiteId} 推进下游失败:`, error));
  }, 150).unref());
}

async function progress(prerequisiteId: string, known?: string[]): Promise<void> {
  const dependents = known ?? (await dependentEdges(prerequisiteId)).map((edge) => edge.taskId);
  if (!dependents.length) return;
  await republishPrerequisiteView(dependents);
  for (const taskId of dependents) {
    await settleIfAbandoned(taskId);
    await releaseLaunch(taskId);
  }
}

/**
 * 去掉 / 删掉了一条前置：下游要是一条都不剩、又有换到一半的安装，当场退回建任务时的起点，不等它下一次起跑
 * （打开预览看到的就是对的代码）。走开工判定同一条路（holdForPrerequisites 没有前置时只做这件事），挡住了就
 * 记在任务上。
 */
async function settleIfAbandoned(taskId: string): Promise<void> {
  const record = await launchRecord(taskId);
  if (!record?.installJournal?.length || record.launchedAt || (await prerequisiteEdges(taskId)).length) return;
  await withPrerequisiteLock(taskId, async () => {
    const current = await launchRecord(taskId);
    if (!current?.installJournal?.length || current.launchedAt || (await prerequisiteEdges(taskId)).length) return;
    const task = (await db.select().from(tasks).where(eq(tasks.id, taskId))).at(0);
    const project = task && (await db.select().from(projects).where(eq(projects.id, task.projectId))).at(0);
    if (!task || !project) return;
    const { settleAbandonedInstall } = await import("./prerequisite-install.js");
    const { withRepoLock } = await import("./repo-lock.js");
    const reason = await withRepoLock(project.repoPath, () => settleAbandonedInstall(project.repoPath, task));
    if (reason) await appendTaskTimeline(taskId, alertLine(reason));
  });
}

let started = false;
/** 开机调一次：挂上事件总线（前置的状态 / 审查一变就重判下游），再起自动开工那一份账（补办、每分钟兜底）。 */
export async function startPrerequisiteLaunches(intervalMs = 60_000): Promise<void> {
  if (started) return;
  started = true;
  bus.subscribe((event) => {
    if (event.type === "task.status" || event.type === "task.review") notePrerequisiteProgress(event.taskId);
    else if (event.type === "task.updated" && !isRepublishingView(event.task.id)) notePrerequisiteProgress(event.task.id);
  });
  const { startLaunchRequests } = await import("./launch-request.js");
  await startLaunchRequests(intervalMs);
}
