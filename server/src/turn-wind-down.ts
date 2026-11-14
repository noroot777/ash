// ── 回合的收尾段:「CLI 已经结束,这一轮还没收完」────────────────────────────────
// 单飞回合的锁要等到起跑方(orchestrator / task-run / reattach)那道 finally 才放,而它前面
// 隔着一长串收尾 await:回收后代、写会话、补录交卷、结算、基线对账、结算后续……其中一步不
// 返回,锁就一直占着,点运行一律 409。
//
// ## 这里只做「记步」,不做「放开」
//
// 原则是**同一个任务任何时刻只有一个回合的代码活着**,锁只由占着它的那一轮在自己的出口放。
// 一条卡住的进程内调用链没有办法从外面结束(Node 杀不掉一条 async 链),从旁边把它的锁拿走
// 等于让它和下一轮并存 —— 它之后的每一次写库、起的每一个子进程都可能落到新一轮头上。上一次
// 沿那条路做了 9 个提交仍没收敛(任务 wuzq0lVUsMc9,复盘在 kFyO7VBh9XcH)。所以:
//   · 收尾里**等外部东西**的那几步各自有时限,到点由这一轮自己放弃那一步、留痕、继续走到
//     自己的放锁出口(时限住在各步自己那里,例如 turn-baseline.ts 的工作区快照);
//   · 这里记下**走到了哪一步、什么时候进的**,巡检据此在同一步停太久时写一条持久提示,说清
//     卡在哪、出路是重启 ash(turn-lock-reclaim.ts `reportStuckWindDowns`);
//   · 人工放开对这类锁继续拒绝,拒绝的话里带同样的说明。
//
// 记录**挂在那把锁的身份上**(`TurnIdentity.windDown`),跟锁同生同死:放锁即带走,换了主人
// 的锁上读不到上一轮的记录。依赖单向:这里读写 turn-lock 交出来的身份,turn-lock 只借类型。
import { AsyncLocalStorage } from "node:async_hooks";
import { turnIdentity, type TurnOwner } from "./turn-lock.js";

/**
 * 收尾停在同一步多久才写「卡住了」的提示。
 *
 * 为什么按「停在同一步」计:收尾一直在往前走,哪怕走得慢,也说明它会自己放锁;只有原地不动
 * 才是卡住。为什么 10 分钟:各步正常是秒级;最慢的是回收 CLI 甩出去的后台后代(自带等待上界,
 * executors/kill.ts)和工作区快照那几条 git(各自有时限,见 `WIND_DOWN_COMMAND_TIMEOUT_MS`)。
 * 取到 10 分钟,有界的步骤够不着。可用 `ASH_STUCK_WIND_DOWN_MS`(毫秒)调,回归测试靠它压窗口。
 */
export const STUCK_WIND_DOWN_MS = (() => {
  const configured = Number(process.env.ASH_STUCK_WIND_DOWN_MS);
  return Number.isFinite(configured) && configured > 0 ? configured : 10 * 60_000;
})();

/**
 * 「结算后续」那一步的提示阈值:里面会同步跑完预设工作流的站点线(命令站自带 20 分钟上限,
 * 一条线上可以有好几站)、派审、补推队列,正常就可能是几十分钟。取基准的 6 倍(缺省 60 分钟),
 * 跟同一个环境变量一起缩放。
 */
export const LONG_WIND_DOWN_STEP_MS = 6 * STUCK_WIND_DOWN_MS;

/**
 * 收尾里每一条外部命令(git 之类)的时限。到点按进程组杀掉,那一步按它自己的「取不到」处理
 * (exec.ts `execFileText` 的 `timeoutMs`)。正常是毫秒到秒级;2 分钟只为兜住超大仓库的
 * `git diff HEAD`。可用 `ASH_WIND_DOWN_COMMAND_TIMEOUT_MS` 调。
 */
export const WIND_DOWN_COMMAND_TIMEOUT_MS = (() => {
  const configured = Number(process.env.ASH_WIND_DOWN_COMMAND_TIMEOUT_MS);
  return Number.isFinite(configured) && configured > 0 ? configured : 2 * 60_000;
})();

/**
 * 「结算后续」那一步里等外部东西(没自带上限的 git、仓库锁)的时限:派审要准备工作目录、预设
 * 工作流的验收要排仓库锁再合并,前面排着别人的验收或网络 git 时正常就要几分钟。取单条命令时限的
 * 5 倍(缺省 10 分钟),跟同一个环境变量一起缩放。
 */
export const WIND_DOWN_SETTLEMENT_WAIT_MS = 5 * WIND_DOWN_COMMAND_TIMEOUT_MS;

export type WindDown = {
  /** 进入收尾段的时刻(CLI 事件流结束)。 */
  since: number;
  /** 此刻停着的那一步。 */
  step: string;
  /** 进到这一步的时刻。 */
  stepAt: number;
  /** 停在这一步多久算卡住。 */
  boundMs: number;
  /** 这是收尾的第几步(从 1 起)。巡检按「哪一轮的哪一步」去重,同一步只报一次。 */
  index: number;
};

/**
 * 记下「这一轮正在收尾,此刻走到了 `step`」。第一次调用即进入收尾段。
 *
 * 锁已经不是 `owner` 那一把(或者压根没传凭据)时什么都不记 —— 记步只是诊断,不改变收尾
 * 往下走不走:锁由这一轮自己放,别人拿不走,所以这里没有「被放开了就停下」那一档。
 */
export function windDownStep(
  taskId: string,
  owner: TurnOwner | null | undefined,
  step: string,
  boundMs = STUCK_WIND_DOWN_MS,
): void {
  if (!owner) return;
  const held = turnIdentity(taskId);
  if (held?.seq !== owner.seq) return;
  const at = Date.now();
  const prior = held.windDown;
  held.windDown = { since: prior?.since ?? at, step, stepAt: at, boundMs, index: (prior?.index ?? 0) + 1 };
}

/** 停在这一步已经超过它的阈值了吗。 */
export function windDownStuck(windDown: WindDown, at = Date.now()): boolean {
  return at - windDown.stepAt > windDown.boundMs;
}

// 不满一分钟就按秒说 —— 阈值被调低时(回归测试、临时排查)「约 0 分钟」读起来像没发生。
export const heldFor = (ms: number) => (ms < 60_000 ? `${Math.round(ms / 1000)} 秒` : `${Math.round(ms / 60_000)} 分钟`);

/**
 * 卡住时对人说的那段话:卡在哪一步、多久了、出路是什么。巡检的持久提示和人工放开的拒绝
 * 用同一份,两边说的永远是同一件事。
 */
export function stuckWindDownText(windDown: WindDown, at = Date.now()): string {
  return `这一轮的 CLI 已经结束，收尾停在「${windDown.step}」已经约 ${heldFor(at - windDown.stepAt)}`
    + `（收尾开始于约 ${heldFor(at - windDown.since)}前），回合占位因此一直没放，点运行会被挡回。`
    + "收尾里等外部命令和仓库锁的那几步都有时限，超过阈值还不动，多半是 ash 进程里这一段调用卡住了；"
    + "从外面放开占位会让它和下一轮同时活着、互相改状态，所以不提供手动放开。"
    + "出路是重启 ash：在跑的其它 agent 会被接回、不会丢；这一轮的产物都在磁盘上，"
    + "任务要是还停在「运行中」会按中断收成可重试，没走完的那几步收尾不会再补。";
}

const progressScope = new AsyncLocalStorage<{ taskId: string; owner: TurnOwner; boundMs: number; active: boolean }>();

/**
 * 在收尾的某一步里跑 `run`,其间 `noteWindDownProgress` 报的进度记到这一轮名下、沿用这一步的
 * 阈值。给「结算后续」用:它在一步里同步跑完整条预设工作流站点线,每过一站报一次,「停在同一步」
 * 才说得准,提示里也说得出卡在哪一站。`run` 结束后不再记(理由同 external-wait-bound.ts 的失效)。
 */
export async function windDownWithin<T>(taskId: string, owner: TurnOwner | null | undefined, boundMs: number,
  run: () => Promise<T>): Promise<T> {
  if (!owner) return run();
  const store = { taskId, owner, boundMs, active: true };
  try { return await progressScope.run(store, run); }
  finally { store.active = false; }
}

/** 收尾某一步内部的进度(预设工作流每过一站)。不在任何一轮收尾里时什么都不做。 */
export function noteWindDownProgress(step: string): void {
  const scope = progressScope.getStore();
  if (scope?.active) windDownStep(scope.taskId, scope.owner, step, scope.boundMs);
}
