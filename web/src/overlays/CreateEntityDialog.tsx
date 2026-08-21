import { useState } from "react";
import type { GroupMode } from "@ash/shared";
import { ConfirmDialog } from "../task-detail/ConfirmDialog.tsx";
import { DirectoryPickerButton, directoryName } from "../components/DirectoryPickerButton.tsx";
import { hostSamplePath, useHostInfo } from "../lib/useHostInfo.ts";
import { PathHealthStatus, useDebouncedPathHealth } from "../settings/PathHealthStatus.tsx";

export function CreateProjectDialog({ onClose, onCreate, notify }: {
  onClose: () => void;
  onCreate: (name: string, repoPath: string) => Promise<void>;
  notify: (message: string) => void;
}) {
  const [name, setName] = useState("");
  const [repoPath, setRepoPath] = useState("");
  const [busy, setBusy] = useState(false);
  // 占位符按**服务端**那台机器的形状给：路径要落在跑 server 的机器上，
  // 在 Windows 上照着 `/Users/you/...` 填是填不出能用的目录的。
  const host = useHostInfo();
  const pathHealth = useDebouncedPathHealth(repoPath);
  // 从系统窗口点出来的目录顺手把项目名也填上（目录名就是绝大多数人会起的名字）；
  // 已经手打过名字就不覆盖。
  const applyPicked = (picked: string) => {
    setRepoPath(picked);
    if (!name.trim()) setName(directoryName(picked));
  };
  const create = async () => {
    if (!name.trim() || !repoPath.trim() || busy || pathHealth.checking) return;
    setBusy(true);
    try { await onCreate(name.trim(), repoPath.trim()); }
    finally { setBusy(false); }
  };
  return <ConfirmDialog title="新建项目" message="项目目录会成为任务的默认运行位置。" confirmLabel="创建项目" busy={busy} confirmDisabled={!name.trim() || !repoPath.trim() || pathHealth.checking} onClose={onClose} onConfirm={() => void create()}>
    <div className="quick-create-fields">
      <label><span>项目名称</span><input autoFocus value={name} onChange={(event) => setName(event.target.value)} placeholder="如 ash" /></label>
      <label><span>工作目录</span><span className="path-field"><input className="mono" value={repoPath} onChange={(event) => setRepoPath(event.target.value)} placeholder={hostSamplePath(host, ["code", "project"])} /><DirectoryPickerButton startIn={repoPath} onPick={applyPicked} disabled={busy} notify={notify} /></span></label>
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
