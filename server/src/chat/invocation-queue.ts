import type { invokeChat } from "./execution.js";

export function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason ?? new Error("已停止"));
    signal.addEventListener("abort", abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}

export function limitedChatInvoke(invoke: typeof invokeChat, limit = 4): typeof invokeChat {
  let active = 0;
  const waiting: { enter: () => void; signal: AbortSignal }[] = [];
  const release = () => {
    active--;
    while (waiting.length) {
      const next = waiting.shift()!;
      if (next.signal.aborted) continue;
      next.enter();
      break;
    }
  };
  return async (...args) => {
    const signal = args[3];
    signal.throwIfAborted();
    await new Promise<void>((resolve, reject) => {
      const abort = () => {
        const index = waiting.indexOf(entry);
        if (index >= 0) waiting.splice(index, 1);
        reject(signal.reason);
      };
      const entry = { signal, enter: () => { signal.removeEventListener("abort", abort); active++; resolve(); } };
      if (active < limit) entry.enter();
      else { waiting.push(entry); signal.addEventListener("abort", abort, { once: true }); }
    });
    try { signal.throwIfAborted(); return await invoke(...args); }
    finally { release(); }
  };
}
