import { eq } from "drizzle-orm";
import type { AgentType } from "@ash/shared";
import { isGoalExecution, parseCliCommand } from "@ash/shared/cli-commands";
import { db } from "./db/index.js";
import { tasks } from "./db/schema.js";
import { releaseTurn } from "./runs.js";
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
  turnHeld?: boolean;
};

export async function prepareContinuationEntry<Options extends ContinuationEntryOptions>(
  taskId: string,
  userText: string,
  options: Options,
) {
  try {
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
      head, nativeCommand, slash, goalExecution: isGoalExecution(slash),
      options: goalRoute ? { ...options, ...goalRoute } : options,
    };
  } catch (error) {
    if (options.turnHeld) releaseTurn(taskId);
    throw error;
  }
}
