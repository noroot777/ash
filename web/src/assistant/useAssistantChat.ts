import { useCallback, useEffect, useRef, useState } from "react";
import type { ChatMember, ChatRoom, ChatSnapshot } from "@ash/shared/chat";
import { chatApi } from "../chat/chatApi.ts";
import { createClientId } from "../lib/clientId.ts";
import { forgetWorkflows } from "../workflow/WorkflowPicker.tsx";

export function useAssistantChat(projectId: string) {
  const [rooms, setRooms] = useState<ChatRoom[]>([]);
  const [roomId, setRoomId] = useState<string | null>(null);
  const [snapshot, setSnapshot] = useState<ChatSnapshot | null>(null);
  const [ready, setReady] = useState(false);
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState("");
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [savingWorkflow, setSavingWorkflow] = useState<string | null>(null);
  const selected = useRef(roomId);
  const request = useRef<{ id: string; body: string } | null>(null);
  selected.current = roomId;
  const select = useCallback((id: string) => {
    if (selected.current === id) return;
    const previousId = selected.current;
    selected.current = id;
    window.localStorage.setItem("ash:assistant:global", id);
    setRoomId(id); setSnapshot(null); setError(""); setConnected(false);
    const savedDraft = window.sessionStorage.getItem(`ash:assistant-draft:${id}`) ?? "";
    setDraft((current) => previousId ? savedDraft : current || savedDraft);
    request.current = null;
  }, []);
  const apply = useCallback((value: ChatSnapshot) => {
    if (selected.current !== value.room.id) return;
    setSnapshot((current) => {
      if (!current || current.room.id !== value.room.id) return value;
      const messages = value.messages.map((message) => {
        const previous = current.messages.find((entry) => entry.id === message.id);
        if (previous && ["done", "failed", "stopped"].includes(previous.status) && ["queued", "running"].includes(message.status)) return previous;
        if (previous?.assistant?.workflowId && message.assistant && !message.assistant.workflowId) return { ...message, assistant: previous.assistant };
        return message;
      });
      return { ...value, messages };
    });
    setRooms((rows) => rows.map((room) => room.id === value.room.id ? value.room : room));
  }, []);
  useEffect(() => {
    let alive = true;
    chatApi.assistants("").then((rows) => {
      if (!alive) return;
      setRooms(rows);
      const saved = window.localStorage.getItem("ash:assistant:global");
      const first = rows.find((room) => room.id === saved) ?? rows.at(-1);
      if (first) select(first.id);
    }).catch((reason) => { if (alive) setError(String(reason)); }).finally(() => { if (alive) setReady(true); });
    return () => { alive = false; };
  }, [select]);
  useEffect(() => {
    if (roomId) window.sessionStorage.setItem(`ash:assistant-draft:${roomId}`, draft);
  }, [roomId, draft]);
  useEffect(() => {
    if (!roomId) return;
    let alive = true;
    let streamed = false;
    chatApi.snapshot(roomId).then((value) => { if (alive && !streamed) apply(value); }).catch((reason) => { if (alive && !streamed) setError(String(reason)); });
    const source = new EventSource(`/api/chats/${encodeURIComponent(roomId)}/events`);
    source.addEventListener("snapshot", (event) => {
      if (!alive) return;
      streamed = true;
      apply(JSON.parse((event as MessageEvent).data) as ChatSnapshot);
      setConnected(true);
    });
    source.onopen = () => { if (alive) setConnected(true); };
    source.onerror = () => { if (alive) setConnected(false); };
    source.addEventListener("revoked", () => { source.close(); if (alive) { setSnapshot(null); setConnected(false); setError("这段对话已不可访问，请切换项目或重新登录。"); } });
    return () => { alive = false; source.close(); };
  }, [roomId, apply]);
  const room = snapshot?.room ?? rooms.find((value) => value.id === roomId);
  const busy = !!snapshot?.messages.some((message) => message.status === "queued" || message.status === "running") || snapshot?.context?.status === "compacting";
  const saveMember = async (member: ChatMember) => {
    if (roomId) {
      const updated = await chatApi.update(roomId, { members: [member] });
      setRooms((rows) => rows.map((row) => row.id === updated.id ? updated : row));
      setSnapshot((value) => value?.room.id === updated.id ? { ...value, room: updated } : value);
    } else {
      const created = await chatApi.createAssistant("", member);
      setRooms((rows) => [...rows, created]); select(created.id);
    }
  };
  const newConversation = async () => {
    if (!room || sending) return;
    setSending(true); setError("");
    try {
      const created = await chatApi.createAssistant("", room.members[0]!, `对话 ${rooms.length + 1}`);
      setRooms((rows) => [...rows, created]); select(created.id);
    } catch (reason) { setError(String(reason)); }
    finally { setSending(false); }
  };
  const send = async () => {
    const body = draft.trim();
    if (!roomId || !body || body.length > 8000 || sending || busy || !snapshot) return;
    if (request.current?.body !== body) request.current = { body, id: createClientId() };
    setSending(true); setError("");
    try {
      const value = await chatApi.send(roomId, body, request.current.id, projectId);
      if (selected.current !== roomId) return;
      apply(value); setDraft(""); request.current = null;
    } catch (reason) { if (selected.current === roomId) setError(String(reason)); }
    finally { setSending(false); }
  };
  const stop = async () => {
    if (!roomId) return;
    try { apply(await chatApi.stop(roomId)); }
    catch (reason) { setError(String(reason)); }
  };
  const saveWorkflow = async (messageId: string) => {
    if (!roomId || savingWorkflow) return;
    setSavingWorkflow(messageId); setError("");
    try { apply(await chatApi.saveWorkflow(roomId, messageId)); void forgetWorkflows(); }
    catch (reason) { if (selected.current === roomId) setError(String(reason)); }
    finally { setSavingWorkflow(null); }
  };
  return { rooms, room, snapshot, ready, connected, error, draft, sending, busy, savingWorkflow, setDraft, select, saveMember, newConversation, send, stop, saveWorkflow };
}
