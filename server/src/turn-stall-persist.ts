// 熔断判决的**持久那一半**:让「这一轮已经被判失败」跨得过 server 重启。
//
// 为什么要分成两个文件:判据与判决本体(`turn-stall.ts` / `turn-stall-verdict.ts`)是**纯内存**
// 的,一个字都不碰库 —— 那让回合级停滞的整套判据能被纯状态机测试钉住(test-turn-stall.ts 不
// 需要库,也就不可能误连生产库)。落库要引 db,所以单独住在这里,由消费链注入进去
// (`StallActions.persist`),不反过来把 db 拖进状态机。
//
// 要解决的事(审查 F3,已实测两个独立消费进程):**detached 执行器活得过 server 重启**
// (`executors/detached.ts`,ash 的既有能力)。判决原先只活在进程内存里,于是存在这样一条路 ——
// 看门狗判了熔断、终止请求还没兑现(codex 的 kill 先发 interrupt,另设 2 秒回收)时 server
// 退出;重启后接管那个仍然存活的进程,新进程的 Map 空着;上游恰好恢复并正常答完,这一轮就按
// `completed` 结算、任务落 `done`。退出码重建不出这个事实(被我们杀掉的进程多半 exit 0),所以
// 判决本身必须按回合身份留在库里。
//
// 边界:**只有单飞这条链需要恢复**。团队常驻台重启后走的是重开台(`restartImpact` 把 team
// 记进 `resumes`,不接管存活进程),duet 的回合断了就是断了 —— 那两条链上没有「接管一个仍在
// 跑、且已被判熔断的回合」这条路可走,所以不给它们接恢复。落库本身无害,但也没必要。
import { dbClient } from "./db/index.js";
import { markStallFailure, stallFailure, type StallVerdict } from "./turn-stall-verdict.js";

/**
 * 判决作出那一刻就写库(`turn-stall.ts` 的 trip 里调,先于终止动作)。
 *
 * **不抛**:写库失败不该拦住终止本身 —— 那一轮确实该停,同进程的内存判决也已经钉好了,
 * 丢掉的只是「跨重启还认得它」这一层。如实报一句,别把一次库故障变成「这一轮没被熔断」。
 */
export async function persistStallVerdict(sessionId: string, turnStartedAt: string, reason: string): Promise<void> {
  try {
    await dbClient.execute({
      sql: "UPDATE session_turns SET stall_reason = :reason WHERE session_id = :sid AND started_at = :at",
      args: { reason, sid: sessionId, at: turnStartedAt },
    });
  } catch (error) {
    console.warn(`[ash] 会话 ${sessionId} 回合 ${turnStartedAt} 的熔断判决没写进库（跨重启会丢）:`, error);
  }
}

/**
 * 接管一个仍然存活的回合时,把**尚未兑现**的熔断判决装回内存。
 *
 * 判据是「有判决 **且** 这一行还没收口」:收口过的行说明那一轮已经结算完了,判决早该销账,
 * 再装回来等于拿一份旧判决去压一轮新的执行(同一个理由见 turn-stall-verdict.ts 的键为什么
 * 是回合身份而不是 sessionId)。
 *
 * 返回非 null = 这一轮背着一份没兑现的终止义务,调用方**必须接着把它终止掉**:判决已经作出、
 * 用户那边也已经看到「已自动终止本回合并按失败结算」,让它接着跑下去就是第二次失信。
 */
export async function restoreStallVerdict(
  sessionId: string,
  turnStartedAt: string | null | undefined,
): Promise<StallVerdict | null> {
  if (!turnStartedAt) return null;
  // 同进程里已经有了就别再碰库:那一份才是最新的(这条路也走正常起跑,不只走接管)。
  const held = stallFailure(sessionId, turnStartedAt);
  if (held) return held;
  try {
    const read = await dbClient.execute({
      sql: "SELECT stall_reason, ended_at FROM session_turns WHERE session_id = :sid AND started_at = :at LIMIT 1",
      args: { sid: sessionId, at: turnStartedAt },
    });
    const row = read.rows.at(0);
    const reason = typeof row?.stall_reason === "string" ? row.stall_reason : "";
    if (!reason || row?.ended_at != null) return null;
    markStallFailure(sessionId, turnStartedAt, reason);
    return stallFailure(sessionId, turnStartedAt);
  } catch (error) {
    console.warn(`[ash] 会话 ${sessionId} 回合 ${turnStartedAt} 的熔断判决没能从库里恢复:`, error);
    return null;
  }
}
