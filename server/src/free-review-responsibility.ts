// 「这一轮审查的这一次派发,**谁在负责**」—— 这一问的两张账收在这个文件里。
//
// 从 `free-review-dispatch.ts` 切出来的原因:那份文件补上「交付凭据」那一道之后越过了仓库的
// 700 行上限。切口按职责走,不是按行数凑 —— 这边回答**谁在负责、还轮不轮得到他**(两张账加
// 它们各自的 CAS),那边回答**怎么把任务书交出去、抢不到怎么重排**。
//
// 两张账各管一半,缺一边都挡不住(整段理由在 `free-review-dispatch.ts` 文件头 ⑤⑦⑨⑩⑫⑬⑭⑮,
// 这里不复述):
//
//  · **内存认领证**(`armed`)—— 同步 test-and-set,答得出「**本进程**此刻有没有人在办这一轮」。
//    它必须是同步的:补办要重走一长串 await,只在开头读一次等于没有占位。
//  · **库里那份在途意图**(round 行上的 `dispatch`)—— 持久,跨进程、跨重启都算数;每一次写都是
//    一次按版本的 CAS(`takeIntent`),版本就是 `attempts`。
//  · 外加一条**凭据**:任务书送进会话那一刻落下的 `waitOwnership.deliveredReview`。它是
//    「这一份送过没有」的唯一权威 —— 次数 CAS 答不了这一问(清意图失败时,已交付的那一份
//    意图原样留着,慢一份恢复的 CAS 会正常地往下走一版)。
//
// **老使用方照旧从 `free-review-dispatch.js` import**:那边把这里的导出原样转出去。依赖是
// 单向的(本文件不认识那边),所以不成环。
import { and, eq, sql } from "drizzle-orm";
import { db } from "./db/index.js";
import { freeReviewRounds, regressionEvidence, tasks, type FreeReviewDispatchIntent } from "./db/schema.js";

/** 一张认领证:**哪一次**派发在办这一轮,办到哪一步了。 */
type DispatchClaim = {
  /**
   * 这一轮的**持久代次** —— 证据行(`regression_evidence.generation`)上那个值,
   * `reopenFailedFreeReview` 重跑时换成新的。它就是「这一轮的这一次」的身份。
   *
   * 领证的时候就一定知道它(文件头 ⑭ 第二条):公开这一轮之前先建证据行、再领证,所以不存在
   * 「证已经领了、代次还没读到」那一档 —— 原先那张「代次待定」的占位证连带它的 `adopt`
   * 一起去掉了。
   */
  generation: string;
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
 * **领它的人是公开这一轮的那一个**(文件头 ⑭ 第二条),所以代次此刻一定已经知道了,而且领证要
 * 排在「公开 reviewing」那一笔写之前 —— 反过来写就会留下一段「库里已经 reviewing、谁都没在
 * 负责」的时间,那正是孤儿收尸的全部依据。
 */
export function claimReviewDispatch(
  runId: string, round: number, generation: string, phase: DispatchClaim["phase"] = "preparing",
): string | null {
  const key = keyOf(runId, round);
  if (armed.has(key)) return null;
  const token = `${generation}#${++claimSeq}`;
  armed.set(key, { generation, token, phase });
  return token;
}

/**
 * **送上一代退场的人撕掉它那张认领证** —— 接管的唯一合法出路(见 `claimReviewDispatch`)。
 *
 * 只有重跑那一笔能调:它在同一把生命周期锁里、同一笔事务里把证据行换成了新代次,所以「上一代
 * 是谁」在它手上是**权威**而不是猜测。撕完要在**同一段同步代码**里抢下自己那一张 —— 中间插进
 * 任何 await,就又开出一个「谁都没在负责」的窗口给对账收尸。
 *
 * **只撕上一代那一张**:认领证上的代次自领证那一刻就定下来了(文件头 ⑭ 第二条),所以这里不必
 * 再照顾「代次待定」那一档 —— 它已经不存在。撕不掉(手里那张属于别人)就返回 false,调用方据它
 * 知道自己没能接管。
 */
export function supersedeReviewDispatch(runId: string, round: number, generation: string): boolean {
  const key = keyOf(runId, round);
  const held = armed.get(key);
  if (held?.generation !== generation) return false;
  armed.delete(key);
  return true;
}

/** 准备完了、排进回合锁的等待队列了:相位往前走一格(见 `DispatchClaim.phase`)。 */
export function markReviewDispatchQueued(runId: string, round: number, token: string): void {
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
 * **公开 reviewing 那一笔里一起落下的「有人负责」** —— 准备阶段持久的那一半(文件头 ⑭)。
 *
 * 为什么非得持久:内存认领(`armed`)只答得出「**本进程**此刻有没有人在办」。公开 reviewing
 * 之后、派发真正排上队之前,这一轮在库里长的是「reviewing + 没有意图」—— 那正是孤儿的全部
 * 特征,于是
 *  · 同进程里,对账只要落在「读完 armed」与「下笔」之间,活着的准备照样被收尸(第 2 轮审查
 *    问题 2 复现 B:零故障注入,两次普通查询的返回顺序就够了);
 *  · 跨重启更没救 —— 内存那张表随进程一起没了,这一轮再也没人补办。
 * 所以责任和「公开 reviewing」同在一笔写里落进库。上一个进程死在准备阶段的那一种,由
 * `redeliverReviewRound` 照补投那条路重走一遍 —— 「死在准备」和「死在排队」本来就是同一回事。
 *
 * `attempts: 0` 不是凑数:它同时是**第一次排队那一笔写的 CAS 版本**(`takeIntent` 的 `from`),
 * 所以准备与排队是同一条意图链上的第 0 次与第 1 次,不是各写一次的两份意图。
 *
 * `replay` 三位照 `FreeReviewDispatchIntent` 的原意写:补办必须重放**原派发**的会话策略,
 * 所以登记的时候就得算准(公式只有 `freshSessionFor` 一处,别在调用点自己拼)。
 */
export function preparingReviewDispatch(
  generation: string, since: string,
  replay: { resumeSessionId?: string | null; retry?: boolean; freshSession: boolean },
): FreeReviewDispatchIntent {
  return { attempts: 0, since, generation, phase: "preparing", ...replay };
}

/**
 * 交付凭据那两位 —— `commitReviewTurnDelivery` 紧挨着 spawn 之后落下的
 * `waitOwnership.deliveredReview`。**判据只有这一份**,下面三处都读它(文件头 ⑮)。
 *
 * 判据是**目录 + 代次**:目录里带着 run 与轮次,所以第 2 轮、合并结果审查各不相同;代次区分
 * 同一轮的不同次「重跑」(`reopenFailedFreeReview` 走 `restartRegressionEvidence` 换代次),
 * 上一次的旧凭据因此配不上这一次。
 */
const receiptDirectory = sql`json_extract(${tasks.waitOwnership}, '$.deliveredReview.directory')`;
const receiptGeneration = sql`json_extract(${tasks.waitOwnership}, '$.deliveredReview.generation')`;

/**
 * **这一轮这一代次的任务书已经送进会话了** —— 库里那份在途意图只是没来得及清掉。
 *
 * 为什么非得问这一句:投递是两次写,而且不同事务 —— 凭据先落(紧挨着 spawn),之后才经过落盘、
 * 回执,最后才清意图。服务断在这两次写中间、或者清意图那一笔自己失败(`settled` 刻意不因此
 * 卡住),留下的组合都是「凭据已确认 + 意图还挂着」。只看意图的恢复会把这份**审查者已经读过**
 * 的任务书整份再发一遍,白烧一轮(第 2 轮审查 F2 实测:无需任何磁盘故障,恢复即再次拉起执行器)。
 * 把回执提前到落盘那一刻只缩短了窗口,消不掉它 —— 所以恢复这一侧必须认持久交付事实为权威。
 *
 * **它只是早筛**:幂等由写意图那一笔自己的 WHERE 担保(`takeIntent` 的 `undelivered`)。先问
 * 一句是为了省掉一整段准备(工作区、MCP 预检、任务书重算),不是为了取代那一笔 CAS ——
 * 「问完再动手」中间隔着那一整段,正是第 1 轮审查问题 1 走的那条缝。
 */
export async function reviewPromptDelivered(
  taskId: string, directory: string, generation: string,
): Promise<boolean> {
  return (await db.select({ id: tasks.id }).from(tasks).where(and(
    eq(tasks.id, taskId),
    sql`${receiptDirectory} = ${directory}`,
    sql`${receiptGeneration} = ${generation}`,
  ))).length > 0;
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
 * **次数证不了「这一份没送过」**(第 1 轮审查问题 1):清意图那一笔失败时,库里那份**已经交付
 * 过**的意图原样留着,于是一份慢恢复的 CAS 会从 2 正常地走到 3 —— 它根本不会输,接着就对一条
 * 审查者已经读过的任务书再排一份完整的。所以「准许排队」与「这一份还没送过」必须同在这一笔的
 * WHERE 里(`undelivered`),判据取**持久交付凭据**而不是任何一份 task 快照。早筛那一问只是省
 * 掉一整段准备,问完到下笔之间隔着工作区、MCP 预检、任务书重算 —— 幂等只能由这一笔自己担保。
 *
 * 三种回答要分开,**别把库写不下来算成「别人办了」**:
 *  · `taken`      —— 这一版归我了;
 *  · `lost`       —— 库里已经不是那一版(别人办过了 / 轮次落了终态):让出,不投递也不落终态;
 *  · `unwritable` —— 库写不下来。同进程的等待者是活的,所以照旧排(行为与改之前一致);欠的是
 *    「跨重启还能补办」与「放弃时说得出排了几次」。这一档**不再闷着**:调用侧写一句时间线把
 *    降级说清(见 `dispatchReviewRound` 的 `warnedUnwritable`)—— 时间线落在会话文件上,跟库是
 *    两个故障域,库写不下来时它大概率还写得进去。
 */
export type IntentTake = "taken" | "lost" | "unwritable";

export async function takeIntent(
  runId: string, round: number, generation: string, from: number | null, intent: FreeReviewDispatchIntent,
  /** 这一轮的证据目录:代次的**权威**那一份在它那行上(见上面「不同代次 ≠ 更新代次」)。 */
  directory: string,
  /** 交付凭据挂在任务行上,所以这一笔还要知道是哪个任务(见上面「次数证不了没送过」)。 */
  taskId: string,
): Promise<IntentTake> {
  // `json_extract` 在「没有意图」和「老意图没这一位」两种现场都给 NULL,所以这里一律用
  // SQLite 的 `IS` / `IS NOT`(对 NULL 也成立),别换成 `=`:那样两种现场会静静地都不匹配。
  const mine = sql`json_extract(${freeReviewRounds.dispatch}, '$.generation')`;
  const version = sql`json_extract(${freeReviewRounds.dispatch}, '$.attempts')`;
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
        // **这一份还没送过**:凭据一落,这一代次的任务书就再也不许排队(文件头 ⑮)。
        sql`not exists (select 1 from ${tasks} where ${tasks.id} = ${taskId}
          and ${receiptDirectory} = ${directory} and ${receiptGeneration} = ${generation})`,
        from === null
          ? sql`${mine} is not ${generation}`
          : and(
            // `from === 0` = **第一次排队**,CAS 的对象是登记责任那一笔写下的准备意图
            // (`preparingReviewDispatch`)。意图不在也放行:那一份没落下来(`unwritable` 那一档)
            // 时同进程的等待者仍然是活的,在这里把它判成「别人办过了」等于拿一次写库故障换掉
            // 一整轮审查 —— 和改之前(`from === null` 对空意图放行)一个口径。
            from === 0 ? sql`(${version} is null or ${version} = 0)` : sql`${version} = ${from}`,
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
