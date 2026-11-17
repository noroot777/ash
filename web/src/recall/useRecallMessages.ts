import { useCallback, useEffect, useRef, useState } from "react";
import type { UserMessage, UserMessageTask } from "@ash/shared/user-messages";
import { api } from "../lib/api.ts";

/** 打字停下这么久才去问：每敲一个字问一次没必要，服务端那边是一次全量筛。 */
const QUERY_DEBOUNCE_MS = 160;

type State = {
  messages: UserMessage[];
  tasks: Map<string, UserMessageTask>;
  next: string | null;
  /** 第一页还没回来（换了查询也算）。 */
  loading: boolean;
  /** 正在接下一页。 */
  loadingMore: boolean;
  /**
   * 出错了。有它在就不再自己去取：接下一页有两处自动触发（滚到底、按着 ↓ 快到底），失败后两处的条件都
   * 还成立，不停下就是一边报错一边连珠炮地重试。只有点「重试」才清掉它。
   */
  error: string | null;
};

const EMPTY: State = { messages: [], tasks: new Map(), next: null, loading: true, loadingMore: false, error: null };

const messageOf = (error: unknown) => error instanceof Error ? error.message : "读取失败";

/**
 * R 键那张表的数据：开着才问，换了查询从第一页重来，`more()` 接下一页。
 *
 * 每一问都有自己的 AbortController，后发的作废先发的 —— 打字快的时候先发的那问可能后回来，
 * 不作废就会把旧查询的结果盖在新查询上。
 */
export function useRecallMessages(open: boolean, query: string) {
  const [state, setState] = useState<State>(EMPTY);
  const [debounced, setDebounced] = useState(query);
  const controller = useRef<AbortController | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (!open) return;
    const timer = window.setTimeout(() => setDebounced(query), query ? QUERY_DEBOUNCE_MS : 0);
    return () => window.clearTimeout(timer);
  }, [open, query]);

  useEffect(() => {
    if (!open) {
      controller.current?.abort();
      setState(EMPTY);
      return;
    }
    controller.current?.abort();
    const current = new AbortController();
    controller.current = current;
    setState((previous) => ({ ...previous, loading: true, loadingMore: false, error: null }));
    api.userMessages({ query: debounced, signal: current.signal }).then((page) => {
      if (current.signal.aborted) return;
      setState({
        messages: page.messages,
        tasks: new Map(page.tasks.map((task) => [task.id, task])),
        next: page.next,
        loading: false,
        loadingMore: false,
        error: null,
      });
    }).catch((error: unknown) => {
      if (current.signal.aborted) return;
      setState((previous) => ({ ...previous, messages: [], next: null, loading: false, error: messageOf(error) }));
    });
    return () => current.abort();
  }, [attempt, debounced, open]);

  const more = useCallback(() => {
    if (!open || state.loading || state.loadingMore || state.error || !state.next) return;
    const current = controller.current ?? new AbortController();
    const cursor = state.next;
    setState((previous) => ({ ...previous, loadingMore: true }));
    api.userMessages({ query: debounced, cursor, signal: current.signal }).then((page) => {
      if (current.signal.aborted) return;
      setState((previous) => {
        // 回来时查询已经换过（游标对不上了）：这一页不是当前列表的下一页。
        if (previous.next !== cursor) return previous;
        const seen = new Set(previous.messages.map((message) => message.id));
        const tasks = new Map(previous.tasks);
        for (const task of page.tasks) tasks.set(task.id, task);
        return {
          ...previous,
          messages: [...previous.messages, ...page.messages.filter((message) => !seen.has(message.id))],
          tasks,
          next: page.next,
          loadingMore: false,
          error: null,
        };
      });
    }).catch((error: unknown) => {
      if (current.signal.aborted) return;
      setState((previous) => ({ ...previous, loadingMore: false, error: messageOf(error) }));
    });
  }, [debounced, open, state.error, state.loading, state.loadingMore, state.next]);

  // 第一页就没取到：整份重来。接下一页时出的错：已经读到的留着，清掉错误，两处自动触发会照常接上那一页。
  const pagingFailed = state.error !== null && state.messages.length > 0 && state.next !== null;
  const retry = useCallback(() => {
    if (pagingFailed) setState((previous) => ({ ...previous, error: null }));
    else setAttempt((value) => value + 1);
  }, [pagingFailed]);
  // 列表此刻对应的查询：打字还没停下时 query 已经变了、列表还是上一问的，高亮得跟列表走。
  return { ...state, query: debounced, more, retry };
}
