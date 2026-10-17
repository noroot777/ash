// 调度台的**投递口**:所有写进它 stdin 的消息都从这里过(用户插话、执行者汇报、回合收尾
// 的合并汇报)。单独成一个文件,是因为这里管着三件互相缠着的事 —— 现读授权、按调用顺序
// 串行、以及「打断与投递必须是同一个动作」,它们的理由都在下面那段注释里,跟事件消费循环
// 放一起只会被淹掉(而且 session-consumer.ts 已经顶到 700 行上限)。
import { browserGrantForTask, withGlobalBrowserPolicy } from "../browser-verification-policy.js";
import { now } from "../util.js";
import { holdTurn } from "./lead-turns.js";
import type { Lead } from "./session-types.js";

/**
 * 一次投递的结果。
 *
 * `interrupted` 只对用户插话有意义:时间线上那句「已打断」靠它。
 * `at` = 收下这条消息的那一刻,也就是**它开起来的那个回合的身份**(没收下就是 null)。调用方
 * 必须拿它去 `beginTurn`,不能自己再取一次 `now()` —— 那会是**另一个**身份,于是同一轮在活动
 * 册上登记两个起点,其中一个谁都不会来收。
 */
export type LeadDelivery = { sent: boolean; interrupted: boolean; at: string | null };

/**
 * 把一条消息交给这台调度台的进程,**返回它收下了没有**(见 ResidentHandle.send)。
 *
 * 拿不到回执就只能假定送到了,而两种常驻实现都会静默拒收:codex 在 `ended || closing`
 * 时直接返回,claude 在 stdin 已关时写不进去。抛错同样按「没收下」算 —— 一次注入失败不该
 * 掀掉整台调度台(理由同 persistOrReport),但更不能被当成送到了。
 *
 * **同一台按调用顺序串行**:这里要 await 一次读库(现读浏览器授权),没有这条链的话,回合
 * 收尾那条合并汇报还卡在读授权上,用户插话就能抢先写进 stdin —— 调度者先看到「新要求」、
 * 后看到本该在它之前的那份执行结果,上下文是倒的(第 7 链第 1 轮审查实测到这个顺序)。
 *
 * **打断必须和这次投递是同一个动作**(`steer`)。把判据留在入队那一刻取的话,排队期间前面
 * 那条消息可能刚把一个新回合送出去,等轮到插话时它只是排在队尾 —— 用户看到「已发出」,
 * 调度者却要跑完整个旧回合才理他,steering 名存实亡(第 7 链第 2 轮审查 P1:codex 常驻一次
 * 只跑一个回合,忙时 send 只是进 waiting,真正转向必须 interrupt)。
 */
export async function sendToLead(lead: Lead, text: string, opts: { steer?: boolean } = {}): Promise<LeadDelivery> {
  const delivery = (lead.sending ?? Promise.resolve()).then(async (): Promise<LeadDelivery> => {
    try {
      // 授权现读:开台时带的是「已授权 x.com」,后续消息若还注入默认拒绝,调度台收到的
      // 就是一对自相矛盾的指令(第 2 轮审查 P3)。同时这也让撤销对常驻调度台即时生效。
      const message = withGlobalBrowserPolicy(text, "reminder", await browserGrantForTask(lead.taskId));
      // 判据取在这里:读授权之后、写 stdin 之前,中间不再有 await。
      const interrupted = !!opts.steer && lead.busy;
      if (interrupted) lead.handle.interrupt();
      const at = now();
      const sent = lead.handle.send(message);
      // 送进去了就等于一个回合已经开跑,**身份与状态一起在这儿落账**(holdTurn,见
      // team/lead-turns.ts)。调用方的 beginTurn 还隔着两次写库,在那之前轮到链上下一条消息
      // 时,它读到的 busy 还是 false,就不会打断这个刚起的回合;消费循环的
      // `!lead.busy && startsSelfTurn(event)` 兜得住「CLI 自己先吐了个事件」的那一路,但那
      // 要碰运气 —— 这一行是不碰运气的那半。
      //
      // 只置 busy 不持有身份是不够的(第 8 轮那一版):旧回合的 turnEnd 可能恰好落在这里和
      // beginTurn 之间,那时队列里还没有这一轮,`releaseHeldTurn` 会把 busy 清回 false,消费
      // 者于是对新回合的第一条输出另开一个起点 —— 真实起点(投入这一刻)就此丢掉。
      if (sent) holdTurn(lead, at);
      return { sent, interrupted, at: sent ? at : null };
    } catch (error) {
      console.error(`[ash] team send(${lead.taskId}) failed:`, error);
      return { sent: false, interrupted: false, at: null };
    }
  });
  // 链上只留「轮到下一个了」,不留成败 —— 一条没送成不该把后面的也拖成 rejected。
  lead.sending = delivery.then(() => undefined, () => undefined);
  return delivery;
}
