import { useEffect, useRef, useState } from "react";
import type { UserMessage, UserMessageContext } from "@ash/shared/user-messages";
import { api } from "../lib/api.ts";

/** 选中行停下这么久才去问：按着 ↓ 一路划过去的那些行不必每行都问一次。 */
const SETTLE_MS = 120;

/**
 * 右边那栏的上下文（它上一句说到哪、这一轮怎么回的）。按句缓存：来回挪选中不重复问；
 * 每次换句作废上一问，慢回来的旧上下文不会画到新的那句旁边。
 */
export function useRecallContext(message: UserMessage | undefined): UserMessageContext | null {
  const cache = useRef(new Map<string, UserMessageContext>());
  const [, setVersion] = useState(0);
  const id = message?.id;

  useEffect(() => {
    if (!message || cache.current.has(message.id)) return;
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      api.userMessageContext({ taskId: message.taskId, sessionId: message.sessionId, index: message.index }, controller.signal)
        .then((context) => {
          cache.current.set(message.id, context);
          if (!controller.signal.aborted) setVersion((value) => value + 1);
        })
        // 读不到就只露这一句本身：上下文是添头，不值得为它报错。
        .catch(() => {});
    }, SETTLE_MS);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
    // 只跟着「哪一句」走：同一句的对象换了（翻页合并）不重问。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  return id ? cache.current.get(id) ?? null : null;
}
