// 调度台的「待送执行者消息」托盘:持久队列(team_inbound,见 inbound-queue.ts)之上那层
// **进程内**的收发纪律 —— 换台认领、忙时排队、落库失败的退路。从 session.ts 拆出(文件
// 700 行闸),语义原样;reportLeadFailure 住在 session-consumer 里,由 session.ts 注入。
import { enqueueInbound, pendingInbound, type PendingInbound } from "./inbound-queue.js";
import { now } from "../util.js";
import type { Lead } from "./session-types.js";

export function createPendingInbox(report: (lead: Lead, text: string, at?: string) => void) {
  // 落库失败时的**最后一档**:没能写进 team_inbound 的入站消息只剩这一份内存副本。换台时
  // 跟着它走(releasePending → adoptInbound),server 一重启就真没了 —— 但那是数据库当时
  // 拒收的直接后果,总好过当场丢掉还一声不吭(2026-08-26 第 13 轮审查)。
  const unqueuedFallback = new Map<string, string[]>();

  /** 没有在线调度台时的兜底入口:写持久队列,写不进去退最后一档(strandedByHalt 用)。 */
  async function stashUnqueued(taskId: string, text: string): Promise<void> {
    try {
      await enqueueInbound(taskId, text);
    } catch (error) {
      // 跟 queueInbound 同一口径:写不进去也别当场丢掉,退回进程内的最后一档(见 adoptInbound)。
      console.error(`[ash] team enqueueInbound(${taskId}) failed:`, error);
      unqueuedFallback.set(taskId, [...(unqueuedFallback.get(taskId) ?? []), text]);
    }
  }

  /**
   * 认领这条任务名下还没送出去的入站消息 —— 上一台没送成的、换台丢下的、上一个 server
   * 进程留下的,都在这儿接回来(队列本身见 team/inbound-queue.ts)。
   *
   * 放在 consume 的开头而不是 attachLead 里,是因为读库要 await 而 attachLead 必须同步返回;
   * 排在 for-await 之前就够了 —— 事件都在 generator 里排着,turnEnd 一定在认领之后才处理。
   * 按 seq 去重是防这一手:认领读库的这段时间里,并发的 push 可能刚好把同一行也塞进了 pending。
   */
  async function adoptInbound(lead: Lead): Promise<void> {
    // 最后一档先取走:它只活在这个进程的内存里,没别的地方能等。
    const fallback = unqueuedFallback.get(lead.taskId) ?? [];
    unqueuedFallback.delete(lead.taskId);
    let rows: { seq: number; text: string }[] = [];
    try {
      rows = await pendingInbound(lead.taskId);
    } catch (error) {
      // 读不到不能当成「没有」:那等于把这些消息判死。如实说一句,它们仍在库里等下一台。
      report(lead, `读取待送的执行者消息失败：${error instanceof Error ? error.message : String(error)}`);
    }
    if (lead.retired) {
      // 读库这段时间里被换掉了。库里那些自有下一台去认领,内存这一份得放回最后一档。
      if (fallback.length) unqueuedFallback.set(lead.taskId, [...fallback, ...(unqueuedFallback.get(lead.taskId) ?? [])]);
      return;
    }
    const have = new Set(lead.pending.map((m) => m.seq));
    lead.pending.unshift(
      ...rows.filter((r) => !have.has(r.seq)),
      // 落库失败过的排在有 seq 的之后 —— 它们没有序号,精确的先后早在写库被拒时就丢了。
      ...fallback.map((text) => ({ seq: null, text })),
    );
  }

  /**
   * 排进持久待送队列,**写库失败不抛**。
   *
   * 抛出去没有意义:这条链是 fire-and-forget 的(执行者结算侧 `notifyTeamLead(...)` 只
   * `.catch(console.error)`),异常最终只变成一行控制台日志,而执行者已经结算,没有任何补送
   * 入口 —— 一次瞬时故障就永久吃掉一份执行结果、一句失败说明或一个待回答的提问,用户刷新
   * 也看不到发生过什么(2026-08-26 第 13 轮审查)。
   *
   * 写不进去就退回内存副本(seq=null):这一回合照样送得出去,下一次回合收尾还会重试落库
   * (flushUnqueued),换台也带得走(releasePending)。失败本身如实落进会话。
   */
  async function queueInbound(lead: Lead, text: string, at = now()): Promise<PendingInbound> {
    try {
      return await enqueueInbound(lead.taskId, text);
    } catch (error) {
      console.error(`[ash] team enqueueInbound(${lead.taskId}) failed:`, error);
      report(
        lead,
        `执行者消息写入待送队列失败：${error instanceof Error ? error.message : String(error)}。`
          + `这条消息眼下只有一份内存副本,回合收尾时会重试落库;在那之前 server 重启就会丢。`,
        at,
      );
      return { seq: null, text };
    }
  }

  /** 重试把还没落库的那几条写进去。库一恢复它们就重新变成持久的;还是不行就照旧只有内存副本。 */
  async function flushUnqueued(lead: Lead): Promise<void> {
    for (const message of lead.pending) {
      if (message.seq !== null) continue;
      try {
        message.seq = (await enqueueInbound(lead.taskId, message.text)).seq;
      } catch {
        // 还写不进去。第一次已经如实报过了,别每个回合再刷一遍屏 —— 内存副本还在,照样送。
        return;
      }
    }
  }

  /**
   * 交出这台手上的待送消息。有 seq 的留在 team_inbound 里等下一台认领;**没 seq 的只有内存
   * 这一份**,交给进程内的最后一档,别跟着这台一起没(见 unqueuedFallback)。
   *
   * 必须清空 `lead.pending`:摘牌不让旧进程闭嘴,它晚一步吐出的 turnEnd 照样会走 endTurn 那段
   * 合并投递,不清就是同一条汇报朝一个已经被杀的 handle 再送一遍,送「成」了还会把行删掉。
   */
  function releasePending(lead: Lead): void {
    const unqueued = lead.pending.filter((m) => m.seq === null).map((m) => m.text);
    if (unqueued.length) {
      unqueuedFallback.set(lead.taskId, [...(unqueuedFallback.get(lead.taskId) ?? []), ...unqueued]);
    }
    lead.pending = [];
  }

  return { adoptInbound, queueInbound, flushUnqueued, releasePending, stashUnqueued };
}
