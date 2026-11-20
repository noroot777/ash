import type { AgentEvent } from "@navi/shared";
import { readFile } from "node:fs/promises";
import { and, desc, eq, isNull } from "drizzle-orm";
import { db } from "./db/index.js";
import { sessions } from "./db/schema.js";
import { turnOutcome } from "./session-turns.js";
import { parseSessionTraceLines, sessionTracePath } from "./transcript.js";

/** 「实施此计划」之前：出计划的那位（执行器类型 + profile + 发起人）最近一回合正常结束，且交出了这一版计划。 */
export async function assertPlanReady(taskId: string, agentType: string, executorId: string | null, ownerId: string | null, planId: string | undefined): Promise<void> {
  const [session] = await db.select().from(sessions).where(and(
    eq(sessions.taskId, taskId), eq(sessions.agentType, agentType), eq(sessions.role, "single"),
    executorId === null ? isNull(sessions.executorId) : eq(sessions.executorId, executorId),
    ownerId === null ? isNull(sessions.runOwnerUserId) : eq(sessions.runOwnerUserId, ownerId),
  )).orderBy(desc(sessions.turnStartedAt), desc(sessions.startedAt));
  if (!session?.endedAt) throw new Error("计划仍在生成或没有可实施的计划，请先完成规划");
  const turn = session.turnStartedAt ?? session.startedAt;
  const outcome = await turnOutcome(session.id, turn);
  if (session.stoppedAs || outcome === "failed" || outcome === "stopped" || (!outcome && session.exitStatus != null && session.exitStatus !== 0)) {
    throw new Error("本次规划未正常完成，请先继续完善计划");
  }
  const raw = await readFile(sessionTracePath(taskId, session.id), "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") throw new Error("计划记录不存在，请重新生成计划");
    throw error;
  });
  const parsed = parseSessionTraceLines(raw);
  if (parsed.badLines || parsed.truncatedTail) throw new Error("计划记录不完整，无法确认要实施的版本，请重新生成计划");
  const latest = parsed.entries.filter((entry) => entry.turnStartedAt === turn && entry.event.kind === "plan").at(-1);
  if (!latest || latest.event.kind !== "plan" || latest.event.status !== "complete" || !latest.event.text.trim()) {
    throw new Error("没有已完成的计划，请先生成计划");
  }
  if (planId && latest.event.id !== planId) throw new Error("计划已有新版本，请刷新后确认最新计划");
}

/**
 * 一条会话这一回合里已经落进会话记录的计划事件（按先后）。接管 claude 计划回合时拿它当「当年发过哪些
 * 卡」的事实（claude-plan-gate.ts 的重放对账）；记录不存在 = 一张都没发过，读不了就不给（undefined）。
 */
export async function recordedPlanEvents(taskId: string, sessionId: string, turnStartedAt: string): Promise<AgentEvent[] | undefined> {
  const raw = await readFile(sessionTracePath(taskId, sessionId), "utf8").catch((error: NodeJS.ErrnoException) => error.code === "ENOENT" ? "" : null);
  if (raw === null) return undefined;
  return parseSessionTraceLines(raw).entries.flatMap((entry) => entry.turnStartedAt === turnStartedAt && entry.event.kind === "plan" ? [entry.event] : []);
}
