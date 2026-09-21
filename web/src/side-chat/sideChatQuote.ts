import { useEffect, useMemo, useSyncExternalStore } from "react";
import { createClientId } from "../lib/clientId.ts";

export type SideChatQuote = { id: string; text: string };
const pendingKey = (taskId: string) => `ash:side-chat:quote:task:${taskId}`;
const roomKey = (roomId: string) => `ash:side-chat:quote:room:${roomId}`;
const newKey = (taskId: string) => `ash:side-chat:quote:new:${taskId}`;
const cache = new Map<string, string>();
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((listener) => listener());

function read(key: string): string {
  if (!cache.has(key)) {
    try { cache.set(key, localStorage.getItem(key) ?? ""); }
    catch { return ""; }
  }
  return cache.get(key)!;
}

function write(key: string, value: string) {
  cache.set(key, value);
  try {
    if (value) localStorage.setItem(key, value);
    else localStorage.removeItem(key);
  } catch { /* The in-memory draft remains usable when storage is unavailable. */ }
}

function parse(value: string): SideChatQuote | null {
  try {
    const quote = JSON.parse(value) as SideChatQuote;
    return typeof quote?.id === "string" && typeof quote.text === "string" ? quote : null;
  } catch { return null; }
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  const sync = (event: StorageEvent) => {
    if (event.storageArea !== localStorage) return;
    if (!event.key) cache.clear();
    else if (event.key.startsWith("ash:side-chat:quote:")) cache.delete(event.key);
    else return;
    listener();
  };
  window.addEventListener("storage", sync);
  return () => { listeners.delete(listener); window.removeEventListener("storage", sync); };
}

export function stageSideChatQuote(taskId: string, text: string) {
  if (!text.trim()) return;
  write(pendingKey(taskId), JSON.stringify({ id: createClientId(), text }));
  emit();
}

export function clearSideChatQuote(taskId: string, roomId: string | null, id: string) {
  for (const key of [pendingKey(taskId), roomId ? roomKey(roomId) : newKey(taskId)]) {
    if (parse(read(key))?.id === id) write(key, "");
  }
  emit();
}

export function moveNewSideChatQuote(taskId: string, roomId: string) {
  const draft = read(newKey(taskId));
  if (draft) { write(roomKey(roomId), draft); write(newKey(taskId), ""); }
  emit();
}

export function useSideChatQuote(taskId: string, roomId: string | null, ready = true) {
  const raw = useSyncExternalStore(subscribe, () => read(pendingKey(taskId)) || read(roomId ? roomKey(roomId) : newKey(taskId)), () => "");
  const quote = useMemo(() => parse(raw), [raw]);
  useEffect(() => {
    const pending = read(pendingKey(taskId));
    if (!ready || !pending) return;
    write(roomId ? roomKey(roomId) : newKey(taskId), pending);
    write(pendingKey(taskId), "");
    emit();
  }, [taskId, roomId, raw, ready]);
  return quote;
}

export function sideChatMessageBody(draft: string, quote: SideChatQuote | null): string {
  const question = draft.trim();
  if (!quote) return question;
  return `【主会话选文，仅作参考】\n${quote.text.split(/\r\n|\r|\n/u).map((line) => `> ${line}`).join("\n")}\n\n【当前问题】\n${question}`;
}
