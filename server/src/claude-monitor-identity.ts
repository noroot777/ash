// 「库里这一行是不是那条监听」—— **归属判据只有这一个地方**。
//
// 持久身份是 `(task_id, 来源, native_id)`（唯一索引 `monitors_native_source`）：同一个任务上
// 两条 CLI 会话撞同一个 native_id 是允许的，所以认行必须带上来源。「来源」优先是 CLI 会话号，
// 认不出来时是**那个 run 文件**（索引里 `COALESCE(cli_session_id, 'run:'||source_run)`，见
// db/index.ts）—— 一个 run 文件 = 一次进程启动 = 一个 CLI 会话。
// 而 `cli_session_id` 为空的是**存量行**（这一列是后加的），空的意思是「不知道是谁的」，
// **不是「跟谁都相等」**。
//
// 为什么抽出来：这个判据原先在四个地方各写了一遍 —— 实时投影的 `locateRow`、`open` 的重复
// 判定、历史提交的 `pick`、未决调用的销账。第 13 轮审查把「已知来源」那一半在四处都修了，
// 未知来源那一半于是在四处各留了一个通配口子（第 14 轮审查 N2 在其中两处实测到后果：一条
// 无归属的旧投影把另一条会话里还悬着的同号调用销了账，那条调用唯一的恢复依据就此消失）。
// 一个判据四份实现，修一次就只能修一处——所以它搬到这里，调用点只许调它。
export type SourceRow = {
  cliSessionId: string | null;
  /** 这一行是读哪个 run 文件读出来的 / 起它的那一代 run(存量行上是空的)。 */
  sourceRun?: string | null;
};

/**
 * 我这一侧手里的来源证据。
 *
 * `sourceRun` 是**可重验的同来源证据**:run 文件名就是 `<会话 id>-<时刻>.agent-out.jsonl`,
 * 一个文件只由一次 agent 进程启动写出,所以「库里那一行记的 run 跟我手上的是同一个」直接
 * 证明了那一行说的就是我这条会话 —— 这是无归属存量行**唯一**能被认领的理由。
 *
 * 为什么不拿别的当证据:`native_id` 来源侧只承诺在一条会话内唯一(见 claude-monitor-commit.ts
 * 的 `RowIndex`);`tool_use_id` 实际上也是一条会话内生成的,本仓库对它同样不作跨会话唯一的
 * 假设(`scripts/test-claude-monitor-identity.ts` 的 ① 就是按「两条会话撞同一个 tool_use」
 * 构造的)。只有 run 文件这一样能自证来源。
 *
 * `soleSource` 是另一条路:**这个任务的完整来源集合里只有我这一条**。注意它必须来自 `sessions`
 * (来源的权威全集),不是「投影库里此刻只有这一行」—— 后者只是恢复进度,证明不了别的会话没有
 * 同号监听(第 5 轮审查 N2)。全集里只有我,无归属的行就只可能是我的:这是升级前落下的那些
 * 行(连 `source_run` 都没有)唯一还能被认回来的依据,不认的后果是它从此谁都管不了、永远
 * running(第 3 轮审查实测)。
 */
export type SourceEvidence = {
  cliSessionId: string | null;
  sourceRun?: string | null;
  soleSource?: boolean;
};

/**
 * 从同一个 id 底下的那几行里挑出「属于我这条会话的那一行」;挑不出就 `undefined`。
 *
 * 两条规矩:
 *
 * ① **来源对得上**(两边都知道且相等)→ 就是它。
 * ② 对不上时,只认**能被证明是我的**那一行:它记的 `source_run` 跟我手上的是同一个(而且
 *    它的归属不与我矛盾),或者调用方拿来源全集证明了这个任务只有我这一条来源。
 *
 * **「库里只有这一行」不是证据**(第 5 轮审查 N2):投影库此刻有几行只说明恢复进度走到哪儿
 * 了,不说明别的会话没有同号监听 —— 甲的无归属旧行 + 乙后来起的同号监听,乙先被读到时库里
 * 就只有甲那一行。认下去是两张卡一起坏:甲的卡被乙的事实改写,乙自己那张再也插不进来。
 * **「两边都不知道」同样不是证据**:那只是两个未知,不是同一个来源。
 *
 * 证明不了就不认 —— 一条事实暂时没归宿,下一轮重读还在(迟到事实还有 `undecidable` 那条
 * 重放路);写到错的那一行上是永久的。
 */
export function matchBySource<T extends SourceRow>(
  rows: readonly T[], evidence: SourceEvidence,
): T | undefined {
  if (!rows.length) return undefined;
  const mine = evidence.cliSessionId || null;
  if (mine) {
    const exact = rows.find((r) => r.cliSessionId === mine);
    if (exact) return exact;
  }
  const run = evidence.sourceRun || null;
  const byRun = run ? rows.find((r) => r.sourceRun === run && (!r.cliSessionId || !mine)) : undefined;
  if (byRun) return byRun;
  // 来源全集里只有我 ⇒ 无归属的行只可能是我的（`soleSource` 的说明在上面）。
  return evidence.soleSource ? rows.find((r) => !r.cliSessionId) : undefined;
}
