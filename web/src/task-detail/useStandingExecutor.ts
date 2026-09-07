import { useEffect, useRef, useState } from "react";
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
 * 改了执行器时，界面仍然跟着任务走，而不是被这份乐观值钉死）。
 *
 * **写回必须串行，而且只认最后一次提交。** 胶囊本来就会连着提交两次 —— 选完智能体
 * 自动向右展开模型段，用户接着选模型，两份**完整配置**的 PATCH 前后脚发出。并发发
 * 的话，先发的那份要是后到，数据库就被它盖回旧配置，而界面还留着新的乐观值：胶囊
 * 写着新模型，实际跑的却是旧的（第 1 轮审查用夹具实测复现）。所以这里排成一条链，
 * 一次只在飞一个；排队期间又被更新的提交取代的，直接跳过不发。失败与回滚也按提交
 * 序号认领 —— 旧请求的报错既不该弹出来，更不该把用户更新的选择拽回去。
 *
 * **`settle()` 是发送前的闸。** 改完执行器立刻按发送，PATCH 还在飞、回复的 POST 先
 * 到服务端，读到的仍是旧执行器 —— 用户明明改过了，这一句照旧由旧的跑（第 2 轮审查
 * 实测复现）。所以发送路径必须先 `await settle()`：链空了才算改过去了。返回非 null
 * 表示最后一次写回失败，调用方**不能静默按旧配置发出去**。
 */
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
  const [pending, setPending] = useState<StandingExecutor | null>(null);
  const seq = useRef(0);
  const chain = useRef<Promise<void>>(Promise.resolve());
  const failure = useRef<string | null>(null);
  const settled = standingExecutorOf(task);

  useEffect(() => {
    setPending((current) => (current && same(current, settled) ? null : current));
  }, [settled.agentType, settled.executorId, settled.model, settled.reasoningEffort]);
  // 换任务 = 作废所有在飞的提交：它们仍会写进各自的任务（那是对的），但结果不该再
  // 弹到现在这个任务的界面上。
  useEffect(() => {
    seq.current += 1;
    failure.current = null;
    setPending(null);
  }, [task.id]);

  const commit = (next: StandingExecutor) => {
    if (!save) return;
    const mine = ++seq.current;
    failure.current = null; // 又改了一次 = 上一次的失败翻篇，成败以这一次为准
    setPending(next);
    chain.current = chain.current.then(async () => {
      if (mine !== seq.current) return; // 还在排队时就被更新的提交取代了，这份不必发
      try {
        await save(next);
      } catch (error: unknown) {
        if (mine !== seq.current) return; // 更新的提交已经接管，旧请求的失败与界面无关
        const message = error instanceof Error ? error.message : String(error);
        failure.current = message;
        setPending(null); // 回到任务的真实字段，别拿一份没写成的乐观值糊着
        onError(message);
      }
    });
  };

  // 等到链真正空下来：等待期间用户可能又改了一次（新提交追加在链尾），只等当次的
  // 链尾会漏掉它，于是循环到链不再变化为止。
  const settle = async (): Promise<string | null> => {
    let awaited: Promise<void>;
    do {
      awaited = chain.current;
      await awaited;
    } while (chain.current !== awaited);
    return failure.current;
  };

  return { config: pending ?? settled, commit, settle };
}
