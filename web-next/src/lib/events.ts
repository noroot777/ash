import { useEffect, useRef, useState } from "react";
import type { ServerEvent } from "@harness/shared";

type EventListener = (event: ServerEvent) => void;
type ConnectionListener = (connected: boolean) => void;

const eventListeners = new Set<EventListener>();
const connectionListeners = new Set<ConnectionListener>();
let eventSource: EventSource | null = null;
let connected = false;

function publishConnection(next: boolean) {
  connected = next;
  for (const listener of connectionListeners) listener(next);
}

function ensureConnection() {
  if (eventSource) return;
  eventSource = new EventSource("/api/events");
  eventSource.onopen = () => publishConnection(true);
  eventSource.onerror = () => publishConnection(false);
  eventSource.onmessage = (message) => {
    try {
      const event = JSON.parse(message.data) as ServerEvent;
      for (const listener of eventListeners) listener(event);
    } catch {
      // 心跳或非 JSON 消息无需进入应用状态。
    }
  };
}

function releaseConnection() {
  if (eventListeners.size || connectionListeners.size || !eventSource) return;
  eventSource.close();
  eventSource = null;
  connected = false;
}

function subscribeEvents(listener: EventListener) {
  eventListeners.add(listener);
  ensureConnection();
  return () => {
    eventListeners.delete(listener);
    releaseConnection();
  };
}

function subscribeConnection(listener: ConnectionListener) {
  connectionListeners.add(listener);
  listener(connected);
  ensureConnection();
  return () => {
    connectionListeners.delete(listener);
    releaseConnection();
  };
}

/** 全应用共享一条 EventSource；多个数据 hook 只增加本地订阅者。 */
export function useServerEvents(onEvent: EventListener): boolean {
  const handler = useRef(onEvent);
  handler.current = onEvent;
  const [isConnected, setIsConnected] = useState(connected);

  useEffect(() => {
    const removeEvent = subscribeEvents((event) => handler.current(event));
    const removeConnection = subscribeConnection(setIsConnected);
    return () => {
      removeEvent();
      removeConnection();
    };
  }, []);

  return isConnected;
}
