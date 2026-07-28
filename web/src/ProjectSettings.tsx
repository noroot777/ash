import { useState } from "react";
import type { ProjectView } from "@harness/shared";
import { Modal, ConfirmModal, fieldCls, primaryCls } from "./Modal";
import { Kbd, PathHealth, submitShortcutTitle } from "./ui";

// Project settings — the canonical home for editing a project's name + repoPath
// (load-bearing: it's the cwd of every run), with live path validation and a
// danger-zone delete. Opened from the switcher and Cmd-K.
export function ProjectSettings({
  project,
  onClose,
  onSave,
  onDelete,
}: {
  project: ProjectView;
  onClose: () => void;
  onSave: (patch: { name: string; repoPath: string }) => void;
  onDelete: () => void;
}) {
  const [name, setName] = useState(project.name);
  const [repoPath, setRepoPath] = useState(project.repoPath);
  const [confirmDel, setConfirmDel] = useState(false);
  const dirty = name.trim() !== project.name || repoPath.trim() !== project.repoPath;
  const save = () => name.trim() && onSave({ name: name.trim(), repoPath: repoPath.trim() });
  return (
    <>
      <Modal
        title="项目设置"
        onClose={onClose}
        footer={(close) => (
          <>
            <button
              onClick={() => setConfirmDel(true)}
              className="mr-auto rounded-md px-3 py-1.5 text-[13px] text-red-600 hover:bg-red-50"
            >
              删除项目
            </button>
            <button onClick={close} className="px-3 py-1.5 text-[13px] text-muted">取消</button>
            <button disabled={!name.trim() || !dirty} onClick={save} title={submitShortcutTitle("保存项目设置")} className={`${primaryCls} inline-flex items-center gap-1.5`}>
              保存 <Kbd />
            </button>
          </>
        )}
      >
        <div className="flex flex-col gap-3" onKeyDown={(e) => (e.metaKey || e.ctrlKey) && e.key === "Enter" && save()}>
          <label className="flex flex-col gap-1.5">
            <span className="text-[12px] text-muted">项目名称</span>
            <input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="如 my-app" className={fieldCls} />
          </label>
          <label className="flex flex-col gap-1.5">
            <span className="text-[12px] text-muted">工作目录</span>
            <span className="text-[11px] text-faint">任务将在此目录运行；若为 git 仓库，可额外使用分支、diff 和 worktree 能力。</span>
            <input value={repoPath} onChange={(e) => setRepoPath(e.target.value)} placeholder="/Users/you/code/my-app" className={`${fieldCls} font-mono`} />
            <PathHealth path={repoPath} />
          </label>
        </div>
      </Modal>
      {confirmDel && (
        <ConfirmModal
          title="删除项目"
          message={`确定删除「${project.name}」？该项目下的所有任务、分组、运行记录都会一并删除，无法撤销。`}
          confirmLabel="删除"
          danger
          onConfirm={onDelete}
          onClose={() => setConfirmDel(false)}
        />
      )}
    </>
  );
}
