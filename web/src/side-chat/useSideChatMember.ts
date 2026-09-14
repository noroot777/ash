import { useEffect, useState } from "react";
import type { AgentExecutorProfile, Task } from "@ash/shared";
import type { ChatMember } from "@ash/shared/chat";
import { api } from "../lib/api.ts";
import { createClientId } from "../lib/clientId.ts";
import { readSideStorage, writeSideStorage } from "./sideChatStorage.ts";

export function useSideChatMember(task: Task) {
  const key = `ash:side-chat:member:${task.id}`;
  const [profiles, setProfiles] = useState<AgentExecutorProfile[]>([]);
  const [member, setMember] = useState<ChatMember | undefined>(() => {
    try {
      const saved = JSON.parse(readSideStorage(key) ?? "null") as ChatMember | null;
      return saved && typeof saved.id === "string" && typeof saved.agentType === "string" ? saved : undefined;
    } catch { return undefined; }
  });
  const [ready, setReady] = useState(false);
  const [error, setError] = useState("");
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    let alive = true;
    setReady(false);
    api.agents().then((rows) => {
      if (!alive) return;
      setProfiles(rows); setError("");
      const match = rows.find((row) => row.id === task.executorId) ?? rows.find((row) => row.type === task.agentType && row.isDefault);
      const first = match ?? rows.find((row) => row.isDefault) ?? rows[0];
      if (first) setMember((current) => current ?? {
        id: createClientId(), name: "侧聊助手", agentType: first.type, executorId: first.id,
        model: match ? task.model ?? null : null, reasoningEffort: match ? task.reasoningEffort ?? null : null,
      });
    }).catch((reason) => { if (alive) setError(String(reason)); })
      .finally(() => { if (alive) setReady(true); });
    return () => { alive = false; };
  }, [task.id, task.executorId, task.agentType, task.model, task.reasoningEffort, revision]);
  const choose = (value: ChatMember) => { setMember(value); writeSideStorage(key, JSON.stringify(value)); };
  return { profiles, member, ready, error, choose, reload: () => setRevision((value) => value + 1) };
}
