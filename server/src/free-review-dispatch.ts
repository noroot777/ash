// 「这一轮审查的任务书到底送进会话了没有」—— 派发这一问收在这个文件里。
//
// 派发是**两段式**的:`launchReviewRound` 同步地建好 run/round 行、写下「审查开始」,真正的
// 投递却交给 `continueWhenIdle` —— 它排进回合锁的等待队列,等这个任务当前那一轮退干净,才在
// 释放点上抢锁、起旁路回合。两段之间隔着一整轮的时长。
//
// 老写法在第二段上只有一次机会:抢锁失败就走 `onError` → `failReviewStart`,round 落 error、
// run 落 failed,**终态**。而抢锁失败是个纯瞬时条件 —— 同一个释放点上注册在前的那条 waiter
// 先同步抢走了锁(`endOwnTurn` 按注册顺序放 waiter 走),谁先注册纯属时序运气。
//
// 2026-10-31 的实例(任务 IZk5yKUHpR2G,run QHyF0WKIgo_h):修复回合 02:46:18 结束 → 预约复审
// 02:46:19.231 写下「第 1 轮审查开始」→ 02:46:19.379(148ms 后)「启动失败:回合被其它执行抢占,
// 消息未能投递」。预约在启动前就已被 CAS 消费掉,于是自动链就地停住,要用户手动再开一轮。
// **瞬时条件不该变成永久失败**,这个文件就是那条修法:
//
//   ① 抢锁失败不落终态 —— 把意图重新排进下一个空闲窗口(`hand` 的递归);
//   ② 有界 —— 连输 `MAX_REVIEW_DISPATCH_ATTEMPTS` 次才放弃,放弃时的终态带着「输了几次」;
//   ③ 有痕 —— 每一次重排和最终放弃都写时间线(持久,刷新后还在;不是 toast);
//   ④ 触发不止一条 —— 重排走的是回合锁自己的 `afterTurn`,所以**凡是放锁都会放它走**:持有者
//      自己的 finally、人工放开(`POST /tasks/:id/reclaim-turn`)、幽灵锁巡检的
//      `forceReleaseTurn` 全走 `endOwnTurn`。只挂「下次执行回合正常结束」是不够的 —— 那次实例
//      里抢赢的就有可能是个占了锁什么都不起的幽灵,它永远没有「下一次回合结束」。
//
// 后来补上的两条不变量,它们各自都曾把上面四条抵消掉(第 1 轮审查 F1/F2):
//
//   ⑤ **在途 ≠ 没在干活** —— 「本进程还盯着」必须是恢复状态机里独立的一档(`in-flight`),对账
//      看到它要 `continue`。并进「没有意图」那一档的话,合法排队中的审查会在约 30 秒后被周期
//      对账按孤儿收尸,自动链照样断。而认领必须是**同步** test-and-set(`claimReviewDispatch`):
//      补办要重走一长串 await,只在开头读一次等于没有占位,两个恢复入口会各排一份同样的任务书。
//   ⑥ **投递的凭据取在「原话落盘」那一刻**,不是整轮跑完 —— 后者要等审查者跑几十分钟才
//      resolve,这中间服务断掉,新进程看到挂着的意图就会对一条已经执行过的审查整份重投。
//
// 第 2 轮审查又指出,上面两条各自只堵了「同时开始」那一种时序,真正的不变量还没立起来:
//
//   ⑦ **同一份在途意图只许被消费一次** —— 内存认领证不了这件事(它只说「本进程此刻没有第二个
//      人在办」),所以每一次写意图都是一次按版本的 CAS(`takeIntent`,版本就是 `attempts`),
//      而补办在认领之后必须去库里**现读**那一份、不许信调用方手里的快照。慢一份的旧快照
//      无条件写回去 = 把一条已经办完的意图凭空重建,接着再排一份完整任务书(第 2 轮审查 F1:
//      审查者刚提问、还没等到答复,第二份任务书已经开了一条新会话)。
//   ⑧ **持久交付凭据是恢复的权威** —— `commitReviewTurnDelivery` 先落
//      `waitOwnership.deliveredReview`,之后才走到清意图那一步,两者不同事务。把回执提前只是
//      缩短了窗口,消不掉它:服务断在中间,恢复只看意图就会把一份**审查者已经收到**的任务书
//      再发一遍。所以补办之前先核对这一轮同代次的交付凭据,对得上就只结清意图、不重投
//      (判据在 `reviewPromptAlreadyDelivered`)。
//
// 第 3 轮审查指出,上面这套「一份派发一个身份」的假设在**用户重跑同一轮**面前失效,而认领本身
// 还缺一条异常出路:
//
//   ⑨ **身份是「这一轮的这一次」,不是「这一轮」** —— 认领、意图、清理、失败收尾一律按**持久
//      代次**(证据行的 `generation`,`reopenFailedFreeReview` 重跑时换新)隔离。少了这一位:上一次
//      失败的收尾还没放手(它先提交终态,再做哨兵/时间线/工作区清理),用户在那个**合法**窗口里点
//      「继续本轮审查」,新一次派发被旧认领当成重复静默吞掉,接着旧收尾又把新一次刚写下的意图
//      清掉 —— 留下 reviewing + 没有意图 + 没有等待者,只能等下一拍对账按孤儿收尸(第 3 轮审查 F2)。
//   ⑩ **认领必须有异常出路** —— 从认领到「责任交给等待者」之间每一步都可能抛(现读、凭据查询、
//      耗尽收尾、`launchReviewRound` 的整段准备)。抛了不还认领,`armed` 就从「有人负责等待」退化
//      成一条谁都读不懂的真值:对账见它就跳过,库里那份没消费的意图再也没人补办,数据库早就恢复
//      健康也救不回来(第 3 轮审查 F3)。所以归还走 try/finally,判据是「责任有没有真的交出去」。
//   ⑪ **「没派出去」不许冒充「安排好了」** —— 让出要有返回值(`ReviewDispatchOutcome`);用户亲手
//      点出来的那一次还要留一句时间线,否则他只能得出「按钮坏了」(见 `reopenFailedFreeReview`)。
//
// 第 4 轮审查指出 ⑨ 那一位只落在「比两份代次」上,而代次这件事本身还缺一个权威:
//
//   ⑫ **派发权与资源处置权只属于「证据行此刻那一代次」** —— 「不同代次」不等于「更新的代次」。
//      两头都要钉:写意图那一笔在同一条 WHERE 里要求证据行当下就是我这一代(见 `takeIntent`),
//      否则旧的那一次 launch 从长 await 里回来能反向覆盖新一代的意图;而终态之后的**资源处置**
//      (哨兵、待发结果、合并结果审查工作区)全是 run 级的、一个代次都不认,靠的是把「代次闸 +
//      处置」整段与「重跑换代次」互斥(`review-lifecycle-lock.ts`)—— 只在动手前多读一次代次
//      仍然是检查与动作分离,读完到下刀之间隔着仓库锁和 git 命令(第 4 轮审查 F2 实测:旧收尾
//      把新一代刚挂上的哨兵停掉,新一代审查者还在跑,它等的结果再也不会来)。
//
// 第 1 轮(本轮)审查指出 ⑫ 只钉住了**库**那一半,内存认领与真正起跑那两半还各自为政:
//
//   ⑬ **一份派发的所有权必须贯穿「认领 — 准备 — 排队 — 起跑」整条链** —— 三处缺口是同一个
//      根因的三个面:
//       · 认领层原先写着「代次不同就直接接管」。可「不同」不等于「更新」:旧那一次 launch 从
//         长 await 里回来,照样能把新一代的认领挤掉;它随后被库里的权威 CAS 拒掉、按自己刚抢
//         来的 token 归还,删掉的是**它覆盖后**的那一项 —— 新一代从此没有认领,而它原先排的
//         等待者还活着。对账见「有意图、没人盯着」就再排一份(第 1 轮审查问题 1 实测:同一轮
//         invocations 由 1 增到 3,审查者刚提问、还没等到答复)。所以认领改成**纯 test-and-set**:
//         有活认领就抢不到,接管只有一条合法出路 —— **送上一代退场的人定向撤销它那一张**
//         (`supersedeReviewDispatch`,与「一代次退场时由送它退场的人收尾」同一条原则)。
//       · 准备阶段**压根没有认领**:`launchReviewRound` 要走证据行、工作区、HEAD、MCP 预检、
//         任务书重算一长串 await,而 run/round 在它之前就已经是 reviewing。那段时间里对账看到
//         的正是「reviewing + 没有意图 + 没有等待者」= 孤儿的全部特征,于是把一个**活着的准备**
//         收尸(第 1 轮审查问题 2 实测:准备完成后 dispatched=false,再也不会自动开始)。所以
//         认领挪到 launch 的第一行、任何 await 之前,代次待定(`null`)也先占住,读到证据行再
//         `adoptReviewDispatchGeneration` 填上。「有人在准备」从此和「有人在排队」是同一份责任。
//       · 等待者**起跑前不问所有权**:回合锁只回答「此刻谁能跑一轮」,它不认识派发。过期的那一
//         笔照样能在释放点上抢到锁、把作废的任务书送进会话。所以投递前过一道
//         `ownership` 闸(`turn-idle-delivery.ts`):同步问内存认领还是不是我,再问库里那份在途
//         意图此刻属于谁。不是我的 → `superseded`,就地让出,不重排也不落终态。
//
// ## 为什么界是「次数」而不是「时长」
//
// 这一侧等的是**另一个回合跑完**,而回合的时长没有上界(一轮审查几十分钟,duet 的人工裁决门
// 按小时算)。给它一个墙上时钟的截止时间,等于在慢任务身上重新造出原来那个缺陷 —— 审查明明
// 还在合法排队,却被判死。次数才是这里唯一有意义的界:**每一次计数都对应一次真实的锁释放,
// 而我们在那一次里输了**。连输五次说明不是运气而是系统性的(比如一串排队消息在同一个任务上
// 反复抢位),那才值得落终态让用户来看。
//
// ## 与幽灵锁修复的分工
//
// 那一侧(CKjeps4QSRTE)治「赢家占着锁不干活」,这一侧治「输家一次就放弃」。两者独立成立:
// 幽灵修好了,也仍然会有合法的赢家让我们输一次;重排做好了,也仍然需要有人把幽灵锁放开,
// 否则重排等的那次释放永远不来。
import { and, eq, sql } from "drizzle-orm";
import { db } from "./db/index.js";
import { freeReviewRounds, regressionEvidence, type FreeReviewDispatchIntent } from "./db/schema.js";
import { freeReviewEvidenceDir } from "./free-review-files.js";
import { continueWhenIdle } from "./runs.js";
import { appendTaskTimeline } from "./task-timeline.js";
import { now } from "./util.js";

type ContinueOpts = import("./task-continue-options.js").ContinueTaskOptions;

/**
 * 连输几次才放弃把这一轮交出去。
 *
 * 为什么 5 够:每一次计数都对应一次真实的锁释放,而正常现场里同一个释放点上的竞争者是**个位
 * 数**(排队消息投递、队列补推、这一条审查)。输五次意味着每一次释放都有人比我们先注册,那不
 * 是运气,是系统性的,该让用户看见而不是继续静静重排。
 *
 * 可调(`ASH_REVIEW_DISPATCH_ATTEMPTS`):回归要测「次数用尽」那一条,照 `ASH_SUSPECT_TURN_MS`
 * 同一口径从环境读。
 */
export const MAX_REVIEW_DISPATCH_ATTEMPTS = (() => {
  const configured = Number(process.env.ASH_REVIEW_DISPATCH_ATTEMPTS);
  return Number.isInteger(configured) && configured > 0 ? configured : 5;
})();

/** 一张认领证:**哪一次**派发在办这一轮,办到哪一步了。 */
type DispatchClaim = {
  /**
   * 这一轮的**持久代次** —— 证据行(`regression_evidence.generation`)上那个值,
   * `reopenFailedFreeReview` 重跑时换成新的。它就是「这一轮的这一次」的身份。
   *
   * **`null` = 代次待定**:`launchReviewRound` 在读证据行之前就得先占住这一轮(不然那一长串
   * 准备全裸着,见文件头 ⑬ 第二条),而代次要等那一行读出来才知道。读到之后由
   * `adoptReviewDispatchGeneration` 补上,在那之前这张证只说「有人在准备」。
   */
  generation: string | null;
  /** 这张证本身的编号。归还只认它:上一张证归还不了别人后来领的那一张。 */
  token: string;
  /**
   * 办到哪一步了。**两档都算「有人负责」**(`reviewDispatchArmed` 对两者一视同仁)——
   * 分开记只为把现场说清楚:日志里「还在准备」和「排着等窗口」要分得出来,否则查一条
   * 迟迟不开始的审查时读不出它卡在哪一段。
   */
  phase: "preparing" | "queued";
};

/**
 * **本进程此刻还盯着的那些派发** —— key 是「哪条 run 的哪一轮」,值是**这一次**派发的身份。
 *
 * 为什么必须有这张表:`reconcileFreeReviews` 每 30 秒跑一次(`startRegressionSettlementRecovery`),
 * 它看到的「run 是 reviewing + round.dispatch 非空」有两种完全不同的现场:
 *  · 本进程正排着等窗口 —— 碰它就是**重复投递**(同一轮任务书送两遍);
 *  · 上一个进程排着、进程没了 —— 不碰它就**永远没人补办**。
 * 库里那一行分不出这两者(它们长得一模一样),只有「这个进程的内存里还armed 着吗」能分。
 *
 * 为什么值不能只是个布尔:同一轮会被用户重跑(换代次),于是「这一轮有人在办」和「**这一次**
 * 有人在办」不是一件事。只记前者的代价是 F2 那条路 —— 上一次的收尾和新一次的派发互相认错
 * (旧认领吞掉新派发、旧收尾清掉新意图),见文件头 ⑨。
 */
const armed = new Map<string, DispatchClaim>();

let claimSeq = 0;

const keyOf = (runId: string, round: number): string => `${runId}#${round}`;

/**
 * 这条 run 的这一轮,**本进程**是否还盯着它的派发。给对账路径问(见 `armed`)。
 *
 * 「盯着」含**准备阶段**:任务书还在算(工作区、HEAD、MCP 预检)也是在干活,而那一段里库里
 * 还没有意图 —— 不认它的话,对账看到的就是孤儿的全部特征,会把一个活着的准备收尸
 * (文件头 ⑬ 第二条)。
 */
export function reviewDispatchArmed(runId: string, round: number): boolean {
  return armed.has(keyOf(runId, round));
}

/** 这张证**此刻还是这一轮的负责人吗** —— 给起跑前那道所有权闸同步问(文件头 ⑬ 第三条)。 */
export function reviewDispatchOwned(runId: string, round: number, token: string): boolean {
  return armed.get(keyOf(runId, round))?.token === token;
}

/**
 * **抢下「这一轮的这一次派发归我」** —— 同步的 test-and-set,抢到返回认领证编号,没抢到 null。
 *
 * 为什么非得有这一下:补办要重走整个 `launchReviewRound`(证据目录、工作区、MCP 预检、
 * 任务书重算),那是一长串 await。只在开头读一次 `reviewDispatchArmed` 等于没有占位 ——
 * 两个恢复入口(30 秒定时对账、单任务中断恢复、答复提问各有一条路)落在同一段时间里,
 * 都会读到「没人盯着」,各排一份同样的任务书。认领必须排在**任何 await 之前**,所以它是
 * 同步的,也必须就是 `armed` 这同一张表 —— 否则「谁在途」会有两个彼此不同步的答案。
 *
 * **有活认领就抢不到,代次一律不例外**(文件头 ⑬ 第一条)。早先这里写着「代次不同就直接接管」,
 * 理由是「手里那张证属于上一次重跑,它对这一轮再没有任何权限」—— 可那句话只在「来者更新」时
 * 成立:**「不同代次」不等于「更新的代次」**。旧那一次 launch 卡在长 await 里(MCP 预检、任务书
 * 重算),这期间这一轮失败并被重跑,它回来仍以为自己是当事人,于是把新一代的认领挤掉;它随后被
 * 库里的权威 CAS 拒掉、按自己刚抢来的 token 归还 —— 删掉的正是它覆盖后的那一项。新一代从此
 * 没有认领,而它原先排的等待者还活着,对账见「有意图、没人盯着」就再排一份(第 1 轮审查问题 1)。
 *
 * 那么「新一次被旧收尾挡住」(第 3 轮审查 F2)靠什么解?靠**定向撤销**:送上一代退场的人(重跑那
 * 一笔)知道上一代是谁,由它撕掉那一张(`supersedeReviewDispatch`),然后同步抢自己这一张。接管
 * 因此只有一条有权威依据的出路,而不是「谁后来谁有理」。
 *
 * `generation` 传 `null` = **代次待定**的准备占位(见 `DispatchClaim.generation`)。
 */
export function claimReviewDispatch(
  runId: string, round: number, generation: string | null, phase: DispatchClaim["phase"] = "preparing",
): string | null {
  const key = keyOf(runId, round);
  if (armed.has(key)) return null;
  const token = `${generation ?? "preparing"}#${++claimSeq}`;
  armed.set(key, { generation, token, phase });
  return token;
}

/**
 * 准备占位读到证据行了:把**代次**补到自己那张证上。token 已经不是负责人就返回 false ——
 * 调用方据它就地让出(一个字都别写)。
 *
 * 为什么不能默默填上:中间可能正好有一次重跑把这张证撕掉了(`supersedeReviewDispatch` 对
 * 代次待定的证也生效,理由在那边)。那一刻这一次准备已经作废,拿新代次填上去就等于冒充现任,
 * 接着会和重跑自己那一份各送一份任务书。
 */
export function adoptReviewDispatchGeneration(
  runId: string, round: number, token: string, generation: string,
): boolean {
  const held = armed.get(keyOf(runId, round));
  if (held?.token !== token) return false;
  held.generation = generation;
  return true;
}

/**
 * **送上一代退场的人撕掉它那张认领证** —— 接管的唯一合法出路(见 `claimReviewDispatch`)。
 *
 * 只有重跑那一笔能调:它在同一把生命周期锁里、同一笔事务里把证据行换成了新代次,所以「上一代
 * 是谁」在它手上是**权威**而不是猜测。撕完要在**同一段同步代码**里抢下自己那一张 —— 中间插进
 * 任何 await,就又开出一个「谁都没在负责」的窗口给对账收尸。
 *
 * **代次待定的那种证也一并撕掉**:它的持有者还没读到证据行,放着不动的话它随后读到的会是
 * **新**代次、以现任身份继续准备,于是重跑自己那一份和它各送一份任务书。它的 `adopt` 会在那
 * 一刻失败,就地让出(那条出路就是为这里留的)。
 */
export function supersedeReviewDispatch(runId: string, round: number, generation: string): boolean {
  const key = keyOf(runId, round);
  const held = armed.get(key);
  if (!held || (held.generation !== null && held.generation !== generation)) return false;
  armed.delete(key);
  return true;
}

/** 准备完了、排进回合锁的等待队列了:相位往前走一格(见 `DispatchClaim.phase`)。 */
function markReviewDispatchQueued(runId: string, round: number, token: string): void {
  const held = armed.get(keyOf(runId, round));
  if (held?.token === token) held.phase = "queued";
}

/**
 * 认领了却没把责任交出去(准备阶段抛了、或者这一轮已经不归我们办):**还回去**,
 * 否则这一轮在本进程里永远「在途」(文件头 ⑩)。
 *
 * 只还自己那一张:中间若已经有新一次派发接管了这一轮,它那张证不能被上一次的收尾撕掉。
 */
export function releaseReviewDispatchClaim(runId: string, round: number, token: string): void {
  const key = keyOf(runId, round);
  if (armed.get(key)?.token === token) armed.delete(key);
}

/**
 * 写下/刷新这一轮的派发意图 —— **按版本 CAS**,不是无条件覆盖。
 *
 * `from` 是「我手里这份快照说库里现在是第几次」(第一次派发传 null = 库里应当还没有意图)。
 * 这一位是整条链唯一的持久不变量:**同一份在途意图只许被消费一次**。内存认领
 * (`claimReviewDispatch`)证不了这件事 —— 它只能证明「本进程此刻没有第二个人在办」,
 * 而对账那一侧是先读 round 快照、再 await 几次才走到补办的:先到的一份完全可以在这期间
 * 把任务书送出去、把意图清掉、把内存认领也放掉,后到的那一份才从 await 里回来。它手里的
 * 快照仍然写着 `attempts: 1`,于是无条件写回去 = 把一条**已经办完**的意图凭空重建,接着
 * 再排一份完整任务书(第 2 轮审查 F1 实测:审查者刚提了问题还没等到答复,第二份任务书就
 * 开了一条新会话)。CAS 之后那一份会在这里输掉,就地让出。
 *
 * `attempts` 当版本够用:它只增不减,而同一轮上的意图只有这一条链在推进 —— 前提是「同一条链」。
 * 用户重跑同一轮就会换一条链,所以条件里还要带上**代次**:第一次交出去(`from === null`)只在
 * 库里没有意图、或者挂着的是**上一代次**的残留时才算抢到;重排(`from` 非空)则必须是我们这一代、
 * 这一版。少了代次这一位,上一次重跑遗留的意图会把新一次的第一次写挡成「别人办过了」,或者
 * 反过来被新一次悄悄覆盖(第 3 轮审查 F2)。老意图(加这一位之前写下的)没有代次,按版本放行。
 *
 * **「不同代次」不等于「更新的代次」**(第 4 轮审查 F2):光比意图上那一位,方向是反的也照样放行
 * —— 旧的那一次 launch 在读完证据行之后卡住(MCP 预检、任务书重算都是长 await),这一轮期间失败
 * 并被重跑,它从 await 里回来仍然以为自己是当事人,于是把新一代写下的意图覆盖掉。所以条件里还
 * 要钉住**权威**那一份:证据行此刻的代次就得是我这一代。它跟上面两问同在一条 UPDATE 的
 * WHERE 里,所以不存在「核完又变」—— 派发权只属于**证据行此刻那一代次**。
 *
 * 三种回答要分开,**别把库写不下来算成「别人办了」**:
 *  · `taken`      —— 这一版归我了;
 *  · `lost`       —— 库里已经不是那一版(别人办过了 / 轮次落了终态):让出,不投递也不落终态;
 *  · `unwritable` —— 库写不下来。同进程的等待者是活的,所以照旧排(行为与改之前一致);欠的是
 *    「跨重启还能补办」与「放弃时说得出排了几次」。这一档**不再闷着**:调用侧写一句时间线把
 *    降级说清(见 `dispatchReviewRound` 的 `warnedUnwritable`)—— 时间线落在会话文件上,跟库是
 *    两个故障域,库写不下来时它大概率还写得进去。
 */
type IntentTake = "taken" | "lost" | "unwritable";

async function takeIntent(
  runId: string, round: number, generation: string, from: number | null, intent: FreeReviewDispatchIntent,
  /** 这一轮的证据目录:代次的**权威**那一份在它那行上(见上面「不同代次 ≠ 更新代次」)。 */
  directory: string,
): Promise<IntentTake> {
  // `json_extract` 在「没有意图」和「老意图没这一位」两种现场都给 NULL,所以这里一律用
  // SQLite 的 `IS` / `IS NOT`(对 NULL 也成立),别换成 `=`:那样两种现场会静静地都不匹配。
  const mine = sql`json_extract(${freeReviewRounds.dispatch}, '$.generation')`;
  try {
    const taken = await db.update(freeReviewRounds).set({ dispatch: intent })
      .where(and(
        eq(freeReviewRounds.runId, runId),
        eq(freeReviewRounds.round, round),
        // 落了终态的轮次不接受在途意图:写进去等于让对账去补投一条已经宣告结束的审查。
        eq(freeReviewRounds.status, "reviewing"),
        // 权威代次:证据行此刻就得是我这一代,否则我是上一次重跑的迟到者。
        sql`exists (select 1 from ${regressionEvidence} where ${regressionEvidence.directory} = ${directory}
          and ${regressionEvidence.generation} = ${generation})`,
        from === null
          ? sql`${mine} is not ${generation}`
          : and(
            sql`json_extract(${freeReviewRounds.dispatch}, '$.attempts') = ${from}`,
            sql`(${mine} is ${generation} or ${mine} is null)`,
          ),
      ))
      .returning({ id: freeReviewRounds.id });
    return taken.length ? "taken" : "lost";
  } catch (error) {
    console.error(`[ash] 审查派发意图落库失败 run=${runId} round=${round}:`, error);
    return "unwritable";
  }
}

/**
 * 这一轮的派发有了结局(送进会话了,或者次数用尽放弃了):意图到此了结。
 *
 * 不返回成败:清不掉**不改变任何人的下一步**(理由见 `settled`),写失败只记日志。
 *
 * **只清自己那一行**(run+round),不按 taskId 扫:同一个任务上同时只有一条审查链在跑,但
 * 对账路径可能正拿着另一轮的快照在手里。
 *
 * 给了 `generation` 就**只清自己那一代次**:同一轮会被用户重跑,上一次的收尾无条件清,清掉的
 * 就是新一次刚写下的意图 —— 那一轮随后既没有等待者也没有意图,只能等对账按孤儿收尸
 * (第 3 轮审查 F2)。老意图没有代次,照旧清(那时整条链只有一代)。
 *
 */
export async function clearReviewDispatchIntent(
  runId: string, round: number, generation?: string,
): Promise<void> {
  const mine = sql`json_extract(${freeReviewRounds.dispatch}, '$.generation')`;
  return await db.update(freeReviewRounds).set({ dispatch: null })
    .where(and(
      eq(freeReviewRounds.runId, runId), eq(freeReviewRounds.round, round),
      ...(generation ? [sql`(${mine} is ${generation} or ${mine} is null)`] : []),
    ))
    .then(() => undefined)
    .catch((error) => {
      console.error(`[ash] 审查派发意图清理失败 run=${runId} round=${round}:`, error);
    });
}

export type ReviewDispatch = {
  taskId: string;
  /** 这一轮属于哪条审查链的第几轮 —— 意图的身份就是这两样。 */
  run: { id: string; currentRound: number };
  /** 界面上怎么称呼这一轮(「自由工作流第 2 轮」/「合并结果」),只进时间线措辞。 */
  label: string;
  /** 送进会话的那段话。重排原样重放它 —— 同进程里不必、也不该重算。 */
  message: string;
  opts: ContinueOpts;
  /** 跨重启补办要原样重放的三个入参(见 `FreeReviewDispatchIntent`)。 */
  resumeSessionId?: string | null;
  retry?: boolean;
  freshSession?: boolean;
  /** 已经输过几次(补办时从库里读回来);缺省 0 = 这是第一次交出去。 */
  attempts?: number;
  /** 第一次交出去的时刻(补办时沿用库里那个,别把等待时长重置掉)。 */
  since?: string;
  /**
   * 这一轮的**持久代次**(证据行的 `generation`)—— 认领、意图、清理、失败收尾的共同身份。
   * 由 `launchReviewRound` 从证据行上读来:只有它手里同时握着 run、轮次与那一行。
   */
  generation: string;
  /**
   * 调用方**已经领过证了**(`claimReviewDispatch` 的返回值)。现在所有入口都走这条:认领必须
   * 排在 `launchReviewRound` 那一长串准备之前,等到这里就把整个准备阶段裸在外面(文件头 ⑬
   * 第二条)。这里只核一句「它还是不是负责人」—— 中间可能已经被一次重跑定向撤销掉。
   */
  claimToken?: string;
  /** 这一轮彻底起不来了,按原路收尾(`failReviewStart`)。 */
  onFail: (message: string) => Promise<unknown>;
};

/**
 * 这一次调用到底把任务书排出去了没有。
 *
 * **让出不许冒充安排好了**(文件头 ⑪):调用方据它决定要不要跟用户交代一句 —— 用户亲手点的
 * 那一次若被静静吞掉,他看到的就是「点了没反应,三十秒后变成失败」(第 3 轮审查 F2)。
 *  · `dispatched`  —— 已经排进回合锁的等待队列,责任(连认领证一起)归派发层;
 *  · `handed-off`  —— 这一轮的这一次不归我们办,一个字都没写,认领证已经还掉。
 */
export type ReviewDispatchOutcome = "dispatched" | "handed-off";

/**
 * 把这一轮的任务书交给回合锁,**抢不到就重排**,直到送进会话或者次数用尽。
 *
 * 同步返回(与 `continueWhenIdle` 一样是「排进去就回来」):第二段的结局通过 `onFail` 与时间线
 * 交代,调用方不等它。
 */
export async function dispatchReviewRound(dispatch: ReviewDispatch): Promise<ReviewDispatchOutcome> {
  const { taskId, run, label, generation } = dispatch;
  const since = dispatch.since ?? now();
  let attempts = dispatch.attempts ?? 0;
  /** 库里此刻该是哪一版在途意图 —— 每一次写都按它做 CAS(见 `takeIntent`)。 */
  let expected: number | null = dispatch.attempts ?? null;
  /** 「意图没存进库」这句话说过了没有(重排会反复走到那里)。 */
  let warnedUnwritable = false;

  // **这一轮的这一次派发归谁** —— 同步领证,排在任何 await 之前(所以也排在任何库写之前:对账
  // 区分「该补投」与「别碰」靠的就是「库里有意图」与「内存里有人盯着」这一对线索,反过来
  // 写就会开出一个两边都说「没人在途」的窗口)。领不到 = 真有人在办这一轮。
  //
  // 调用方带着证进来的(现在是常态),这里只核一句**它还是不是负责人**:从它领证到这里之间隔着
  // 整个准备阶段,中途完全可能有一次重跑把它定向撤销掉(`supersedeReviewDispatch`)。不核就会
  // 以作废的身份往下写意图、排等待者 —— 而真正的现任也在办同一轮。
  const token = dispatch.claimToken ?? claimReviewDispatch(run.id, run.currentRound, generation, "queued");
  if (!token) {
    console.error(`[ash] ${label}派发让出 task=${taskId} run=${run.id}：这一轮已经有在途派发`);
    return "handed-off";
  }
  if (!reviewDispatchOwned(run.id, run.currentRound, token)) {
    console.error(`[ash] ${label}派发让出 task=${taskId} run=${run.id}：手里这张认领证已经被撤销（这一轮期间被重跑成另一次）`);
    return "handed-off";
  }

  /**
   * 这一轮的派发收摊 —— **先清库、再放内存**,顺序是这两步的全部要点。
   *
   * 「库里挂着意图」和「内存里有人盯着」是对账区分「该补投」与「别碰」的唯一一对线索
   * (`reviewDispatchRecovery`)。反过来写就会开出一个两边都说「没人在途」的窗口:对账的 30 秒
   * 定时器正好落在里面,就会对着一条**刚刚送进会话**的审查再投一次任务书。
   *
   * **清库失败也照样放手**(原先是「不清掉就不放」):那条分支留下的正是文件头 ⑩ 要除掉的东西
   * —— 一张没有活负责人的认领证,对账见它就跳过这一轮,再也没人补办。而「别重复投递」这件事
   * 现在有更硬的担保:送进会话那一刻落下的**持久交付凭据**(`reviewPromptAlreadyDelivered`),
   * 补办据它只结清意图、不重投;放弃那一路更不用担心,终态与清意图同在一个事务里,而落了终态
   * 的轮次压根没有补投资格(`takeIntent` 的 `status='reviewing'`、`redeliverReviewRound` 的
   * 现读)。内存那张证从此只回答「此刻有没有活负责人」这一件事。
   */
  const settled = async (): Promise<void> => {
    await clearReviewDispatchIntent(run.id, run.currentRound, generation);
    releaseReviewDispatchClaim(run.id, run.currentRound, token);
  };

  /** 这一轮不归我们办了(在途意图已经不是手里那一份):认领还回去,一个字都不写。 */
  const handOff = (why: string): ReviewDispatchOutcome => {
    releaseReviewDispatchClaim(run.id, run.currentRound, token);
    console.error(`[ash] ${label}派发让出 task=${taskId} run=${run.id}：${why}`);
    return "handed-off";
  };

  const giveUp = async (message: string, failure: string): Promise<void> => {
    // **先落终态、再了结意图**:`failReviewStart` 把 round/run 的终态与 `dispatch=null` 写在
    // 同一个事务里,所以让它先走;这里的 `settled` 随后只负责收掉内存那一半(清库成了空操作)。
    // 反过来(先清意图)会开出一个「意图没了、终态还没写」的中断窗口 —— 放弃的次数和原因
    // 一起丢掉,这一轮只剩对账那句通用的「未能正常给出结论」(第 2 轮审查的不拦验收事项)。
    // `settled` 放在 finally 里:`onFail`(= `failReviewStart`)抛出来的话,认领证不还就等于把
    // 这一轮永久锁在「在途」上(文件头 ⑩)。终态那一笔已经自己带事务,这里只收内存那一半。
    try {
      await dispatch.onFail(message);
    } finally {
      await settled();
    }
    console.error(`[ash] ${label}派发放弃 task=${taskId} run=${run.id} attempts=${attempts}: ${failure}`);
  };

  /**
   * **起跑前的最后一道闸**(交给 `continueWhenIdle`,拿到回合锁之后才问):这一笔交接此刻还归
   * 我们吗。返回理由 = 不归了。
   *
   * 两问各管一半,缺一边都挡不住(文件头 ⑬ 第三条):
   *  · 内存那张认领证还是不是我 —— 重跑定向撤销、或者同一轮的另一次接手,这一问当场就知道;
   *  · 库里那份在途意图此刻属于哪一代 —— 跨进程(两个服务共用一个库)时内存那张证说不出话,
   *    而意图上的代次是持久事实。
   *
   * **意图为 null 不算「不归我」**:写意图落库失败(`unwritable`)时库里压根没有这一份,而同进程
   * 的等待者仍然是活的 —— 那一档的降级早就说明过(照旧投递,只丢跨重启补办)。在这里拒掉它就
   * 等于把一次写库故障升级成「这一轮不投了」。
   */
  const ownershipGate = async (): Promise<string | null> => {
    if (!reviewDispatchOwned(run.id, run.currentRound, token)) {
      return "这一轮的派发已经换了负责人（这一次被重跑成另一次，或者另一条恢复接手了同一份意图）";
    }
    const current = (await db.select({ status: freeReviewRounds.status, dispatch: freeReviewRounds.dispatch })
      .from(freeReviewRounds)
      .where(and(eq(freeReviewRounds.runId, run.id), eq(freeReviewRounds.round, run.currentRound)))).at(0);
    if (!current) return null;
    if (current.status !== "reviewing") return "这一轮已经落了终态，任务书不再投递";
    const holder = current.dispatch?.generation;
    return holder && holder !== generation
      ? "库里那份在途意图已经属于这一轮的另一次（这一轮期间被重跑过）"
      : null;
  };

  const hand = async (): Promise<ReviewDispatchOutcome> => {
    const next = attempts + 1;
    const taken = await takeIntent(run.id, run.currentRound, generation, expected, {
      attempts: next, since, resumeSessionId: dispatch.resumeSessionId ?? null, retry: dispatch.retry,
      freshSession: dispatch.freshSession, generation,
    }, freeReviewEvidenceDir(taskId, run.id, run.currentRound));
    if (taken === "lost") {
      return handOff("在途意图已经不是我们手里那一份（这一轮已经被办过了，或者这一轮已经被重跑成另一次）");
    }
    attempts = next;
    if (taken === "taken") expected = next;
    // **落不下来就说一句**:同进程的等待者仍然是活的,所以照旧排(这一支的行为与改之前一致);
    // 丢掉的是「跨重启还能补办」那条担保 —— 此刻服务一断,这一轮就只剩库里一个 reviewing。
    // 时间线落在会话文件上,跟库是两个故障域,所以库写不下来时它大概率还写得进去。只说一次:
    // 重排会反复走到这里,每次都说等于把真问题埋进刷屏里。
    if (taken === "unwritable" && !warnedUnwritable) {
      warnedUnwritable = true;
      await appendTaskTimeline(taskId,
        `${label}的任务书正在等一个空闲回合窗口，但这一轮的派发意图没能存进库里（写库失败，`
        + `详情在服务日志）。等待本身照旧有效；只是服务若在送出去之前重启，这一轮不会被自动补投，`
        + `需要你手动再开一轮。`);
    }
    // 排进等待队列之前把相位标成「排着」:准备阶段到此结束(两档都算有人负责,分开记只为
    // 日志读得出它卡在哪一段)。
    markReviewDispatchQueued(run.id, run.currentRound, token);
    continueWhenIdle(taskId, dispatch.message, dispatch.opts, async (message, failure) => {
      // **整段包在异常出路里**:这是回合锁回调上的一段,抛出去只会变成一条没人接的 rejection
      // (抢占那一支不等它),而认领证跟着漏掉的话,这一轮在本进程里就永远「在途」—— 对账见
      // `armed` 即跳过,库里那份没消费的意图再也没人补办(文件头 ⑩)。还掉证反而全身而退:
      // 意图还在库里,下一拍对账照样能补办。
      try {
        // **不归我们了 ≠ 办不成**:起跑前那道所有权闸说这一笔已经过期(用户重跑了这一轮、或者
        // 另一条恢复接手了同一份意图)。重排只会把同一笔作废的交接再排一遍,落终态更糟 ——
        // 打死的是**现任**那一次。就地让出:不写意图、不动终态、把自己那张证还掉(已被撤销的
        // 话这一下是空操作,撤不掉别人后来领的那张)。
        if (failure === "superseded") return void handOff(message);
        // 瞬时以外的几种(撤回 / continueTask 答了没送出去 / 抛错)照旧落终态:它们不是「这一刻
        // 轮不到我们」,重排只会把同一个拒绝理由再撞一遍,而撤回那一种还会磨掉用户的决定。
        if (failure !== "turn-taken") return await giveUp(message, failure);
        if (attempts >= MAX_REVIEW_DISPATCH_ATTEMPTS) {
          return await giveUp(
            `${message}；已连续重排 ${attempts} 次（每次都在回合锁的释放点上被其它执行先抢到），不再重试`,
            failure,
          );
        }
        // 留痕排在重排**之前**:重排是同步排进等待队列的,排完下一次失败可能立刻就到,先写时间线
        // 才保证顺序读得通。
        await appendTaskTimeline(taskId,
          `${label}的任务书还没能送进会话：回合锁在释放点上被其它执行先抢到（第 ${attempts} 次）。`
          + `已重新排到下一个空闲窗口，不需要你动手；连续 ${MAX_REVIEW_DISPATCH_ATTEMPTS} 次都抢不到才会停下来。`);
        await hand();
      } catch (error) {
        releaseReviewDispatchClaim(run.id, run.currentRound, token);
        console.error(`[ash] ${label}派发重排出错 task=${taskId} run=${run.id}（认领已归还，`
          + `库里的意图留着等下一拍对账补办）:`, error);
      }
    }, async () => {
      // 真的送进会话了 —— 意图到此了结。这一声取在**原话落盘**那一刻(而不是整轮跑完,
      // 理由在 `continueWhenIdle` 的 `onDelivered` 上):取后者的话,这一轮审查跑着的几十
      // 分钟里库里都挂着意图,服务在中间断掉,新进程就会对一条**已经执行过**的审查整份重投。
      await settled();
    }, ownershipGate);
    // 排进等待队列了 = 责任（连那张认领证一起）归派发层：它在投递成功、放弃、让出时各自了结。
    return "dispatched";
  };

  try {
    return await hand();
  } catch (error) {
    // 领了证却没能把责任交给等待者(库写不下来以外的任何一步抛了):**证必须还回去**。
    // 不还的话对账只看见 `armed` 就跳过这一轮,库里那份没消费的意图再也没人补办(文件头 ⑩)。
    releaseReviewDispatchClaim(run.id, run.currentRound, token);
    throw error;
  }
}

/**
 * 上一个进程死在「交出去了、还没送进会话」中间的那些轮次 —— 这一轮该怎么办。
 *
 * 四档,每一档对应一个**不同的动作**,合并任意两档都会出事:
 *
 *  · `none`      —— 压根没有在途意图(普通审查)。调用方照原路往下走。
 *  · `in-flight` —— 有意图,而且**本进程还盯着它**:它正排在回合锁的等待队列里等下一个空闲
 *    窗口。既不该补投(同一轮任务书送两遍),**也不该收尸** —— 这一条当初并进 `none` 过,于是
 *    合法排队中的审查落回对账的通用收尸路,约 30 秒后自己 failed、自动链照样断在那里
 *    (第 1 轮审查 F1)。「有人负责等待」不等于「没有在途工作」。
 *  · `redeliver` —— 有意图、没人盯着(= 上一个进程没了):补投一次。
 *  · `exhausted` —— 同上,但次数已经用尽:落终态,并且**说得出一句理由**。并进 `none` 的话这
 *    一轮会落回通用收尸路,用户只看到「审查未能正常给出结论」—— 而真相是「任务书连一次回合
 *    窗口都没抢到」,两句话对他下一步该做什么的指示完全不同。
 *
 * **判词不带意图本体**:调用方拿到 `redeliver` 之后必须自己去库里现读那一份(见
 * `redeliverReviewRound`)。这是故意的 —— 传进来的 `intent` 来自一份快照,而从读到快照到真正
 * 动手之间隔着好几次 await,把它当真就是第 2 轮审查 F1 那条路(已经办完的意图被旧快照重建)。
 *
 * 判据故意不含「任务忙不忙」:那一问由 `reconcileFreeReviews` 在它自己那一串判据里回答过了
 * (reviewer 还活着就压根走不到这里)。
 */
export type ReviewDispatchRecovery = "none" | "in-flight" | "redeliver" | "exhausted";

/** 单看这一份意图该怎么办(不问「有没有人盯着」)。认领之后按**库里现读的那一份**问它。 */
export function reviewDispatchVerdict(
  intent: FreeReviewDispatchIntent | null | undefined,
): "none" | "redeliver" | "exhausted" {
  if (!intent) return "none";
  return intent.attempts < MAX_REVIEW_DISPATCH_ATTEMPTS ? "redeliver" : "exhausted";
}

export function reviewDispatchRecovery(
  runId: string, round: number, intent: FreeReviewDispatchIntent | null | undefined,
): ReviewDispatchRecovery {
  if (!intent) return "none";
  if (reviewDispatchArmed(runId, round)) return "in-flight";
  return reviewDispatchVerdict(intent);
}
