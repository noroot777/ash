import { useState } from "react";
import type { Task, Group, AgentType, Priority } from "@harness/shared";
import { api } from "./api";
import { PRIORITIES } from "./constants";

export function CreateTask({
  projectId,
  groups,
  onClose,
  onCreated,
}: {
  projectId: string;
  groups: Group[];
  onClose: () => void;
  onCreated: (t: Task) => void;
}) {
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [agentType, setAgentType] = useState<AgentType>("claude");
  const [groupId, setGroupId] = useState("");
  const [priority, setPriority] = useState<Priority>("none");
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    if (!title.trim()) return;
    setBusy(true);
    try {
      const t = await api.createTask({
        projectId,
        title: title.trim(),
        body,
        mode: "single",
        agentType,
        priority,
        groupId: groupId || null,
      });
      onCreated(t);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/50 pt-[12vh]" onClick={onClose}>
      <div
        className="w-[600px] max-w-[92vw] overflow-hidden rounded-xl border border-neutral-700 bg-neutral-900 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === "Escape") onClose();
          if ((e.metaKey || e.ctrlKey) && e.key === "Enter") submit();
        }}
      >
        <input
          autoFocus
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="任务标题"
          className="w-full bg-transparent px-4 pt-4 text-base outline-none placeholder:text-neutral-600"
        />
        <textarea
          value={body}
          onChange={(e) => setBody(e.target.value)}
          placeholder="给 agent 的目标 / prompt…"
          rows={5}
          className="w-full resize-none bg-transparent px-4 py-2 text-sm outline-none placeholder:text-neutral-600"
        />
        <div className="flex flex-wrap items-center gap-2 border-t border-neutral-800 px-4 py-3 text-xs">
          <select
            value={agentType}
            onChange={(e) => setAgentType(e.target.value as AgentType)}
            className="rounded-md border border-neutral-800 bg-neutral-950 px-2 py-1 text-neutral-300 outline-none"
          >
            <option value="claude">@claude</option>
            <option value="codex">@codex（M3）</option>
            <option value="antigravity">@antigravity（M6）</option>
          </select>
          <select
            value={priority}
            onChange={(e) => setPriority(e.target.value as Priority)}
            className="rounded-md border border-neutral-800 bg-neutral-950 px-2 py-1 text-neutral-300 outline-none"
          >
            {PRIORITIES.map((p) => (
              <option key={p.key} value={p.key}>
                优先级·{p.label}
              </option>
            ))}
          </select>
          <select
            value={groupId}
            onChange={(e) => setGroupId(e.target.value)}
            className="rounded-md border border-neutral-800 bg-neutral-950 px-2 py-1 text-neutral-300 outline-none"
          >
            <option value="">无分组</option>
            {groups.map((g) => (
              <option key={g.id} value={g.id}>
                {g.name} · {g.mode}
              </option>
            ))}
          </select>
          <div className="ml-auto flex items-center gap-2">
            <span className="text-neutral-600">⌘↵ 创建</span>
            <button onClick={onClose} className="px-2 py-1 text-neutral-500">
              取消
            </button>
            <button
              disabled={!title.trim() || busy}
              onClick={submit}
              className="rounded-md bg-neutral-200 px-3 py-1 font-medium text-neutral-900 disabled:opacity-40"
            >
              创建
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
