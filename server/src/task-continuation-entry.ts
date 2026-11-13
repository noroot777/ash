import { eq } from "drizzle-orm";
import type { AgentType } from "@ash/shared";
import { isGoalExecution, isGoalRecovery, parseCliCommand, type CliCommand } from "@ash/shared/cli-commands";
import { db } from "./db/index.js";
import { tasks } from "./db/schema.js";
import { withTurnPreflight } from "./turn-entry-guard.js";
import type { TurnIdentity } from "./runs.js";
import { nativeCliCommand } from "./skills.js";
import { preflightCliGoalCommand } from "./task-cli-state.js";
import { bindUploadsToTask } from "./uploads.js";

type ContinuationEntryOptions = {
  agent?: AgentType;
  executorId?: string | null;
  model?: string | null;
  reasoningEffort?: string | null;
  attachments?: string[];
  actingUserId?: string | null;
  turnHeld?: TurnIdentity | null;
};

/**
 * 一句用户输入交给 continueTask 时,**光凭这句话本身**就会被当成任务的执行(而不是续聊):
 * 结算不按 followUpFrom 护回原终态,队列也按它在执行看。现在只有恢复持续目标(`/goal resume`,
 * 含 `--scope` 形式)是这样。continueTask 判 execution、「重试这一回合」判要不要过队列那道闸,
 * 读的都是这一份 —— 两边各写一份,重投 `/goal resume` 就会绕过队列跟同队成员一起跑。
 */
export function commandStartsExecution(slash: CliCommand | null): boolean {
  return isGoalRecovery(slash);
}

export function inputStartsExecution(agentType: string, userText: string): boolean {
  return commandStartsExecution(parseCliCommand(agentType, userText));
}

export async function prepareContinuationEntry<Options extends ContinuationEntryOptions>(
  taskId: string,
  userText: string,
  options: Options,
) {
  return withTurnPreflight(taskId, options.turnHeld, async () => {
    const head = (await db.select().from(tasks).where(eq(tasks.id, taskId))).at(0);
    await bindUploadsToTask(options.attachments, taskId, options.actingUserId ?? null);
    const agentType = options.agent ?? (head?.agentType as AgentType) ?? "claude";
    const nativeCommand = nativeCliCommand(agentType, userText);
    const slash = parseCliCommand(agentType, userText);
    const goalRoute = head ? await preflightCliGoalCommand(
      head, agentType, userText,
      options.agent ? options.executorId ?? null : head.executorId,
      options.actingUserId ?? head.ownerUserId,
    ) : undefined;
    return {
      head, nativeCommand, slash, goalExecution: isGoalExecution(slash), inputExecution: commandStartsExecution(slash),
      options: goalRoute ? { ...options, ...goalRoute } : options,
    };
  });
}
