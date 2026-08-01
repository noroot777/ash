import { useState } from "react";
import type { AgentExecutorProfile, AgentType } from "@harness/shared";
import { AGENT_TYPES } from "@harness/shared";
import { api } from "../lib/api.ts";
import { ConfirmDialog } from "../task-detail/ConfirmDialog.tsx";

function nextSshName(type: AgentType, host: string, profiles: AgentExecutorProfile[]) {
  const names = new Set(profiles.map((profile) => profile.name));
  const base = `${type}@${host}`;
  if (!names.has(base)) return base;
  let index = 2;
  while (names.has(`${base}·${index}`)) index += 1;
  return `${base}·${index}`;
}

export function AddSshProfileDialog({
  profiles,
  onAdded,
  onClose,
  notify,
}: {
  profiles: AgentExecutorProfile[];
  onAdded: (profile: AgentExecutorProfile) => void;
  onClose: () => void;
  notify: (message: string) => void;
}) {
  const [type, setType] = useState<AgentType>(profiles[0]?.type ?? "claude");
  const [host, setHost] = useState("");
  const [busy, setBusy] = useState(false);

  const add = async () => {
    if (busy) return;
    const nextHost = host.trim();
    if (!nextHost) return;
    setBusy(true);
    try {
      const profile = await api.createAgent({
        type,
        name: nextSshName(type, nextHost, profiles),
        target: { kind: "ssh", host: nextHost },
        isDefault: !profiles.some((candidate) => candidate.type === type),
      });
      onAdded(profile);
      onClose();
    } catch (error) {
      notify(error instanceof Error ? error.message : "SSH 执行器新增失败");
      setBusy(false);
    }
  };

  return (
    <ConfirmDialog
      title="新增 SSH 执行器"
      message="选择执行器类型并填写 SSH host；供应商、模型与参数可在创建后的行内继续调整。"
      confirmLabel="创建"
      busy={busy}
      confirmDisabled={!host.trim()}
      onClose={onClose}
      onConfirm={() => void add()}
    >
      <div className="agent-ssh-form">
        <label>
          <span>类型</span>
          <select value={type} disabled={busy} onChange={(event) => setType(event.target.value as AgentType)}>
            {AGENT_TYPES.map((candidate) => (
              <option value={candidate} key={candidate}>{candidate}</option>
            ))}
          </select>
        </label>
        <label>
          <span>SSH host</span>
          <input
            autoFocus
            value={host}
            disabled={busy}
            placeholder="user@example.com"
            onChange={(event) => setHost(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && host.trim()) void add();
            }}
          />
        </label>
      </div>
    </ConfirmDialog>
  );
}
