// **任务级删除门闸**：「这个任务还有没有资格被写入」只有这一个判据（第 14 轮审查 N3）。
//
// 删除不是一个瞬间：`deleteTaskCompletely` 从停哨兵到删任务行要走好几步，每步都 await。
// 只在写之前问一次「任务还在不在」挡不住中间那段缝，所以判据是「任务级、覆盖整个删除期、
// 全部 writer 都问它」：
//
// ① 删除**一进门就关闸**（在第一条 DELETE 之前）；
// ② 落库前都问一句，关着就不写 —— 内置 Monitor 的实时投影、claude 后台任务的留痕、
//    ash 哨兵的创建（monitor-create.ts / monitor-session.ts）；
// ③ **闸的开和关都绑在删除的结果上**：删完了（任务行真的没了）才 `confirm`，删到一半失败、
//    任务还在，就必须 `release` —— 否则任务还在列表里，它却再也写不进任何监听（第 5 轮审查
//    实测）。闸只能是**删除中**的临时状态或**已删除**的终态，不存在「关着但没人知道结果」
//    这一档（收口在 `settleTaskRevocation`）。
//
// 门闸只覆盖「删除期间别再写」；「问完之后、写之前任务删完了」那个窗口由落库资格跟插入
// 同批提交兜住（claude-monitor-write.ts）。
import { eq } from "drizzle-orm";
import { db } from "./db/index.js";
import { tasks } from "./db/schema.js";

/**
 * 闸关着的任务 → 它现在处在哪一档。
 *
 * · `deleting`：删除正在走。写入一律挡住，但这是**临时**状态，必须由 `settle` 收口。
 * · `deleted`：任务行确认没了。写入继续挡住（到 TTL 为止）。
 */
type Revocation = { state: "deleting" | "deleted"; at: number };
const revoked = new Map<string, Revocation>();

/**
 * 确认删除之后闸再关多久。在途的写最多也就排几十秒，所以十分钟足够覆盖「删除期 + 任何
 * 还没落库的在途写」。留着不清会随删除次数无界增长。
 */
const GATE_MS = 10 * 60 * 1000;
/** 同时最多记这么多条（极端情况下批量删任务）。超了先丢最老的。 */
const GATE_CAP = 4096;

function prune(): void {
  const cutoff = Date.now() - GATE_MS;
  // **只有确认删除的那一档才按 TTL 过期。** `deleting` 由 `settle` 收口（删除流程的 finally
  // 一定会走到它），不靠时间；真要是进程在删除中途没了，下次启动内存本来就是空的。
  for (const [taskId, entry] of revoked) if (entry.at < cutoff) revoked.delete(taskId);
  while (revoked.size > GATE_CAP) {
    const oldest = revoked.keys().next();
    if (oldest.done) break;
    revoked.delete(oldest.value);
  }
}

/** 删除开工：**第一条 DELETE 之前**调它。 */
export function beginTaskRevocation(taskId: string): void {
  revoked.set(taskId, { state: "deleting", at: Date.now() });
  prune();
}

/** 删完了：任务行确认不在了。闸继续关着，直到 TTL。 */
export function confirmTaskRevocation(taskId: string): void {
  revoked.set(taskId, { state: "deleted", at: Date.now() });
}

/**
 * 删除没删成、任务还在：**把闸打开**。
 *
 * 只由 `settleTaskRevocation` 按删除结果调用（回归里也拿它模拟「闸已失效」）。
 */
export function releaseTaskRevocation(taskId: string): void {
  revoked.delete(taskId);
}

/** 「这个任务正在删或已经删了，这一笔不许落库」。 */
export const isTaskRevoked = (taskId: string): boolean => revoked.has(taskId);

/**
 * 闸处在哪一档；没关就是 `null`。
 *
 * 只问「能不能写」的调用方用上面那个就够了（挡住、让调用方重来）。**手里压着一次性事实的**
 * 写入方必须分开看：`deleting` 只是「先别写」—— 删除可能整批回滚、`settle` 再把闸打开，这时
 * 放弃就是永久丢账；只有 `deleted` 才是「可以放弃了」（见 claude-monitor-write-queue.ts）。
 */
export const taskRevocation = (taskId: string): Revocation["state"] | null => revoked.get(taskId)?.state ?? null;

/**
 * 删除流程收口：**按「任务行还在不在」决定那道闸是关死还是打开**（第 5 轮审查 F1）。
 *
 * 由 `deleteTaskCompletely` 的 finally 调用 —— 删除的全部语句（含任务行本身）都在它里面，
 * 所以「行还在不在」在这一刻才是**删除的结果**，而不是中间态。
 */
export async function settleTaskRevocation(taskId: string): Promise<void> {
  let alive = true;
  try {
    alive = !!(await db.select({ id: tasks.id }).from(tasks).where(eq(tasks.id, taskId))).length;
  } catch (e) {
    // 连「它还在不在」都查不出来：按**还在**处理。把一个仍存在的任务永久封死是用户看得见
    // 的损坏；反过来多开一会儿闸，最坏也只是几行孤儿（落库资格同批那一道仍然挡着）。
    console.warn(`[ash] task=${taskId} 删除后核对任务是否还在失败，按「还在」放开闸:`, e);
    alive = true;
  }
  if (alive) releaseTaskRevocation(taskId);
  else confirmTaskRevocation(taskId);
}
