// 「这一轮的输入到底进没进 agent 手里」—— 从**拿到执行句柄那一刻**起,这份观察责任就归
// continueTask,而且**每一条出口**都要把它交给调用方。
//
// 为什么单拎出来(第 2 轮自由审查 F1,已实测两种相反的后果):上一版把回执交接写在起跑流程
// 的末尾 —— spawn 之后还要等会话持久化、清交接提示、登记回合,这些本地记账任何一步抛了,
// 控制流就从 catch 走掉,手上那份已经存在的协议事实谁也没交出去:
//   · 普通排队消息:租约拿不到定论,调用点按「回执压根没来过」归还重投 —— 而 codex 早就
//     收下了第一次,同一句话执行两遍;
//   · 续跑交代:`onInputReceipt` 从未被调到,`undefined` 被读成「这个执行器不提供回执」
//     → accepted → 交代被消费 —— 而协议层其实明确拒收了,本该继续执行的那段话凭空消失。
// 两个相反的错误来自同一个缺口:**协议事实的交接依赖本地记账成功**。
//
// 所以现在是两步,都住在这里:
//   ① `handOver`:run() 一返回、在任何可失败的 await 之前,把回执本体交出去。执行器不提供
//      回执也给一个**显式的** accepted 承诺 —— 调用方手上的 `undefined` 从此只有一个意思:
//      「还没交接」,不再与「无回执能力」共用一个值;
//   ② `settle`:按协议定论结算(落协议记号 → 回调调用方 → 迟到的那一档接着转)。正常路径在
//      原话落进会话之后调;**异常出口先把进程收掉再调**(进程一关,未完成的请求一律落定,有界
//      等待通常当场返回)。只结一次,哪条出口先到算哪条。
import { noteDeliveryAccepted, noteDeliveryRefusal } from "./delivery-crossing.js";
import type { InputAcceptance, RunHandle } from "./executors/types.js";
import { closeReviewInputWait, noteReviewInputAcceptance } from "./review-input-verdict.js";
import type { ReviewStartReceipt } from "./review-start-withdrawal.js";
import { awaitTurnInput, logTurnInputAcceptance, settleLateTurnInput } from "./turn-input-acceptance.js";

export interface TurnInputSettlement {
  /** run() 一返回就调:回执本体交给 `onInputReceipt`(同步,不许有 await 夹在前面)。 */
  handOver(handle: RunHandle): void;
  /** 按协议定论结算一次;第二次调用是空转。既没有 `onInputSettled`、又不是审查回合的,什么都不做。 */
  settle(handle: RunHandle): Promise<void>;
  /** 结过了没有(异常出口据此判断还欠不欠这一笔)。 */
  settled(): boolean;
}

export function createTurnInputSettlement(taskId: string, opts: {
  pendingMessageIds?: readonly string[];
  onInputSettled?: (acceptance: InputAcceptance) => void | Promise<unknown>;
  onInputReceipt?: (receipt: Promise<InputAcceptance>) => void;
},
/**
 * 这一轮若是审查回合:它的起跑收据(spawn 之后才有,所以是个取值函数)。有就把回执同时记到
 * 审查的交付凭据上 —— 审查结算在这一轮结束前就要读它(../review-input-verdict.ts)。
 */
reviewReceipt?: () => ReviewStartReceipt | undefined,
): TurnInputSettlement {
  let done = false;
  const ids = opts.pendingMessageIds ?? [];
  // **先把协议层那个事实落盘,再去记账。** 进程内那一份只够当场处置:
  //   · refused  —— 判出拒收之后、归还落库之前进程没了,重启对账手上只有越线记号(线确实
  //     越过了),少了这张记号它会判成已送达并补记(第 1 轮自由审查 F2);
  //   · accepted —— 对称的那一半:协议确认了、而 `markSent` 还没落库就崩,重启对账必须仍然
  //     判 `delivered`(只能往前走,绝不归还)。这张记号是「已送达」**唯一**的凭据 ——
  //     本地会话行已经退出那一问(第 2 轮自由审查 F1)。
  const noteFact = async (fact: InputAcceptance, stillWaiting = false): Promise<void> => {
    if (ids.length) {
      if (fact === "refused") noteDeliveryRefusal(taskId, ids);
      else if (fact === "accepted") noteDeliveryAccepted(taskId, ids);
    }
    // 审查回合:定论先进本进程内存再落库,写不下来也不会被读成缺席(review-input-verdict.ts)。
    await noteReviewInputAcceptance(taskId, reviewReceipt?.(), fact, stillWaiting);
  };
  return {
    handOver(handle) {
      opts.onInputReceipt?.(handle.inputAccepted ?? Promise.resolve<InputAcceptance>("accepted"));
    },
    settled: () => done,
    async settle(handle) {
      const settled = opts.onInputSettled;
      if (done) return;
      done = true;
      // 没有调用方要记账的回合也照样问回执:审查回合的结算要读它(见 `reviewReceipt`)。
      if (!settled && !reviewReceipt?.()) return;
      const acceptance = await awaitTurnInput(handle);
      logTurnInputAcceptance(acceptance, `任务 ${taskId}`);
      // 有界等待超时 ≠ 回执落定:本体还悬着,定论就还可能到 —— 审查结算据此按住这一轮。
      await noteFact(acceptance, acceptance === "unknown" && !!handle.inputAccepted);
      // **失败不许静默**(第 3 轮自由审查 F4):记账失败照旧不拖累这一轮(这里不抛),但它得
      // 留下痕迹 —— 租约那条路自己带退避补偿(delivery-lease.ts),能走到这儿的是**它之外**
      // 的记账炸了,咽下去就等于「消息永久卡在待发送」这类现场连一行线索都没有。
      try { await settled?.(acceptance); } catch (error) {
        console.error(`[ash] 任务 ${taskId} 的投递记账(${acceptance})出错，这一轮照常继续:`, error);
      }
      if (acceptance === "unknown") {
        // **接着等那份凭据**(不阻塞这一轮),**三档一律转给调用方**:它最终落定成 `accepted`
        // 就是补记账,落定成 `refused` 就是归还重投 —— 上一版只转 accepted,于是迟到的拒收
        // 把那张租约永远留在「在途」(第 2 轮自由审查 F3,已实测)。各档的调用点都做成幂等。
        settleLateTurnInput(handle, `任务 ${taskId}`, async (late) => {
          await noteFact(late);
          try { await settled?.(late); } catch (error) {
            console.error(`[ash] 任务 ${taskId} 的迟到投递记账(${late})出错:`, error); // 同上,不静默
          }
        });
        // 落定成 unknown 或者抛了:定论再也不会到。审查那一侧照样按住,只是从「等迟到的定论」
        // 换成「等用户拿主意」(review-input-verdict.ts 的 unconfirmed;定论那一档由上面先记)。
        void handle.inputAccepted?.then((late) => {
          if (late === "unknown") closeReviewInputWait(taskId, reviewReceipt?.());
        }, () => closeReviewInputWait(taskId, reviewReceipt?.()));
      }
    },
  };
}
