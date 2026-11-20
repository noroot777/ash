import { and, eq, inArray } from "drizzle-orm";
import type { AgentType } from "@navi/shared";
import { db } from "./db/index.js";
import { agents, sessions, tasks } from "./db/schema.js";
import { resolveExecutorFor } from "./executors/index.js";
import { heldTurns } from "./turn-lock.js";
import { runtimeConsumerAvailable } from "./runtime-consumers.js";

type Item = { id: string; title: string };
export type RuntimeEligibility = { blocked: (Item & { reason: string })[]; sessions: string[] };

export async function runtimeEligibility(impact: {
  survives: (Item & { pid: number })[]; interrupted: (Item & { reason: string })[]; resumes: Item[];
}): Promise<RuntimeEligibility> {
  const result: RuntimeEligibility = { sessions: [], blocked: [...impact.interrupted,
    ...impact.resumes.map((item) => ({ ...item, reason: "调度台当前回合不能无损接管" }))] };
  for (const task of impact.survives) {
    const live = (await db.select().from(sessions).where(and(eq(sessions.taskId, task.id),
      inArray(sessions.role, ["single", "reviewer"])))).filter((session) => !session.endedAt);
    let reason = "";
    if (live.length !== 1 || live[0].agentPid !== task.pid || !live[0].agentOutPath || !live[0].agentErrPath || !live[0].agentRcPath) {
      reason = "会话身份或输出接管信息不完整";
    } else {
      const session = live[0];
      const profile = (await db.select().from(agents).where(eq(agents.name, session.executor))).at(0);
      const record = (await db.select().from(tasks).where(eq(tasks.id, task.id))).at(0)!;
      const executor = await resolveExecutorFor({ executorId: profile?.id ?? record.executorId,
        type: session.agentType as AgentType, model: null, reasoningEffort: null });
      if (!executor.attach) reason = "执行器不支持接管";
      else if (!runtimeConsumerAvailable(session.id)) reason = "输出消费屏障尚未就绪或仍有未持久化状态";
      else result.sessions.push(session.id);
    }
    if (reason) result.blocked.push({ id: task.id, title: task.title, reason });
  }
  for (const turn of heldTurns()) if (!impact.survives.some((task) => task.id === turn.taskId)) {
    result.blocked.push({ id: turn.taskId, title: turn.taskId, reason: "仍有起跑或维护操作在途" });
  }
  return result;
}
