// 回合占位锁:「一个任务同一时刻只跑一个回合」这把锁本身,加上几种**不是回合**的预占
// (SCM 写工作区、调度台收唤醒、残留结算)、起跑冻结标记,以及「等这一轮跑完再给它送下
// 一条」那条唯一安全的续跑路。
//
// 从 runs.ts 搬出来的理由很实:那边是「在飞的 CLI 进程登记册」(句柄、归属三态、停止落位、
// 引导预约),这边是「谁有权开始下一轮」。两摊的使用方几乎不重叠,挤在一个文件里它已经
// 742 行、过了 700 行上限(第 3 轮审查 F3)。
//
// **老使用方照旧从 `runs.js` import** —— 那边把这里的导出原样转出去(八十多个文件在用)。
// 依赖是单向的:这个文件不 import runs 的运行时(只借一个类型),所以 `claimReconcileTurn`
// 那条要问「有没有句柄在册」的,住在 runs.ts 里。
import type { StopSettle } from "./runs.js";

// ── 单飞锁与「这一轮跑完之后」────────────────────────────────────────────────
// 一个任务同一时刻只跑一个回合。锁本身原来住在 orchestrator 里，挪到这个中立模块
// 是因为「等这个任务当前这一轮退干净了再给它起下一轮」需要跟锁同一份真相：
// **结算钩子是在 run loop 的 try 里调的**（afterSettlement → handleTaskSettlement），
// 那一刻锁还锁着，此时对同一个任务调 continueTask 会被直接挡回、什么都不发生 ——
// 就地验证轮正是这种情况。于是由 run loop 释放锁的同一处把队列排空，不靠
// setTimeout 赌事件循环的先后。
/**
 * **一个回合的完整身份,一份对象。**
 *
 * 为什么三样挤在一起:令牌、角色、审查代次要么出自同一份回合事实,要么就会被拼成一份
 * 谁都没授权过的来源。第 10 轮审查 F1 实测过那条拼法 —— 旧审查的令牌 + 「现在是哪次审查」
 * 的现查结果:旧审查结束、新审查(换了审查者)刚写进库而新令牌还没落下的那一瞬,一条由
 * **原审查者**提交的哨兵被绑到了**新审查**上(HTTP 200、命令照跑、`delivery.agent` 从
 * codex 变成 claude),原审查没有任何后续。
 *
 * 所以身份只在这里产生、只整份读走(`turnIdentity`):
 *  · `role`  —— 这一轮是谁(`single` / `reviewer` / 占位身份…),运行时事实;
 *  · `review`—— 这一轮**为哪一次审查的哪一轮**而起(由派审那一侧在 claim 时交代);
 *  · `token` —— 这一轮的令牌。由写 `tasks.active_turn_token` 的同一处绑上来
 *    (`bindTurnToken`),所以「库里的令牌」和「内存里的这一轮」说的是同一件事。
 */
export type TurnReview = { run: string; round: number };
/**
 * **放锁凭据** —— 「我占到的是哪一把」。`claimTurn` / `reclaimTurn` / `enterTurn` 交回来的
 * `TurnIdentity` 结构上就是它,所以拿着身份就能还锁,拿不到身份就还不了别人的锁。
 *
 * 为什么单独一个类型而不是直接收 `TurnIdentity`:条件释放只认号码(`seq`),身份里其余几样
 * (role/token/review)在占位转正时会变 —— 签名只要号码,就不会有人以为「传一份新读出来的
 * 身份」也算凭据(那正是按 id 删锁的变装版:现读的身份必然等于现在那把锁)。
 */
export type TurnOwner = { readonly seq: number };
export type TurnIdentity = {
  role: string;
  review: TurnReview | null;
  token: string | null;
  /**
   * 这把锁是**哪一刻**占下的（`Date.now()`）。占位转正(`reclaimTurn`)沿用原值 —— 转正不是
   * 重新占一次,把它刷新会让一把已经占了十分钟的锁每次转正都显得崭新。
   *
   * 它只有一个用途:判「这把锁还有没有主」。幽灵锁(占着、却再没有任何人会来释放)在瞬时
   * 快照里和「正常起跑中」长得一模一样 —— `handles` 是空的(claim 排在 trackRun 之前)、
   * 令牌也还没绑(`bindTokenTurn` 排在它之后),两者的唯一区别就是**这个状态持续了多久**。
   * 回收判据与阈值住在 turn-lock-reclaim.ts。
   */
  claimedAt: number;
  /**
   * **这一次占用的身份号** —— 全进程单调递增,`turns` 里删掉之后也绝不复用。
   *
   * 它只服务一件事:让「替别人还锁」变成**条件释放**。判定一把锁可疑要读进程登记册、
   * 要写时间线,中间全是 await;而按任务 id 删锁的写法在那段间隙里认不出换了主人 ——
   * 原持有者自己还了锁、一个正常回合随即占上,拔的就是**后来者**那把,同一个任务从此
   * 两个回合并跑(本轮审查 F2 按批量快照复现)。所以 `forceReleaseTurn` 只收快照、
   * 核对号码,对不上就什么都不做。
   *
   * 占位转正(`reclaimTurn`)沿用原号:转正接的是同一把锁,换号会让判定时拿到的快照
   * 凭空失效,可疑锁反而永远拔不掉。
   */
  seq: number;
};

/**
 * **起这一轮的人是谁、为哪一次审查而起** —— 一个对象,不是两个各自可缺的字段。
 *
 * 为什么是联合类型:上一版这两样在回合入口上是 `sessionRole?` 和 `reviewSource?` 两个独立
 * 可选字段,于是「reviewer 但没带审查代次」是一个**类型上完全合法**的组合 —— 首次派审带了,
 * 自动投递、手动恢复、答复提问三条恢复入口各自漏了,而漏掉的后果不是报错而是**静默降级**:
 * 续起来的那一轮身份里 `review=null`,来源核验据此判「这次审查已经结束」,还活着的审查者
 * 从此一条哨兵都挂不上(本轮审查 F2 实测 HTTP 409)。
 *
 * 所以 reviewer 这一支**必须**说出 review。确实不代表某一轮审查的 reviewer 回合(duet 研讨、
 * 辩论)写 `"unbound"`:那是一句**显式**的「这一轮不绑任何审查」,读代码的人和编译器都看得见,
 * 而且它换来的行为正是对的 —— 那种回合挂不上「本轮审查」的哨兵。
 */
export type TurnSource =
  | { role: "single" }
  | { role: "reviewer"; review: TurnReview | "unbound" };

/** 回合身份里的角色。缺省(普通续聊)就是 `single`。 */
export const turnSourceRole = (source?: TurnSource | null): string => source?.role ?? "single";

/** 回合身份里绑定的那次审查。`"unbound"` 与不是 reviewer 都是 null。 */
export const turnSourceReview = (source?: TurnSource | null): TurnReview | null =>
  source && source.role === "reviewer" && source.review !== "unbound" ? source.review : null;

const turns = new Map<string, TurnIdentity>();
/** 占用身份号的发号器。只增不减、删掉不回收(见 `TurnIdentity.seq`)。 */
let nextTurnSeq = 1;
const afterTurn = new Map<string, Array<() => void>>();

// 「回合已占位、进程还没起来」时收到的冻结请求。这一段窗口里 `handles` 是空的、
// `tasks.status` 也可能还停在上一轮的终态 —— 只有回合锁看得见它，所以分组暂停既杀不到
// 也拦不住（第 1 轮审查 finding 1：pause 已经 200 返回，重试仍把 CLI 拉起来了）。
// 记在这里，由起跑前的最后一道闸在 spawn 之前消费（turn-freeze.ts）。
const startFreeze = new Map<string, StopSettle>();

/**
 * SCM 面板占住工作区时写进 `turns` 的身份。它**不是一个回合**：没有 agent、没有 spawn、
 * 不进结算。凡是「对正在起跑的回合做点什么」的逻辑都得按这个身份把它排除掉
 * （目前是 `freezeStartingTurn`）。
 */
const WORKSPACE_TURN_ROLE = "scm";

/**
 * 同样**不是一个回合**：常驻团队调度台收一条唤醒类通知(哨兵事件)时的短暂预占,只为了
 * 和「手动改终态」互斥（`claimWakeTurn`）。调度台的一次运行是整段常驻,它平时不占这把
 * 锁;这一次占也不代表有谁在起跑,所以照 SCM 预占同一口径排除在起跑冻结之外。
 */
const WAKE_TURN_ROLE = "lead-wake";

/**
 * 「重启后给打断的任务做失败结算」的占位身份（`claimReconcileTurn`）。同样不是一个回合:
 * 它不 spawn 任何东西,只是把「读状态 → 判定 → 写状态」围成一段临界区。
 */
export const RECONCILE_TURN_ROLE = "reconcile";

/**
 * 队列占位回滚**提交状态时**占的位(`queue-seat` 的 rollback、`scheduler` 的
 * `reclaimStrandedSeat`)。同样不是一个回合。
 *
 * 为什么回滚非得占这把锁:它要把任务从 queued 写回占位前的状态,而 `setTaskStatus` **自己
 * 内部就有 await**(先整行 SELECT 再 UPDATE)。「写之前再查一次所有权」挡不住那段窗口 ——
 * 新持有者可以在那次 SELECT 期间占锁、绑令牌、落 running,旧回滚随后照样把它写回终态,
 * 还连带触发结算与队列推进(第 2 轮审查 F1 实测:新锁仍在而状态已被翻成 failed)。
 * 占着锁写就没有这段窗口:任何新持有者都 claim 不进来,提交期间不可能有人开始新一轮。
 */
export const SEAT_ROLLBACK_ROLE = "seat-rollback";

/**
 * 冻结一个**正在起跑**的回合：已 claim、还没 spawn，所以没有 handle 可杀。
 * 返回 false = 这个任务根本没有回合在起跑（调用方无事可做）。
 *
 * 标记只对当前这一回合有效：回合退出时由 releaseTurn 清掉，绝不留给下一轮
 * （留下来就是「下一次运行刚起跑就被上一次的暂停冻掉」）。
 *
 * **SCM 占位不是回合**，所以一律不接：`claimWorkspaceTurn` 能占住就说明此刻没有 agent
 * 在起跑（真回合占着锁时它压根占不到），冻它没有对象；而它释放时刻意不清起跑冻结（那是
 * 真回合的东西），标记会活到下一次真启动，把一次正常的「运行」莫名撤回成 paused，时间线
 * 还写成「所在分组已暂停」——分组其实早恢复了（第 3 轮审查稳定复现）。
 */
export function freezeStartingTurn(taskId: string, settle: StopSettle = "paused"): boolean {
  const role = turns.get(taskId)?.role;
  if (role === undefined || role === WORKSPACE_TURN_ROLE || role === WAKE_TURN_ROLE) return false;
  if (role === RECONCILE_TURN_ROLE) return false; // 残留结算也不是回合,理由同上
  if (role === SEAT_ROLLBACK_ROLE) return false; // 占位回滚也不是回合,理由同上
  startFreeze.set(taskId, settle);
  return true;
}

/** 起跑前的最后一道闸消费它：非 null = 这一轮必须在 spawn 之前撤回，并按这个落位结算。 */
export function takeStartFreeze(taskId: string): StopSettle | null {
  const s = startFreeze.get(taskId) ?? null;
  startFreeze.delete(taskId);
  return s;
}

/**
 * 抢占这个任务的回合，并把**放锁凭据**交回来；已经有人在跑就返回 null（调用方直接放弃
 * 这一次，`if (!claimOwnTurn(...))` 照旧成立）。
 * role 是这一回合的身份（"single" / "reviewer"…）——它是**运行时事实**，审查结论的
 * 归属检查（report_stage）读它，而不是查 sessions 表猜（session 行的 endedAt 语义
 * 既不代表进程活着、也不代表回合归属，审查实测两个方向都错过）。
 */
export function claimOwnTurn(taskId: string, role = "single", review: TurnReview | null = null): TurnIdentity | null {
  if (turns.has(taskId)) return null;
  const identity: TurnIdentity = { role, review, token: null, claimedAt: Date.now(), seq: nextTurnSeq++ };
  turns.set(taskId, identity);
  return identity;
}

/**
 * 同上,但**只回答「抢到没抢到」**。
 *
 * 不交凭据,所以它只配得上一种形状:**同一段同步代码里 claim 完马上 release**(中间没有
 * await ⇒ 没人可能把这把锁换掉 ⇒ 凭据没有信息量)。回归脚本里两百多处就是这种形状,诊断
 * 端点同理。
 *
 * **生产路径一个都不许走这条**:凡是占位与释放之间隔着 await 的,必须 `claimOwnTurn` 把
 * 身份留住、`releaseTurn(taskId, owner)` 还它(理由整段在 `endOwnTurn`)。这一条由 tsc 盯着
 * server/src ——「要凭据」是 `releaseTurn` 的签名要求,拿布尔值的调用方在那里编译不过。
 */
export function claimTurn(taskId: string, role = "single", review: TurnReview | null = null): boolean {
  return claimOwnTurn(taskId, role, review) !== null;
}

/**
 * 只读探测：这个任务的回合是否已被占用。
 *
 * 给「验收 / 派审 / 修复 / 预览」这类守卫用：`tasks.status` 要到 continueTask 深处才写成
 * running，claim 到落库之间有真实窗口——只看 DB status 会把一个已经开跑的任务当成空闲，
 * 进而合并、删 worktree 或往它身上派审（审查报告实测复现过）。守卫必须两个都看。
 */
export function isTurnClaimed(taskId: string): boolean {
  return turns.has(taskId);
}

/** 当前回合的身份；没有回合在跑返回 null。 */
export function turnRole(taskId: string): string | null {
  return turns.get(taskId)?.role ?? null;
}

/**
 * 这一轮的**整份身份**(令牌 + 角色 + 它为哪一次审查而起)。
 *
 * 要用就整份读走:拆成「先读角色、再去查审查」就又回到第 10 轮审查 F1 那条拼法上了
 * (见 `TurnIdentity`)。读到 null = 此刻没有回合在跑。
 */
export function turnIdentity(taskId: string): TurnIdentity | null {
  return turns.get(taskId) ?? null;
}

/**
 * 把这一轮的令牌绑到它的身份上。**只许在写 `tasks.active_turn_token` 的同一处调**
 * (orchestrator 起一轮、task-run 首跑、reattach 接回上一轮),这样「库里那个令牌」和
 * 「内存里这一轮」永远指同一件事 —— 来源核验据此只认一份事实。
 */
export function bindTurnToken(taskId: string, token: string): void {
  const held = turns.get(taskId);
  if (!held) {
    // 没占位就写令牌 = 调用顺序错了。不静默:来源核验会把这一轮当「不是当前这一轮」拒掉。
    console.error(`[ash] bindTurnToken(${taskId}) 时没有回合在跑,这一轮的来源将无法核验`);
    return;
  }
  held.token = token;
}

/**
 * 占位转正：入口在最后一个 await 检查之后原子占住 turn（`turnHeld` 把那份身份传给启动
 * 函数），启动函数到位后用真实身份接管这把锁。返回接管后的身份;**null = 这把锁已经不是
 * 你那一把了**(人工放开拔走之后另一轮占上,或者压根没占),调用方据此当「这一轮没接管」
 * 处理 —— 对拿着用户原话的调用方就是「一个字没送出去」,消息按未投递回托盘。
 *
 * 为什么它也必须核 owner:转正是**整份覆写**这把锁的 role/review。旧代次的转正会把后来者
 * 那一轮的身份改成自己的(seq/token 还是后来者的),于是来源核验按一个谁都没授权过的组合
 * 放行 —— 和裸删锁同一类(见 `endOwnTurn`),只是破坏面从互斥换成了身份。
 */
export function reclaimTurn(taskId: string, owner: TurnOwner, role: string,
  review?: TurnReview | null): TurnIdentity | null {
  const held = turns.get(taskId);
  if (!held || held.seq !== owner.seq) {
    // 出声:这一轮不接管了,而「锁被拔走」和「调用顺序写错了」在日志里长得一样。
    console.error(`[ash] reclaimTurn(${taskId}) 的占位已经不在手上(seq=${owner.seq},`
      + ` 现持有=${held ? held.seq : "无"}),这一轮不接管`);
    return null;
  }
  // `review` 省略 = 沿用占位时交代的那一份(占位转正不该把它抹掉);显式传 null 才是清掉。
  // `claimedAt` 沿用:转正接的是同一把锁,不是新占一次(见 `TurnIdentity.claimedAt`)。
  const identity: TurnIdentity = {
    role,
    review: review === undefined ? held.review : review,
    token: held.token,
    claimedAt: held.claimedAt,
    seq: held.seq, // 同一把锁,不换号(见 `TurnIdentity.seq`)
  };
  turns.set(taskId, identity);
  return identity;
}

/**
 * 回合结束：先放锁，再跑「等这一轮跑完」的回调（它们多半要立刻起下一轮）。
 *
 * **`owner` 不是可选的礼节**:它是 `claimTurn` / `reclaimTurn` / `enterTurn` 交回来的那份
 * 身份,放的只能是**自己占下的那一把**。理由整段写在 `endOwnTurn` 上。
 */
export function releaseTurn(taskId: string, owner: TurnOwner): void {
  // 起跑冻结标记只属于刚结束的这一回合（没被消费 = 那一轮已经自己结束了）。留着它，
  // 下一次运行会在起跑前被上一次的暂停莫名冻掉。clearFreeze 由原语按 owner 核过之后才做:
  // 旧代次连「清掉新锁的冻结标记」都不许(那等于把下一轮该撤回的暂停意图吃掉)。
  //
  // `!owner` 只可能来自**不过 tsc 的回归脚本**(server/scripts 不在 tsconfig 的 include 里):
  // 那边有两百多处 `releaseTurn(taskId)`,全是「同一段同步代码里 claim 完马上 release」的
  // 形状。按「放掉此刻那一把」兼容它们;生产路径由签名兜住,少传一个参数就编译不过。
  if (!owner) { releaseHeldTurn(taskId); return; }
  endOwnTurn(taskId, owner, true);
}

/**
 * **放掉这个任务此刻占着的那一把,不核凭据** —— 返回被放掉的那份身份(没占着是 null)。
 *
 * 和 `releaseTurn` 的差别就是「核不核」,所以它只配得上 `claimTurn`(布尔版)那同一种形状:
 * 同一段同步代码里 claim 完马上 release。**凡是中间隔着 await 的,用它就是本轮审查 F1 那个
 * 缺陷本身** —— 读到的「此刻那一把」必然等于现在占着的那一把,等于不核。
 */
export function releaseHeldTurn(taskId: string): TurnIdentity | null {
  const held = turns.get(taskId);
  return held ? endOwnTurn(taskId, held, true) : null;
}

/**
 * SCM 面板要动这个工作目录：**用同一把回合锁原子预占**，占不到返回 null。
 *
 * 为什么不是「再查一次在不在飞」：查是观察式的，`claimTurn` 不需要仓库锁，查完到真正
 * 动手之间另一次启动完全可以合法插进来（第 2 轮审查确定性复现过：guard 观察到空闲，
 * 其后的微任务里 claim 成功，git 命令仍照跑）。多查几次关不掉这个窗口——启动与工作区
 * 写入必须争同一个原子对象。占住之后 `claimTurn` 会挡下新的启动，`isTurnClaimed` 也会
 * 让归档/验收/派审这些既有守卫一并退避，不必在每个调用点再加一道。
 *
 * **要占的是这个目录的全部共用者，不是一个 task id**（`workspaceParticipants`）：团队
 * 调度台和它那些跟随的执行者跑在同一个 worktree 里，只占自己那把锁，兄弟执行者照样能在
 * 我们跑 git 的同一时刻起跑（第 4 轮审查复现）。所以这里是**全有或全无**：中途占不到就
 * 把已占的全部还回去，让调用方按 `needsForce` 那一档处理；用户确认过的 force 走
 * `claimIdleWorkspaceTurns`。
 *
 * 和真回合的唯一差别是**不碰起跑冻结**：这不是一个回合，清掉它会把上一次真回合留下的
 * 暂停意图吃掉；反过来，占住期间也不许有人往它身上写冻结（见 `freezeStartingTurn`），
 * 否则标记会漏给下一次真启动。
 */
export function claimWorkspaceTurn(taskIds: string[]): (() => void) | null {
  const claimed: Array<{ taskId: string; owner: TurnIdentity }> = [];
  for (const taskId of new Set(taskIds)) {
    const owner = claimOwnTurn(taskId, WORKSPACE_TURN_ROLE);
    if (owner) {
      claimed.push({ taskId, owner });
      continue;
    }
    for (const held of claimed) endOwnTurn(held.taskId, held.owner, false);
    return null;
  }
  return releaserFor(claimed);
}

/**
 * 同上，但**能占到几把就占几把**——只跳过此刻真有回合在跑的那些。带 `force` 的写操作走
 * 这一条。
 *
 * force 的本意是覆盖「已经在写这个目录的那一位」，用户为此点过一次确认。全有或全无在这
 * 里是反的：一位共用者在跑，整组锁就都还回去了，于是**还没起跑的闲置同伴照样能在这次
 * git 期间起跑**（第 1 轮审查函数级复现：`claimWorkspaceTurn([running, idle]) === null`
 * 之后 `claimTurn(idle)` 立刻成功）。用户放行的是一个明确的对象，不是整组。
 *
 * 占不到的那些不必回给调用方：force 路径本来就不再据此拒绝，知道也无事可做。
 */
export function claimIdleWorkspaceTurns(taskIds: string[]): () => void {
  const claimed: Array<{ taskId: string; owner: TurnIdentity }> = [];
  for (const taskId of new Set(taskIds)) {
    const owner = claimOwnTurn(taskId, WORKSPACE_TURN_ROLE);
    if (owner) claimed.push({ taskId, owner });
  }
  return releaserFor(claimed);
}

/**
 * 团队调度台要收一条**唤醒类**通知：按同一把回合锁原子预占，占不到返回 null。
 *
 * 为什么也是这把锁：手动改终态的那条路（`PATCH /tasks/:id`）占的就是它。通知那一侧
 * 「这个任务还能不能被叫醒」的判定与它必须互斥，否则两种交错里总有一种漏过去 —— 判定
 * 读到 idle、结果还没交回去，完成操作照样写库，放开之后通知仍旧开台（第 6 轮审查实测）。
 * 再多查几次状态是关不掉这个窗口的：查是观察式的。
 *
 * 和真回合的差别同 `claimWorkspaceTurn`：**不碰起跑冻结**（这不是一个回合）。
 */
export function claimWakeTurn(taskId: string): (() => void) | null {
  const owner = claimOwnTurn(taskId, WAKE_TURN_ROLE);
  if (!owner) return null;
  return releaserFor([{ taskId, owner }]);
}

/**
 * **占一把「不是回合」的位**:同一把回合锁,占不到返回 null。残留结算(`claimReconcileTurn`,
 * 住在 runs.ts —— 它还要问「有没有句柄在册」)走这条。
 *
 * 和真回合的差别同 `claimWorkspaceTurn`:**不碰起跑冻结**(这不是一个回合)。
 */
export function claimNonTurn(taskId: string, role: string): (() => void) | null {
  const owner = claimOwnTurn(taskId, role);
  if (!owner) return null;
  return releaserFor([{ taskId, owner }]);
}

/**
 * 释放函数可重复调用（写操作的 finally 与错误路径可能都走到）。
 *
 * **闭包里存的是身份而不是任务 id**:占位与释放之间隔着整段 await(git 命令、通知落库),
 * 人工放开可以在那段间隙里把这把锁拔走、另一轮合法占上 —— 按 id 释放拔的就是后来者那把
 * (本轮审查 F1 在生产构建产物上实测:seq=1 的旧闭包撤掉了 seq=2,第三次认领随即成功)。
 */
function releaserFor(claimed: ReadonlyArray<{ taskId: string; owner: TurnIdentity }>): () => void {
  let released = false;
  return () => {
    if (released) return;
    released = true;
    // 预占不碰起跑冻结(那是真回合的东西,理由见 `claimWorkspaceTurn` 的注释)。
    for (const held of claimed) endOwnTurn(held.taskId, held.owner, false);
  };
}

/**
 * **唯一的放锁原语:只放 seq 对得上的那一把。** 返回被放掉的那份身份,null = 这把锁不是
 * 你那一把(换了主人,或者早就没了)。
 *
 * 为什么没有「按任务 id 放锁」的形态 —— 那是本轮审查 F1 的根因:占位到释放之间全是 await,
 * 而人工放开(`forceReleaseTurn`)可以合法地在那段间隙里把锁拔走、让下一轮占上。按 id 删锁
 * 的调用在那一刻**没有任何办法**认出锁已经换了主人,于是:
 *  · 删掉后来者那把 ⇒ 同一个任务两个回合并跑(实测 thirdClaimed=true);
 *  · 排空后来者的 `afterTurn` ⇒ 那一轮真结束时该走的交接(排队投递、队列补推)已经被别人
 *    消费掉了,再没有第二次;
 *  · 清掉后来者的起跑冻结标记 ⇒ 下一轮该撤回的暂停意图凭空消失。
 * 三件事因此全收在这一处,按 owner 核过之后才做 —— 「在某一个调用点补一次检查」挡不住它,
 * 新接进来的释放入口默认就是没有核验的那一种。
 *
 * `seq` 全进程单调、删了也不复用(见 `TurnIdentity.seq`),所以它是这一层唯一可信的凭据:
 * 身份**对象**在占位转正(`reclaimTurn`)时会被整份换掉,按对象比会把自己的锁也判成别人的。
 */
function endOwnTurn(taskId: string, owner: TurnOwner, clearFreeze: boolean): TurnIdentity | null {
  const held = turns.get(taskId);
  if (!held || held.seq !== owner.seq) return null;
  if (clearFreeze) startFreeze.delete(taskId);
  turns.delete(taskId);
  const waiting = afterTurn.get(taskId);
  if (!waiting) return held;
  afterTurn.delete(taskId);
  for (const fn of waiting) {
    try {
      fn();
    } catch (error) {
      console.error(`[ash] after-turn hook failed for ${taskId}:`, error);
    }
  }
  return held;
}

/**
 * 此刻所有被占着的回合锁的**只读快照**(含占用时刻与角色)。
 *
 * 给幽灵锁巡检用(turn-lock-reclaim.ts)。导出快照而不是导出那张 Map:回收方只许按判据
 * 读与释放,不许顺手改别人这一轮的身份。
 */
export function heldTurns(): Array<TurnIdentity & { taskId: string }> {
  return [...turns].map(([taskId, identity]) => ({ taskId, ...identity }));
}

/**
 * **条件释放**一把回合锁 —— 给「旁人判定原持有者已经不在了」那一种收尾用。
 *
 * 和 `releaseTurn` 的差别只在调用者的身份:`releaseTurn` 是**持有者自己**在 finally 里还锁;
 * 这一条是旁人替它还。所以它返回被拔掉的那份身份 —— 回收方要把「拔掉的是谁、占了多久」
 * 如实写进日志和任务时间线,不许静默。
 *
 * **参数是一份快照,不是一个任务 id**,这是故意的:
 * 判定「这把锁可疑」要读进程登记册、读库、写时间线,中间全是 await。按 id 删锁的签名
 * 在那段间隙里**没有任何办法**认出锁已经换了主人 —— 原持有者自己还了锁、一个正常回合随即
 * 占上,拔的就是后来者那把,同一个任务从此两个回合并跑。本轮审查 F2 就是按批量快照复现的:
 * 一轮巡检先判定 N 把,逐把处理时第 2 把已经换了主。
 *
 * 所以类型上就不给「释放任务 X 上随便哪一把」这种说法:只收 `{ taskId, seq }`,`seq` 全进程
 * 不复用(见 `TurnIdentity.seq`),号码对不上就返回 null、一个字节都不动。调用方要保证的只剩
 * 一件事:**快照和这次调用之间不许隔 await**(判据自己也要重新算一次,见
 * turn-lock-reclaim.ts `releaseSuspectTurn`)。
 *
 * ⚠ 该不该拔不在这里判。拔错一把正在起跑的锁 = 同一个任务起两个回合,比卡住严重得多;
 * 判据与阈值只许住在 turn-lock-reclaim.ts 那一处(它要同时问进程登记册,依赖方向不许反过来)。
 *
 * 和 `releaseTurn` 一样会跑 `afterTurn` 回调:卡住的锁底下往往正压着
 * 「等这一轮跑完再送」的交接(排队消息投递、队列补推),它们跟着这把锁一起被冻住了 ——
 * 拔锁而不放它们走,任务照旧停在原地。
 */
export function forceReleaseTurn(expected: { taskId: string; seq: number }): TurnIdentity | null {
  return endOwnTurn(expected.taskId, expected, true);
}

/**
 * **等这个任务的回合锁空出来**,最多等 `timeoutMs`。true = 真的空了;false = 等到超时它还占着。
 *
 * 给「停止」用,而且是它唯一能拿到的**证据**:停止在没有进程可杀时会竖一个起跑冻结标记,
 * 但标记本身证明不了有人会来消费它 —— `freezeStartingTurn` 只要看见一个非预占身份就返回
 * true,活着的起跑流程和一把没人管的锁在它眼里一模一样(第 2 轮审查 F3)。真正的区别是
 * **会不会有人来还锁**:活着的起跑流程走到 spawn 前那道闸会消费掉标记、撤回这一轮、在
 * 自己的 catch 里 releaseTurn;没有主的锁则一直占着。所以等一会儿看锁空不空,是唯一不靠
 * 年龄猜测、而是靠**观察到释放**的判据。等不到也不猜 —— 如实说还占着,把放开交给用户。
 */
export function waitForTurnIdle(taskId: string, timeoutMs: number): Promise<boolean> {
  if (!turns.has(taskId)) return Promise.resolve(true);
  return new Promise((resolve) => {
    let settled = false;
    let cancel: (() => void) | null = null;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      // **等到超时就不再是等待者了**(自由工作流第 1 轮审查 N1)。上一版只把自己标成
      // settled 就走人,那个闭包一直留在 `afterTurn` 里 —— 对一个长期不释放的回合反复按
      // 停止(每次都等到超时),一次按一个,全攒到这把锁真的释放或者进程退出。它们都是
      // 死的(settled 之后一个字都不做),但「死的观察者」和「等着的观察者」在那张表里
      // 长得一模一样:巡检读到的待办数量、以及这块内存,都跟着按的次数线性涨。
      cancel?.();
      resolve(false);
    }, timeoutMs);
    // **不 unref**:有一条 HTTP 响应在等这个 Promise。unref 掉的话,进程只剩它时事件循环
    // 会直接空转退出,那条响应永远发不出去(回归里实测到「unsettled top-level await」)。
    cancel = whenTurnIdle(taskId, () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(true);
    });
  });
}

/**
 * 任务空着就立刻执行，正在跑就排到它这一轮退出之后。
 *
 * **交回一个取消函数**:等待方有自己的出路(超时、换了代次、请求断开)时,得撤掉的只有
 * 自己这一笔 —— 按任务 id 清整组是另一个缺陷的形状(`endOwnTurn` 的文件注释),那会把别人
 * 排着的交接一并吃掉。空着那一侧已经当场执行完了,取消是个空操作(调了也不抛)。
 */
export function whenTurnIdle(taskId: string, fn: () => void): () => void {
  if (!turns.has(taskId)) {
    fn();
    return () => {};
  }
  const waiting = afterTurn.get(taskId);
  if (waiting) waiting.push(fn);
  else afterTurn.set(taskId, [fn]);
  return () => {
    const list = afterTurn.get(taskId);
    if (!list) return; // 这一轮已经释放过了:整组被 endOwnTurn 取走并清掉
    const at = list.indexOf(fn);
    if (at >= 0) list.splice(at, 1);
    if (!list.length) afterTurn.delete(taskId);
  };
}

/**
 * **这一次投递为什么没成功** —— 四种原因里只有 `turn-taken` 是**瞬时**条件。
 *
 * 为什么必须分开报:四种在调用方眼里完全不是一件事,而老签名只给一个字符串,于是每个调用方
 * 都只能一视同仁地落终态。瞬时那一种因此被当成永久失败(2026-10-31 实例 IZk5yKUHpR2G:
 * 预约复审建好 run 之后 148ms 落 failed,只因为同一个释放点上另一条 waiter 先抢到了锁)。
 *
 *  · `turn-taken`   —— 排到队头时 `claimOwnTurn` 失败。**此刻锁在别人手上**,而这一侧到这
 *    一刻一个字节都没动(没查库、没建会话、没碰状态),所以重排是安全的;而且锁总会被还回来
 *    (持有者自己的 finally,或人工放开 / 幽灵锁巡检的 `forceReleaseTurn` —— 它们走的也是
 *    `endOwnTurn`,一样会放 `afterTurn` 的 waiter 走),所以「排到下一个空闲窗口」一定还有
 *    下一次机会。
 *  · `withdrawn`    —— 起跑前的冻结闸撤回(分组已暂停 / 任务已归档或删除)。那是用户的动作,
 *    重排只会把它的决定磨掉。
 *  · `not-delivered`—— `continueTask` 自己答了「一个字没送出去」。它的几种成因(历史审查退役、
 *    接力出去、输入交付期中断的 uncertain、验收互斥退避)在这一层分不开,所以不猜,照旧上报。
 *  · `failed`       —— 抛了。
 */
export type TurnDeliveryFailure = "turn-taken" | "withdrawn" | "not-delivered" | "failed";

/**
 * 结算钩子里给同一个任务续跑的**唯一安全写法**：等它这一轮退干净再送消息。
 *
 * 直接 `continueTask` 会被单飞锁静默挡回（结算钩子跑在 run loop 的 try 里，锁还锁着），
 * 表现是「什么都没发生」——就地验证轮起不来、打回重做的提示没人收。动态 import 是为了
 * 不让这个中立模块回头依赖 orchestrator（类型是纯类型引用，不构成运行时环）。
 */
// 入口参数的类型住在 `task-continue-options.ts`(只放类型,不放运行时 —— 这条链上的运行时
// import 要留给那句 dynamic import)。
type ContinueOpts = import("./task-continue-options.js").ContinueTaskOptions;

export function continueWhenIdle(
  taskId: string,
  text: string,
  opts: ContinueOpts = {},
  onError?: (message: string, failure: TurnDeliveryFailure) => void | Promise<unknown>,
  /**
   * `continueTask` 真的接过了这一轮(送出去了)。
   *
   * 为什么要有它:老接口只报失败,于是「这一轮的输入到底送进会话了没有」在外面无法回答 ——
   * 而凡是把派发记成**持久意图**的调用方都要靠这一声去把意图了结掉,不然重启后的补办会
   * 对着一条已经在跑的审查再投一次任务书。
   *
   * **时机是「原话落盘」那一刻,不是这一轮跑完**:`continueTask` 要等执行器收流、结算做完
   * 才 resolve,一轮审查动辄几十分钟。取后者等于在整轮期间都把意图挂着,服务在这中间断掉,
   * 新进程看到「有意图、没人盯着」就会对一条**已经执行过**的审查整份重投(第 1 轮审查 F2)。
   * 所以这里接的是 `continueTask` 自己的 `onDelivered`(orchestrator 里 spawn + 落盘之后的
   * 那一声),整轮返回只作兜底 —— 见下面 `confirmDelivered`。
   */
  onDelivered?: () => void | Promise<unknown>,
): void {
  whenTurnIdle(taskId, () => {
    // 排到队头的一瞬间**同步**锁定所有权（turnHeld 传递给 continueTask 接管）：不占的
    // 话，异步 import 的间隙里同一释放点的后续 waiter 能同步抢锁——投递「not delivered」
    // 而调用方可能已提前写下状态（审查实测 3/3：dispatch 释放点被竞争 waiter 抢先，
    // 任务留在 stage=verifying 而验证从未启动）。
    // **占位的那一刻就把「谁起的、为哪一次审查而起」一起交代清楚**:派审那一侧此刻手里正握着
    // run 和轮次,而创建入口过后只能查「现在是哪一次」—— 那两者在派审交接期并不是同一个
    // (第 10 轮审查 F1)。两样同在一个 `TurnSource` 里,所以这里不可能只带到一半。
    const source = (opts as { turnSource?: TurnSource | null }).turnSource ?? null;
    // 占到的那份身份一路带到下面两条释放出路上:从这里到它们之间隔着 `await import`、
    // 隔着一次查库,人工放开完全可以在那段间隙里把这把锁拔走、另一轮合法占上(见
    // `endOwnTurn`)。按任务 id 还锁撤掉的就是后来者那把。
    const owner = claimOwnTurn(taskId, turnSourceRole(source), turnSourceReview(source));
    if (!owner) {
      console.error(`[ash] continueWhenIdle(${taskId}) not delivered: turn re-claimed`);
      // **瞬时**:锁此刻在别人手上,而这一侧一个字节都没动。分类交给调用方决定要不要重排
      // (见 `TurnDeliveryFailure`);不想重排的照旧按失败收场,行为与老签名一致。
      //
      // 这一声不等它(重排是异步的,等于等整条链),但 rejection 必须接住:底下另外几条出路都
      // try/catch 过,只有这一条漏着 —— 重排路上任何一步抛出来就是一条没人接的 rejection
      // (进程级 unhandledRejection),而那一侧的清理也跟着跳过(第 3 轮审查 F3)。
      void Promise.resolve(onError?.("回合被其它执行抢占，消息未能投递", "turn-taken"))
        .catch((error) => console.error(`[ash] continueWhenIdle(${taskId}) 抢占后的重排处理失败:`, error));
      return;
    }
    /**
     * 「这一轮的输入已经落盘」只报一次。
     *
     * 两处会叫它:`continueTask` 自己的 `onDelivered`(原话写进会话那一刻,**权威**),以及
     * 整轮返回之后的兜底 —— 后者只为「走了一条没经过那一声的投递路径」留条活路:那一轮
     * 确实跑过了,不报的话调用方的持久意图会一直挂着,重启后又整份重投一次。
     */
    let handed = false;
    const confirmDelivered = async (): Promise<void> => {
      if (handed) return;
      handed = true;
      try { await onDelivered?.(); } catch (error) {
        console.error(`[ash] continueWhenIdle(${taskId}) 投递成功的回执处理失败:`, error);
      }
    };
    void import("./turn-freeze.js")
      .then(async ({ turnFreezeReason }) => {
        // 这条路上的启动**全是系统发起的**（就地验证、自由派审、修复、验收冲突叫醒），
        // 而且都是「先占位登记、释放点之后才真起跑」的交接：从调用方那次预检查到这里，
        // 中间隔着上一整轮，用户完全可能已经把分组暂停、把任务删了或归档了。
        //
        // 内存里的起跑冻结标记在这条路上**指望不上**：`pauseGroup` 冻的是占位那一个
        // 回合（dispatch），占位方的 finally `releaseTurn` 会连着标记一起清掉——接棒的
        // 真实回合什么都看不到，于是「暂停已经 200 返回，reviewer 照样被拉起来」
        //（第 4 轮审查确定性复现）。所以这里按事实查库权威复查一次。
        const freeze = await turnFreezeReason(taskId, true);
        if (!freeze) {
          const delivered = await (await import("./orchestrator.js"))
            .continueTask(taskId, text, {
              ...opts,
              turnHeld: owner,
              // 调用方自己的记账先走(排队消息标 sent 那一类),再报「送出去了」。它抛了就
              // 不报,留给下面的兜底 —— 那一侧还会把异常记下来。
              onDelivered: async () => {
                await opts.onDelivered?.();
                await confirmDelivered();
              },
            });
          // continueTask 返回 false = 一个字都没送出去（验收互斥退避等）。吞掉它，
          // 调用方的时间线就会停在「意见已发回会话」而消息实际没了——必须当失败上报。
          if (delivered === false) {
            console.error(`[ash] continueWhenIdle(${taskId}) not delivered`);
            return { failure: "not-delivered" as const, message: "回合被其它执行抢占，消息未能投递" };
          }
          return null;
        }
        // 撤回，且**不标停止落位**：这一轮一个字都没送出去，任务状态还停在上一轮的终态，
        // 标了就会被下一次真启动误读成「上一轮是被停的」。当作投递失败上报，调用方那套
        // 回滚（清 verifyRound、复位 stage、写时间线）才跑得到——不然任务会永久卡在
        // 「正在验证」而验证从未开始。
        releaseTurn(taskId, owner);
        console.error(`[ash] continueWhenIdle(${taskId}) withdrawn: ${freeze.reason}`);
        // **撤回不再冒充 delivered**:老代码在这儿先 `onError` 再 `return true`,靠「true 不等于
        // false」绕过下面那道判定 —— 于是「送出去了」和「被撤回了」在返回值上长得一模一样,
        // 新接进来的成功回调会在撤回时也被叫一次(那正是持久意图被误了结的形状)。
        return { failure: "withdrawn" as const, message: `${freeze.reason}，这一轮在启动前被撤回` };
      })
      .then(
        async (outcome) => {
          if (!outcome) {
            // 真的交出去了。正常路径上「原话落盘」那一刻已经报过,这里只兜底:整轮都跑完了
            // 却一声没报,说明这一轮走的是一条没经过那个点的投递路径 —— 它确实跑过,所以照样
            // 报(否则持久意图会一直挂着),但要留一行日志,别让这条异常路静默下去。
            if (!handed) console.error(`[ash] continueWhenIdle(${taskId}) 整轮已结束却没收到落盘回执，按已投递了结`);
            await confirmDelivered();
            return;
          }
          try { await onError?.(outcome.message, outcome.failure); } catch { /* 上报失败不再连锁 */ }
        },
        async (error) => {
          // 只有 import 失败或 continueTask 进入自己的 try/finally 之前抛错才会到这——
          // 那两种情况下锁还是这里占的那把，必须还回去（continueTask 一旦接管，正常与
          // 失败路径都由它自己释放，不会落到这个分支）。
          releaseTurn(taskId, owner);
          const message = error instanceof Error ? error.message : String(error);
          console.error(`[ash] continueWhenIdle(${taskId}) failed:`, error);
          try { await onError?.(message, "failed"); } catch { /* 上报失败不再连锁 */ }
        },
      );
  });
}
