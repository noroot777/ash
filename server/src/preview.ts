// 预览的生命周期：启动代、停止、重跑回收与持久记录的清扫。
import { randomUUID } from "node:crypto";
import { existsSync, readdirSync, rmSync } from "node:fs";
import { bus } from "./bus.js";
import { RUNS_DIR } from "./paths.js";
import { heldCacheOf, pruneNodeDeps, removePreparedLinks } from "./preview-deps.js";
import { appendTaskTimeline } from "./task-timeline.js";
import { readAnyPreview, recordPath, alive, archivePreview, type PreviewStep, type PreviewResult, type PreviewRecord } from "./preview-store.js";
import { starting, beginDriving, endDriving, driving, cancelDriving, hasUnfinishedPreviewStart } from "./preview-start-state.js";
import { hasPendingPreviewStops, retryPreviewStops, stopPreviewProcesses, type PreviewStopResult } from "./preview-process-stop.js";
import { runPreview, type PreviewStartOptions } from "./preview-start.js";
export { readPreview, readPreviewLog, hasPreviewLog, previewLogPath } from "./preview-store.js";
export type { PreviewStep, PreviewRecord, PreviewResult } from "./preview-store.js";
export { beginPreviewStart, endPreviewStart, previewStartCanceled } from "./preview-start-state.js";
export const PREVIEW_CANCELED = "预览启动被取消（关闭预览 / 任务重新开跑 / ash 重启）";
const IDLE_LIFE_MS = 30 * 60_000;
const SWEEP_MS = 5 * 60_000;

export function isPreviewStarting(taskId: string): boolean {
  return starting.has(taskId) || readAnyPreview(taskId)?.state === "starting";
}

/** 盘上那条「正在启动」的记录（给路由/状态用：它是不是该显示成「可以关掉」）。 */
export function previewStartingRecord(taskId: string): PreviewRecord | null {
  const record = readAnyPreview(taskId);
  return record?.state === "starting" ? record : null;
}

export async function startPreview(taskId: string, step: PreviewStep, cwd: string, registered?: string, options?: PreviewStartOptions): Promise<PreviewResult> {
  const gen = registered ?? randomUUID();
  if (registered === undefined) beginDriving(taskId, gen);
  try {
    return await runPreview(taskId, step, cwd, gen, options, () => stopPreviewExcept(taskId, null, gen));
  } finally {
    if (registered === undefined) endDriving(taskId, gen);
  }
}

// 收掉一个任务的预览。reason 非空才往时间线写一行——刷新后仍能看出「预览被收了、
// 为什么收的」，这是停止/暂停那条规矩的同一条判据。
export async function stopPreview(taskId: string, reason: string | null): Promise<boolean> {
  return await stopPreviewExcept(taskId, reason, null);
}

export async function stopPreviewForWorktreeCleanup(taskId: string): Promise<boolean> {
  const stopped = await stopPreviewExcept(taskId, "验收清理工作区前回收预览", null);
  if (hasPendingPreviewStops(taskId)) throw new Error("预览进程尚未完全退出，工作区已保留；请稍后重试验收。");
  if (hasUnfinishedPreviewStart(taskId)) throw new Error("预览启动正在退出，工作区已保留；请稍后重试验收。");
  if (readAnyPreview(taskId)) throw new Error("预览已被另一趟启动替换，工作区已保留；请稍后重试验收。");
  return stopped;
}

/**
 * 收预览的真身。`exceptGen` 只有一个用处：起新预览时先收旧的，那一下不能把**自己**
 * 也标成取消（自己刚刚才注册进 starting）。
 */
async function stopPreviewExcept(
  taskId: string,
  reason: string | null,
  exceptGen: string | null,
): Promise<boolean> {
  // readAnyPreview：**还在启动的那一趟也得收得掉**。记录一删，那一趟自己下一个检查点
  // 就会发现代号没了，杀掉自己起的进程、把链撤干净（见 runPreview 里的 abandoned）。
  const record = readAnyPreview(taskId);
  // 记录还没落盘的那一段也要停得掉（见 canceledGens）：标上记号，那一趟到下一个检查点
  // 就自己收摊，而且**永远不会写出记录**。
  const marked = cancelDriving(taskId, exceptGen);
  const pending = await retryPreviewStops(taskId);
  if (!record) {
    if (!marked) return false;
    // 这一段还没有 url、也还没有 pid，能说的只有「取消了一次启动」——但必须说，
    // 「刷新之后仍看得出我停过」是停止/暂停那条规矩的判据。
    if (reason) await appendTaskTimeline(taskId, `预览启动已取消（${reason}）${pending.stopped ? "" : "；仍有此前请求停止的进程未退出。"}`);
    bus.publish({ type: "task.review", taskId });
    return pending.stopped;
  }
  // 不先看组长是否还活着：组长死、vite 仍留在同一进程组，正是必须回收的现场。
  // pid 为 0 = 还没 spawn，`kill(0, …)` 打的是**自己这一组**，绝不能放过去。
  const retired = await retirePreview(record, "stopped");
  if (!retired) return false;
  const result = retired.stopped ? pending : retired;
  if (reason) await appendTaskTimeline(taskId, result.stopped
    ? `预览已回收（${reason}）：${record.url ?? record.cmd}` : `${result.message}（${reason}）`);
  // 自由工作流状态里的 preview.running 变了就必须发事件：那份快照的版本号只由
  // task.review / task.status 递增，不发的话前端拿到的新快照版本相等，会被当成
  // 「不比现值新」丢掉——按钮就一直停在「关闭预览」上。
  bus.publish({ type: "task.review", taskId });
  return result.stopped;
}

/**
 * 验收通过时的回收：`gate`（下一个人工关口结束时回收）和 `task`（任务结束时回收）两档
 * 一起收。
 *
 * 「任务结束时回收」得真有个结束点，否则那一档就是永不回收——一个 dev server 一直占着
 * 端口，用户还以为选了「任务结束时回收」它自己会走。这条线的终点就是验收：走到这儿
 * 这个任务不会再动了。（打回重做那条路上关口也结束了，但那时预览由「任务重新开跑」
 * 那一下收掉，见 stopPreviewOnRerun。）
 *
 * 调用点在**「点头之后」那一段开跑之前**，所以那一段又起的预览（用户特意编排的「验收完
 * 把线上环境开起来」）不受影响 —— 它是验收之后才有的东西。
 */
export async function stopPreviewAtAccept(taskId: string): Promise<void> {
  const record = readAnyPreview(taskId);
  // 记录还没落盘、内存里已经有启动代的那一段同样要收：验收之后工作区就不归这个任务了，
  // 让那一趟接着起来等于往一个已经交出去的检出里塞进程。这一段还没有 life 可读，按
  // 「验收完就该收」处理。
  if (!record) {
    if (starting.has(taskId)) await stopPreview(taskId, "任务已验收完成");
    return;
  }
  if (record.life === "gate") await stopPreview(taskId, "人工关口已结束");
  else if (record.life === "task") await stopPreview(taskId, "任务已验收完成，按线上写的「任务结束时回收」收掉");
}

/** 任务又开跑了：预览指向的是上一版代码，一律收掉，免得对着旧页面验新改动。 */
export async function stopPreviewOnRerun(taskId: string): Promise<void> {
  // **不设门禁。** 这里曾经拿 `readAnyPreview` 当开关，漏掉的正是「内存里已经有启动代、
  // 盘上还没有记录」那一段：任务从 done 重新开跑得足够快时（自动推进、连点重跑），上一版
  // 的预览此刻正在冷启动，`readAnyPreview` 却读不到东西，于是这一下什么也没停——几十秒后
  // 它照常上线，用户对着上一版代码验新改动，而这正是本函数唯一要防的事。
  //
  // 直接调 stopPreview 是安全的：它本身幂等，既没有记录、内存里也没有在启动的代时，
  // 它什么都不做，也不会往时间线写字。
  await stopPreview(taskId, "任务重新开跑，旧预览指向的是上一版代码");
}

// 清扫：进程早死了的记录、以及 idle30 那一档到点的。启动时先扫一遍，之后每 5 分钟一次
// —— 重启后内存 map 没了也不影响，判据全在盘上。
//
// 还兜一类：**任务本身已经没了或者被归档**。验收那条路径收得掉正常走完的，收不掉「任务
// 直接被删/归档，预览还在那儿开着」的——那种情况下没有任何一个界面还会提到它，端口却
// 一直占着。db 走动态 import：这个模块本来只碰进程和文件，不想为一条兜底把它绑到表上。
export async function sweepPreviews(): Promise<void> {
  let dirs: string[];
  try {
    dirs = readdirSync(RUNS_DIR);
  } catch {
    return;
  }
  for (const taskId of dirs) {
    try { await sweepTaskPreview(taskId); }
    catch (error) { await appendTaskTimeline(taskId, `预览清理暂缓：${String(error)}`); }
  }
  // 收尾再清备用依赖：这套东西按内容一份一份地装，一份前端依赖几百兆，不清就会在**用户的
  // 磁盘**上无声地涨（见 pruneNodeDeps）。
  //
  // 顺序是有讲究的，**必须排在上面那一圈之后**：清理只认 mtime，而缓存只在挂链那一刻
  // touch 过一次。自由预览是 `life: "task"`，一个任务等人验收等上三十天完全合法，那份
  // 缓存却会在预览还跑着的时候「过期」。删掉的后果不是下次慢一点——工作区那条软链还在、
  // 只是断了，dev server 按需加载下一个模块时才炸，记录上它还好端端地跑着。所以先把死掉的
  // 记录和它们的软链收干净，再拿**剩下这些还活着的**记录告诉清理器哪几份动不得。
  pruneNodeDeps(heldCaches());
}

async function sweepTaskPreview(taskId: string): Promise<void> {
  if (hasPendingPreviewStops(taskId)) await retryPreviewStops(taskId);
  if (!existsSync(recordPath(taskId))) return;
  const record = readAnyPreview(taskId);
  if (!record) { rmSync(recordPath(taskId), { force: true }); return; }
  const interrupted = record.state === "starting";
  // 按代号识别仍在驱动的启动；重叠启动中的新一代不会被当作上一条命留下的孤儿。
  if (interrupted && driving(taskId, record.gen)) return;
  if (interrupted || !(record.services?.length ? record.services.every((s) => s.status === "ready" && alive(s.pid)) : alive(record.pid))) {
    const retired = await retirePreview(record, "failed");
    if (!retired) return;
    await appendTaskTimeline(taskId, !retired.stopped ? retired.message : interrupted
      ? `预览没能起完就中断了（ash 重启），已经清理：${record.cmd}`
      : `预览进程已自行退出：${record.url ?? record.cmd}`);
    return;
  }
  if (record.life === "idle30" && Date.now() - Date.parse(record.startedAt) > IDLE_LIFE_MS) {
    await stopPreview(taskId, "起来满 30 分钟，按线上写的回收");
    return;
  }
  const gone = await taskGone(taskId);
  if (gone) await stopPreview(taskId, gone);
}

/** 还活着的预览记录正占着哪几份依赖缓存（顺着它们挂出去的软链倒推）。 */
function heldCaches(): string[] {
  const held = new Set<string>();
  let dirs: string[];
  try { dirs = readdirSync(RUNS_DIR); } catch { return []; }
  for (const taskId of dirs) {
    // readAnyPreview：正在启动那一趟挂的链同样占着缓存，别在它装到一半时把树删了。
    for (const link of readAnyPreview(taskId)?.links ?? []) {
      const cache = heldCacheOf(link);
      if (cache) held.add(cache);
    }
  }
  return [...held];
}

/** 任务已经不在了（删了/归档了）就给个理由，否则 null。查不动库时一律当「还在」。 */
async function taskGone(taskId: string): Promise<string | null> {
  try {
    const [{ db }, { tasks }, { eq }] = await Promise.all([
      import("./db/index.js"),
      import("./db/schema.js"),
      import("drizzle-orm"),
    ]);
    const row = (await db
      .select({ archived: tasks.archived })
      .from(tasks)
      .where(eq(tasks.id, taskId))).at(0);
    if (!row) return "任务已被删除";
    return row.archived ? "任务已归档" : null;
  } catch {
    return null;
  }
}

export function startPreviewSweeper(): NodeJS.Timeout {
  void sweepPreviews();
  const timer = setInterval(() => void sweepPreviews(), SWEEP_MS);
  timer.unref();
  return timer;
}

async function retirePreview(record: PreviewRecord, status: "stopped" | "failed"): Promise<PreviewStopResult | null> {
  // 各入口共享退出确认；未退出的进程另存停止记录，当前预览代仍可正常归档。
  const result = await stopPreviewProcesses(record.taskId, record);
  const current = readAnyPreview(record.taskId);
  if (!current) return result; // 被取消的启动可能已经完成了同一趟归档。
  if (current.gen !== record.gen || current.pid !== record.pid) return null;
  removePreparedLinks(record.links ?? []);
  archivePreview(record, status);
  rmSync(recordPath(record.taskId), { force: true });
  return result;
}
