// 「库里这一行是不是那条监听」—— **归属判据只有这一个地方**。
//
// 持久身份是 `(task_id, 来源, native_id)`（唯一索引 `monitors_native_source`）：同一个任务上
// 两条 CLI 会话撞同一个 native_id 是允许的，所以认行必须带上来源。「来源」优先是 CLI 会话号，
// 认不出来时是**那个 run 文件**（索引里 `COALESCE(cli_session_id, 'run:'||source_run)`，见
// db/index.ts）—— 一个 run 文件 = 一次进程启动 = 一个 CLI 会话。
// 而 `cli_session_id` 为空的是**存量行**（这一列是后加的），空的意思是「不知道是谁的」，
// **不是「跟谁都相等」**。
//
// 实时投影的 `locateRow` 和 `open` 的重复判定都调它：同一个判据两份实现，修一次就只能修一处
// （第 13/14 轮审查各栽过一次）。
export type SourceRow = {
  cliSessionId: string | null;
  /** 起它的那一代 run(存量行上是空的)。 */
  sourceRun?: string | null;
};

/**
 * 我这一侧手里的来源证据。
 *
 * `sourceRun` 是**可重验的同来源证据**:run 文件名就是 `<会话 id>-<时刻>.agent-out.jsonl`,
 * 一个文件只由一次 agent 进程启动写出,所以「库里那一行记的 run 跟我手上的是同一个」直接
 * 证明了那一行说的就是我这条会话 —— 这是无归属存量行**唯一**能被认领的理由。
 *
 * 为什么不拿别的当证据:`native_id` 和 `tool_use_id` 来源侧都只承诺在一条会话内唯一。只有
 * run 文件这一样能自证来源。
 */
export type SourceEvidence = {
  cliSessionId: string | null;
  sourceRun?: string | null;
};

/**
 * 从同一个 id 底下的那几行里挑出「属于我这条会话的那一行」;挑不出就 `undefined`。
 *
 * 两条规矩:
 *
 * ① **来源对得上**(两边都知道且相等)→ 就是它。
 * ② 对不上时,只认**能被证明是我的**那一行:它记的 `source_run` 跟我手上的是同一个(而且
 *    它的归属不与我矛盾)。
 *
 * **「库里只有这一行」不是证据**(第 5 轮审查 N2):甲的无归属旧行 + 乙后来起的同号监听,
 * 乙先到时库里就只有甲那一行。认下去是两张卡一起坏:甲的卡被乙的事实改写,乙自己那张再也
 * 插不进来。**「两边都不知道」同样不是证据**:那只是两个未知,不是同一个来源。
 *
 * 证明不了就不认:写到错的那一行上是永久的。
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
  return run ? rows.find((r) => r.sourceRun === run && (!r.cliSessionId || !mine)) : undefined;
}
