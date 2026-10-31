// 团队任务(§Team)的插话投递:用户那句话直接写进常驻调度台的 stdin。
//
// 为什么单独一个文件:`continueTask` 里那条「团队」分支跟它后面那一大段(起跑前的闸、
// 会话准备、执行器解析、结算)没有任何共享状态 —— 它自己占锁、自己还锁、自己返回。
// 本轮审查点出 `orchestrator.ts` 已经 711 行(超过 700 行的约定、而且本轮还在长),
// 这一段是其中边界最干净的一块,所以搬出来;逻辑一个字没改。
import { deliverToLead } from "./session.js";
import type { ContinueTaskOptions } from "../task-continue-options.js";
import { enterLeadDelivery } from "../turn-entry-guard.js";

/**
 * 把一句话投给常驻调度台 —— 即时、同一会话、用户侧感觉不断线。于是 `/reply`、`/answer`、
 * @提及全都自动生效。
 *
 * 入口那串闸(验收互斥、唤醒资格、以及**只给唤醒类投递**的那把互斥锁)在
 * `turn-entry-guard.ts` 的 `enterLeadDelivery`:常驻调度台没有「一个回合」可以托管占位,
 * 所以它把要还的锁当返回值交出来,这里用 finally 还 —— 含 `deliverToLead` 抛错那条出路。
 *
 * **返回值 = 这一句有没有送出去**(跟 `continueTask` 同一口径)。
 */
export async function deliverLeadInterjection(
  taskId: string,
  userText: string,
  opts: ContinueTaskOptions,
): Promise<boolean> {
  const releaseLead = await enterLeadDelivery({
    taskId,
    turnHeld: opts.turnHeld,
    wakeGuard: opts.wakeGuard,
    pendingMessageIds: opts.pendingMessageIds,
  });
  if (!releaseLead) return false;
  try {
    // 调度台明确拒收(离线时收到 `/compact` 这类原生命令,拼上唤醒前言就不再是命令;
    // 或者进程正在收尾、stdin 已经关了)时,这一句**一个字都没送出去** —— 绝不能顺手
    // onDelivered():那是 pending → sent 的唯一写点,标了 sent 排队/定时的那条就从托盘里
    // 消失、会话里也没有,用户的话凭空蒸发(docs/incidents.md「排队消息凭空消失」)。
    // 跟单飞锁挡回同一口径:返回 false。
    const delivered = await deliverToLead(taskId, userText, {
      attachments: opts.attachments,
      bySystem: opts.byBackend,
      monitorWake: opts.monitorWake,
      throwOnOpenFailure: opts.throwOnTeamUnavailable,
    });
    if (!delivered) return false;
    if (opts.onDelivered) {
      try { await opts.onDelivered(); } catch { /* 记账失败不拖累这一轮 */ }
    }
    return true;
  } finally {
    releaseLead();
  }
}
