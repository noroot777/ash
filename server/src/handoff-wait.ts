import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { db } from "./db/index.js";
import type { tasks } from "./db/schema.js";
import type { TaskWaitOwnership, WaitOrigin } from "./db/schema-task-wait.js";
import { RUNS_DIR } from "./paths.js";
import { questionWaitMatches, questionWaitOrigin } from "./task-wait-ownership.js";
import { HandoffError } from "./handoff-types.js";

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

export function importWaitOwnership(task: { id: string; question: string | null; questionOptions: string | null;
  questionItems: string | null; resumePrompt: string | null; resumePromptGeneration: number },
  origins: HandoffWaitOrigins | undefined): TaskWaitOwnership | null {
  validateWaitOrigins(origins);
  if (!task.question && !task.resumePrompt) return null;
  // **清单里压根没有 `waitOrigins` = 来源机是归属跟踪上线之前的版本**(升级期的兼容面:
  // `exportWaitOrigins` 只要有问题/检查点就一定会写这一格)。那种来源机上这格等待本来就
  // 没有归属,答复一律走普通回合 —— 所以兼容值只能是 `ordinary`。
  //
  // 早先这里把「没写」和「写了 unknown」并成一档,代价是**导入的任务从此答不了**:
  // `queueReviewAnswer` 见到 unknown 一律抛「审查所属的原目标方向已失效」,HTTP 回 409,
  // 而那一格 directory 是这里现编的 `handoff-wait/<uuid>`,本机没有任何证据行能让它翻身 ——
  // 远端任务挂着提问就成了死路(test-handoff-auth 第 ⑦ 节钉的就是这一条)。
  // 显式写了 `review`/`unknown` 的不动:那是来源机真的知道并告诉了我们的事实。
  const origin = (kind: WaitOrigin["kind"] | undefined): WaitOrigin => kind === "ordinary" || kind === undefined
    ? { kind: "ordinary" }
    : { kind, directory: join(RUNS_DIR, task.id, "handoff-wait", randomUUID()), generation: null };
  return {
    ...(task.question ? { question: { occupancy: randomUUID(), origin: origin(origins?.question), text: task.question,
      options: task.questionOptions, items: task.questionItems } } : {}),
    ...(task.resumePrompt ? { checkpoint: { generation: task.resumePromptGeneration, origin: origin(origins?.checkpoint) } } : {}),
  };
}
