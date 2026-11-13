// 从 task-follow-up.ts 拆出来的纯函数：那边一导入就连库，这条挑选规则要能脱库钉住
// （server/scripts/test-follow-up.ts）。

/**
 * 各条会话里我最后说的那句，挑出整个任务里最新的一句。
 *
 * 按**发言时刻**比，不按会话开始的先后：执行会话是一条一路续跑的长会话，开得最早，我在
 * 里面说的话却往往最新；审查、验证这些旁路会话开得晚，里面多半没有我的话。拿「最近开始的
 * 几次会话」去找，审查一多，执行会话就被挤出窗口，侧栏那一列就成了「还没追问过」。
 *
 * 老会话（写围栏之前跑的）的发言没有时刻：一律算比有时刻的旧，彼此之间按会话开始先后
 * （`order` 小 = 开始得晚）兜底 —— 那是唯一还剩的线索，不编时间。
 */
export function latestFollowUp<T extends { at?: string | null }>(candidates: { seg: T; order: number }[]): T | null {
  let best: { seg: T; order: number } | null = null;
  for (const candidate of candidates) {
    if (!best) { best = candidate; continue; }
    const at = candidate.seg.at ?? "";
    const bestAt = best.seg.at ?? "";
    if (at > bestAt || (at === bestAt && candidate.order < best.order)) best = candidate;
  }
  return best?.seg ?? null;
}

/**
 * 一个任务的全部追问排成一条从旧到新的线（侧栏铺开时悬停「追问」那一格要全列出来）。
 *
 * 口径跟 `latestFollowUp` 是同一套，排在最后的那句必然就是它挑出来的那句：按发言时刻比；
 * 没时刻的老发言算比有时刻的都旧，彼此按会话开始先后（`order` 大 = 开始得早 = 更旧）；
 * 同一条会话里时刻相同的，保留它们在正文里的先后（`index`）。
 */
export function orderFollowUps<T extends { at?: string | null }>(
  candidates: { seg: T; order: number; index: number }[],
): T[] {
  return [...candidates]
    .sort((a, b) => {
      const at = a.seg.at ?? "";
      const bt = b.seg.at ?? "";
      if (at !== bt) return at < bt ? -1 : 1;
      if (a.order !== b.order) return b.order - a.order;
      return a.index - b.index;
    })
    .map((candidate) => candidate.seg);
}
