import type { AgentType, Task } from "@navi/shared";
import { useOrderedSave } from "./useOrderedSave.ts";

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

/** 写回的顺序、乐观值和发送前的闸见 useOrderedSave.ts（派出去的活交给谁也是同一套）。 */
export function useStandingExecutor(
  task: Task,
  save: ((next: StandingExecutor) => Promise<void>) | undefined,
  onError: (message: string) => void,
): {
  config: StandingExecutor;
  commit: (next: StandingExecutor) => void;
  /** 等写回全部落地。null = 都成功了；字符串 = 最后一次写回失败的原因。 */
  settle: () => Promise<string | null>;
} {
  const { value, commit, settle } = useOrderedSave(standingExecutorOf(task), same, task.id, save, onError);
  return { config: value, commit, settle };
}
