// ── 幽灵回合锁的回收 ──────────────────────────────────────────────────────────
// 「回合锁被占着,但**再没有任何人会来释放它**」这个形态。症状是整条链一起死:
//   · `/run` 一律 409「任务回合正在进行」,而 `tasks.active_turn_token` 是空的
//     (证明泄漏纯在内存态,重启就好 —— 2026-10-26 实测唯一解法就是重启 :4317);
//   · `stop_task` 把任务落了 canceled 也救不回来 —— 它只杀进程,而这里压根没有进程;
//   · 队列占位的两个兜底(`seat.release`、`reclaimStrandedSeat`)都以
//     `if (isTurnClaimed) return` 开头,于是锁被幽灵占着时双双放弃,任务永久停在 queued;
//   · 任务停在 queued,排队消息的投递判定就永远是「等它空下来」,用户那句话静静躺在
//     托盘里(2026-10-26:70+ 分钟,日志一声不吭)。
// 全仓此前**没有任何**可以释放它的入口(HTTP 也没有),scheduler.ts 里那条注释
// 早就承认过这类「没人释放 → /run 一律 409 → 人工救不回」。
//
// ## 判据:三条同时成立才算幽灵
//
// 瞬时快照分不出幽灵和「正常起跑中」—— 两者都是「锁占着、进程还没在册、令牌还没绑」:
// `claimTurn` 排在 `trackRun` 之前(所以 `isRunning` 答不了「有没有人正在起跑」,见
// runs.ts `claimReconcileTurn`),`bindTurnToken` 排在它之后。唯一的区别是**持续多久**:
//
//   ① `Date.now() - claimedAt > STALE_TURN_MS` —— 正常路径从 claim 到绑上令牌只隔几次
//      库读加一个事务(task-run.ts / orchestrator.ts 都是先 bind 再去准备工作目录),
//      毫秒级;阈值取到分钟量级,正常起跑够不着;
//   ② `!isRunning(taskId)` —— 进程登记册里一个句柄都没有。有句柄 = 真有 CLI 在跑,
//      它的消费循环会在 finally 里还锁;
//   ③ `token === null` —— 没绑过令牌。绑了 = 这一轮已经落过库,结算路径认得它。
//
// ②③ 任一成立就说明「有主」,放着不动。宁可多等一轮,不许拔错 —— 拔掉一把正在起跑的锁
// 就是同一个任务起两个回合,比卡住严重得多。
//
// ## 不是所有角色都纳入
//
// 回合锁同时被几种**不是回合**的预占借用(见 turn-lock.ts)。其中三种天生长时间「无句柄、
// 无令牌」,按上面的判据会被误判:
//   · `scm`       SCM 面板占着工作区跑 git —— 大仓库的 git 操作可以跑很久;
//   · `handoff`   接力导出 —— 要打包整个 worktree 再传给对端;
//   · `reconcile` 重启后的残留结算 —— 短,但它是**回收路径自己的**预占,纳入会自噬。
// 这三种各自都包在明确的 try/finally 里,所以排除它们不留缺口。
// `lead-wake`(调度台收唤醒)同样短且带 finally,但它一旦泄漏症状与幽灵锁完全一致
// (状态改不动),所以**纳入** —— 阈值远大于它的正常生命周期,不会误伤。
//
// ## 回收之后
//
// 拔锁走 `forceReleaseTurn`,它连 `afterTurn` 回调一起放走:幽灵锁底下往往正压着
// 「等这一轮跑完再送」的交接(排队消息投递、队列补推),只拔锁不放它们,任务照旧停在原地。
// 然后**如实留痕**:一行 warn + 一条任务时间线。时间线那条是硬要求 —— 用户刷新页面后
// 仍要能看出「这里曾经卡住过、是谁替它解开的」(AGENTS.md 关于持久可见状态的约定)。
import { isRunning } from "./runs.js";
import { forceReleaseTurn, heldTurns } from "./turn-lock.js";
import { appendTaskTimeline } from "./task-timeline.js";

/**
 * 一把「无句柄、无令牌」的锁占多久才算幽灵。
 *
 * 为什么 60 秒就够:两条起跑路径从 `claimTurn` 到 `bindTurnToken` 之间**只有几次库读加一个
 * 事务**(task-run.ts、orchestrator.ts 都是先绑令牌、再去准备工作目录和 spawn),毫秒级;
 * 那些从不绑令牌的预占(`dispatch`/`status`/`team`/`lead-wake`)也都在秒级内走完自己的
 * try/finally。所以这个窗口比任何正常持有都大一到两个数量级 —— 留这么宽只为兜住一种已知
 * 的慢:SQLite 写锁撞上时那个事务会卡几秒(第 6、7 轮审查注入过 7 秒)。
 *
 * 代价方向是「真卡住时用户要等多久才自动恢复」:配 30 秒的 tick,实测最坏约 90 秒。等不及
 * 的人走 `POST /api/tasks/:id/reclaim-turn` 立刻回收。
 */
export const STALE_TURN_MS = (() => {
  // 可调(`ASH_STALE_TURN_MS`,毫秒):回归测试要把这个窗口压到毫秒级才测得动真实的 HTTP
  // 救援路径,照 `ASH_MONITOR_SCAN_MAX_BYTES` 等数值常量同一口径从环境读。
  const configured = Number(process.env.ASH_STALE_TURN_MS);
  return Number.isFinite(configured) && configured > 0 ? configured : 60_000;
})();

/** 按判据排除的预占角色(理由见文件头「不是所有角色都纳入」)。 */
const EXEMPT_ROLES = new Set(["scm", "handoff", "reconcile"]);

export type StaleTurn = {
  taskId: string;
  role: string;
  /** 这把锁已经占了多久(毫秒),写进日志与时间线。 */
  heldMs: number;
};

/**
 * 此刻符合幽灵判据的那些锁。**只读** —— 判定与回收分开,好让回归测试与 HTTP 只读探测
 * 都能拿到同一份判断而不产生副作用。
 */
export function staleTurns(at = Date.now(), thresholdMs = STALE_TURN_MS): StaleTurn[] {
  return heldTurns()
    .filter((held) => !EXEMPT_ROLES.has(held.role))
    .filter((held) => held.token === null)
    .filter((held) => !isRunning(held.taskId))
    .filter((held) => at - held.claimedAt > thresholdMs)
    .map((held) => ({ taskId: held.taskId, role: held.role, heldMs: at - held.claimedAt }));
}

// 不满一分钟就按秒说 —— 阈值被调低时(回归测试、临时排查)「约 0 分钟」读起来像没发生。
const held = (ms: number) => (ms < 60_000 ? `${Math.round(ms / 1000)} 秒` : `${Math.round(ms / 60_000)} 分钟`);

/**
 * 回收一把已经判定为幽灵的锁:拔锁 + 留痕。
 *
 * **判定不在这里**(调用方要么来自 `sweepStaleTurns`,要么是用户显式点的救援入口),
 * 但拔之前会再核一次「它还在被占着吗」—— 从判定到这里隔着 await,原持有者完全可能
 * 刚好自己还了锁、另一个正常回合随即占上。
 */
export async function reclaimStaleTurn(stale: StaleTurn, how: "巡检" | "人工"): Promise<boolean> {
  const released = forceReleaseTurn(stale.taskId);
  if (!released) return false; // 判定之后它自己还了锁,无事可做
  const detail = `占位身份 ${released.role}、已持有约 ${held(stale.heldMs)}`;
  console.warn(
    `[ash] ${how}回收无主的回合锁 task=${stale.taskId}（${detail}）`
    + "：进程登记册里没有句柄、也没有绑过回合令牌，不会再有人来释放它",
  );
  // 持久可见:只打日志不算数,用户刷新页面后也要能看出这里卡过一次。
  await appendTaskTimeline(
    stale.taskId,
    `〔系统〕这个任务的回合占位已被${how}回收（${detail}）。`
    + "它被占着却没有任何回合在跑，期间点运行会被挡回「任务回合正在进行」；现在已经可以继续运行了。",
  );
  return true;
}

/** 扫一遍并回收。返回这一趟真正回收了几把。 */
export async function sweepStaleTurns(thresholdMs = STALE_TURN_MS): Promise<number> {
  let reclaimed = 0;
  for (const stale of staleTurns(Date.now(), thresholdMs)) {
    try {
      if (await reclaimStaleTurn(stale, "巡检")) reclaimed += 1;
    } catch (error) {
      // 一把的失败不影响其余;下一趟还会扫到它。
      console.error(`[ash] 回收无主回合锁失败 task=${stale.taskId}:`, error);
    }
  }
  return reclaimed;
}
