import { useEffect, useRef, useState } from "react";

/**
 * 一份写回任务的**完整配置**（常设执行器、派出去的活交给谁），按用户提交的顺序落库。
 *
 * 写回是异步的（往返 + SSE 回流），中间这一两百毫秒不能让界面弹回旧值 —— 所以本地先押一份乐观值，
 * 任务字段追上来就把它撤掉（这样 agent 自己改了这份配置时，界面仍然跟着任务走，而不是被乐观值钉死）。
 *
 * **写回必须串行，而且只认最后一次提交。** 胶囊本来就会连着提交两次 —— 选完智能体自动向右展开模型段，
 * 用户接着选模型，两份完整配置前后脚发出。并发发的话，先发的那份要是后到，数据库就被它盖回旧配置，
 * 而界面还留着新的乐观值：胶囊写着新模型，实际用的却是旧的（常设执行器第 1 轮审查、派活默认第 1 轮审查
 * 都实测复现）。所以这里排成一条链，一次只在飞一个；排队期间又被更新的提交取代的，直接跳过不发。失败与
 * 回滚也按提交序号认领 —— 旧请求的报错既不该弹出来，更不该把用户更新的选择拽回去。
 *
 * **`settle()` 是依赖这份配置的操作前的闸。** 改完立刻按发送 / 派出去，写回还在飞、那一笔请求先到服务端，
 * 读到的仍是旧配置。所以那些路径必须先 `await settle()`：链空了才算改过去了。返回非 null 表示最后一次
 * 写回失败，调用方**不能静默按旧配置继续**。
 */
export function useOrderedSave<T>(
  /** 任务字段视角的当前值。 */
  settled: T,
  same: (a: T, b: T) => boolean,
  /** 换了这个（任务 id）= 作废所有在飞的提交。 */
  scope: string,
  save: ((next: T) => Promise<void>) | undefined,
  onError: (message: string) => void,
): {
  value: T;
  commit: (next: T) => void;
  /** 等写回全部落地。null = 都成功了；字符串 = 最后一次写回失败的原因。 */
  settle: () => Promise<string | null>;
} {
  const [pending, setPending] = useState<{ next: T } | null>(null);
  const seq = useRef(0);
  const chain = useRef<Promise<void>>(Promise.resolve());
  const failure = useRef<string | null>(null);

  useEffect(() => {
    setPending((current) => (current && same(current.next, settled) ? null : current));
  }, [JSON.stringify(settled)]);
  // 换任务 = 作废所有在飞的提交：它们仍会写进各自的任务（那是对的），但结果不该再弹到现在这个任务的界面上。
  useEffect(() => {
    seq.current += 1;
    failure.current = null;
    setPending(null);
  }, [scope]);

  const commit = (next: T) => {
    if (!save) return;
    const mine = ++seq.current;
    failure.current = null; // 又改了一次 = 上一次的失败翻篇，成败以这一次为准
    setPending({ next });
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

  // 等到链真正空下来：等待期间用户可能又改了一次（新提交追加在链尾），只等当次的链尾会漏掉它，
  // 于是循环到链不再变化为止。
  const settle = async (): Promise<string | null> => {
    let awaited: Promise<void>;
    do {
      awaited = chain.current;
      await awaited;
    } while (chain.current !== awaited);
    return failure.current;
  };

  return { value: pending ? pending.next : settled, commit, settle };
}
