import { isAcceptedStage as sharedIsAcceptedStage, type Task, type TaskListItem } from "@ash/shared";
import {
  awaitsYourWord, hasFailed, isTaskAwaitingAcceptance, isTaskLive, isTeamLead, isTeamSettledLead,
} from "@ash/shared/task-attention";

// 「轮到谁动」的判据本体在 shared/src/task-attention.ts（mobile 与 server 的飞书推送读的
// 也是那一份）；这里只放 web 自己的分堆与任务模式口径，并把 shared 的谓词原样转出，
// 让 web 内部继续从 lib 一处引用。
// 放在 lib 而不是 workspace，是因为 lib/useTaskReadState 也要用它 —— 反过来引会成环。
// 注意任务树的**排序**不看这里：那边只认更新时间（见 workspace/taskTreeModel.ts）。
export {
  awaitsAcceptance, awaitsYourWord, hasFailed, isTaskAwaitingAcceptance, isTaskLive, isTeamSettledLead,
  needsYourCommand,
} from "@ash/shared/task-attention";

export type SpreadBucket = "todo" | "run" | "wait" | "done" | "accepted";

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
  if (hasFailed(task)) return "todo";
  // 等我盖章 = 轮到我动，判据跟任务模式共用一份（见 shared 的 isTaskAwaitingAcceptance）。
  // 干完没点头的因此落「需要你处理」，而不是「已收尾」—— 后者是「这事翻篇了」的意思。
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
// 判据本体是 shared 的 isAcceptedStage(stage)，这里收整个任务只是 web 调用点的习惯。
export function isAcceptedStage(task: Pick<Task, "stage">): boolean {
  return sharedIsAcceptedStage(task.stage);
}

// 「任务模式」（侧栏跨项目那一档）放行哪些行的判据，就下面这四条 —— 机器在动、摔了、
// 等我说句话（提问 / 停在检查点）、或者盖着「待验收」的章。别的一律不进：那一档存在的
// 意义是「此刻还没落地的活」，把收了尾又验完的一起塞进来，它跟单项目态就没区别了。
//
// 判据跟 spreadBucket 用的是同一批谓词，连**顺序**都一样（先看在跑、再让盖过章的出局），
// 所以进得来的行必定落在筛选条上的 在跑 / 需要你处理 / 排着·暂停 三档里，永远不会掉进
// 「已收尾」「验收完成」这种模式自己都不认的档。这条不变式由 test-spread-filter 钉住。

export function inTaskMode(task: TaskListItem, workers: TaskListItem[] = []): boolean {
  if (isTaskLive(task, workers)) return true;
  // 摔了的照收，而且排在「盖过章的出局」前面 —— 同 spreadBucket 里 failed 压在 accepted
  // 之上的道理：验收完又重跑、这次挂了的任务，事实是它现在坏着，记号盖不住。
  // 团队不必在这儿额外问执行者：执行者摔了不算「活的」，整队会因此被 isTeamSettled 判成
  // 收工，从下面「等我盖章」那条进来。这里这一条管的是**调度台自己**摔了的团队 ——
  // 它落在 teamNeverStarted 上，收工那条接不住它。
  if (hasFailed(task)) return true;
  // 盖过章的一律出局，跟 spreadBucket 把 accepted 排在 run 之后同一个道理：事实高于
  // 记号（验收完又重新开工的上一条已经放行），但只剩记号时它就是「落地了」。
  if (isAcceptedStage(task)) return false;
  return isTaskAwaitingAcceptance(task, workers) || awaitsYourWord(task, workers);
}
