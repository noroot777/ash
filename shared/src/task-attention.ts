import { isAcceptedStage, type TaskListItem, type TaskStatus } from "./index.ts";
import { isTeamSettled, teamNeverStarted } from "./team.ts";

// 「此刻轮到你动手了吗」—— web 的侧栏分堆与行首圆点、mobile 的列表与行内标识、server 的
// 飞书推送，读的都是这一份。从前 web 一份、mobile 照抄一份，飞书再写第三份的话，迟早会
// 一边推着「等你验收」一边页面上写着别的；所以三方共用这里的谓词，各端只在外面包自己的
// 展示口径（mobile 不标归档、web 的分堆顺序等）。
//
// 团队一律要连执行者一起看（workers 由调用方给）：调度台派完活自己落回 idle，问题、
// 失败、收工都写在执行者身上。传空执行者表 = 按调度台自己那一行判。workers 是
// parentId === task.id 的那些行，这里不再按 parentId 过滤 —— 误把全表传进来，所有任务都会被
// 当成它的执行者。

// 「机器在动」的三种 status。团队调度台自己从不落在这三档上。
const LIVE_STATUSES = new Set<TaskStatus>(["running", "queued", "awaiting_review"]);

export function isTeamLead(task: Pick<TaskListItem, "mode" | "parentId">): boolean {
  return task.mode === "team" && !task.parentId;
}

// 「机器在动」。团队写在执行者身上：调度台派完活自己就落回 idle，只盯它会把一屋子
// 执行者正在跑的团队判成静止。
export function isTaskLive(task: TaskListItem, workers: TaskListItem[] = []): boolean {
  if (LIVE_STATUSES.has(task.status)) return true;
  return isTeamLead(task) && workers.some((worker) => LIVE_STATUSES.has(worker.status));
}

// 「这个团队收工了」。开过台是前提 —— 还停在 backlog 的团队是**没开始**，不是干完了。
export function isTeamSettledLead(task: TaskListItem, workers: TaskListItem[] = []): boolean {
  return isTeamLead(task)
    && !teamNeverStarted(task.status)
    && isTeamSettled(task.status === "running", workers);
}

// 「这一行摔了」。跑挂了（status=failed）和验证没过（stage=verify_failed）是同一件事的
// 两种记法 —— 都是活停在半路、而且下一步得人来看。
export function hasFailed(task: Pick<TaskListItem, "status" | "stage">): boolean {
  return task.status === "failed" || task.stage === "verify_failed";
}

// 「干完了但还没盖章」。settled 由调用方判断（单飞看 status === "done"，团队看 isTeamSettled）。
//
// 注意 stage 多数时候是 null —— 只有走过 report_stage 的任务才有值。null 一律算**没验收**：
// 用户要的就是「凡是我没点过验收的，都得看得见」，而不是「只有 agent 主动报过待验收的才算」。
export function awaitsAcceptance(task: Pick<TaskListItem, "stage">, settled: boolean): boolean {
  return settled && !isAcceptedStage(task.stage);
}

// 「等我盖章」= 干完了、没盖过章。**不设时限**：没点过头的活就是没落地的活，搁多久都算。
//
// 这一档来回改过两次，原委记在这儿免得再绕：
//   · 起初回落到「done 且没盖章」，于是三百多条历史任务把任务模式淹了；
//   · 收窄成只认显式 stage=awaiting_acceptance —— 可自由工作流只调 complete_task，
//     stage 多数时候是 null，今天刚干完、界面上写着「完成待验收」的任务反而进不来；
//   · 2026-08-26 查明淹掉列表的是 daily-report 那条流水线（541 条里它占 518 条，
//     连 28 条显式 awaiting_acceptance 也全是它的）。用户把那批一次性标成已验收，
//     并明确「以后不会发生这种事情」，剩下的一共 22 条 —— 到这里时限就没有存在理由了。
// 所以真正的判据只有「盖没盖章」这一条，别再往里加年龄、条数之类的兜底：那是拿口径
// 去补数据的问题，历史证明补不对。
export function isTaskAwaitingAcceptance(task: TaskListItem, workers: TaskListItem[] = []): boolean {
  if (isAcceptedStage(task.stage)) return false;
  if (task.stage === "awaiting_acceptance") return true;
  return awaitsAcceptance(task, task.status === "done" || isTeamSettledLead(task, workers));
}

// 「等我说句话」。提问是明着要答案，paused 是停在检查点等续跑 —— 两样都是「活还在半路，
// 而且下一步得人动手」。
export function awaitsYourWord(task: TaskListItem, workers: TaskListItem[] = []): boolean {
  if (task.question || task.status === "paused") return true;
  return isTeamLead(task) && workers.some((worker) => worker.question || worker.status === "paused");
}

// 「停在这儿等你指挥」= 明着问你（question），或者验证没过（verify_failed）。
//
// 跟 awaitsYourWord 的分工：那条收的是「等我说句话」（提问 / 停在检查点），服务的是
// 任务模式收哪些行；这条收的是「等我指挥」，多一档验证未通过，少一档 paused —— 停在
// 检查点是等续跑指令，行内没有跟提问同级的醒目标识，硬拉进列表的年龄豁免就成了
// 「留下来的比标出来的多」。
export function needsYourCommand(task: TaskListItem, workers: TaskListItem[] = []): boolean {
  const stuck = (item: TaskListItem) => !!item.question || item.stage === "verify_failed";
  return stuck(task) || (isTeamLead(task) && workers.some(stuck));
}

// ── 推给人的「下一步」：飞书推送用 ──────────────────────────────────────────────
// 「此刻要人做哪一件事」只取一件：一个任务在某一刻只有一个下一步，卡片也只有一张（下一步
// 变了，旧卡改成已处理、新卡另发）。判断顺序与各条路由的前置条件一一对上 —— 卡片上的
// 按钮按下去不能是 409：
//   · 归档、接力出去、团队执行者、独立审查任务：不推（answer/retry/accept 都会拒；执行者的
//     提问是问调度台的，验收也是验收整个团队）。
//   · duet 闸口开着：闸口卡。它在 awaiting_review 上，isTaskLive 会把它算作「机器在动」，
//     所以排在 live 判断之前。
//   · 有提问、且提问回合已经结束（团队调度台不受这条限制）：提问卡。还在 running 时答复会 409。
//   · 托盘里有此刻就该送进会话的消息（排队追问、审查没过排着的修复意见）：不推。任务一空下来它就
//     送进去、接着跑，推出去的卡转眼就得撤回。
//   · status=failed：失败卡。retry 只收 failed。
//   · 机器在动：不推。
//   · 有待裁定的驳回：驳回卡（排在待验收前面：驳回不裁，验收就是在没看审查意见的情况下合并）。
//   · stage=verify_failed：只发通知、不给按钮（强制通过不可逆，见 docs/feishu-integration.md）。
//   · 干完了没盖章：待验收卡。门禁正在跑、验证轮还没出结论这类「过一会儿就能按」的状态不算
//     换了下一步 —— 卡片留着，按下去由验收接口如实说「还在跑」，免得一张卡来回收、发好几遍。
// 检查点暂停（paused）不推：它会被队列或哨兵自己叫醒，界面上也没有跟提问同级的醒目标识。
export type HumanTurnKind = "duet_gate" | "question" | "failed" | "dispute" | "verify_failed" | "accept";

/** shared 自己算不出来、要 server 读库或读内存补上的几样。 */
export interface HumanTurnFacts {
  /** 父任务是团队调度台：这是团队执行者。 */
  teamWorker?: boolean;
  /** duet 闸口此刻开着。 */
  duetGateOpen?: boolean;
  /** 自由工作流有待裁定的驳回。 */
  disputeOpen?: boolean;
  /** 托盘里有此刻就该送进会话的消息（判据同投递端，server pending-messages.ts hasDeliverablePendingMessages）。 */
  deliveryPending?: boolean;
}

export function humanTurnOf(
  task: TaskListItem,
  workers: TaskListItem[] = [],
  facts: HumanTurnFacts = {},
): HumanTurnKind | null {
  if (task.archived || task.handoff?.direction === "out" || facts.teamWorker || task.reviewOf) return null;
  if (task.mode === "duet" && facts.duetGateOpen) return "duet_gate";
  if (task.question && (isTeamLead(task) || (task.status !== "running" && task.status !== "queued"))) return "question";
  if (facts.deliveryPending) return null;
  if (task.status === "failed") return "failed";
  if (isTaskLive(task, workers)) return null;
  if (facts.disputeOpen) return "dispute";
  if (task.stage === "verify_failed") return "verify_failed";
  if (isAcceptedStage(task.stage)) return null;
  const settled = task.status === "done" || isTeamSettledLead(task, workers);
  return awaitsAcceptance(task, settled) ? "accept" : null;
}
