// 飞书分区三份服务端状态（连接状态、个人绑定、群绑定）共用的轮询。
//
// 状态一律以服务端为准：绑定走到了哪一步、连没连上、推送开没开，刷新页面之后都得原样
// 看得出来，所以这里不在页面上推演状态，只管「拉一份、接一份」。
//
// 两条防旧响应的规矩合成一个递增戳：
//  · 每次发轮询取一个戳；每次写操作**完成时**也取一个戳（写操作都回完整状态，直接接住）。
//  · 只接戳比上一次接住的更大的那份。于是写操作完成之前就已发出的轮询，响应晚到也会被丢掉
//    ——否则刚点完「确认绑定」，一份还停在「待确认」的旧响应能把界面拽回去。
//
// 后台轮询失败不弹提示（下一轮会补上），但会把错误留着：连接卡据此标出「这是哪个时刻的状态」，
// 免得服务端挂了界面还一直亮着「已连接」。
import { useCallback, useEffect, useRef, useState } from "react";

export const FAST_POLL_MS = 2000;
export const SLOW_POLL_MS = 10_000;

export interface FeishuPoll<T> {
  data: T | null;
  /** 最近一次拉取失败的原因；之后拉成功了就清掉。 */
  error: string | null;
  /** 当前这份数据是什么时候拿到的。 */
  syncedAt: number | null;
  reload: () => Promise<void>;
  /** 写操作回来的完整状态：接住，并让更早发出的轮询作废。 */
  apply: (next: T) => void;
}

export function useFeishuPoll<T>(
  load: () => Promise<T>,
  /** 按当前数据决定多久拉一次（有待确认的码时勤一点）。 */
  intervalOf: (data: T | null) => number,
  failText: string,
): FeishuPoll<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [syncedAt, setSyncedAt] = useState<number | null>(null);
  const stamp = useRef(0);
  const accepted = useRef(0);
  const alive = useRef(true);
  const loadRef = useRef(load);
  loadRef.current = load;

  const accept = useCallback((at: number, next: T) => {
    if (!alive.current || at <= accepted.current) return;
    accepted.current = at;
    setData(next);
    setError(null);
    setSyncedAt(Date.now());
  }, []);

  const reload = useCallback(async () => {
    const at = ++stamp.current;
    try {
      accept(at, await loadRef.current());
    } catch (cause) {
      if (alive.current && at > accepted.current) setError(cause instanceof Error ? cause.message : failText);
    }
  }, [accept, failText]);

  const apply = useCallback((next: T) => accept(++stamp.current, next), [accept]);

  useEffect(() => {
    alive.current = true;
    void reload();
    return () => { alive.current = false; };
  }, [reload]);

  const interval = intervalOf(data);
  useEffect(() => {
    // 页面藏在后台时不拉：切回来那一下立刻补一次，比后台空转更及时也更省。
    const timer = window.setInterval(() => {
      if (document.visibilityState !== "hidden") void reload();
    }, interval);
    const onVisible = () => { if (document.visibilityState === "visible") void reload(); };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [interval, reload]);

  return { data, error, syncedAt, reload, apply };
}

/**
 * 倒计时要每秒重画；没有在走的倒计时就不起定时器。
 *
 * 时间在渲染时现取，定时器只负责催一次重画：把时刻存进 state 的话，刚生成码那一帧用的还是
 * 上一次滴答（甚至挂载那一刻）的时间，十分钟的码会先显示成 10:01 之类。
 */
export function useNow(active: boolean): number {
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!active) return;
    const timer = window.setInterval(() => setTick((tick) => tick + 1), 1000);
    return () => window.clearInterval(timer);
  }, [active]);
  return Date.now();
}
