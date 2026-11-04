import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { db } from "./db/index.js";
import type { tasks } from "./db/schema.js";
import type { TaskWaitOwnership, WaitOrigin } from "./db/schema-task-wait.js";
import { RUNS_DIR } from "./paths.js";
import { questionWaitMatches, questionWaitOrigin } from "./task-wait-ownership.js";
import { HandoffError, type HandoffManifest } from "./handoff-types.js";

export type HandoffWaitOrigins = { question?: WaitOrigin["kind"]; checkpoint?: WaitOrigin["kind"] };

export function validateWaitOrigins(origins: HandoffWaitOrigins | undefined): void {
  if (origins === undefined) return;
  if (!origins || typeof origins !== "object" || Array.isArray(origins)
    || Object.entries(origins).some(([field, kind]) => !["question", "checkpoint"].includes(field)
      || !["ordinary", "review", "unknown"].includes(kind))) throw new HandoffError("waitOrigins 非法");
}

export async function exportWaitOrigins(task: typeof tasks.$inferSelect): Promise<HandoffWaitOrigins> {
  const fallback = await db.transaction((transaction) => questionWaitOrigin(transaction, { ...task, waitOwnership: null }),
    { behavior: "immediate" });
  return {
    ...(task.question ? { question: questionWaitMatches(task) ? task.waitOwnership!.question!.origin.kind : fallback.kind } : {}),
    ...(task.resumePrompt ? { checkpoint: task.waitOwnership?.checkpoint?.generation === task.resumePromptGeneration
      ? task.waitOwnership.checkpoint.origin.kind : fallback.kind } : {}),
  };
}

/**
 * 老清单(没有 `waitOrigins`)自己带没带「这格等待可能是审查留下的」证据。判据与本机导出侧
 * `questionWaitOrigin` 的兜底同源,只是换成清单里过得了网的那几格:预设工作流还停在验证中
 * (对应本机的 `verifyRound`),或者带着自由审查记录(对应本机「有过任何一轮 freeReviewRuns」)。
 */
export function manifestCarriesReview(m: Pick<HandoffManifest, "freeWorkflow"> & { task: { stage: string | null } }): boolean {
  return m.task.stage === "verifying" || !!m.freeWorkflow?.runs?.length;
}

export function importWaitOwnership(task: { id: string; question: string | null; questionOptions: string | null;
  questionItems: string | null; resumePrompt: string | null; resumePromptGeneration: number },
  origins: HandoffWaitOrigins | undefined, carriesReview: boolean): TaskWaitOwnership | null {
  validateWaitOrigins(origins);
  if (!task.question && !task.resumePrompt) return null;
  // **清单里压根没有 `waitOrigins` = 来源机是归属跟踪上线之前的版本**(升级期的兼容面:
  // `exportWaitOrigins` 只要有问题/检查点就一定会写这一格)。那种来源机没记归属,只能按清单
  // 自己带的证据推(`manifestCarriesReview`),跟本机导出侧缺记录时的兜底一个口径:
  //
  //  · 看不出任何审查痕迹 → `ordinary`。早先这里把「没写」一律并进 `unknown`,代价是普通任务
  //    导入后挂着的提问**从此答不了**:`queueReviewAnswer` 见到 unknown 一律 409,而 directory
  //    是这里现编的,本机没有证据行能让它翻身(test-handoff-auth 第 5 节钉的就是这一条)。
  //  · 有审查痕迹 → `unknown`(隔离)。反过来一律给 `ordinary` 等于让来源不明的审查等待拿到
  //    普通实现回合的权限(test-review-transfer 钉的就是这一条);原机审查权限迁不过来,
  //    导入侧的提示会让用户在本机重新派审。
  //
  // 显式写了 `review`/`unknown` 的不动:那是来源机真的知道并告诉了我们的事实。
  const origin = (kind: WaitOrigin["kind"] | undefined): WaitOrigin => {
    const resolved = kind ?? (carriesReview ? "unknown" : "ordinary");
    return resolved === "ordinary" ? { kind: "ordinary" }
      : { kind: resolved, directory: join(RUNS_DIR, task.id, "handoff-wait", randomUUID()), generation: null };
  };
  return {
    ...(task.question ? { question: { occupancy: randomUUID(), origin: origin(origins?.question), text: task.question,
      options: task.questionOptions, items: task.questionItems } } : {}),
    ...(task.resumePrompt ? { checkpoint: { generation: task.resumePromptGeneration, origin: origin(origins?.checkpoint) } } : {}),
  };
}
