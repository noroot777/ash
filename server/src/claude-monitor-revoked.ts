// **任务级删除门闸**：「这个任务还有没有资格被写入」只有这一个判据（第 14 轮审查 N3）。
//
// 上一版是在扫描开工时取一次「删除代次」，中途再对一次。那一道挡住的是**那一次 await 之前
// 发生的删除**，而删除本身不是一个瞬间：`deleteTaskCompletely` 从停哨兵到删任务行有十几条
// 语句、每条都 await，提交侧也是一行一行写的。于是真实交错里总有缝：
//
// · 删除删完 monitors、还没删 sessions 时，另一个请求进来的新扫描读得到旧会话，而它开工时
//   取的代次已经是删除之后的值 —— 它不认为自己被撤销过，于是把那些行又写了回去；
// · 在途那一轮的补偿清理（`purgeRevokedTask`）本身失败时，只打了一行 warn：任务已经没了，
//   以后也没有任何入口会再清，孤儿行永久留着。
//
// 所以判据改成「任务级、覆盖整个删除期、全部 writer 都问它」：
//
// ① 删除**一进门就关闸**（在第一条 DELETE 之前）；
// ② 四个 writer（投影行、未决调用、读取位置、恢复账本）落库前都问一句，关着就不写；
// ③ **闸的开和关都绑在删除的结果上**：删完了（任务行真的没了）才叫 `confirm`，删到一半失败、
//    任务还在，就必须 `release` 并把它恢复成可重建的样子。只记「进程内记得删除过」是不够的
//    ——第 5 轮审查实测：删除中途一条 DELETE 失败，任务还在列表里，而它的监听卡片从此再也
//    打不开（回填入口早退、恢复责任也不登记），刷新也不回来。闸只能是**删除中**的临时状态
//    或**已删除**的终态，不存在「关着但没人知道结果」这一档；
// ④ 补偿清理失败不吞：留一笔**可推进的清理责任**，由退避重试推，进程没了还有启动期的孤儿
//    清扫兜底（见 `sweepOrphanClaudeMonitors`）。**补偿只针对确认删除的任务**：任务还在就
//    绝不许清它的数据（那正是上一条那个 bug 的另一半）。
//
// 为什么单独一个模块：这四个 writer 分别住在 commit / pending / cursors / recovery 四个文件
// 里，而它们都被 backfill 导入 —— 判据放 backfill 里就是四条反向依赖（循环）。

/**
 * 闸关着的任务 → 它现在处在哪一档。
 *
 * · `deleting`：删除正在走。写入一律挡住，但这是**临时**状态，必须由 `settle` 收口。
 * · `deleted`：任务行确认没了。写入继续挡住（到 TTL 为止），补偿清理也只认这一档。
 */
type Revocation = { state: "deleting" | "deleted"; at: number };
const revoked = new Map<string, Revocation>();

/**
 * 闸关多久。在途那一轮最多也就跑几十秒（单次读取窗口 + 几次写），所以十分钟足够覆盖
 * 「删除期 + 任何还没结束的在途回合」。留着不清会随删除次数无界增长。
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

/** 删完了：任务行确认不在了。闸继续关着，补偿清理从这一刻才被允许。 */
export function confirmTaskRevocation(taskId: string): void {
  revoked.set(taskId, { state: "deleted", at: Date.now() });
}

/**
 * 删除没删成、任务还在：**把闸打开**。
 *
 * 调用方还要负责把它恢复成可重建的样子（丢掉进程内状态、作废读取位置）—— 删到一半的
 * 任务，行可能已经删了而位置还停在后面，光开闸它的卡也回不来（见 `settleTaskRevocation`）。
 */
export function releaseTaskRevocation(taskId: string): void {
  revoked.delete(taskId);
}

/** 「这个任务正在删或已经删了，这一笔不许落库」。 */
export const isTaskRevoked = (taskId: string): boolean => revoked.has(taskId);

/** 「任务行确认已经没了」——补偿清理的唯一许可（任务还在时绝不许清它的数据）。 */
export const isTaskDeleted = (taskId: string): boolean => revoked.get(taskId)?.state === "deleted";

/** 清理还没做完的任务（补偿 DELETE 失败）。 */
const unpurged = new Set<string>();

/** 这些任务的残留还没清掉（只给回归和启动期清扫用）。 */
export const pendingPurges = (): string[] => [...unpurged];

export function notePurgeDone(taskId: string): void {
  unpurged.delete(taskId);
}

/**
 * 清理失败：记一笔责任并按退避重试。
 *
 * 退避阶梯短而有限（几十秒内试几次就够：这不是用户在等的事）；全试完还不行就留在
 * `unpurged` 里，由启动期的孤儿清扫收掉。
 */
export function notePurgeFailed(taskId: string, retry: (taskId: string) => Promise<void>): void {
  if (unpurged.has(taskId)) return;   // 已经在重试阶梯上了
  unpurged.add(taskId);
  const ladder = [1_000, 5_000, 20_000];
  let step = 0;
  const tick = (): void => {
    if (!unpurged.has(taskId)) return;
    if (step >= ladder.length) return;
    const wait = ladder[step]!;
    step += 1;
    const timer = setTimeout(() => {
      void retry(taskId).then(() => {
        if (unpurged.has(taskId)) tick();   // 还没成功（retry 自己会销账）
      }).catch(() => tick());
    }, wait);
    timer.unref?.();
  };
  tick();
}
