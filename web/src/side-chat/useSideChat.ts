import { useCallback, useEffect, useRef, useState } from "react";
import type { ChatMember, ChatRoom, ChatSnapshot } from "@ash/shared/chat";
import { chatApi } from "../chat/chatApi.ts";
import { createClientId } from "../lib/clientId.ts";

const read = (key: string) => { try { return localStorage.getItem(key); } catch { return null; } };
const write = (key: string, value: string) => { try { localStorage.setItem(key, value); } catch { /* Storage can be unavailable. */ } };
const draftKey = (id: string) => `ash:side-chat:draft:${id}`;
const requestKey = (id: string) => `ash:side-chat:send:${id}`;
const finished = (status: string) => ["done", "failed", "stopped"].includes(status);

export function mergeSideSnapshot(previous: ChatSnapshot | null, next: ChatSnapshot): ChatSnapshot {
  if (!previous || previous.room.id !== next.room.id) return next;
  const messages = new Map(previous.messages.map((message) => [message.id, message]));
  for (const message of next.messages) {
    const old = messages.get(message.id);
    if (old && finished(old.status) && !finished(message.status)) continue;
    const forward = old?.forward && ["sent", "canceled"].includes(old.forward.status)
      && message.forward && ["queued", "delivering"].includes(message.forward.status) ? old.forward : message.forward;
    messages.set(message.id, { ...message, forward });
  }
  return { ...next, messages: [...messages.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id)).slice(-500) };
}

export function useSideChat(taskId: string) {
  const [rooms, setRooms] = useState<ChatRoom[]>([]);
  const [roomId, setRoomId] = useState<string | null>(null);
  const [snapshot, setSnapshot] = useState<ChatSnapshot | null>(null);
  const [ready, setReady] = useState(false);
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState("");
  const [draft, setDraftState] = useState("");
  const [sending, setSending] = useState(false);
  const alive = useRef(true);
  const locked = useRef(false);
  const selected = useRef<string | null>(null);
  const selectionKey = `ash:side-chat:task:${taskId}`;
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const select = useCallback((id: string) => {
    selected.current = id;
    write(selectionKey, id);
    setRoomId(id); setSnapshot(null); setConnected(false); setError("");
    setDraftState(read(draftKey(id)) ?? "");
  }, [selectionKey]);
  const apply = useCallback((value: ChatSnapshot) => {
    if (!alive.current || selected.current !== value.room.id || value.room.parentTaskId !== taskId) return;
    setSnapshot((previous) => mergeSideSnapshot(previous, value));
    setRooms((rows) => rows.map((row) => row.id === value.room.id ? value.room : row));
    setError("");
    try {
      const request = JSON.parse(read(requestKey(value.room.id)) ?? "null") as { id: string; body: string } | null;
      if (request && value.messages.some((message) => message.id === request.id && message.role === "user")) {
        if (read(draftKey(value.room.id)) === request.body) {
          write(draftKey(value.room.id), ""); setDraftState("");
        }
        write(requestKey(value.room.id), "null");
      }
    } catch { /* Invalid local drafts do not affect server history. */ }
  }, [taskId]);
  const reload = useCallback(async () => {
    try {
      const rows = await chatApi.sideChats(taskId);
      if (!alive.current) return;
      setRooms(rows); setError("");
      const saved = read(selectionKey);
      const first = rows.find((room) => room.id === saved) ?? rows[0];
      if (first && !selected.current) select(first.id);
    } catch (reason) { if (alive.current) setError(String(reason)); }
    finally { if (alive.current) setReady(true); }
  }, [taskId, selectionKey, select]);
  useEffect(() => { void reload(); }, [reload]);
  useEffect(() => {
    if (!roomId) return;
    let active = true;
    let streamed = false;
    chatApi.snapshot(roomId).then((value) => { if (active && !streamed) apply(value); }).catch((reason) => { if (active && !streamed) setError(String(reason)); });
    const source = new EventSource(`/api/chats/${encodeURIComponent(roomId)}/events`);
    source.addEventListener("snapshot", (event) => {
      if (!active) return;
      streamed = true;
      apply(JSON.parse((event as MessageEvent).data) as ChatSnapshot); setConnected(true);
    });
    source.onopen = () => { if (active) setConnected(true); };
    source.onerror = () => { if (active) setConnected(false); };
    source.addEventListener("revoked", () => {
      source.close();
      if (active) { setSnapshot(null); setConnected(false); setError("侧聊已不可访问，请检查项目权限。"); }
    });
    return () => { active = false; source.close(); };
  }, [roomId, apply]);
  const room = snapshot?.room ?? rooms.find((row) => row.id === roomId);
  const busy = !!snapshot?.messages.some((message) => !finished(message.status)) || snapshot?.context?.status === "compacting";
  const setDraft = (value: string) => {
    if (roomId) write(draftKey(roomId), value);
    setDraftState(value);
  };
  const create = async (member: ChatMember) => {
    if (locked.current) return;
    locked.current = true; setSending(true);
    const key = `ash:side-chat:create:${taskId}`;
    const id = read(key) || createClientId();
    write(key, id);
    try {
      const created = await chatApi.createSideChat(taskId, member, id);
      write(key, "");
      if (!alive.current) return;
      setRooms((rows) => [created, ...rows.filter((row) => row.id !== created.id)]); select(created.id);
    } finally { locked.current = false; if (alive.current) setSending(false); }
  };
  const saveMember = async (member: ChatMember) => {
    if (!roomId) return create(member);
    const updated = await chatApi.update(roomId, { members: [member] });
    if (!alive.current || selected.current !== roomId) return;
    setRooms((rows) => rows.map((row) => row.id === roomId ? updated : row));
    setSnapshot((value) => value ? { ...value, room: updated } : value);
  };
  const send = async () => {
    const body = draft.trim();
    if (!roomId || !snapshot || busy || locked.current || !body) return;
    locked.current = true; setSending(true); setError("");
    let request: { id: string; body: string } | null = null;
    try { request = JSON.parse(read(requestKey(roomId)) ?? "null"); } catch { /* Recreate invalid local metadata. */ }
    if (!request || request.body !== body) request = { id: createClientId(), body };
    write(requestKey(roomId), JSON.stringify(request));
    write(draftKey(roomId), body);
    try { apply(await chatApi.send(roomId, body, request.id)); }
    catch (reason) { if (alive.current && selected.current === roomId && read(requestKey(roomId)) !== "null") setError(String(reason)); }
    finally { locked.current = false; if (alive.current) setSending(false); }
  };
  const stop = async () => {
    if (!roomId || sending) return;
    try { apply(await chatApi.stop(roomId)); }
    catch (reason) { if (alive.current && selected.current === roomId) setError(String(reason)); }
  };
  return { rooms, room, snapshot, ready, connected, error, draft, sending, busy, select, setDraft, create, saveMember, send, stop, reload };
}
