import { useState } from "react";
import type { GroupMode } from "@ash/shared";
import { ConfirmDialog } from "../task-detail/ConfirmDialog.tsx";

// 新建项目那个弹层分量比这里重得多（两条路、路径体检、克隆进度），住在
// `CreateProjectDialog.tsx`。

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
