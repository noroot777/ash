import { useEffect, useRef, useState } from "react";
import type { ServerEvent } from "@harness/shared";

// Subscribes to the server SSE stream and forwards parsed events to a handler.
// One connection per app (DESIGN.md §12).
export function useServerEvents(onEvent: (ev: ServerEvent) => void) {
  const handler = useRef(onEvent);
  handler.current = onEvent;
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    const es = new EventSource("/api/events");
    es.onopen = () => setConnected(true);
    es.onerror = () => setConnected(false);
    es.onmessage = (m) => {
      try {
        handler.current(JSON.parse(m.data) as ServerEvent);
      } catch {
        /* ignore pings / non-json */
      }
    };
    return () => es.close();
  }, []);

  return connected;
}
