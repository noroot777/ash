import type { AgentType } from "@ash/shared";
import { isGoalExecution, validateCliCommand } from "@ash/shared/cli-commands";
import { and, desc, eq, isNull } from "drizzle-orm";
import type { Context } from "hono";
import { ownerIdOf, actorOf } from "./auth/context.js";
import { db } from "./db/index.js";
import { sessions, tasks } from "./db/schema.js";
import { nativeCommandRun, stopTask, whenTurnIdle } from "./runs.js";
import { appendTaskTimeline } from "./task-timeline.js";
import { preflightCliGoalResume, readCliState, renameCliTask, resolvedCliState, saveCliState } from "./task-cli-state.js";
import { formatClaudeGoal } from "./executors/claude-goal.js";
import type { TaskReplyBody } from "./task-reply.js";
import { enqueueMessage } from "./pending-messages.js";

const LIVE_COMMANDS = new Set(["goal", "status", "usage", "mcp", "ps", "stop", "debug-config", "hooks", "apps", "plugins", "rename"]);

export async function taskCliCommand(c: Context, task: typeof tasks.$inferSelect, body: TaskReplyBody): Promise<Response | null> {
  const agentType = body.agent ?? (task.agentType as AgentType) ?? "claude";
  const command = validateCliCommand(agentType, body.text ?? "");
  if (!command) return null;
  if (body.annotationBatchId || body.attachments?.length) throw new Error("原生命令不接受附件或页面批注，请单独发送");
  if (task.mode !== "single" && !(agentType === "claude" && command.name === "compact")) throw new Error("这些原生命令仅支持普通单任务；团队调度台请使用原有派活通道");
  if (isGoalExecution(command) && (task.verifyRound || task.reviewOf)) throw new Error("验证或审查回合不能启动持续目标，请在普通执行任务中使用 /goal");
  if (body.sendAt) return null;
  const running = task.status === "running" || task.status === "queued";
  const userId = ownerIdOf(actorOf(c));
  if (!running) {
    await preflightCliGoalResume(task, agentType, command.text, body.agent ? body.executorId ?? null : task.executorId, userId);
    if (agentType === "claude" && command.name === "goal" && (!command.args || command.args === "pause")) {
      const state = await resolvedCliState(task, agentType, body.agent ? body.executorId ?? null : task.executorId, userId);
      if (command.args && state.goal) { state.goal.status = "paused"; await saveCliState(task.id, agentType, state); }
      const text = formatClaudeGoal(state.goal ?? null);
      const recorded = await appendTaskTimeline(task.id, `${command.text}\n${text}`, { agentType });
      return c.json({ started: false, command: true, text, recorded });
    }
    return null;
  }
  if (!LIVE_COMMANDS.has(command.name)) return null;
  if (isGoalExecution(command) && !task.goalTurn) return null;
  const current = nativeCommandRun(task.id);
  const [session] = await db.select().from(sessions).where(and(eq(sessions.taskId, task.id), isNull(sessions.endedAt), eq(sessions.role, "single"))).orderBy(desc(sessions.turnStartedAt), desc(sessions.startedAt));
  const target = session ? `通过 @${session.agentType} 选择执行器「${session.executor}」${session.executorId ? `（${session.executorId}）` : ""}，` : "";
  if (isGoalExecution(command)) {
    const objective = current?.goal?.()?.objective ?? (session ? readCliState(task.cliState, session.agentType, session.executorId, session.runOwnerUserId).goal?.objective : undefined);
    throw new Error(`当前目标${objective ? `「${objective}」` : ""}正在执行，不能替换或恢复，请先${target}发送 /goal pause，等待回合结束后再设置或恢复目标。`);
  }
  if (!current || !session) throw new Error("当前回合正在启动或收尾，请稍后再发送原生命令");
  if (session.agentType !== agentType || (body.executorId && session.executorId !== body.executorId)) throw new Error(`原生命令必须发给当前正在运行的执行器；请${target}再发送${session.agentType === "claude" ? " /goal 查询、/goal pause 或 /goal clear" : ` ${command.text}`}。`);
  if (session.runOwnerUserId !== userId && (session.runOwnerUserId || userId)) throw new Error("只有当前回合的发起人可以操作其原生执行通道");
  let text: string;
  const clear = command.name === "goal" && /^(clear|stop|off|reset|none|cancel)$/.test(command.args);
  if (agentType === "claude") {
    if (command.name !== "goal" || (command.args && command.args !== "pause" && !clear)) throw new Error("当前 Claude 原生通道不支持此命令");
    const state = { ...readCliState(task.cliState, agentType, session.executorId, session.runOwnerUserId), profileId: session.executorId, ownerUserId: session.runOwnerUserId };
    if (command.args) {
      if (!state.goal || !task.goalTurn) throw new Error("当前回合没有正在执行的目标");
      state.goal = clear ? null : { ...state.goal, status: "paused" };
      state.goalHold = !clear;
      if (clear) delete state.goalStart;
      await saveCliState(task.id, agentType, state);
      if (!stopTask(task.id, "paused")) throw new Error("当前回合已结束");
      if (clear) whenTurnIdle(task.id, () => {
        void import("./orchestrator.js").then(async ({ continueTask }) => {
          const route = { agent: agentType, executorId: session.executorId, actingUserId: userId };
          if (!await continueTask(task.id, "/goal clear", route)) await enqueueMessage({ taskId: task.id, text: "/goal clear", ...route, ownerUserId: userId });
        })
          .catch((error) => appendTaskTimeline(task.id, `原生目标清除失败：${String(error)}；请再次 /goal clear`, { agentType }));
      });
    }
    text = clear ? "目标执行已停止，原生目标清除请求已安排；任务和历史保留。" : formatClaudeGoal(state.goal ?? null);
  } else {
    if (!current.command) throw new Error("当前 Codex profile 使用 exec 回退通道，无法执行原生控制命令");
    text = await current.command(command);
    if (command.name === "goal") {
      const state = { ...readCliState(task.cliState, agentType, session.executorId, session.runOwnerUserId), profileId: session.executorId, ownerUserId: session.runOwnerUserId };
      state.goal = current.goal?.() ?? null;
      if (task.goalTurn && (command.args === "pause" || clear)) state.goalHold = !clear;
      if (clear) { state.goal = null; delete state.goalStart; }
      await saveCliState(task.id, agentType, state);
      if (task.goalTurn && (command.args === "pause" || clear)) stopTask(task.id, "paused");
    }
  }
  if (command.name === "rename") await renameCliTask(task.id, command.args);
  const recorded = await appendTaskTimeline(task.id, `${command.text}\n${text}`, { sessionId: session.id });
  return c.json({ started: false, command: true, text, recorded });
}
