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
