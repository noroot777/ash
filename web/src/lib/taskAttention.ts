import type { Task } from "@ash/shared";

// 「轮到谁动」的判据集中在这里：侧边栏筛选的分堆和行首圆点读的是同一份。
// 放在 lib 而不是 workspace，是因为 lib/useTaskReadState 也要用它 —— 反过来引会成环。
// 注意任务树的**排序**不看这里：那边只认更新时间（见 workspace/taskTreeModel.ts）。

export type SpreadBucket = "todo" | "run" | "wait" | "done" | "accepted";

// 分堆的判据只问一句：这一行现在轮到谁动。轮到我 = todo（等答复 / 待验收 / 失败），
// 机器在动 = run，谁也没轮到 = wait，收了尾 = done，走完验收 = accepted。
//
// accepted 是唯一一档看 stage 而不看 status 的 —— stage 与 status 正交（见 shared 的
// TaskStage 注释），所以它只能**从 done 里切一刀**、不能跟别的桶并排，否则五个桶不再互斥，
// 计数加起来会超过「全部」。位置也是判据的一部分：
//   · 排在 run 之后 —— 「验收完成 + awaiting_review」（盖了章又派了审查）机器确实在动，
//     事实高于记号，这种得留在「在跑」，不能被 stage 抢走。
//   · 排在 done/wait 之前 —— team 没有 done 终态（收工只回到 idle，归档才结束），
//     验收完的调度台以前只能兜进 wait，让「排着 / 暂停」里堆着几十个其实早就干完的团队。
export function spreadBucket(task: Task): SpreadBucket {
  if (task.question) return "todo";
  if (task.status === "failed" || task.stage === "awaiting_acceptance" || task.stage === "verify_failed") return "todo";
  if (task.status === "running" || task.status === "queued" || task.status === "awaiting_review") return "run";
  if (task.stage === "accepted" || task.stage === "merged") return "accepted";
  if (task.status === "done" || task.status === "canceled") return "done";
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
