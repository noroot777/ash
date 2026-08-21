import { useEffect, useState } from "react";
import type { ProjectView } from "@ash/shared";
import { Button } from "../components/ui.tsx";
import { DirectoryPickerButton } from "../components/DirectoryPickerButton.tsx";
import { api } from "../lib/api.ts";
import { ConfirmDialog } from "../task-detail/ConfirmDialog.tsx";
import { PathHealthStatus, useDebouncedPathHealth } from "./PathHealthStatus.tsx";
import { WorkflowPicker, useWorkflows } from "../workflow/WorkflowPicker.tsx";

export function ProjectSettingsPanel({ project, onUpdated, onDeleted, notify }: {
  project: ProjectView;
  onUpdated: (project: ProjectView) => void;
  onDeleted: () => void;
  notify: (message: string) => void;
}) {
  const [name, setName] = useState(project.name);
  const [repoPath, setRepoPath] = useState(project.repoPath);
  const [busy, setBusy] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const pathHealth = useDebouncedPathHealth(repoPath);
  const workflows = useWorkflows();
  useEffect(() => { setName(project.name); setRepoPath(project.repoPath); }, [project]);
  const dirty = name.trim() !== project.name || repoPath.trim() !== project.repoPath;
  const save = async () => {
    if (!name.trim() || !repoPath.trim() || !dirty) return;
    setBusy(true);
    try { onUpdated(await api.updateProject(project.id, { name: name.trim(), repoPath: repoPath.trim() })); notify("项目设置已保存"); }
    catch (error) { notify(error instanceof Error ? error.message : "项目设置保存失败"); }
    finally { setBusy(false); }
  };
  // 起手式是下拉即存的：它没有「改到一半」的中间态，攒进「保存更改」反而让人以为没生效。
  const pickWorkflow = async (workflowId: string) => {
    setBusy(true);
    try { onUpdated(await api.updateProject(project.id, { workflowId: workflowId || null })); }
    catch (error) { notify(error instanceof Error ? error.message : "默认起手式保存失败"); }
    finally { setBusy(false); }
  };
  const remove = async () => {
    setBusy(true);
    try { await api.deleteProject(project.id); onDeleted(); }
    catch (error) { notify(error instanceof Error ? error.message : "项目删除失败"); setBusy(false); }
  };
  return (
    <>
      <header className="settings-heading"><div><h1>项目设置</h1><p>项目目录是所有任务的默认运行位置，也是 worktree 与 diff 的根。</p></div></header>
      <section className="settings-section"><h2>基本信息</h2><div className="settings-card">
        <label className="settings-field"><span>项目名称</span><input value={name} onChange={(event) => setName(event.target.value)} /></label>
        <label className="settings-field"><span>工作目录</span><span className="path-field"><input className="mono" value={repoPath} onChange={(event) => setRepoPath(event.target.value)} /><DirectoryPickerButton startIn={repoPath} onPick={setRepoPath} disabled={busy} notify={notify} /></span></label>
        <PathHealthStatus path={repoPath} state={pathHealth} />
        <div className="settings-card-foot"><span>修改目录不会移动磁盘文件，只会改变后续任务的 cwd。</span><Button variant="primary" disabled={!dirty || !name.trim() || !repoPath.trim() || busy} onClick={() => void save()}>{busy ? "保存中…" : "保存更改"}</Button></div>
      </div></section>
      <section className="settings-section"><h2>默认起手式</h2><div className="settings-card">
        <div className="settings-row">
          <div>
            <b>这个项目的新任务默认走哪条线</b>
            <small>没设就跟着系统默认走；每张新任务仍可单独换，换了也只影响那一张</small>
          </div>
          <WorkflowPicker
            value={project.workflowId ?? ""}
            items={workflows}
            inheritLabel="跟着系统默认走"
            disabled={busy}
            onChange={(workflowId) => void pickWorkflow(workflowId)}
          />
        </div>
      </div></section>
      <section className="settings-section"><h2>危险操作</h2><div className="settings-card settings-danger-row"><div><b>删除项目</b><small>删除项目记录，以及它下面的任务、分组和运行记录；不会删除仓库目录。</small></div><Button variant="danger" disabled={busy} onClick={() => setConfirmDelete(true)}>删除项目</Button></div></section>
      {confirmDelete && <ConfirmDialog title="删除项目" message={`确定删除“${project.name}”？项目下的任务、分组和运行记录会一并删除，仓库目录不会被删除。`} confirmLabel="删除项目" danger busy={busy} onClose={() => setConfirmDelete(false)} onConfirm={() => void remove()} />}
    </>
  );
}
