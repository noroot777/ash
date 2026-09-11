import type { ChatMember, ChatRoom, ChatSnapshot } from "@ash/shared/chat";
import { request } from "../lib/apiClient.ts";

const json = (body: unknown, method = "POST"): RequestInit => ({ method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

export const chatApi = {
  sideChats: (taskId: string) => request<ChatRoom[]>(`/tasks/${encodeURIComponent(taskId)}/side-chats`),
  createSideChat: (taskId: string, member: ChatMember, id: string) => request<ChatRoom>(`/tasks/${encodeURIComponent(taskId)}/side-chats`, json({ member, id })),
  rooms: (projectId: string) => request<ChatRoom[]>(`/chats?projectId=${encodeURIComponent(projectId)}`),
  create: (projectId: string, name: string, members: ChatMember[]) => request<ChatRoom>("/chats", json({ projectId, name, members })),
  update: (roomId: string, patch: { name?: string; members?: ChatMember[] }) => request<ChatRoom>(`/chats/${roomId}`, json(patch, "PATCH")),
  snapshot: (roomId: string) => request<ChatSnapshot>(`/chats/${roomId}`),
  send: (roomId: string, body: string, id: string, projectId?: string) => request<ChatSnapshot>(`/chats/${roomId}/messages`, json({ body, id, projectId })),
  stop: (roomId: string) => request<ChatSnapshot>(`/chats/${roomId}/stop`, json({})),
  assistants: (projectId: string) => request<ChatRoom[]>(`/chats?kind=assistant&projectId=${encodeURIComponent(projectId)}`),
  createAssistant: (projectId: string, member: ChatMember, name = "ash 助手") => request<ChatRoom>("/chats", json({ projectId, name, members: [member], kind: "assistant" })),
  saveWorkflow: (roomId: string, messageId: string) => request<ChatSnapshot>(`/chats/${roomId}/messages/${messageId}/workflow`, json({})),
};
