import { useCallback, useEffect, useRef, useState } from "react";
import type { UserMessage } from "@navi/shared/user-messages";
import { api } from "../lib/api.ts";

/** 打字停下这么久才去问：每敲一个字问一次没必要，服务端那边是一次全量筛。 */
const QUERY_DEBOUNCE_MS = 160;
/** 选中停下这么久才去读右边：按着 ↓ 一路划过去的那些行不必每行都读一次。 */
const SETTLE_MS = 90;

const messageOf = (error: unknown) => error instanceof Error ? error.message : "读取失败";

/**
 * 打了字时，哪些任务里我说的话对得上（各几句）。
 *
 * - `query` 是这份结果对应的那一问；`pending` = 输入框里已经不是这一问了（防抖中、请求还没回来）。
 *   列表和打开动作都跟着结果走，所以 pending 的时候什么都不许打开 —— 不然改完词立刻回车，开的是上一问
 *   选中的那条。
 * - 失败不当成「没有对得上的」：`error` 单独记着、给重试，`hits` 留 null（只按标题筛的那一半照样能用）。
 */
export function useRecallHits(open: boolean, query: string) {
  const [state, setState] = useState<{ query: string; hits: Map<string, number> | null; error: string | null }>(
    { query: "", hits: null, error: null },
  );
  const [attempt, setAttempt] = useState(0);
  const trimmed = query.trim();
  useEffect(() => {
    if (!open || !trimmed) return setState({ query: "", hits: null, error: null });
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      api.userMessageHits(trimmed, controller.signal).then((result) => {
        if (!controller.signal.aborted) setState({ query: trimmed, hits: new Map(result.hits.map((hit) => [hit.taskId, hit.count])), error: null });
      }).catch((error: unknown) => {
        if (!controller.signal.aborted) setState({ query: trimmed, hits: null, error: messageOf(error) });
      });
    }, QUERY_DEBOUNCE_MS);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [attempt, open, trimmed]);
  const retry = useCallback(() => setAttempt((value) => value + 1), []);
  return { ...state, pending: open && trimmed !== state.query, retry };
}

type Entry = {
  /** 已经读到的，旧的在前。 */
  messages: UserMessage[];
  /** 再往前读的游标；null = 读到头了。 */
  older: string | null;
  loadingOlder: boolean;
  /**
   * 往前读那一页失败了。有它在就不再自己去读：往前读是滚到顶自动触发的，失败后那个条件还成立，
   * 不停下就是一边报错一边连珠炮地重试。只有点「重试」才清掉。
   */
  olderError: string | null;
};

/**
 * 右边那一串：选中那一行（连它名下的几条）里我说过的话。先读最近一页，`loadOlder()` 往前接一页。
 *
 * 按行缓存 —— 来回挪选中不重读；每开一次窗口清一次，免得看到的是上次打开时的旧话。换行就作废上一问，
 * 慢回来的旧结果不会画到新的那一行上。
 */
export function useRecallMessagesOf(open: boolean, rowId: string | null, members: readonly string[]) {
  const cache = useRef(new Map<string, Entry>());
  const failed = useRef(new Map<string, string>());
  const [, setVersion] = useState(0);
  const [attempt, setAttempt] = useState(0);
  const key = rowId ? `${rowId}|${members.join(",")}` : null;
  const bump = () => setVersion((value) => value + 1);

  useEffect(() => {
    if (open) return;
    cache.current.clear();
    failed.current.clear();
  }, [open]);

  useEffect(() => {
    if (!open || !key || cache.current.has(key)) return;
    failed.current.delete(key);
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      api.userMessagesOf(members, null, controller.signal).then((page) => {
        cache.current.set(key, { messages: page.messages, older: page.older, loadingOlder: false, olderError: null });
      }).catch((error: unknown) => {
        if (!controller.signal.aborted) failed.current.set(key, messageOf(error));
      }).finally(() => {
        if (!controller.signal.aborted) bump();
      });
    }, SETTLE_MS);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
    // members 已经编进 key；只跟着 key 走，同一行的数组换了个引用不重读。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [attempt, key, open]);

  const entry = key ? cache.current.get(key) : undefined;

  const loadOlder = useCallback(() => {
    if (!key) return;
    const current = cache.current.get(key);
    if (!current?.older || current.loadingOlder || current.olderError) return;
    const loading: Entry = { ...current, loadingOlder: true };
    cache.current.set(key, loading);
    bump();
    api.userMessagesOf(members, current.older).then((page) => {
      // 窗口关过（缓存清了）或这一行被重读过：这一页不是它的前一页了。
      if (cache.current.get(key) !== loading) return;
      cache.current.set(key, { messages: [...page.messages, ...loading.messages], older: page.older, loadingOlder: false, olderError: null });
    }).catch((error: unknown) => {
      if (cache.current.get(key) !== loading) return;
      cache.current.set(key, { ...loading, loadingOlder: false, olderError: messageOf(error) });
    }).finally(bump);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  const retry = useCallback(() => {
    if (!key) return;
    const current = cache.current.get(key);
    if (current?.olderError) {
      cache.current.set(key, { ...current, olderError: null });
      bump();
      return;
    }
    cache.current.delete(key);
    setAttempt((value) => value + 1);
  }, [key]);

  return {
    data: entry ?? null,
    error: key && !entry ? failed.current.get(key) ?? null : null,
    loadOlder,
    retry,
  };
}
