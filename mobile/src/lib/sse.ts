// SSE connection manager — the RN analog of web/src/useEvents.ts. The browser's
// EventSource doesn't exist in React Native, so we use `react-native-sse` (pure
// JS over XMLHttpRequest, runs in Expo Go). One connection for the whole app;
// parsed ServerEvents are dispatched into the store. The library auto-reconnects
// on drop; `onOpen` fires on every (re)connect so callers can backfill state
// that may have changed while we were offline.
import EventSource from "react-native-sse";
import type { ServerEvent } from "@harness/shared";
import { getBaseURL } from "./config";
import { useStore } from "./store";

let es: EventSource | null = null;

export function connectSSE(onOpen?: () => void) {
  disconnectSSE();
  const b = getBaseURL();
  if (!b) return;

  const src = new EventSource(`${b}/api/events`, {
    // Keep the stream open; rely on the library's reconnect, not HTTP polling.
    pollingInterval: 4000,
  });
  es = src;

  src.addEventListener("open", () => {
    useStore.getState().setConnected(true);
    onOpen?.();
  });
  src.addEventListener("error", () => useStore.getState().setConnected(false));
  src.addEventListener("close", () => useStore.getState().setConnected(false));
  src.addEventListener("message", (e) => {
    if (!e.data) return;
    try {
      useStore.getState().handleEvent(JSON.parse(e.data) as ServerEvent);
    } catch {
      /* ignore pings / non-json keepalives */
    }
  });
}

export function disconnectSSE() {
  if (es) {
    es.removeAllEventListeners();
    es.close();
    es = null;
  }
}
