import type { TaskListItem } from "@ash/shared";
import { isTeamSettled, teamNeverStarted } from "@ash/shared/team";
import { awaitsAcceptance, awaitsRuling, hasFailed, isAcceptedStage, spreadBucket, type SpreadBucket } from "./taskAttention.ts";

// 一条任务「现在怎么样」的唯一出处：侧栏行首画什么、指上去说什么、行尾那两三个字、算进
// 顶上筛选的哪一颗 —— 全从 taskLook 一处取。从前行首那颗点（useTaskReadState）和顶上那排
// 点（spreadBucket）各判各的：在跑的行是灰色呼吸点、顶上「在跑」却是靛蓝；失败的行看过一眼
// 就塌成跟已验收一样的灰环，顶上照旧把它算进「需要你处理」。两边对不上，人就不知道该信哪个。
//
// 颜色不追求跟顶上一一对应：行首说的是「这一条现在怎么样」，顶上说的是「归哪一档」。
// 失败（红点）、做完没验收（靛蓝环）都归琥珀色的「需要你处理」；验收过没看（绿点）归青色的
// 「验收完成」。要它们一一对上就得改顶上那排保留项的颜色，那排不动。

export type TaskStatusIndicator =
  | "pending"
  /** 机器在动：running / awaiting_review，团队里有执行者在跑。 */
  | "active"
  /** 排在队里、还没轮到。归档仍是「在跑」（任务模式的口径），但样子跟真在跑的分开。 */
  | "queued"
  /** 要它起跑了，在等前置站稳（shared/src/prerequisites.ts）。画法同排队：都是「轮到了自己会起」。 */
  | "waiting"
  /** 轮到你说话：在等答复、等你裁定驳回、停在检查点、前置齐了却开不了工。 */
  | "attention"
  /** 有东西在后台替它跑着、而且会自己回来：挂着的哨兵、正在跑的验收前置命令。不用你管。 */
  | "working"
  /**
   * 它看着在跑,其实在**干等模型上游**(回合级停滞看门狗,见 server/src/turn-stall.ts)。
   *
   * 跟 "working" 正相反:那是「有东西会自己回来」,这是「大概回不来,到点会被熔断」。
   * 跟 "error" 也不是一回事 —— 那一档是已经收场了,这一档还在倒计时、还能救(重试或换
   * 执行器)。所以颜色用红、形状用环:红说「出事了」,环说「等你动手」。
   */
  | "stalled"
  | "unaccepted"
  /** 验收过、还有没看的动态：点开就熄。 */
  | "success"
  /** 摔了（失败 / 验证没过）。一直亮着，跟读没读过无关 —— 失败是越老越该被看见的一档。 */
  | "error";

const liveWork = (task: TaskListItem): boolean => !!task.acceptGateRunning || !!task.monitorRunning;

/**
 * 「它此刻在干等上游」。
 *
 * 停滞是**派生事实**(标记在 + 那条会话没收尾 + 任务真的在跑,三条都在 server/src/task-store.ts
 * 的投影里),可后台水位只盯那个标记列 —— 乱序到达的旧响应于是能把「旧的 true」和「新的状态」
 * 拼在一起,卡片上亮一个过期的红环(第 3 轮审查 N1,未实测、按代码推断)。这里跟服务端**同一个
 * 口径**再问一次:条件一致,正常情形下一个字都不变,只是不让陈旧的 true 自己说话。
 */
const stalledNow = (task: TaskListItem): boolean => !!task.upstreamStalled && task.status === "running";
const runningNow = (task: TaskListItem): boolean => task.status === "running" || task.status === "awaiting_review";

export function deriveTaskStatusIndicator(
  task: TaskListItem,
  workers: TaskListItem[] = [],
  unread = false,
): TaskStatusIndicator | null {
  if (task.mode === "team" && !task.parentId) {
    // 「等你说话」和「等一件会自己回来的事」分开，判据见下面单飞那一段。
    if (task.question || workers.some((worker) => worker.question) || awaitsRuling(task)) return "attention";
    // 排在 working/active 之前:一台卡在上游的调度台这三档全都成立,而「它其实没在动」是
    // 其中唯一需要用户做点什么的那一位。
    if (stalledNow(task) || workers.some(stalledNow)) return "stalled";
    if (liveWork(task) || workers.some(liveWork)) return "working";
    if (task.status === "running" || workers.some(runningNow)) return "active";
    if (workers.some((worker) => worker.status === "queued")) return "queued";
    if (task.status === "paused" || workers.some(worker => worker.status === "paused")) return "attention";
    // 调度台自己摔了：跟 spreadBucket 一样直接算「需要你处理」，红点一直在。
    if (hasFailed(task)) return "error";
    if (task.status === "backlog" && workers.every((worker) => worker.status === "backlog")) {
      return "pending";
    }
    const settled = isTeamSettled(false, workers);
    // 收了工、有执行者摔了、还没盖章：这一队要你来看，跟单飞的失败一样一直红着。
    // 盖过章的就不再红 —— 那是你看过、认了的结果。
    if (settled && !teamNeverStarted(task.status) && !isAcceptedStage(task) && workers.some(hasFailed)) return "error";
    // 团队收工 = 它的「干完了」。没盖章就一直亮着未验收，跟读没读过无关。
    // 从没开过台的（还停在 backlog）不算收工 —— 那是没开始，不是等验收。
    if (!teamNeverStarted(task.status) && awaitsAcceptance(task, settled)) return "unaccepted";
    return unread && settled ? "success" : null;
  }

  if (task.question) return "attention";
  if (stalledNow(task)) return "stalled"; // 同上:排在 working/active 之前
  if (liveWork(task)) return "working";
  // 失败排在暂停、在跑之前，跟 spreadBucket 把它压在「在跑」之上同一个口径。
  if (task.status === "failed") return "error";
  // 等你裁定：任务多半已经 done（或停在检查点），只看 status/stage 会读成「做完了，等验收」。
  // 排在「验证没过」前面：被驳回的正是那一轮没过的结论，下一步是你拍板，不是去看失败。
  if (awaitsRuling(task)) return "attention";
  if (hasFailed(task)) return "error";
  if (task.status === "paused") return "attention";
  if (runningNow(task)) return "active";
  if (task.status === "queued") return "queued";
  if (task.status === "backlog") {
    // 前置都站稳了却开不了工（合不拢）：要你去处理；只是在等：跟没要求起跑的待办分开。
    if (task.prerequisites?.blocked) return "attention";
    return task.prerequisites?.waiting ? "waiting" : "pending";
  }
  // 「干完了但我还没验收」是持久事实，不是未读提醒：已读之后仍要标出来，
  // 否则做完的任务全都塌成同一种样子，分不出哪些还等着我盖章。
  // 执行者不进这一档 —— 验收是顶层任务的事（accept_task 拒绝共享执行者）。
  if (!task.parentId && awaitsAcceptance(task, task.status === "done")) return "unaccepted";
  // 取消的不亮：那是你自己停的，不算「出事了」也不算「做完了」。
  return unread && task.status === "done" ? "success" : null;
}

/** 侧栏行首那颗记号的画法（task-status-dot.css 的 .workspace-status-dot--*）。null = 槽空着、位置留着。 */
export type TaskMark = "run" | "queue" | "wait" | "hold" | "stalled" | "open" | "new" | "bad";

// 那张表。say 是指着记号时那句话（也是读屏念的）；没有记号就没有话。
// 待排期（pending）在侧栏上不画：它就是「还没动过」，归「排着 / 暂停」那一档已经说清了。
// 团队页、任务头那几颗点（TaskStatusDot）用的是同一列 say。
export const TASK_LOOK: Record<TaskStatusIndicator, { mark: TaskMark | null; say: string }> = {
  active: { mark: "run", say: "运行中" },
  queued: { mark: "queue", say: "排队中" },
  waiting: { mark: "queue", say: "在等前置任务" },
  attention: { mark: "wait", say: "需要人工输入" },
  working: { mark: "hold", say: "在等后台的事跑完，它会自己回来" },
  stalled: { mark: "stalled", say: "在干等模型上游回话，没有任何输出" },
  unaccepted: { mark: "open", say: "已完成，等你验收" },
  success: { mark: "new", say: "验收过，有没看的动态" },
  error: { mark: "bad", say: "失败" },
  pending: { mark: null, say: "尚未开始" },
};

/**
 * 名下派出去的任务（Task.dispatchedBy，整棵往下）往上带到这一行的那几档，排前面的压过排后面的。
 *
 * 派出去的活收在派它的那条下面以后，派它的那条大多早就 done 了：只看它自己，名下还在跑、在问你、
 * 摔了，行首照样是一圈「已完成，等你验收」，收起来就什么都看不出。所以跟团队调度台看执行者一样，
 * 名下的这几档往上带；它自己那几档里只有「轮到你」的（等答复 / 裁定、失败、卡在上游）排在
 * 「名下在跑」之前，其余（做完没验收、没看的动态、没开始）都让给名下。
 */
const ROLL_UP: readonly TaskStatusIndicator[] = ["attention", "error", "stalled", "active", "working", "queued", "waiting"];

function rollUpRank(indicator: TaskStatusIndicator | null): number {
  const at = indicator ? ROLL_UP.indexOf(indicator) : -1;
  return at < 0 ? ROLL_UP.length : at;
}

/** 名下整棵里最该被看见的那一档（ROLL_UP 之外的不往上带）；没有就是 null。 */
export function dispatchedRollUp(indicators: readonly (TaskStatusIndicator | null)[]): TaskStatusIndicator | null {
  let best: TaskStatusIndicator | null = null;
  for (const indicator of indicators) {
    if (rollUpRank(indicator) < rollUpRank(best)) best = indicator;
  }
  return best;
}

export type TaskLook = {
  indicator: TaskStatusIndicator | null;
  mark: TaskMark | null;
  /** 指着记号时那句话；mark 为 null 时为空串。 */
  say: string;
  /** 这颗记号说的是名下派出去的任务（dispatchedRollUp），不是这一条自己。 */
  fromDispatched: boolean;
  /** 算进顶上那排筛选的哪一颗。判据本体是 lib/taskAttention 的 spreadBucket。 */
  bucket: SpreadBucket;
  /** 行尾那两三个字（等什么）。只有明着等你答复 / 裁定、或前置齐了却开不了工时才有。 */
  word: string | null;
  /** 指着那两三个字时多给的半句（问题本身 / 开不了工的原因）。 */
  detail: string | null;
};

function questionOf(task: TaskListItem, workers: TaskListItem[]): string | null {
  if (task.question) return task.question;
  return workers.find((worker) => worker.question)?.question ?? null;
}

const DETAIL_MAX = 60;

export function taskLook(
  task: TaskListItem,
  workers: TaskListItem[] = [],
  unread = false,
  /** 名下派出去的任务的档位（整棵往下、没归档的），见 dispatchedRollUp。 */
  dispatched: TaskStatusIndicator | null = null,
): TaskLook {
  const own = deriveTaskStatusIndicator(task, workers, unread);
  const fromDispatched = rollUpRank(dispatched) < rollUpRank(own);
  const indicator = fromDispatched ? dispatched : own;
  const row = indicator ? TASK_LOOK[indicator] : null;
  const mark = row?.mark ?? null;
  // 行尾那两三个字只说这一条自己：名下哪一条在问你，那一行自己会写。
  const asked = own === "attention" ? questionOf(task, workers) : null;
  const ruling = own === "attention" && !asked && awaitsRuling(task);
  const blocked = own === "attention" && !asked && !ruling ? task.prerequisites?.blocked ?? null : null;
  const question = asked ?? blocked;
  const oneLine = question?.replace(/\s+/g, " ").trim() ?? "";
  return {
    indicator,
    mark,
    say: mark ? (fromDispatched ? `派出的任务：${row!.say}` : row!.say) : "",
    fromDispatched,
    bucket: spreadBucket(task, workers),
    word: asked ? "等你答复" : ruling ? "等你裁定" : blocked ? "开不了工" : null,
    detail: oneLine ? (oneLine.length > DETAIL_MAX ? `${oneLine.slice(0, DETAIL_MAX)}…` : oneLine) : null,
  };
}
