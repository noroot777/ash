import type { Task, TaskListItem, TaskStatus } from "@ash/shared";
import { isTeamSettled, teamNeverStarted } from "@ash/shared/team";

// 「轮到谁动」的判据集中在这里：侧边栏筛选的分堆和行首圆点读的是同一份。
// 放在 lib 而不是 workspace，是因为 lib/useTaskReadState 也要用它 —— 反过来引会成环。
// 注意任务树的**排序**不看这里：那边只认更新时间（见 workspace/taskTreeModel.ts）。

export type SpreadBucket = "todo" | "run" | "wait" | "done" | "accepted";

// 「机器在动」的三种 status。团队调度台自己从不落在这三档上，所以下面几条判据里
// 团队一律要连执行者一起看。
const LIVE_STATUSES = new Set<TaskStatus>(["running", "queued", "awaiting_review"]);

function isTeamLead(task: Pick<TaskListItem, "mode" | "parentId">): boolean {
  return task.mode === "team" && !task.parentId;
}

// 「调度台 id → 它的执行者」。下面每条判据都要它，而每个调用点各自 filter 一遍是 O(n²)：
// 侧栏一千多行、筛选每次渲染都算一遍，那是能卡住的量级。建一次传下去。
export type WorkerIndex = Map<string, TaskListItem[]>;

export function indexWorkers(tasks: TaskListItem[]): WorkerIndex {
  const index: WorkerIndex = new Map();
  for (const task of tasks) {
    if (!task.parentId) continue;
    const workers = index.get(task.parentId);
    if (workers) workers.push(task);
    else index.set(task.parentId, [task]);
  }
  return index;
}

export function workersFrom(index: WorkerIndex | null | undefined, taskId: string): TaskListItem[] {
  return index?.get(taskId) ?? [];
}

// 「机器在动」。团队写在执行者身上：调度台派完活自己就落回 idle，只盯它会把一屋子
// 执行者正在跑的团队判成静止。
export function isTaskLive(task: TaskListItem, workers: TaskListItem[] = []): boolean {
  if (LIVE_STATUSES.has(task.status)) return true;
  return isTeamLead(task) && workers.some((worker) => LIVE_STATUSES.has(worker.status));
}

// 「这个团队收工了」。开过台是前提 —— 还停在 backlog 的团队是**没开始**，不是干完了。
// 收工判据只用 shared 的 isTeamSettled（web/CLAUDE.md 的约定）。
export function isTeamSettledLead(task: TaskListItem, workers: TaskListItem[] = []): boolean {
  return isTeamLead(task)
    && !teamNeverStarted(task.status)
    && isTeamSettled(task.status === "running", workers);
}

// 分堆的判据只问一句：这一行现在轮到谁动。轮到我 = todo（等答复 / 待验收 / 失败），
// 机器在动 = run，谁也没轮到 = wait，收了尾 = done，走完验收 = accepted。
//
// **团队必须连执行者一起看**（workers），而且用的就是上面那两条 —— 跟「任务模式收哪些行」
// 同一套判据。调度台自己没有「在跑」也没有 done 终态（派完活落回 idle，收工也只是 idle），
// 只读它这一行的话，满负荷的团队和早就干完的团队都会被判成「排着 / 暂停」：那是假话，
// 而任务模式（只收在跑 / 待验收）会把这句假话直接印在筛选条上 —— 一个写着
// 「排着 / 暂停 · 1」的档，点开是一条「已完成，等你验收」。
// 传空执行者表 = 按调度台自己那一行判，只在确实拿不到执行者的调用点才这么用。
//
// accepted 是唯一一档看 stage 而不看 status 的 —— stage 与 status 正交（见 shared 的
// TaskStage 注释），所以它只能**从 done 里切一刀**、不能跟别的桶并排，否则五个桶不再互斥，
// 计数加起来会超过「全部」。位置也是判据的一部分：
//   · 排在 run 之后 —— 「验收完成 + awaiting_review」（盖了章又派了审查）机器确实在动，
//     事实高于记号，这种得留在「在跑」，不能被 stage 抢走；盖过章又重新开工的团队同理。
//   · 排在 done/wait 之前 —— 验收完的调度台没有 done 终态，只能靠这一档接住，
//     否则「排着 / 暂停」里会堆着几十个其实早就干完的团队。
export function spreadBucket(task: TaskListItem, workers: TaskListItem[] = []): SpreadBucket {
  if (task.question) return "todo";
  if (task.status === "failed" || task.stage === "verify_failed") return "todo";
  // 等我盖章 = 轮到我动。判据跟任务模式共用一份（见下面 isTaskAwaitingAcceptance）：
  // 刚收尾还没点头的落这一档，过了窗口的老账落回下面的「已收尾」。
  if (isTaskAwaitingAcceptance(task, workers)) return "todo";
  if (isTaskLive(task, workers)) return "run";
  // 调度台自己没在说话，底下却有执行者卡在提问上 —— 那句话最后是要你来答的。排在
  // isTaskLive 之后：调度台还在跑就由它自己去答，那种时候事实是「机器在动」。
  if (isTeamLead(task) && workers.some((worker) => worker.question)) return "todo";
  // 底下还有执行者停着 = 这一队没落地，哪怕调度台那一行写着 done / 盖过章。事实高于记号，
  // 跟 shared 的 isTeamSettled 把 paused 算作「活的执行者」是同一个口径。
  if (isTeamLead(task) && workers.some((worker) => worker.status === "paused")) return "wait";
  if (task.stage === "accepted" || task.stage === "merged") return "accepted";
  if (task.status === "done" || task.status === "canceled") return "done";
  // 收了工的团队跟单飞的 done 同义。「盖没盖章」不由桶来说 —— 行首那颗未验收的点
  // 单独说，跟单飞 done 的行为一致。
  if (isTeamSettledLead(task, workers)) return "done";
  return "wait";
}

// 盖过章了吗。merged 也算 —— 合并即走完了验收链路（accept_task 的终点）。
export function isAcceptedStage(task: Pick<Task, "stage">): boolean {
  return task.stage === "accepted" || task.stage === "merged";
}

// 「干完了但还没盖章」。settled 由调用方判断（单飞看 status === "done"，团队看 isTeamSettled），
// 因为团队要拿执行者才能算收工，这个模块不碰执行者列表。
//
// 注意 stage 多数时候是 null —— 只有走过 report_stage 的任务才有值。null 一律算**没验收**：
// 用户要的就是「凡是我没点过验收的，都得看得见」，而不是「只有 agent 主动报过待验收的才算」。
export function awaitsAcceptance(task: Pick<Task, "stage">, settled: boolean): boolean {
  return settled && !isAcceptedStage(task);
}

// 「任务模式」（侧栏跨项目那一档）放行哪些行的判据，就下面这三条 —— 机器在动、等我
// 说句话（提问 / 停在检查点）、或者盖着「待验收」的章。别的一律不进：那一档存在的意义
// 是「此刻还没落地的活」，把收了尾又验完的一起塞进来，它跟单项目态就没区别了。
//
// 判据跟 spreadBucket 用的是同一批谓词，连**顺序**都一样（先看在跑、再让盖过章的出局），
// 所以进得来的行必定落在筛选条上的 在跑 / 需要你处理 / 排着·暂停 三档里，永远不会掉进
// 「已收尾」「验收完成」这种模式自己都不认的档。这条不变式由 test-spread-filter 钉住。

// 「等我说句话」。提问是明着要答案，paused 是停在检查点等续跑 —— 两样都是「活还在半路，
// 而且下一步得人动手」。**团队要连执行者一起看**：调度台派完活自己落回 idle，执行者在
// 底下卡着提问时，只读调度台那一行会把整个团队判成没事发生。
export function awaitsYourWord(task: TaskListItem, workers: TaskListItem[] = []): boolean {
  if (task.question || task.status === "paused") return true;
  return isTeamLead(task) && workers.some((worker) => worker.question || worker.status === "paused");
}

// 「等我盖章」。两种都算，判据一份，spreadBucket 和任务模式共用：
//   · 显式 stage=awaiting_acceptance —— 明着停在验收关口上，多久都算；
//   · 收了尾、没盖过章、而且是**最近**收的 —— 自由工作流只调 complete_task，stage 多数
//     时候是 null，这种「已完成，等你点头」占了绝大多数（实测 335 条对 28 条）。
//
// 时限是这一档的全部要害。不设时限，三百多条历史任务会把任务模式淹掉（那正是收窄前
// 的样子）；只认显式的章，今天刚干完的活又一条都进不来 —— 用户看着一条 0.2 小时前
// 收尾、写着「完成待验收」的任务问「它不该在列表里吗」，问的就是这个。实测这一周内
// 收尾且没盖章的只有 4 条：一周的窗口接住手头的活，接不住三个月前那批。
//
// 读 updatedAt 而不是 endedAt：侧栏的年龄闸（taskTreeModel 的 TASK_PREVIEW_MAX_AGE_MS）
// 也读它，一个列表里只该有一口时钟；续聊过的老任务因此按「最近碰过」算，这也对。
//
// 行首那颗未验收的圆点**不受这个时限管**（useTaskReadState 的 awaitsAcceptance）：
// 那是「我还没点过头」的长期记号，翻到哪条都得看得见；这一档说的是「这条线现在停在
// 验收关口上」，过了一周还没人管，它就不再是「现在」的事了。
export const TASK_MODE_ACCEPTANCE_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

export function isTaskAwaitingAcceptance(
  task: TaskListItem,
  workers: TaskListItem[] = [],
  nowMs = Date.now(),
): boolean {
  if (isAcceptedStage(task)) return false;
  if (task.stage === "awaiting_acceptance") return true;
  // 团队的「干完了」写在执行者身上，调度台自己没有 done 终态。
  const settled = task.status === "done" || isTeamSettledLead(task, workers);
  if (!settled) return false;
  const updatedAt = Date.parse(task.updatedAt);
  return Number.isFinite(updatedAt) && nowMs - updatedAt < TASK_MODE_ACCEPTANCE_WINDOW_MS;
}

export function inTaskMode(task: TaskListItem, workers: TaskListItem[] = []): boolean {
  if (isTaskLive(task, workers)) return true;
  // 盖过章的一律出局，跟 spreadBucket 把 accepted 排在 run 之后同一个道理：事实高于
  // 记号（验收完又重新开工的上一条已经放行），但只剩记号时它就是「落地了」。
  if (isAcceptedStage(task)) return false;
  return isTaskAwaitingAcceptance(task, workers) || awaitsYourWord(task, workers);
}
