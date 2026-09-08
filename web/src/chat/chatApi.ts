import type { ChatMember, ChatRoom, ChatSnapshot } from "@ash/shared/chat";
import { request } from "../lib/apiClient.ts";

const json = (body: unknown, method = "POST"): RequestInit => ({ method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

export const chatApi = {
  rooms: (projectId: string) => request<ChatRoom[]>(`/chats?projectId=${encodeURIComponent(projectId)}`),
  create: (projectId: string, name: string, members: ChatMember[]) => request<ChatRoom>("/chats", json({ projectId, name, members })),
  update: (roomId: string, patch: { name?: string; members?: ChatMember[] }) => request<ChatRoom>(`/chats/${roomId}`, json(patch, "PATCH")),
  snapshot: (roomId: string) => request<ChatSnapshot>(`/chats/${roomId}`),
  send: (roomId: string, body: string, id: string) => request<ChatSnapshot>(`/chats/${roomId}/messages`, json({ body, id })),
  stop: (roomId: string) => request<ChatSnapshot>(`/chats/${roomId}/stop`, json({})),
};
