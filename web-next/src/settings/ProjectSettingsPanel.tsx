import { useEffect, useState } from "react";
import type { ProjectHealth, ProjectView } from "@harness/shared";
import { Button } from "../components/ui.tsx";
import { api } from "../lib/api.ts";
import { ConfirmDialog } from "../task-detail/ConfirmDialog.tsx";

function healthText(health: ProjectHealth | null) {
  if (!health) return "正在检查目录…";
  if (!health.exists) return "目录不存在";
  if (!health.isRepo) return "目录存在，但不是 Git 仓库";
  return `Git 仓库${health.branch ? ` · ${health.branch}` : ""}${health.dirty ? " · 有未提交修改" : " · 工作区干净"}`;
}

export function ProjectSettingsPanel({ project, onUpdated, onDeleted, notify }: {
  project: ProjectView;
  onUpdated: (project: ProjectView) => void;
  onDeleted: () => void;
  notify: (message: string) => void;
}) {
  const [name, setName] = useState(project.name);
  const [repoPath, setRepoPath] = useState(project.repoPath);
  const [health, setHealth] = useState<ProjectHealth | null>(project.health);
  const [busy, setBusy] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  useEffect(() => { setName(project.name); setRepoPath(project.repoPath); setHealth(project.health); }, [project]);
  useEffect(() => {
    const path = repoPath.trim();
    if (!path) { setHealth(null); return; }
    const timer = window.setTimeout(() => api.checkPath(path).then(setHealth).catch(() => setHealth({ exists: false, isRepo: false })), 350);
    return () => window.clearTimeout(timer);
  }, [repoPath]);
  const dirty = name.trim() !== project.name || repoPath.trim() !== project.repoPath;
  const save = async () => {
    if (!name.trim() || !repoPath.trim() || !dirty) return;
    setBusy(true);
    try { onUpdated(await api.updateProject(project.id, { name: name.trim(), repoPath: repoPath.trim() })); notify("项目设置已保存"); }
    catch (error) { notify(error instanceof Error ? error.message : "项目设置保存失败"); }
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
        <label className="settings-field"><span>工作目录</span><input className="mono" value={repoPath} onChange={(event) => setRepoPath(event.target.value)} /></label>
        <div className={`settings-health${health?.exists && health.isRepo ? " is-good" : ""}`}><i />{healthText(health)}</div>
        <div className="settings-card-foot"><span>修改目录不会移动磁盘文件，只会改变后续任务的 cwd。</span><Button variant="primary" disabled={!dirty || !name.trim() || !repoPath.trim() || busy} onClick={() => void save()}>{busy ? "保存中…" : "保存更改"}</Button></div>
      </div></section>
      <section className="settings-section"><h2>危险操作</h2><div className="settings-card settings-danger-row"><div><b>删除项目</b><small>删除项目记录，以及它下面的任务、分组和运行记录；不会删除仓库目录。</small></div><Button variant="danger" disabled={busy} onClick={() => setConfirmDelete(true)}>删除项目</Button></div></section>
      {confirmDelete && <ConfirmDialog title="删除项目" message={`确定删除“${project.name}”？项目下的任务、分组和运行记录会一并删除，仓库目录不会被删除。`} confirmLabel="删除项目" danger busy={busy} onClose={() => setConfirmDelete(false)} onConfirm={() => void remove()} />}
    </>
  );
}
