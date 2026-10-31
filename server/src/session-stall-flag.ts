// 「这条会话此刻卡在上游连不上」的**持久**那一半。
//
// 判据与两档动手一律在 `turn-stall.ts`(纯状态机);这里只负责把结论落进库、再广播一次任务行,
// 让它活过刷新、也能当场出现在任务卡片上。
//
// 为什么非得落库:项目规矩是「停止/暂停必须留下持久可见的状态,判据是用户刷新页面后仍能看
// 出」(AGENTS.md)。停滞是同一类事 —— 内存里那份(`session-waiting.ts` 的 sessionWaiting)
// 是**转瞬状态**,ash 重启就没了,而且只在会话详情那一路取得到;而「这个任务其实在干等」要
// 在列表里一眼看出来,只能靠库。
//
// 写得很省:一次停滞最多两次 UPDATE(报警时置上、上游回话或回合收尾时撤掉),而停滞本身是
// 少见状态 —— 绝大多数回合一次都不写。
import { and, eq, isNotNull } from "drizzle-orm";
import { db } from "./db/index.js";
import { sessions } from "./db/schema.js";
import { publishTaskUpdated } from "./task-store.js";

/**
 * 这个标记的身份是**这一次停滞**(`since`,由 `openStall` 取的那一刻),不是会话行上的
 * `turn_started_at`。
 *
 * 上一版拿后者做 CAS,错在把**最近一次投入**当成了**此刻在执行**(第 3 轮审查 F2,已实测):
 * 常驻台用户插话时 ash 先 `interrupt()` 再 `send()`,`sendToLead` 收下 T2 就当场 `holdTurn`,
 * `beginTurn(T2)` 随即把会话行的 `turn_started_at` 写成 T2 —— 可执行器此刻真在跑的仍是队首
 * T1(`lead.turnStart`),而 interrupt 只是个请求,T1 完全可能继续重连几十分钟(那正是熔断
 * 兜底存在的理由,不能拿「它马上就会结束」把它排除掉)。于是按 T1 的身份既写不进去(报警
 * 没了)、也撤不掉(回合真结束时标记留在库里)。
 *
 * 换成按**停滞自己的那一刻**比对,两头都对上了:
 *   · 置上:按 sessionId 直接写。「这一轮是不是真在跑」只有内存里那份所有权账算得清(持有者
 *     + 回合双判在 `turn-stall.ts`,摘牌当场作废在 `retireLead`,摘过牌的台在
 *     `lead-voice.ts` 连这一笔都不写),库这一侧再比一次只会把上面那种合法写入也挡掉。
 *   · 撤掉:`WHERE upstream_stalled_since = ?` —— 只有**置上它的那一次停滞**撤得动。别人的
 *     那一次(新台、下一轮)值不一样,一个字都碰不到;库里已经是 null 就是空转。这替掉了原来
 *     那道 CAS 想防的事(摘牌后旧台把新台的标记擦掉),而且不依赖「行上写的是哪一轮」。
 */
async function setStalled(sessionId: string, since: string): Promise<void> {
  await db.update(sessions).set({ upstreamStalledSince: since }).where(eq(sessions.id, sessionId));
}

async function unsetStalled(sessionId: string, since: string): Promise<void> {
  await db
    .update(sessions)
    .set({ upstreamStalledSince: null })
    .where(and(eq(sessions.id, sessionId), eq(sessions.upstreamStalledSince, since)));
}

/**
 * 置上/撤掉,并补发一次 `task.updated`。
 *
 * 补发是必须的:这一列不在 `tasks` 上,改它不会动 `tasks.updated_at` —— 没有这一次广播,
 * 卡片要等到下一次整表拉取才变(库里的 trigger 只负责把 `backgroundRevision` 推上去,让
 * 前端那套快照合并知道哪一份的后台字段更新,它自己不负责投递)。
 *
 * 失败只记一句:这是一条提示,不该掀翻正在收尾的回合。
 */
function flip(taskId: string, write: Promise<void>, what: string, sessionId: string): void {
  void write
    .then(() => publishTaskUpdated(taskId))
    .catch((error: unknown) => {
      console.warn(`[ash] ${what}会话 ${sessionId} 的上游停滞标记失败:`, error);
    });
}

export function markSessionStalled(taskId: string, sessionId: string, since: string): void {
  flip(taskId, setStalled(sessionId, since), "置", sessionId);
}

/**
 * 回合收尾那一路也调它:`ended_at` 虽然已经让读侧的 EXISTS 失效,标记本身不该留着 ——
 * 下一轮复用同一行会把 `ended_at` 清成 null,留着的标记当场又亮起来(第 1 轮审查第 3 条)。
 *
 * 开始边界上还有一道:`session-turns.ts` 的 `resumedTurnFields` 顺手把这一列清零 —— 但**只在
 * 真的开跑一轮时**(团队把消息排在正在跑的那一轮后面时不清,见那个函数的 `queuedBehind`)。
 * 两道都要有:这一道是「终止边界」,那一道兜住的是进程都没了、根本没人来撤的那种。
 */
export function clearSessionStalled(taskId: string, sessionId: string, since: string): void {
  flip(taskId, unsetStalled(sessionId, since), "撤", sessionId);
}

/**
 * 把这个任务名下**所有还挂着停滞标记**的会话行清干净,用在「不接管的结束边界」上
 * (`task-reconcile.ts` 的启动对账,第 5 轮审查 F5)。
 *
 * 为什么需要一个不带 `since` 的版本:上面那个 CAS 的前提是「置上它的那一次停滞自己来撤」,而
 * 这条路恰恰是**那个消费者已经不在了** —— 进程随上一个 ash 一起没了,没有任何人握着那个
 * `since`。留着的后果不是「多一个无害的字段」:读侧的 EXISTS 只问「标记在、这行没收尾、任务在
 * 跑」,于是用户换执行器重试时新会话只清自己那一行,旧行跟着新任务的 running 一起又让红环亮起来。
 *
 * 安全性靠调用点保证:对账只处理「状态在飞、手上却没有活句柄」的任务,而且是在原子预占了那个
 * 任务的回合锁之后 —— 此刻不可能有谁正合法地持着一次停滞。
 *
 * 失败只记一句:这是一条提示,不该掀翻正在收尾的对账。
 */
export async function clearTaskStallFlags(taskId: string): Promise<void> {
  try {
    const cleared = await db
      .update(sessions)
      .set({ upstreamStalledSince: null })
      .where(and(eq(sessions.taskId, taskId), isNotNull(sessions.upstreamStalledSince)))
      .returning({ id: sessions.id });
    if (cleared.length) await publishTaskUpdated(taskId);
  } catch (error) {
    console.warn(`[ash] 清任务 ${taskId} 名下的上游停滞标记失败:`, error);
  }
}
