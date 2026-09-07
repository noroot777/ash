import { useEffect, useState } from "react";
import type { AgentType, Task } from "@ash/shared";

/**
 * 任务的**常设**执行配置：以后每一回合默认由谁、用什么模型和智能水平跑。
 *
 * 对话框底部那颗胶囊改的就是它 —— 改完写回任务本身（PATCH /tasks/:id），
 * 所以之后发的每一条（包括任务在跑时排进队列的那些、以及队列自动续跑的回合）
 * 都按新配置走，不必每发一句重选一次。
 *
 * 与它相对的是**一次性召唤**（正文里 `@某个智能体`）：那是「就这一句叫谁」，
 * 只随 reply 请求发出，不落任务（见 ReplyBox 的 `target`）。
 */
export type StandingExecutor = {
  agentType: AgentType;
  executorId: string | null;
  model: string | null; // null = 跟随执行器
  reasoningEffort: string | null; // null = 跟随执行器
};

/** 任务字段视角的当前常设配置（与服务端 resolveExecutorFor 同一条口径的输入）。 */
export function standingExecutorOf(task: Task): StandingExecutor {
  return {
    agentType: (task.agentType ?? "claude") as AgentType,
    executorId: task.executorId ?? null,
    model: task.model ?? null,
    reasoningEffort: task.reasoningEffort ?? null,
  };
}

const same = (a: StandingExecutor, b: StandingExecutor): boolean =>
  a.agentType === b.agentType
  && a.executorId === b.executorId
  && a.model === b.model
  && a.reasoningEffort === b.reasoningEffort;

/**
 * 写回是异步的（PATCH 往返 + SSE 回流），中间这一两百毫秒不能让胶囊弹回旧值 ——
 * 所以本地先押一份乐观值，任务字段追上来就把它撤掉（这样 agent 自己用 patch_task
 * 改了执行器时，界面仍然跟着任务走，而不是被这份乐观值钉死）。写失败则回滚。
 */
export function useStandingExecutor(
  task: Task,
  save: ((next: StandingExecutor) => Promise<void>) | undefined,
  onError: (message: string) => void,
): { config: StandingExecutor; commit: (next: StandingExecutor) => void } {
  const [pending, setPending] = useState<StandingExecutor | null>(null);
  const settled = standingExecutorOf(task);

  useEffect(() => {
    setPending((current) => (current && same(current, settled) ? null : current));
  }, [settled.agentType, settled.executorId, settled.model, settled.reasoningEffort]);
  useEffect(() => { setPending(null); }, [task.id]);

  const commit = (next: StandingExecutor) => {
    if (!save) return;
    const rollback = pending;
    setPending(next);
    void save(next).catch((error: unknown) => {
      setPending(rollback);
      onError(error instanceof Error ? error.message : String(error));
    });
  };

  return { config: pending ?? settled, commit };
}
