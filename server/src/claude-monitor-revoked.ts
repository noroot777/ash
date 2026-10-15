// **任务级删除门闸**：「这个任务还有没有资格被写入」只有这一个判据（第 14 轮审查 N3）。
//
// 上一版是在扫描开工时取一次「删除代次」，中途再对一次。那一道挡住的是**那一次 await 之前
// 发生的删除**，而删除本身不是一个瞬间：`deleteTaskAssociations` 从停哨兵到删会话行有十几条
// 语句、每条都 await，提交侧也是一行一行写的。于是真实交错里总有缝：
//
// · 删除删完 monitors、还没删 sessions 时，另一个请求进来的新扫描读得到旧会话，而它开工时
//   取的代次已经是删除之后的值 —— 它不认为自己被撤销过，于是把那些行又写了回去；
// · 在途那一轮的补偿清理（`purgeRevokedTask`）本身失败时，只打了一行 warn：任务已经没了，
//   以后也没有任何入口会再清，孤儿行永久留着。
//
// 所以判据改成「任务级、覆盖整个删除期、全部 writer 都问它」：
//
// ① 删除**一进门就关闸**（在第一条 DELETE 之前），闸在之后一段时间内一直关着；
// ② 四个 writer（投影行、未决调用、读取位置、恢复账本）落库前都问一句，关着就不写；
// ③ 补偿清理失败不吞：留一笔**可推进的清理责任**，由退避重试推，进程没了还有启动期的孤儿
//    清扫兜底（见 `sweepOrphanClaudeMonitors`）。
//
// 为什么单独一个模块：这四个 writer 分别住在 commit / pending / cursors / recovery 四个文件
// 里，而它们都被 backfill 导入 —— 判据放 backfill 里就是四条反向依赖（循环）。

/** 闸关着的任务 → 关闸的时刻。 */
const revoked = new Map<string, number>();

/**
 * 闸关多久。在途那一轮最多也就跑几十秒（单次读取窗口 + 几次写），所以十分钟足够覆盖
 * 「删除期 + 任何还没结束的在途回合」。留着不清会随删除次数无界增长。
 */
const GATE_MS = 10 * 60 * 1000;
/** 同时最多记这么多条（极端情况下批量删任务）。超了先丢最老的。 */
const GATE_CAP = 4096;

function prune(): void {
  const cutoff = Date.now() - GATE_MS;
  for (const [taskId, at] of revoked) if (at < cutoff) revoked.delete(taskId);
  while (revoked.size > GATE_CAP) {
    const oldest = revoked.keys().next();
    if (oldest.done) break;
    revoked.delete(oldest.value);
  }
}

/** 删除开工：**第一条 DELETE 之前**调它。 */
export function beginTaskRevocation(taskId: string): void {
  revoked.set(taskId, Date.now());
  prune();
}

/** 「这个任务已经被删了（或正在删），这一笔不许落库」。 */
export const isTaskRevoked = (taskId: string): boolean => revoked.has(taskId);

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
