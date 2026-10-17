/**
 * 调度台 ↔ 回合身份的**所有权层**。
 *
 * 产物归属按「这一刻哪个回合在跑」认人（写端的内存登记，见 `../session-turns.ts`），而常驻
 * 调度台是这三条路里唯一一个「身份活得比登记它的那次函数调用更长」的：它属于这台 `Lead`
 * 对象，由消费循环的收尾、关台、换台来释放。所以这件事不能散在 begin/end/retire/close 四处
 * 各写一句，必须有一个地方说清楚**谁持有什么、什么时候放手**。
 *
 * ── 持有的那些身份是一个**队列**，不是一个字段 ──────────────────────────────
 *
 * 一台调度台就是一个 CLI 进程，它**串行**跑回合：第 N 次投入（开台随 spawn 送进去的首轮
 * prompt、用户插话、执行者汇报）对应第 N 个 `turnEnd`。而**投入与它的结束之间是可以交错
 * 的** —— 用户插话时 ash 先 `interrupt()` 再 `send()`，新一轮当场就算开跑（`sendToLead`
 * 里那一句 `holdTurn`），可被打断那一轮的进程要再过一会儿才吐出它的 `turnEnd`。于是同一
 * 瞬间手上有两个未结束的身份。
 *
 * 所以 `turnEnd` 关掉的永远是**队首**（`releaseHeldTurn`），而不是「此刻 `lead.turnStart`
 * 写着的那个」。照后者结算等于**用旧回合的结束事件把新回合提前收口**：新一轮刚落的那行
 * 记录当场被补上 `ended_at`（一个几毫秒的假区间），活动身份也一并撤掉，它真正干活那一段
 * 落进两条记录之间的空洞 —— 那一轮做出来的图从此永久漏在清单外，重新扫描、刷新都找不回来
 * （第 1 轮审查 F1；`AgentEvent` 的 `turnEnd` 不带身份，配对只能靠这个顺序）。
 *
 * ── 三条不变量 ───────────────────────────────────────────────────────────
 *
 *   • **持有与登记同一个同步段**：`holdTurn` 把 `busy`/`turnStart` 与活动登记一次做完，中间
 *     没有 await，所以事件消费不可能看到「一条已经在跑的回合，台上却写着 busy:false」那种
 *     半成品状态（第 8 轮审查必须修 1：首轮登记稍一等库，抢在前面的事件就按 `!lead.busy`
 *     又开一个起点，多出来的那个没人注销）。
 *   • **状态字段跟着队首走**（`adoptFront`）：队首就是执行器此刻在跑、或刚被打断即将被下一轮
 *     顶上的那一轮。`busy` 因此恒等于「手上还有没结束的回合」—— 旧回合的 `turnEnd` 到达时
 *     插话那一轮还在手上，这台就不算空下来，于是不会落 idle、不会被空闲回收、也不会让消费者
 *     对接下来的事件再补开一个回合。
 *   • **放手只认手上这一份集合**：既不认 `lead.turnStart` 那个随时会被下一轮覆盖的字段，也
 *     不整条会话一把清（接管那条路复用同一行会话，清整条会误伤新台刚登记的起点）。
 *   • **结束不可逆,而且判据不在这一层**（`holdTurn` 的返回值）：一个身份被 `turnEnd` 关掉之后,
 *     迟到的开始回调不许把它重新排进队列。这台自己记不住「哪些身份已经结束过」—— 队列里只有
 *     还没结束的那些,弹出去就什么都不剩了,于是同一个回调再来一次又入队成功。所以判据交给
 *     身份层那道已关闭水位（`markTurnActive` 的返回值）：两份账同源,这台只负责照它的答复办。
 *     凭空多出来的那个幽灵队首会被下一次 `turnEnd` 消耗掉,而真正刚结束的那一轮则一直留在活动
 *     册上,读端把区间从它的起点开到无穷,之后别的任务在同一个目录里做的东西全被算成它的
 *     （第 2 轮审查 F2）。
 *   • **起点由身份层分配**（`nextTurnStart`,见 `../session-turns.ts`）：投递口不自己取 `now()`。
 *     两次投递撞在同一毫秒时,`Set<string>` 把两个位置合成一个,FIFO 的一对一前提当场不成立
 *     （第 2 轮审查 F1）。
 */
import { clearTurnActive, markTurnActive } from "../session-turns.js";
import type { Lead } from "./session-types.js";

/**
 * 作用域已经结束的那些台。
 *
 * 用 WeakSet 而不是 Lead 上的字段：这是**所有权层自己的账**，跟 `retired`（那是「不许再写
 * 任何共享产物」）不是一回事——关台之后那台仍可能有一个排在后面的异步回调去开回合，而
 * 那个回合谁都不会来收。键是对象本身，台一被回收这条记录跟着没。摘牌（`retireLead`）必经
 * `closeLeadTurns`，所以 `lead.retired` 也被这一道盖住了。
 */
const closedScopes = new WeakSet<Lead>();

/** 队首 = 执行器此刻在跑的那一轮。`Set` 保持插入序，所以它就是最早那个还没结束的身份。 */
function adoptFront(lead: Lead): void {
  const front: string | undefined = lead.held?.values().next().value;
  lead.busy = front !== undefined;
  lead.turnStart = front ?? null;
}

/**
 * 这台开始持有 `at` 这个回合身份 —— 投入的那一刻就调（`sendToLead` 收下消息之后、
 * `attachLead` 开放事件消费之前），**同一个同步段内**完成。
 *
 * 返回**真的收进手里了没有**。`false` 的两种情形,调用方都只许补持久记录、不许改「这条会话
 * 正在跑」那组状态：
 *   • 这台的作用域已经结束（关台/换台之后迟到的回调）；
 *   • 这个身份已经被关掉过（身份层那道已关闭水位说的,见顶部第四条不变量）。
 *
 * 幂等：同一个身份重复持有不会变成两轮,而且照样答 `true`（`openLead` 先在 `attachLead` 里
 * 持有首轮，紧接着 `beginTurn` 又用同一个 `turnStart` 调一次 —— 那是同一轮,它确实在手上）。
 */
export function holdTurn(lead: Lead, at: string): boolean {
  if (closedScopes.has(lead)) {
    // 作用域早退了（关台/换台之后迟到的回调）：身份一个都不许再登记 —— 那样开出来的回合
    // 谁都不会来收，读端会把它当成「从那个老起点一直在写」。但状态字段还得跟上：摘牌的
    // 台事件流仍在消费，`busy` 一直是假就会对它之后每一条事件各补开一个回合。
    lead.busy = true;
    lead.turnStart = at;
    return false;
  }
  const held = (lead.held ??= new Set<string>());
  if (held.has(at)) return true; // 已经在手上：同一轮被开两次,不是新的一轮
  // **先问身份层,再入队**。顺序反了就是 F2 那个形状：队列收下了、活动册拒了,两份账从此
  // 不一致 —— 多出来的那个队首会被下一次结束消耗,真正在跑的那一轮永远注销不掉。
  if (!markTurnActive({ sessionId: lead.sessId, taskId: lead.taskId, startedAt: at })) return false;
  held.add(at);
  adoptFront(lead);
  return true;
}

/**
 * 执行器报了「一个回合说完了」：放掉**队首**那个身份并把它返回（null = 手上一个都没有，
 * 那是重放的 `turnEnd`，或者摘牌之后的收尾）。
 *
 * 返回值就是调用方该用来结算的那个起点：这一轮的区间、这一轮的用时，都按它算。
 */
export function releaseHeldTurn(lead: Lead): string | null {
  const held = lead.held;
  const front: string | undefined = held?.values().next().value;
  if (!held || front === undefined) {
    lead.busy = false;
    lead.turnStart = null;
    return null;
  }
  held.delete(front);
  clearTurnActive(lead.sessId, front);
  adoptFront(lead);
  return front;
}

/**
 * 这台此刻还攥着的那些身份（队首在前）。
 *
 * 给异常收尾（`closeLead`）补区间用：进程整个没了的时候手上可能不止一个回合（插话那一轮
 * 还排着），每一个都得补上自己的区间，否则缺的那几轮只剩「会话结束了、最后一个回合没有
 * 记录」那一个笼统缺口。
 */
export function heldTurns(lead: Lead): string[] {
  return lead.held ? [...lead.held] : [];
}

/** 放掉这台手上**全部**回合身份,并把放掉的那些**交回调用方**（队首在前）。 */
function releaseAll(lead: Lead): string[] {
  const held = lead.held;
  if (!held?.size) return [];
  const released = [...held];
  for (const at of released) clearTurnActive(lead.sessId, at);
  held.clear();
  // 这里**故意不**跟着 `adoptFront`：`busy` 要留在真上。摘牌的台事件流仍在消费,一松口
  // 消费者就会对它之后每一条事件各补开一个回合（同 `holdTurn` 的 closedScopes 分支）。
  return released;
}

/**
 * 这台的作用域结束了（关台/换台）：放掉全部身份,并且从此不再接受新的持有。
 *
 * 返回这台**在整个生命周期里**被这条路放掉的全部身份（含先前几次调用放掉的）。异常收尾要
 * 按这一份补区间：放手与收尾**不在同一个时刻**——换台那一路是 `attachLead` 接管的那一瞬
 * 就 `retireLead` 了,旧进程的 `close` 事件要再过一会儿才到,等 `closeLead` 去读 `held` 时
 * 它早就空了。那时只能退回 `lead.turnStart` 那个单值,于是**被打断/还排着的那几轮永远留在
 * `ended_at = NULL`**,读端把它们当「崩了没收口」的缺口报出来,整条区间跟着放宽
 * （本轮审查第 3 条,已实测）。所以身份得交回来,而且得**记在台上**而不是只当返回值——
 * 放手的那次调用（`retireLead`）并不是补区间的那次调用（`closeLead`）。
 */
export function closeLeadTurns(lead: Lead): string[] {
  closedScopes.add(lead);
  const released = releaseAll(lead);
  if (released.length) {
    const stash = (lead.releasedTurns ??= []);
    for (const at of released) if (!stash.includes(at)) stash.push(at);
  }
  return lead.releasedTurns ? [...lead.releasedTurns] : [];
}
