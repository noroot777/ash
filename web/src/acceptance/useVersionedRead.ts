import { useCallback, useEffect, useState } from "react";

/**
 * 读一份「属于某个任务某一版」的事实（验收台的走向、提交、diff）。读到的那份**带着它的版本**存，
 * 所以消费方拿到的永远分得清：
 *   current  —— 就是这一版的；
 *   previous —— 同一个任务的上一版（这一版还没读到或读失败了）。只能标明「上一版」给人参考，
 *               不许再当成当前走向摆出来 —— 不然顶行指着旧目标、确认层合的却是新目标；
 * 换了任务（scope 变）上一版一并作废，别人的 diff 不会串过来。
 *
 * `version` 由调用方拼：任务更新时间、工作区提交版本这类「变了就得重读」的东西。
 */
export function useVersionedRead<T>(scope: string, version: string, read: () => Promise<T>, enabled = true) {
  const [snapshot, setSnapshot] = useState<{ scope: string; version: string; value: T } | null>(null);
  const [failure, setFailure] = useState<{ scope: string; version: string; message: string } | null>(null);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    setFailure(null);
    read().then(
      (value) => { if (alive) setSnapshot({ scope, version, value }); },
      (reason) => { if (alive) setFailure({ scope, version, message: reason instanceof Error ? reason.message : String(reason) }); },
    );
    return () => { alive = false; };
    // read 每次渲染都是新的闭包；该重读的时机只由 scope / version / attempt 决定。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scope, version, attempt, enabled]);
  const sameScope = snapshot?.scope === scope;
  const current = sameScope && snapshot.version === version ? snapshot.value : null;
  const previous = sameScope && snapshot.version !== version ? snapshot.value : null;
  const error = failure?.scope === scope && failure.version === version ? failure.message : null;
  const retry = useCallback(() => setAttempt((value) => value + 1), []);
  return { current, previous, loading: enabled && current === null && error === null, error, retry };
}
