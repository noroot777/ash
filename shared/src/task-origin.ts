export type TaskCreationOrigin =
  | { kind: "user" }
  | { kind: "system" }
  | { kind: "agent"; taskId?: string; taskTitle?: string; agentType?: string; executorLabel?: string;
      chatRoomId?: string; chatMemberId?: string };

export function parseTaskCreationOrigin(value: unknown): TaskCreationOrigin | null {
  if (typeof value === "string") {
    try { value = JSON.parse(value); } catch { return null; }
  }
  if (!value || typeof value !== "object" || !("kind" in value)) return null;
  if (value.kind === "user" || value.kind === "system") return { kind: value.kind };
  if (value.kind !== "agent") return null;
  const result: TaskCreationOrigin = { kind: "agent" };
  const fields = value as Record<string, unknown>;
  for (const key of ["taskId", "taskTitle", "agentType", "executorLabel", "chatRoomId", "chatMemberId"] as const) {
    if (typeof fields[key] === "string" && fields[key]) result[key] = fields[key];
  }
  return result;
}

export function taskCreationLabel(origin?: TaskCreationOrigin | null): string {
  if (!origin) return "来源未记录";
  if (origin.kind === "user") return "用户创建";
  if (origin.kind === "system") return "系统创建";
  const fromChat = !!(origin.chatRoomId && origin.chatMemberId);
  if (!origin.taskId && !fromChat) return "智能体创建（自报）";
  const name = origin.agentType === "claude" ? "Claude" : origin.agentType === "codex" ? "Codex" : origin.agentType || "智能体";
  if (fromChat) return `${name} 群聊委派`;
  return `${name}${name === "智能体" ? "" : " "}派生`;
}
