import { useCallback, useEffect, useRef, useState } from "react";

/**
 * 前提列里一行自己的那份现场（工作区目录、待提交的合并……）。首读、自动重读、本行重试、动作之后的
 * 核对**走同一条路**，所以读失败只有一个去处：`error`（旧值照旧留在 `value` 里，由那一行说「待核对」
 * 并给重试）。不许有哪条动作路径把读失败写进只在弹层里显示的状态 —— 弹层一关就没人看得见了。
 *
 * 防乱序：每次读取、每次 `put`（动作回执直接带回来的现场）都换一个序号，晚到的旧读取一律作废，
 * 不会把动作刚写进来的新现场又盖回去。换了 `scope`（另一个任务）旧值一并作废。
 */
export function useRowRead<T>(scope: string, read: () => Promise<T>, enabled = true, deps: readonly unknown[] = []) {
  const [state, setState] = useState<{ scope: string; value: T | null; error: string | null }>({ scope, value: null, error: null });
  const sequence = useRef(0);
  const reader = useRef(read);
  reader.current = read;
  /** 读到了就交回这一份（被更晚的读取或 put 顶掉的不算）；读失败交回 null，原因落在 error。 */
  const reload = useCallback(async (): Promise<T | null> => {
    const mine = ++sequence.current;
    try {
      const value = await reader.current();
      if (sequence.current !== mine) return null;
      setState({ scope, value, error: null });
      return value;
    } catch (reason) {
      if (sequence.current !== mine) return null;
      const message = reason instanceof Error ? reason.message : String(reason);
      setState((current) => ({ scope, value: current.scope === scope ? current.value : null, error: message }));
      return null;
    }
  }, [scope]);
  useEffect(() => {
    if (!enabled) return;
    void reload();
    return () => { sequence.current += 1; };
    // deps 由调用方给：除了 scope 之外，哪些变化要求重读一次现场。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reload, enabled, ...deps]);
  const put = useCallback((value: T) => {
    sequence.current += 1;
    setState({ scope, value, error: null });
  }, [scope]);
  const mine = state.scope === scope;
  return { value: mine ? state.value : null, error: mine ? state.error : null, reload, put };
}
