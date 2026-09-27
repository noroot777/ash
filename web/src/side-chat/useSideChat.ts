import { useCallback, useEffect, useRef, useState, type SetStateAction } from "react";
import type { ChatMember, ChatRoom, ChatSnapshot } from "@ash/shared/chat";
import { chatApi } from "../chat/chatApi.ts";
import { createClientId } from "../lib/clientId.ts";
import type { UploadAttachment, UploadingFile } from "../task-detail/Attachments.tsx";
import { clearSideChatQuote, moveNewSideChatQuote, sideChatMessageBody, useSideChatQuote } from "./sideChatQuote.ts";
import { newSideChatScope, readSideStorage as read, sideAttachmentsKey as filesKey, sideDraftKey as draftKey, sideRequestKey as requestKey, writeSideStorage as write } from "./sideChatStorage.ts";

const finished = (status: string) => ["done", "failed", "stopped"].includes(status);
type SendRequest = { id: string; body: string; draft?: string; quoteId?: string; attachments?: string[] };
const sameMember = (a: ChatMember, b: ChatMember) => a.agentType === b.agentType && a.executorId === b.executorId
  && a.model === b.model && a.reasoningEffort === b.reasoningEffort && a.name === b.name;
const samePaths = (a: string[] | undefined, b: string[]) => JSON.stringify(a ?? []) === JSON.stringify(b);

// 已上传的附件跟草稿一样按 scope 落在本地：刷新页面、切到别的侧聊再切回来，
// 粘好还没发的那几张图仍在原处（字节早就在服务端了，这里存的只是路径和缩略图信息）。
function readAttachments(scope: string): UploadAttachment[] {
  try {
    const value = JSON.parse(read(filesKey(scope)) ?? "[]") as unknown;
    return Array.isArray(value) ? value.filter((item): item is UploadAttachment =>
      !!item && typeof (item as UploadAttachment).path === "string") : [];
  } catch { return []; }
}

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
  const newScope = newSideChatScope(taskId);
  const [rooms, setRooms] = useState<ChatRoom[]>([]);
  const [roomId, setRoomId] = useState<string | null>(null);
  const [snapshot, setSnapshot] = useState<ChatSnapshot | null>(null);
  const [ready, setReady] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState("");
  const [sendError, setSendError] = useState("");
  const [memberError, setMemberError] = useState("");
  const [memberUncertain, setMemberUncertain] = useState(false);
  const [draft, setDraftState] = useState(() => read(draftKey(newScope)) ?? "");
  const [attachments, setAttachmentsState] = useState<UploadAttachment[]>(() => readAttachments(newScope));
  const [pending, setPendingState] = useState<UploadingFile[]>([]);
  const [sending, setSending] = useState(false);
  const [savingMember, setSavingMember] = useState(false);
  const [proposedMember, setProposedMember] = useState<{ roomId: string; member: ChatMember } | null>(null);
  const quote = useSideChatQuote(taskId, roomId, loaded);
  const alive = useRef(true);
  const locked = useRef(false);
  const selected = useRef<string | null>(null);
  const initialized = useRef(false);
  const memberQueue = useRef(Promise.resolve());
  const memberRevision = useRef(0);
  const memberPending = useRef(false);
  const confirmedMembers = useRef(new Map<string, ChatMember>());
  const attached = useRef(attachments);
  const uploading = useRef(pending);
  const selectionKey = `ash:side-chat:task:${taskId}`;
  const restoreAttachments = useCallback((scope: string) => {
    const restored = readAttachments(scope);
    attached.current = restored;
    setAttachmentsState(restored);
  }, []);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const chooseRoom = useCallback((id: string | null) => {
    initialized.current = true; selected.current = id;
    write(selectionKey, id ?? "new");
    setRoomId(id); setSnapshot(null); setConnected(false); setError(""); setSendError(""); setMemberError(""); setMemberUncertain(false);
    setProposedMember(null); memberPending.current = false;
    setDraftState(read(draftKey(id ?? newSideChatScope(taskId))) ?? "");
    restoreAttachments(id ?? newSideChatScope(taskId));
  }, [taskId, selectionKey, restoreAttachments]);
  const apply = useCallback((value: ChatSnapshot) => {
    if (value.room.parentTaskId !== taskId) return;
    const confirmed = confirmedMembers.current.get(value.room.id);
    if (confirmed) {
      if (value.room.members[0] && sameMember(confirmed, value.room.members[0])) confirmedMembers.current.delete(value.room.id);
      else value = { ...value, room: { ...value.room, members: [confirmed] } };
    }
    const active = alive.current && selected.current === value.room.id;
    let clearedDraft = false;
    let clearedFiles = false;
    let acknowledged = false;
    try {
      const request = JSON.parse(read(requestKey(value.room.id)) ?? "null") as SendRequest | null;
      if (request && value.messages.some((message) => message.id === request.id && message.role === "user")) {
        acknowledged = true;
        if (read(draftKey(value.room.id)) === (request.draft ?? request.body)) {
          write(draftKey(value.room.id), ""); clearedDraft = true;
        }
        // 发出去的那几张才摘：请求在途期间又粘进来的留着（跟主会话回复框同一条判据）。
        if (samePaths(request.attachments, readAttachments(value.room.id).map((file) => file.path))) {
          write(filesKey(value.room.id), "[]"); clearedFiles = true;
        }
        if (request.quoteId) clearSideChatQuote(taskId, value.room.id, request.quoteId);
        write(requestKey(value.room.id), "null");
      }
    } catch { /* Invalid local drafts do not affect server history. */ }
    if (!active) return;
    setSnapshot((previous) => mergeSideSnapshot(previous, value));
    setRooms((rows) => rows.map((row) => row.id === value.room.id ? value.room : row));
    setError("");
    if (acknowledged) setSendError("");
    if (clearedDraft) setDraftState("");
    if (clearedFiles) { attached.current = []; setAttachmentsState([]); }
  }, [taskId]);
  const reload = useCallback(async () => {
    const revision = memberRevision.current;
    try {
      const rows = await chatApi.sideChats(taskId);
      if (!alive.current || memberRevision.current !== revision) return;
      setRooms(rows); setError(""); setLoaded(true);
      if (!initialized.current) {
        const saved = read(selectionKey);
        chooseRoom(saved === "new" ? null : (rows.find((room) => room.id === saved) ?? rows[0])?.id ?? null);
      } else if (selected.current) {
        const current = await chatApi.snapshot(selected.current);
        if (!alive.current || memberRevision.current !== revision) return;
        confirmedMembers.current.delete(current.room.id);
        apply(current);
      }
      if (alive.current) { setMemberUncertain(false); setMemberError(""); setProposedMember(null); memberPending.current = false; }
    } catch (reason) { if (alive.current) setError(String(reason)); }
    finally { if (alive.current) setReady(true); }
  }, [taskId, selectionKey, chooseRoom, apply]);
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
      if (active) { setSnapshot(null); setConnected(false); setLoaded(false); setError("侧聊已不可访问，请检查项目权限。"); }
    });
    return () => { active = false; source.close(); };
  }, [roomId, apply]);
  const baseRoom = snapshot?.room ?? rooms.find((row) => row.id === roomId);
  const room = baseRoom && proposedMember?.roomId === baseRoom.id ? { ...baseRoom, members: [proposedMember.member] } : baseRoom;
  const busy = !!snapshot?.messages.some((message) => !finished(message.status)) || snapshot?.context?.status === "compacting";
  const body = sideChatMessageBody(draft, quote);
  // 只粘一张图不打字也能发（正文空、附件在，服务端按有附件放行）；在途的没传完不放行，
  // 否则发出去的那条会少几张图，而用户以为都带上了。
  const canSend = loaded && (!roomId || !!snapshot) && !busy && !sending && !savingMember && !memberUncertain
    && !pending.length && (!!draft.trim() || attachments.length > 0);
  const setDraft = (value: string) => {
    write(draftKey(selected.current ?? newScope), value);
    setDraftState(value);
  };
  const setAttachments = (update: SetStateAction<UploadAttachment[]>) => {
    const next = typeof update === "function" ? update(attached.current) : update;
    attached.current = next;
    write(filesKey(selected.current ?? newScope), JSON.stringify(next));
    setAttachmentsState(next);
  };
  const setPending = (update: SetStateAction<UploadingFile[]>) => {
    const next = typeof update === "function" ? update(uploading.current) : update;
    uploading.current = next;
    setPendingState(next);
  };
  const updateRoom = (value: ChatRoom) => {
    if (!alive.current || selected.current !== value.id) return;
    if (value.members[0]) confirmedMembers.current.set(value.id, value.members[0]);
    setRooms((rows) => rows.map((row) => row.id === value.id ? value : row));
    setSnapshot((previous) => previous ? { ...previous, room: value } : previous);
  };
  const saveMember = async (member: ChatMember) => {
    if (!roomId || !snapshot || busy || locked.current) return;
    const revision = ++memberRevision.current;
    memberPending.current = true;
    setProposedMember({ roomId, member }); setSavingMember(true); setMemberError(""); setSendError(""); setMemberUncertain(true);
    const operation = memberQueue.current.then(() => chatApi.update(roomId, { members: [member] }));
    memberQueue.current = operation.then(() => undefined, () => undefined);
    try {
      const updated = await operation;
      if (revision !== memberRevision.current) return;
      updateRoom(updated);
      if (alive.current && selected.current === roomId) {
        setProposedMember(null); setMemberUncertain(false); memberPending.current = false;
      }
    } catch (reason) {
      if (alive.current && selected.current === roomId && revision === memberRevision.current) {
        setProposedMember(null);
        setMemberError(`更换执行器未完成：${String(reason)}。请重新连接确认当前配置后再发送。`);
        setMemberUncertain(true);
      }
    } finally { if (alive.current && revision === memberRevision.current) setSavingMember(false); }
  };
  const send = async (member: ChatMember | undefined) => {
    if (!member || !canSend || locked.current || memberPending.current) return;
    locked.current = true; setSending(true); setError(""); setSendError("");
    let targetId = roomId;
    const scope = targetId ?? newScope;
    let previous: SendRequest | null = null;
    try { previous = JSON.parse(read(requestKey(scope)) ?? "null"); } catch { /* Recreate invalid local metadata. */ }
    const paths = attached.current.map((file) => file.path);
    const request: SendRequest = { id: previous?.body === body && samePaths(previous.attachments, paths) ? previous.id : createClientId(), body, draft: draft.trim(), quoteId: quote?.id, attachments: paths };
    write(requestKey(scope), JSON.stringify(request));
    write(draftKey(scope), draft.trim());
    try {
      if (!targetId) {
        const key = `ash:side-chat:create:${taskId}`;
        const id = read(key) || createClientId();
        write(key, id);
        const created = await chatApi.createSideChat(taskId, member, id);
        targetId = created.id;
        write(requestKey(targetId), JSON.stringify(request));
        write(draftKey(targetId), read(draftKey(newScope)) ?? request.draft!);
        write(filesKey(targetId), read(filesKey(newScope)) ?? "[]");
        write(draftKey(newScope), ""); write(requestKey(newScope), "null"); write(filesKey(newScope), "[]");
        write(selectionKey, targetId); write(key, "");
        selected.current = targetId; initialized.current = true;
        moveNewSideChatQuote(taskId, targetId);
        if (alive.current) {
          setRooms((rows) => [created, ...rows.filter((row) => row.id !== created.id)]);
          setRoomId(targetId); setSnapshot(null); setConnected(false);
          setDraftState(read(draftKey(targetId)) ?? "");
          restoreAttachments(targetId);
        }
        // A retry can recover a room created with the user's earlier model choice.
        if (created.members[0] && !sameMember(created.members[0], member)) {
          if (alive.current) setMemberUncertain(true);
          const updated = await chatApi.update(targetId, { members: [{ ...member, id: created.members[0].id }] });
          updateRoom(updated);
          if (alive.current) setMemberUncertain(false);
        }
      }
      apply(await chatApi.send(targetId, body, request.id, undefined, paths));
    } catch (reason) {
      if (alive.current && (!targetId || selected.current === targetId)
        && read(requestKey(targetId ?? scope)) !== "null") setSendError(String(reason));
    } finally { locked.current = false; if (alive.current) setSending(false); }
  };
  const stop = async () => {
    if (!roomId || locked.current) return;
    try { apply(await chatApi.stop(roomId)); }
    catch (reason) { if (alive.current && selected.current === roomId) setError(String(reason)); }
  };
  // 传到一半不换房间：在途那张传完会落进「切换之后」的草稿，等于把图挂到别人名下。
  // 头带上的选择框同时也是禁用的，这一句挡的是别的表面直接调过来的情况。
  const select = (id: string | null) => { if (!locked.current && !savingMember && !uploading.current.length) chooseRoom(id); };
  const removeQuote = () => { if (quote) clearSideChatQuote(taskId, roomId, quote.id); };
  return { rooms, room, snapshot, ready, loaded, connected, error: sendError || error, memberError, memberUncertain, draft, attachments, pending, quote, removeQuote, sending, savingMember, busy, canSend, select, setDraft, setAttachments, setPending, saveMember, send, stop, reload };
}
