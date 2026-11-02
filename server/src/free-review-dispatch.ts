// 「这一轮审查的任务书到底送进会话了没有」—— 派发这一问收在这个文件里:**怎么交出去、抢不到
// 怎么重排**。「谁在负责」那两张账(内存认领证 + 库里那份在途意图 + 交付凭据)与它们各自的 CAS
// 住在 `free-review-responsibility.ts`(贴着 700 行上限时按职责切的,老使用方照旧从这里 import)。
// 下面这套不变量是**整条协议**的,两份文件都按它办事,所以只留这一份。
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
//         收尸(第 1 轮审查问题 2 实测:准备完成后 dispatched=false,再也不会自动开始)。
//         「有人在准备」从此和「有人在排队」是同一份责任(`DispatchClaim.phase` 两档都算)。
//       · 等待者**起跑前不问所有权**:回合锁只回答「此刻谁能跑一轮」,它不认识派发。过期的那一
//         笔照样能在释放点上抢到锁、把作废的任务书送进会话。所以投递前过一道
//         `ownership` 闸(`turn-idle-delivery.ts`):同步问内存认领还是不是我,再问库里那份在途
//         意图此刻属于谁。不是我的 → `superseded`,就地让出,不重排也不落终态。
//
// 第 2 轮审查指出 ⑬ 把认领挪到 launch 第一行只补住了**本进程内**那一段,而「有人负责」这件事
// 本身还只活在内存里:
//
//   ⑭ **责任要先登记、才许公开这一轮,而且登记的那一份必须是持久的** —— 公开 reviewing 与
//      「谁负责」之间不许有任何缝,包括跨进程那一道:
//       · 持久的那一半是 round 行上的 `dispatch`(`preparingReviewDispatch`),和公开 reviewing
//         同在一笔写里落下。非空 = 这一轮有人负责,孤儿路一律不许收(`reviewOrphanStillUnowned`);
//         上一个进程死在准备阶段的那一种,由 `redeliverReviewRound` 照补投重走一遍 —— 「死在
//         准备」和「死在排队」本来就是同一回事。没有它,对账只要落在「读完 armed」与「下笔」
//         之间,活着的准备照样被收尸(第 2 轮审查问题 2 复现 B,零故障注入),重启之后更没人补办。
//       · 认领因此由**公开这一轮的人**同步领下(三条入口:即时派审、升轮、重跑),领证的人负责
//         还证;`launchReviewRound` 不再自己领,只核一句「这张证还是不是负责人」。代次也随之
//         先有后公开,所以认领证上的代次不再有「待定」这一档。
//       · 孤儿结算的落笔条件里要带上**同一份持久责任**(`SettlementFence.review`):它的前提就是
//         「此刻没有任何派发责任」,那就让这句话在提交那一刻自己成立 —— 否则「检查完再动手」
//         之间那段 await 里谁都可以合法接手,而拿任务 epoch 去核是答另一个问题(准备责任不
//         增长 epoch)。
//
// 第 1 轮(本轮)审查指出 ⑦⑧ 那一对(「同一份意图只许消费一次」+「已交付的不许重投」)只在
// **库**那一半成立,而「有没有交付过」这件事仍然可以由一份快照来回答:
//
//   ⑮ **「这一份任务书送到过没有」只认权威现读,而且要和「准许排队」同在一笔写里** ——
//      次数 CAS 只证得了「库里现在还是这一版」,证不了「这一份没送过」。清意图那一步失败时
//      (`settled` 刻意不因此卡住,见那里),库里那份**已经交付过**的意图原样留着,于是慢一份
//      恢复的 CAS 会从 2 正常地走到 3 —— 它根本不会输。真正的判据是交付凭据
//      (`commitReviewTurnDelivery` 落的 `waitOwnership.deliveredReview`),所以:
//       · 判据只有一份(`reviewPromptDelivered` / `takeIntent` 的 WHERE 共用同两个
//         `json_extract`),三处读它:补投前的早筛、**写意图那一笔的 WHERE**、起跑前的所有权闸;
//       · 补投那一侧**不收任何 task 快照**(`redeliverReviewRound` 只收 taskId,自己现读)——
//         调用方那份 task 是好几次 await 之前读的,拿它授权就是第 1 轮审查问题 1 那条路:
//         快照里回执为 null、库里非空且同代次,于是对一条**审查者已经读过**的任务书再排一份
//         完整的,审查者刚登记了问题还没等到答复,第二条会话已经起来了;
//       · 早筛只是省掉一整段准备,**不是幂等的来源** —— 幂等由那一笔写自己的 WHERE 担保。
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
import { and, eq } from "drizzle-orm";
import { db } from "./db/index.js";
import { freeReviewRounds, type FreeReviewDispatchIntent } from "./db/schema.js";
import { freeReviewEvidenceDir } from "./free-review-files.js";
// 「谁在负责」那两张账(内存认领证 + 库里那份在途意图)住在 free-review-responsibility.ts ——
// 切出去的理由与切口见那份文件的头部。**老使用方照旧从这里 import**:下面原样转出去。
import {
  claimReviewDispatch, clearReviewDispatchIntent, markReviewDispatchQueued,
  releaseReviewDispatchClaim, reviewDispatchArmed, reviewDispatchOwned,
  reviewPromptDelivered, takeIntent,
} from "./free-review-responsibility.js";
import { continueWhenIdle } from "./runs.js";
import { appendTaskTimeline } from "./task-timeline.js";
import { now } from "./util.js";

export {
  claimReviewDispatch, clearReviewDispatchIntent, preparingReviewDispatch,
  releaseReviewDispatchClaim, reviewDispatchArmed, reviewDispatchOwned,
  reviewPromptDelivered, supersedeReviewDispatch,
} from "./free-review-responsibility.js";

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
   * 三问各管一摊,缺一边都挡不住(文件头 ⑬ 第三条、⑮):
   *  · 内存那张认领证还是不是我 —— 重跑定向撤销、或者同一轮的另一次接手,这一问当场就知道;
   *  · 库里那份在途意图此刻属于哪一代 —— 跨进程(两个服务共用一个库)时内存那张证说不出话,
   *    而意图上的代次是持久事实;
   *  · **这一份任务书送到过没有** —— 内存认领在跨进程时是哑的,而两个进程各有一条等待者排在
   *    同一轮上时,先到的那一条交付完就把意图清了:后到的这一条读到「意图为 null」,而那一档
   *    刻意不算「不归我」(下一段),于是整份任务书会被送第二遍。凭据是持久的,问它才问得准。
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
    if (holder && holder !== generation) {
      return "库里那份在途意图已经属于这一轮的另一次（这一轮期间被重跑过）";
    }
    // 排在最后:上面两问都说「还归我」,但这一份可能**已经送到过**了(另一个进程的等待者先
    // 交付完、把意图清掉;或者清意图那一笔失败、凭据却已经落下)。让出而不是落终态 ——
    // 这一轮此刻很可能正跑着,打终态打死的是**正在干活**的那一次。
    return await reviewPromptDelivered(taskId, freeReviewEvidenceDir(taskId, run.id, run.currentRound), generation)
      ? "这一轮的任务书已经送进会话了（交付凭据已确认），不再投递第二份"
      : null;
  };

  const hand = async (): Promise<ReviewDispatchOutcome> => {
    const next = attempts + 1;
    const taken = await takeIntent(run.id, run.currentRound, generation, expected, {
      attempts: next, since, resumeSessionId: dispatch.resumeSessionId ?? null, retry: dispatch.retry,
      freshSession: dispatch.freshSession, generation, phase: "queued",
    }, freeReviewEvidenceDir(taskId, run.id, run.currentRound), taskId);
    if (taken === "lost") {
      return handOff("在途意图已经不是我们手里那一份（这一份任务书已经送到过，这一轮已经被办过了，"
        + "或者这一轮已经被重跑成另一次）");
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
        // 瞬时以外的几种照旧落终态:撤回(磨掉用户的决定)、退避(原地再撞同一个拒绝理由)、
        // 交付说不清(一个字都不许重投)、抛错。**它们各自带着自己那句话**(分档表在
        // `turn-idle-delivery.ts` 的 `DELIVERY_FAILURE`),所以终态上写的是真实原因,不再是
        // 一句统一的「被其它执行抢占」—— 尤其 `uncertain` 那一档绝不许说「一个字都没送出去」。
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
