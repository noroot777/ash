import { useCallback, useEffect, useRef, useState } from "react";
import type { UserMessagesOf } from "@ash/shared/user-messages";
import { api } from "../lib/api.ts";

/** 打字停下这么久才去问：每敲一个字问一次没必要，服务端那边是一次全量筛。 */
const QUERY_DEBOUNCE_MS = 160;
/** 选中停下这么久才去读右边：按着 ↓ 一路划过去的那些行不必每行都读一次。 */
const SETTLE_MS = 90;

const messageOf = (error: unknown) => error instanceof Error ? error.message : "读取失败";

/**
 * 打了字时，哪些任务里我说的话对得上（各几句）。`query` 是这份结果对应的那一问 —— 打字还没停下时输入框
 * 已经变了、结果还是上一问的，高亮和筛选得跟结果走。没打字时 hits 是 null。
 */
export function useRecallHits(open: boolean, query: string) {
  const [state, setState] = useState<{ query: string; hits: Map<string, number> | null }>({ query: "", hits: null });
  useEffect(() => {
    if (!open) return setState({ query: "", hits: null });
    const trimmed = query.trim();
    if (!trimmed) return setState({ query: "", hits: null });
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      api.userMessageHits(trimmed, controller.signal).then((result) => {
        if (!controller.signal.aborted) setState({ query: trimmed, hits: new Map(result.hits.map((hit) => [hit.taskId, hit.count])) });
      }).catch(() => {
        // 正文筛不了就只按标题筛（hits 留空），不为它弹错误：标题那一半照样能用。
        if (!controller.signal.aborted) setState({ query: trimmed, hits: new Map() });
      });
    }, QUERY_DEBOUNCE_MS);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [open, query]);
  return state;
}

type Loaded = { status: "loaded"; data: UserMessagesOf } | { status: "error"; error: string };

/**
 * 右边那一串：选中那一行（连它名下的几条）里我说过的每一句。按行缓存 —— 来回挪选中不重读；每开一次窗口
 * 清一次，免得看到的是上次打开时的旧话。换行就作废上一问，慢回来的旧结果不会画到新的那一行上。
 */
export function useRecallMessagesOf(open: boolean, rowId: string | null, members: readonly string[]) {
  const cache = useRef(new Map<string, Loaded>());
  const [, setVersion] = useState(0);
  const [attempt, setAttempt] = useState(0);
  const key = rowId ? `${rowId}|${members.join(",")}` : null;

  useEffect(() => {
    if (!open) cache.current.clear();
  }, [open]);

  useEffect(() => {
    if (!open || !key || cache.current.get(key)?.status === "loaded") return;
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      api.userMessagesOf(members, controller.signal).then((data) => {
        cache.current.set(key, { status: "loaded", data });
      }).catch((error: unknown) => {
        if (!controller.signal.aborted) cache.current.set(key, { status: "error", error: messageOf(error) });
      }).finally(() => {
        if (!controller.signal.aborted) setVersion((value) => value + 1);
      });
    }, SETTLE_MS);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
    // members 已经编进 key；只跟着 key 走，同一行的数组换了个引用不重读。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [attempt, key, open]);

  const retry = useCallback(() => {
    if (key) cache.current.delete(key);
    setAttempt((value) => value + 1);
  }, [key]);

  const loaded = key ? cache.current.get(key) : undefined;
  return {
    data: loaded?.status === "loaded" ? loaded.data : null,
    error: loaded?.status === "error" ? loaded.error : null,
    retry,
  };
}
