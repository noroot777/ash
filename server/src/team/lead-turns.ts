/**
 * 调度台 ↔ 回合身份的**所有权层**。
 *
 * 产物归属按「这一刻哪个回合在跑」认人（写端的内存登记，见 `../session-turns.ts`），而常驻
 * 调度台是这三条路里唯一一个「身份活得比登记它的那次函数调用更长」的：它属于这台 `Lead`
 * 对象，由消费循环的收尾、关台、换台来释放。所以这件事不能散在 begin/end/retire/close 四处
 * 各写一句，必须有一个地方说清楚**谁持有什么、什么时候放手**：
 *
 *   • `holdTurn` —— 开始持有一个回合身份。状态（`busy`/`turnStart`）与身份登记在**同一个
 *     同步段**里完成，中间没有 await，所以事件消费不可能看到「一条已经在跑的回合，台上却
 *     写着 busy:false」那种半成品状态。原先这两件事分别排在 `attachLead` 之后的不同 await
 *     后面：首轮登记稍一等库（并发事务），抢在前面的事件就让消费者按 `!lead.busy` 又开了
 *     一个回合起点，多出来的那个身份没人注销，下一次唤醒时读端把它当成「从那个老起点一直
 *     在写」，待命期间别人做的东西全被收进这台的清单（第 8 轮审查必须修 1）。
 *   • `releaseHeldTurns` / `closeLeadTurns` —— 放手。按**这台手上这一份集合**放，既不认
 *     `lead.turnStart` 那个随时会被下一轮覆盖的字段，也不整条会话一把清（接管那条路复用
 *     同一行会话，清整条会误伤新台刚登记的起点）。
 *
 * 一台调度台就是一个 CLI 进程，**同时最多只有一个回合在跑**。所以 `holdTurn` 发现手上还
 * 攥着别的起点时一律放手：要么上一轮刚被用户插话打断（它确实不再写盘了），要么就是上面
 * 那种交错留下的残影。两种都该放。
 */
import { clearTurnActive, markTurnActive } from "../session-turns.js";
import type { Lead } from "./session-types.js";

/**
 * 作用域已经结束的那些台。
 *
 * 用 WeakSet 而不是 Lead 上的字段：这是**所有权层自己的账**，跟 `retired`（那是「不许再写
 * 任何共享产物」）不是一回事——关台之后那台仍可能有一个排在后面的异步回调去开回合，而
 * 那个回合谁都不会来收。键是对象本身，台一被回收这条记录跟着没。
 */
const closedScopes = new WeakSet<Lead>();

/** 这台开始持有 `at` 这个回合身份。必须在开放事件消费**之前**对首轮调一次（见 `attachLead`）。 */
export function holdTurn(lead: Lead, at: string): void {
  if (closedScopes.has(lead)) return; // 作用域早退了：迟到的回调不许把它重新登记成活动
  lead.busy = true;
  lead.turnStart = at;
  const held = (lead.held ??= new Set<string>());
  for (const stale of held) if (stale !== at) clearTurnActive(lead.sessId, stale);
  held.clear();
  // 摘牌的台一个字都不写（同 `updateOwnSession` 顶上那道闸），当然也不该登记活动身份：
  // 接管那条路复用同一行会话，旧台晚到的事件要是登记上去，新台名下就凭空多出一段区间。
  if (lead.retired) return;
  held.add(at);
  markTurnActive({ sessionId: lead.sessId, taskId: lead.taskId, startedAt: at });
}

/** 放掉这台手上**全部**回合身份（回合收尾用：台还在，下一轮会再持有）。 */
export function releaseHeldTurns(lead: Lead): void {
  const held = lead.held;
  if (!held?.size) return;
  for (const at of [...held]) clearTurnActive(lead.sessId, at);
  held.clear();
}

/** 这台的作用域结束了（关台/换台）：放掉全部身份，并且从此不再接受新的持有。 */
export function closeLeadTurns(lead: Lead): void {
  closedScopes.add(lead);
  releaseHeldTurns(lead);
}
