// 「库里这一行是不是那条监听」—— **归属判据只有这一个地方**。
//
// 持久身份是 `(task_id, cli_session_id, native_id)`（唯一索引 `monitors_native_session`）：
// 同一个任务上两条 CLI 会话撞同一个 native_id 是允许的，所以认行必须带上来源会话。
// 而 `cli_session_id` 为空的是**存量行**（这一列是后加的），空的意思是「不知道是谁的」，
// **不是「跟谁都相等」**。
//
// 为什么抽出来：这个判据原先在四个地方各写了一遍 —— 实时投影的 `locateRow`、`open` 的重复
// 判定、历史提交的 `pick`、未决调用的销账。第 13 轮审查把「已知来源」那一半在四处都修了，
// 未知来源那一半于是在四处各留了一个通配口子（第 14 轮审查 N2 在其中两处实测到后果：一条
// 无归属的旧投影把另一条会话里还悬着的同号调用销了账，那条调用唯一的恢复依据就此消失）。
// 一个判据四份实现，修一次就只能修一处——所以它搬到这里，调用点只许调它。
export type SourceRow = { cliSessionId: string | null };

/**
 * 从同一个 id 底下的那几行里挑出「属于 `cliSessionId` 的那一行」；挑不出就 `undefined`。
 *
 * 两条规矩：
 *
 * ① **来源对得上**（两边都有且相等，或者两边都没有）→ 就是它。
 * ② 对不上时，没有归属的存量行**只有在它是唯一候选时**才认（读到一次就把归属补上，见
 *    `mergeInto`）。只要还有别的候选行，这条空归属的行就说不清是谁的了 —— 那时宁可挑不出
 *    来：一条事实暂时没归宿，下一轮重读还在；写到错的那一行上是永久的（而且会同时毁掉两
 *    张卡：甲的终态套到乙身上，甲自己那张永远停在 running）。
 */
export function matchBySource<T extends SourceRow>(
  rows: readonly T[], cliSessionId: string | null,
): T | undefined {
  if (!rows.length) return undefined;
  const exact = rows.find((r) => (r.cliSessionId ?? null) === (cliSessionId ?? null));
  if (exact) return exact;
  if (rows.length === 1 && !rows[0]!.cliSessionId) return rows[0];
  return undefined;
}
