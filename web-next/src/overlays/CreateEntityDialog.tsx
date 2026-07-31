import { useState } from "react";
import type { GroupMode } from "@harness/shared";
import { ConfirmDialog } from "../task-detail/ConfirmDialog.tsx";
import { PathHealthStatus, useDebouncedPathHealth } from "../settings/PathHealthStatus.tsx";

export function CreateProjectDialog({ onClose, onCreate }: {
  onClose: () => void;
  onCreate: (name: string, repoPath: string) => Promise<void>;
}) {
  const [name, setName] = useState("");
  const [repoPath, setRepoPath] = useState("");
  const [busy, setBusy] = useState(false);
  const pathHealth = useDebouncedPathHealth(repoPath);
  const create = async () => {
    if (!name.trim() || !repoPath.trim() || busy || pathHealth.checking) return;
    setBusy(true);
    try { await onCreate(name.trim(), repoPath.trim()); }
    finally { setBusy(false); }
  };
  return <ConfirmDialog title="新建项目" message="项目目录会成为任务的默认运行位置。" confirmLabel="创建项目" busy={busy} confirmDisabled={!name.trim() || !repoPath.trim() || pathHealth.checking} onClose={onClose} onConfirm={() => void create()}>
    <div className="quick-create-fields">
      <label><span>项目名称</span><input autoFocus value={name} onChange={(event) => setName(event.target.value)} placeholder="如 harness" /></label>
      <label><span>工作目录</span><input className="mono" value={repoPath} onChange={(event) => setRepoPath(event.target.value)} placeholder="/Users/you/code/project" /></label>
      <PathHealthStatus path={repoPath} state={pathHealth} className="create-project-health" />
    </div>
  </ConfirmDialog>;
}

export function CreateGroupDialog({ onClose, onCreate }: {
  onClose: () => void;
  onCreate: (name: string, mode: GroupMode) => Promise<void>;
}) {
  const [name, setName] = useState("");
  const [mode, setMode] = useState<GroupMode>("parallel");
  const [busy, setBusy] = useState(false);
  const create = async () => {
    if (!name.trim()) return;
    setBusy(true);
    try { await onCreate(name.trim(), mode); }
    finally { setBusy(false); }
  };
  return <ConfirmDialog title="新建分组" message="并行组会同时启动成员；串行组按队列顺序推进。" confirmLabel="创建分组" busy={busy} onClose={onClose} onConfirm={() => void create()}>
    <div className="quick-create-fields is-group">
      <label><span>分组名称</span><input autoFocus value={name} onChange={(event) => setName(event.target.value)} placeholder="如每日流水线" /></label>
      <label><span>运行方式</span><select value={mode} onChange={(event) => setMode(event.target.value as GroupMode)}><option value="parallel">并行</option><option value="serial">串行</option></select></label>
    </div>
  </ConfirmDialog>;
}
