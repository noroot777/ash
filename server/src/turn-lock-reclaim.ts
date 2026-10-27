// ── 占着不动的回合锁:诊断,以及一个由人按的放开开关 ──────────────────────────────
// 形态是「回合锁被占着,但**再没有任何人会来释放它**」。症状是整条链一起死:
//   · `/run` 一律 409「任务回合正在进行」,而 `tasks.active_turn_token` 是空的
//     (证明泄漏纯在内存态 —— 2026-10-26 实测唯一解法是重启 :4317);
//   · `stop_task` 把任务落了 canceled 也救不回来 —— 它只杀进程,而这里压根没有进程;
//   · 队列占位的两个兜底(`seat.release`、`reclaimStrandedSeat`)都以
//     `if (isTurnClaimed) return` 开头,锁被占着时双双让位,任务停在 queued;
//   · 任务停在 queued,排队消息的投递判定就永远是「等它空下来」,用户那句话静静躺在
//     托盘里(2026-10-26:70+ 分钟,日志一声不吭)。
// 全仓此前**没有任何**可以放开它的入口(HTTP 也没有),scheduler.ts 里那条注释早就承认过
// 这类「没人释放 → /run 一律 409 → 人工救不回」。
//
// ## 为什么这里只诊断、不自动放开
//
// **年龄证不了持有者已经死了。** 瞬时快照分不出「卡住了」和「正常起跑中」—— 两者都是
// 「锁占着、进程还没在册、令牌还没绑」:`claimTurn` 排在 `trackRun` 之前(所以 `isRunning`
// 答不了「有没有人正在起跑」,见 runs.ts `claimReconcileTurn`),`bindTurnToken` 排在它之后。
// 于是只剩「这个状态持续了多久」可用,而**有一整类持有者的等待本来就没有时长上界**:
//   · duet 的人工裁决门 —— `duet/index.ts` `runGate` 里 `await waitForGate(taskId)`,
//     等的是用户点一下,可以是几小时;这一支从头到尾不绑令牌(duet 目录里没有
//     `bindTurnToken`),子进程这期间也确实不在册;
//   · dispatch 的准备期 —— 合并结果审查要 `preparePostMergeReviewWorktree`,整段包在
//     `withRepoLock` 里排队等别人的 git 写操作;
//   · handoff 的导出 —— 打包整个 worktree 再传给对端。
// 对这些持有者,年龄不是「可疑」的证据,它只是**正常等待的长度**。
//
// 前一版据此自动回收,本轮审查 F1 判它是比原缺陷更重的回归:原缺陷是任务卡住,这个是
// **解除互斥**,同一个任务两个回合并跑,烧真额度、对着同一个工作区互相改。
//
// 而这个仓库早就为同一类操作立过口径(AGENTS.md「旁路会话:ash 杀不到的东西」,讲的是
// CUA 那个全局单例):
//   「兜底绝不自动杀 …… 检测到残留只如实上报,强杀走用户主动点的显式端点并明示副作用」
//   「这类不可逆又外溢的操作,默认必须是『告诉用户 + 给一个他自己按的开关』」
// 强放回合锁是同一类:判据证不了安全,后果外溢到别的回合。所以照那条口径办 ——
//   · 巡检(`reportSuspectTurns`)**只读 + 留痕**,一把锁都不碰;
//   · 放开走用户主动点的 `POST /api/tasks/:id/reclaim-turn`,响应里明示副作用;
//   · 连那条人工路也不许无条件删:它按快照条件释放(`forceReleaseTurn` 只收
//     `{ taskId, seq }`),所以哪怕判据判错,也绝不会拔到换了主人之后的那把锁。
//
// 这让安全性不再依赖「判据准不准」:判错的后果从「双跑」降级为「多一条提示」。原缺陷
// (人工救不回、只能重启)由那个开关 + 这条留痕解决 —— 用户刷新页面后看得见它卡过,
// 也看得见该按哪里(AGENTS.md 关于持久可见状态的约定)。
//
// ## 判据(用来**报告**,不用来动手)
//
//   ① `Date.now() - claimedAt > SUSPECT_TURN_MS` —— 两条正常起跑路径从 claim 到绑令牌
//      只隔几次库读加一个事务(task-run.ts / orchestrator.ts 都是先 bind 再去准备工作
//      目录),毫秒级;阈值取到分钟量级,正常起跑够不着;
//   ② `!isRunning(taskId)` —— 进程登记册里一个句柄都没有。有句柄 = 真有 CLI 在跑,
//      它的消费循环会在 finally 里还锁;
//   ③ `token === null` —— 没绑过令牌。绑了 = 这一轮已经落过库,结算路径认得它。
//
// 外加按角色排除 `UNBOUNDED_WAIT_ROLES`。那不是一张「出过事就往里加一个」的补丁清单,
// 是一个判据:**持有者的等待有没有时长上界**。没有上界 → ① 在它身上不携带任何信息,
// 报出来纯是噪音(每个等裁决的 duet 任务都会收到一条「可疑」)。清单漏了谁的代价也只是
// 一条多余的提示 —— 上面那条不变量兜着。
import { eq } from "drizzle-orm";
import { db } from "./db/index.js";
import { tasks } from "./db/schema.js";
import { isRunning, isTurnClaimed } from "./runs.js";
import { forceReleaseTurn, heldTurns } from "./turn-lock.js";
import { noteSystemNotice } from "./user-action-rejection.js";

/**
 * 一把「无句柄、无令牌」的锁占多久开始报可疑。
 *
 * 为什么 60 秒够:两条起跑路径从 `claimTurn` 到 `bindTurnToken` 之间只有几次库读加一个
 * 事务(task-run.ts、orchestrator.ts 都是先绑令牌、再去准备工作目录和 spawn),毫秒级。
 * 留这么宽只为兜住一种已知的慢:SQLite 写锁撞上时那个事务会卡几秒(第 6、7 轮审查注入
 * 过 7 秒)。等待无上界的那几种角色不走年龄判据,见 `UNBOUNDED_WAIT_ROLES`。
 */
export const SUSPECT_TURN_MS = (() => {
  // 可调(`ASH_SUSPECT_TURN_MS`,毫秒):回归测试要把这个窗口压到毫秒级才测得动真实的
  // HTTP 救援路径,照 `ASH_MONITOR_SCAN_MAX_BYTES` 等数值常量同一口径从环境读。
  const configured = Number(process.env.ASH_SUSPECT_TURN_MS);
  return Number.isFinite(configured) && configured > 0 ? configured : 60_000;
})();

/**
 * **持有者的等待没有时长上界**的那些占位身份 —— 年龄对它们不携带信息,所以不进判据
 * (理由与各自等的是什么,见文件头「为什么这里只诊断」)。
 *
 * `reconcile` 在这张表里是另一个理由:它是**诊断路径自己的**预占,纳入会自噬。
 */
const UNBOUNDED_WAIT_ROLES = new Set([
  "duet",      // 等用户点裁决门(waitForGate),小时级
  "dispatch",  // 等 withRepoLock + 建 worktree
  "handoff",   // 等打包 worktree 并传给对端
  "scm",       // 等 SCM 面板那一串 git 操作
  "reconcile", // 诊断路径自己的预占
]);

export type SuspectTurn = {
  taskId: string;
  role: string;
  /**
   * 这把锁的**占用身份号**。拿着它去 `forceReleaseTurn` 才是条件释放 —— 快照和释放之间
   * 换了主人就对不上号、什么都不会发生(见 turn-lock.ts `TurnIdentity.seq`)。
   */
  seq: number;
  claimedAt: number;
  /** 这把锁已经占了多久(毫秒),写进日志与时间线。 */
  heldMs: number;
};

/**
 * 此刻符合可疑判据的那些锁。**只读、同步** —— 同步是契约的一部分:人工放开那条路要
 * 「重算判据 → 条件释放」不隔 await(见 `releaseSuspectTurn`)。
 */
export function suspectTurns(at = Date.now(), thresholdMs = SUSPECT_TURN_MS): SuspectTurn[] {
  return heldTurns()
    .filter((held) => !UNBOUNDED_WAIT_ROLES.has(held.role))
    .filter((held) => held.token === null)
    .filter((held) => !isRunning(held.taskId))
    .filter((held) => at - held.claimedAt > thresholdMs)
    .map((held) => ({ taskId: held.taskId, role: held.role, seq: held.seq, claimedAt: held.claimedAt, heldMs: at - held.claimedAt }));
}

// 不满一分钟就按秒说 —— 阈值被调低时(回归测试、临时排查)「约 0 分钟」读起来像没发生。
const held = (ms: number) => (ms < 60_000 ? `${Math.round(ms / 1000)} 秒` : `${Math.round(ms / 60_000)} 分钟`);

const SIDE_EFFECT =
  "放开之后这个任务就能再次运行；代价是万一原来那一位其实还活着（比如正在等一个很慢的"
  + "准备步骤），互斥就没了，同一个任务会有两个回合并行改同一个工作区。";

/**
 * 已经报过的占用(`taskId:seq`)。按**占用身份号**去重,所以同一把锁只报一次 —— 配 30 秒
 * 的 tick,不去重就是每半分钟一条。换一把新锁(新号)会重新报。
 */
const told = new Set<string>();
const reporting = new Set<string>();

/**
 * 巡检:把可疑的锁如实报出来。**一把都不碰**(理由见文件头)。返回这一趟新报了几把。
 *
 * 留痕是硬要求:只打日志不算数,用户刷新页面后要能看出这里卡住过、以及该按哪里
 * (AGENTS.md 关于持久可见状态的约定)。
 */
export async function reportSuspectTurns(thresholdMs = SUSPECT_TURN_MS): Promise<number> {
  const suspects = suspectTurns(Date.now(), thresholdMs);
  // 已经不在占着的那些从去重表里清掉,免得这张表随进程寿命单调增长。
  const alive = new Set(heldTurns().map((h) => `${h.taskId}:${h.seq}`));
  for (const key of told) if (!alive.has(key)) told.delete(key);

  let reported = 0;
  for (const suspect of suspects) {
    const key = `${suspect.taskId}:${suspect.seq}`;
    if (told.has(key) || reporting.has(key)) continue;
    reporting.add(key);
    const detail = `占位身份 ${suspect.role}、已持有约 ${held(suspect.heldMs)}`;
    console.warn(
      `[ash] 回合占位占着不动 task=${suspect.taskId}（${detail}）`
      + "：进程登记册里没有句柄、也没有绑过回合令牌。不自动放开（可能有人正在长时间准备），"
      + `需要时走 POST /api/tasks/${suspect.taskId}/reclaim-turn`,
    );
    try {
      const persisted = await noteSystemNotice(
        suspect.taskId,
        `suspect-turn:${suspect.claimedAt}:${suspect.seq}`,
        "回合占位占着不动",
        `这个任务的回合占位占着不动（${detail}），期间点运行会被挡回「任务回合正在进行」。`
        + "没有进程在册、也没有绑过回合令牌，但系统**无法确认**原来那一位是否真的已经结束，"
        + "所以不会自动放开。确认它确实不动了，用任务详情页上的「放开回合占位」手动解开"
        + `（或 POST /api/tasks/${suspect.taskId}/reclaim-turn）——**点运行是解不开的**，那条路只会继续被挡回。`
        + SIDE_EFFECT,
      );
      if (persisted) {
        told.add(key);
        reported += 1;
      }
    } finally {
      reporting.delete(key);
    }
  }
  return reported;
}

/** `releaseSuspectTurn` 的结果。`ok:false` 带 `why` 给路由映射状态码与话术。 */
export type ReleaseSuspectResult =
  | {
    ok: true;
    role: string;
    heldMs: number;
    /**
     * **锁放开了,这个任务现在真的点得动吗。**
     *
     * 这两件事不是一件:放开只撤掉内存里那把锁,库里的状态是另一个人的责任 —— 正常
     * 路径上由那把锁的持有者在 finally 里回滚(seat.release / reclaimStrandedSeat),
     * 而本入口要救的恰恰是**再没有人会来回滚**的那种遗留。于是任务停在 queued、
     * `/run` 继续 409「任务当前状态不可运行」,开关却因为锁已经空了而从界面上消失
     * (第 1 轮审查 F3 实测:POST reclaim 回 200「现在可以继续运行」,紧接着 POST run
     * 回 409 `status:"queued"`)。
     *
     * 所以成功的定义收紧成「**恢复了可运行状态,或确实有新回合接手了**」。没恢复不是
     * 错误、也不回滚这次放开(锁确实该放),但响应和留痕都得说真话并给出下一步。
     */
    runnable: boolean;
    /** 放开之后库里的状态(给话术用;读不到时为 null)。 */
    status: string | null;
    /** 没恢复时,用户接着该做的那一步;恢复了为 null。 */
    nextStep: string | null;
  }
  | { ok: false; why: "no-lock" | "not-suspect"; reason: string };

/**
 * 锁放开之后,这个任务还卡着吗。
 *
 * **判据不是「点运行能不能起」**:`canSingleRun` 对 `done` 也返回 false(终态要续聊、
 * 不走 /run),而一个 done 的任务放开占位之后本来就该是 done —— 那不是卡住,报出来只是
 * 噪音(实测日志:`放开了回合占位但任务仍不可运行 task=t-ghost（状态 done）`)。
 * `awaiting_review` 同理,它是明确的「等人」语义。
 *
 * 要答的是**「它还停在刚放开的那一轮留下的状态里吗」**。只有 `queued` / `running` 是
 * 「有一轮在跑」的状态,而那一轮已经被我们放开了,没人会再来把它改回去 —— 这两种才是
 * 残留,也只有这两种需要告诉用户下一步。
 */
async function runnableAfterRelease(taskId: string): Promise<{ runnable: boolean; status: string | null; nextStep: string | null }> {
  // 新回合已经接手 = 这把锁空出来之后立刻有人占上了,状态由那一轮自己负责,不该再说
  // 「你还要去停一次」。
  if (isTurnClaimed(taskId)) {
    return { runnable: true, status: null, nextStep: null };
  }
  let row: { status: string } | undefined;
  try {
    row = (await db.select({ status: tasks.status }).from(tasks).where(eq(tasks.id, taskId))).at(0);
  } catch (error) {
    console.warn(`[ash] 放开回合占位后读状态失败 task=${taskId}:`, error);
    return { runnable: false, status: null, nextStep: "刷新一下页面看它现在的状态；要是还停在「排队中」，点一次停止把它收成「已取消」，然后就能重新运行" };
  }
  if (!row) return { runnable: false, status: null, nextStep: null };
  if (row.status !== "queued" && row.status !== "running") {
    return { runnable: true, status: row.status, nextStep: null };
  }
  return {
    runnable: false,
    status: row.status,
    nextStep: `任务还停在「${row.status === "queued" ? "排队中" : "运行中"}」—— 那是刚放开的那一轮留下的，`
      + "没有人会再来把它改回去了。点一次停止把它收成「已取消」，之后就能重新运行",
  };
}

/**
 * **用户主动点的放开。** 判据不因为「是人点的」就放宽 —— 人看到的那条提示也只是「可疑」,
 * 它同样证不了原持有者已经结束。所以这里照样过一遍判据,过不了就如实 409。
 *
 * 核心是那两行**不隔 await**:重算判据拿到的快照立刻交给条件释放。判定要读进程登记册、
 * 要查角色和年龄,这些都是同步的;一旦中间插进 await(查库、写时间线),锁就可能已经换了
 * 主人,而拔掉后来者那把 = 同一个任务两个回合并跑(本轮审查 F2)。留痕排在释放之后。
 */
export async function releaseSuspectTurn(
  taskId: string,
  thresholdMs = SUSPECT_TURN_MS,
): Promise<ReleaseSuspectResult> {
  const now = Date.now();
  const current = heldTurns().find((h) => h.taskId === taskId);
  if (!current) return { ok: false, why: "no-lock", reason: "这个任务没有被占着的回合占位，不需要放开" };
  // 重算判据 → 条件释放,这中间一个 await 都没有。
  const suspect = suspectTurns(now, thresholdMs).find((s) => s.taskId === taskId);
  if (!suspect) {
    return { ok: false, why: "not-suspect", reason: notSuspectReason(current, now, thresholdMs) };
  }
  const released = forceReleaseTurn(suspect);
  if (!released) {
    // 号码对不上 = 判定到这一行之间换了主人。这是条件释放该有的样子,不是错误。
    return { ok: false, why: "not-suspect", reason: "这个回合占位刚刚换了主人，已经有新的一轮接手了" };
  }
  const detail = `占位身份 ${released.role}、已持有约 ${held(suspect.heldMs)}`;
  console.warn(`[ash] 用户主动放开回合占位 task=${taskId}（${detail}）`);
  // 核对后置条件(理由见 `runnable`)。排在释放之后 —— 释放那两行一个 await 都不能隔。
  const after = await runnableAfterRelease(taskId);
  if (!after.runnable) {
    console.warn(`[ash] 放开了回合占位但任务仍不可运行 task=${taskId}（状态 ${after.status ?? "读不到"}）`);
  }
  await noteSystemNotice(
    taskId,
    `released-turn:${suspect.claimedAt}:${suspect.seq}`,
    "回合占位已放开",
    `这个任务的回合占位已由你手动放开（${detail}）。`
    + (after.runnable ? "现在可以继续运行了。" : `但它还点不动运行：${after.nextStep ?? "请刷新查看当前状态"}。`)
    + SIDE_EFFECT,
  );
  return { ok: true, role: released.role, heldMs: suspect.heldMs, ...after };
}

/** 没过判据时说清是哪一条没过 —— 否则 409 只是一句「不行」,用户无从判断下一步。 */
function notSuspectReason(
  current: { taskId: string; role: string; token: string | null; claimedAt: number },
  now: number,
  thresholdMs: number,
): string {
  if (UNBOUNDED_WAIT_ROLES.has(current.role)) {
    return `这个回合占位的身份是 ${current.role}，它正常就会长时间持有（等人工裁决、等仓库锁、等打包传输），`
      + "系统无法按「占了多久」判断它是不是卡住了。确认那一侧确实不动了，用停止任务来收它";
  }
  if (current.token !== null) return "这一轮已经绑过回合令牌，它有正常的结算路径，不该从旁边拔掉";
  if (isRunning(current.taskId)) return "这个任务此刻真有 CLI 进程在跑，要收掉它请用停止任务";
  return `这个回合占位才持有了 ${held(now - current.claimedAt)}，还在正常起跑的时间范围内（阈值 ${held(thresholdMs)}），再等一会儿`;
}
