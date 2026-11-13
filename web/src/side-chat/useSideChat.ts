import { useCallback, useEffect, useRef, useState, type SetStateAction } from "react";
import type { ChatMember, ChatRoom, ChatSnapshot } from "@ash/shared/chat";
import { chatApi } from "../chat/chatApi.ts";
import { api } from "../lib/api.ts";
import { createClientId } from "../lib/clientId.ts";
import type { UploadAttachment, UploadingFile } from "../task-detail/Attachments.tsx";
import { attachmentsFromPaths, clearSentDraft, dropSentAttachments, reuseDraft, sentSelections, type ReuseMark, type SentSelection } from "../task-detail/withdrawDraft.ts";
import { clearSideChatQuote, moveNewSideChatQuote, sideChatMessageBody, stageSideChatQuote, useSideChatQuote } from "./sideChatQuote.ts";
import { newSideChatScope, readSideStorage as read, sideAttachmentsKey as filesKey, sideDraftKey as draftKey, sideDraftVersionKey as versionKey, sideRequestKey as requestKey, writeSideStorage as write } from "./sideChatStorage.ts";

const finished = (status: string) => ["done", "failed", "stopped"].includes(status);
// `sent`：这次提交带走的是哪几次选择（路径 + 选择记号），确认到了只摘它们；`draftVersion`：提交时
// 正文的版本，确认到了只在版本没变时清正文。老版本存下的请求没有，各自退回按路径 / 按字面。
type SendRequest = { id: string; body: string; draft?: string; draftVersion?: string; quoteId?: string; attachments?: string[]; sent?: SentSelection[] };

// 草稿正文连同版本一起落盘：正文变了（或调用方点名要认领）就换一个版本。
const draftVersionOf = (scope: string) => read(versionKey(scope)) ?? undefined;
function saveDraft(scope: string, text: string, version?: string) {
  if (version) write(versionKey(scope), version);
  else if ((read(draftKey(scope)) ?? "") !== text) write(versionKey(scope), createClientId());
  write(draftKey(scope), text);
}
/** 每份侧聊草稿上一次「改了再发」的记号（判连点）。在事件里读写，不进状态 updater。 */
const reuseMarks = new Map<string, ReuseMark>();
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
    // 送到了就是终局：迟到的快照里那条「排着/正在送」不能把它顶回去。撤回过的不算终局——
    // 撤回以后可以再发一次，那时新快照里的「排着」才是真的。
    const forward = old?.forward?.status === "sent"
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
  // 每「改了再发」一次加一：输入框按它取焦点、光标落到末尾。
  const [reused, setReused] = useState(0);
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
  // 正在飞的发送（一组，同主会话 DraftStore 的 trackSend）。「改了再发」排在它们后面放回，
  // 连点判得准；归属不靠这个顺序，靠正文版本和选择记号。
  const inFlight = useRef(new Set<Promise<void>>());
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
    let remainingFiles: UploadAttachment[] | null = null;
    let acknowledged = false;
    try {
      const request = JSON.parse(read(requestKey(value.room.id)) ?? "null") as SendRequest | null;
      if (request && value.messages.some((message) => message.id === request.id && message.role === "user")) {
        acknowledged = true;
        // 正文同理只清提交的那一份：字面一样不算，版本也得是提交时那个——发送报错后清掉、
        // 又把同一句放回来，字一样，却是又选了一次（「改了再发」第 3 轮审查实测）。
        const stored = { text: read(draftKey(value.room.id)) ?? "", textVersion: draftVersionOf(value.room.id) };
        const sentText = { text: request.draft ?? request.body, textVersion: request.draftVersion ?? stored.textVersion };
        if (stored.text && !clearSentDraft(stored, sentText)) {
          saveDraft(value.room.id, ""); clearedDraft = true;
        }
        // 只摘**这一次发出去的那几次选择**（跟主会话回复框的 dropSentAttachments 同一条判据）：
        // 发送在途的那一两秒里用户完全可能又粘一张、又把同一张图放回来，整份清空会把它一起扔掉，
        // 而「发的那几张必须和手上这几张一模一样才清」则相反——刚粘的那张让条件不成立，
        // 已经发出去的旧图就赖在草稿里，下一条消息把它重复带上一遍。确认可能迟到（发送报了错、
        // 远端其实收下了，之后才由快照带回来），那时草稿早换了几轮，只认选择记号才摘不错。
        const sent = request.sent ?? (request.attachments ?? []).map((path) => ({ path }));
        const kept = dropSentAttachments(readAttachments(value.room.id), sent);
        write(filesKey(value.room.id), JSON.stringify(kept));
        remainingFiles = kept;
        if (request.quoteId) clearSideChatQuote(taskId, value.room.id, request.quoteId);
        write(requestKey(value.room.id), "null");
      }
    } catch { /* Invalid local drafts do not affect server history. */ }
    if (!active) return;
    setSnapshot((previous) => mergeSideSnapshot(previous, value));
    // 快照里的房间不带「第一句话」那个名字（只有列表接口给），换上来时把它留着。
    setRooms((rows) => rows.map((row) => row.id === value.room.id ? { ...value.room, title: row.title } : row));
    setError("");
    if (acknowledged) setSendError("");
    if (clearedDraft) setDraftState("");
    if (remainingFiles) { attached.current = remainingFiles; setAttachmentsState(remainingFiles); }
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
    saveDraft(selected.current ?? newScope, value);
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
    setRooms((rows) => rows.map((row) => row.id === value.id ? { ...value, title: row.title } : row));
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
  const send = (member: ChatMember | undefined) => {
    const run = runSend(member);
    inFlight.current.add(run);
    void run.finally(() => { inFlight.current.delete(run); });
    return run;
  };
  const runSend = async (member: ChatMember | undefined) => {
    if (!member || !canSend || locked.current || memberPending.current) return;
    locked.current = true; setSending(true); setError(""); setSendError("");
    let targetId = roomId;
    const scope = targetId ?? newScope;
    let previous: SendRequest | null = null;
    try { previous = JSON.parse(read(requestKey(scope)) ?? "null"); } catch { /* Recreate invalid local metadata. */ }
    const paths = attached.current.map((file) => file.path);
    saveDraft(scope, draft.trim());
    const request: SendRequest = { id: previous?.body === body && samePaths(previous.attachments, paths) ? previous.id : createClientId(), body, draft: draft.trim(), draftVersion: draftVersionOf(scope), quoteId: quote?.id, attachments: paths, sent: sentSelections(attached.current) };
    write(requestKey(scope), JSON.stringify(request));
    try {
      if (!targetId) {
        const key = `ash:side-chat:create:${taskId}`;
        const id = read(key) || createClientId();
        write(key, id);
        const created = await chatApi.createSideChat(taskId, member, id);
        targetId = created.id;
        write(requestKey(targetId), JSON.stringify(request));
        saveDraft(targetId, read(draftKey(newScope)) ?? request.draft!, draftVersionOf(newScope) ?? request.draftVersion);
        write(filesKey(targetId), read(filesKey(newScope)) ?? "[]");
        saveDraft(newScope, ""); write(requestKey(newScope), "null"); write(filesKey(newScope), "[]");
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
  // 你问过的一句放回输入框改了再发：问的那句并回草稿、附件并回附件卡（同主会话，见
  // task-detail/withdrawDraft.ts），带着的主会话选文重新挂成引用——只有一个引用位，原先挂着的那段让位。
  // 按此刻存着的那份草稿并（等过发送，闭包里的 draft 可能已经是旧的）。放回的附件是新的
  // 选择，之后哪次确认迟到也摘不走它。
  // 放回就是认领：正文换新版本、附件换新选择，之后哪次确认迟到也清不走它们。
  const reuse = async (input: { source: string; question: string; quote: string | null; paths: readonly string[] }) => {
    while (inFlight.current.size) await Promise.allSettled([...inFlight.current]);
    const scope = selected.current ?? newScope;
    const current = { text: read(draftKey(scope)) ?? "", textVersion: draftVersionOf(scope), attachments: attached.current };
    const next = reuseDraft({ source: input.source, text: input.question }, attachmentsFromPaths([...input.paths]), current, reuseMarks.get(scope), createClientId());
    reuseMarks.set(scope, next.mark);
    saveDraft(scope, next.text, next.textVersion);
    setDraftState(next.text);
    setAttachments(next.attachments);
    if (input.quote) stageSideChatQuote(taskId, input.quote);
    setReused((count) => count + 1);
  };
  // 「发给主任务」：把一条答完的回答原文交给主任务（主任务在跑就排着）；回执跟着快照回来。
  const forward = async (messageId: string) => {
    if (!roomId) return;
    try { apply(await chatApi.forward(roomId, messageId)); }
    catch (reason) { if (alive.current && selected.current === roomId) setError(String(reason)); }
  };
  // 撤回还排着的那条：走主任务待发送消息的取消，回执随下一份快照变成「已撤回」。
  const revoke = async (forwardId: string) => {
    const current = roomId;
    try {
      await api.cancelScheduledMessage(forwardId);
      if (current) apply(await chatApi.snapshot(current));
    } catch (reason) { if (alive.current && selected.current === current) setError(String(reason)); }
  };
  return { rooms, room, snapshot, ready, loaded, connected, error: sendError || error, memberError, memberUncertain, draft, attachments, pending, quote, removeQuote, reuse, reused, sending, savingMember, busy, canSend, select, setDraft, setAttachments, setPending, saveMember, send, stop, reload, forward, revoke };
}
