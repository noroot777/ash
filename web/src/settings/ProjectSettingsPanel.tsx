import { useEffect, useState } from "react";
import type { ProjectView } from "@ash/shared";
import { Button } from "../components/ui.tsx";
import { DirectoryPickerButton } from "../components/DirectoryPickerButton.tsx";
import { useAuth } from "../auth/authContext.ts";
import { api } from "../lib/api.ts";
import { ConfirmDialog } from "../task-detail/ConfirmDialog.tsx";
import { PathHealthStatus, useDebouncedPathHealth } from "./PathHealthStatus.tsx";
import { ProjectGitSettings } from "./ProjectGitSettings.tsx";
import { WorkflowPicker, useWorkflows } from "../workflow/WorkflowPicker.tsx";

// 改名 / 改目录 / 默认起手式 / 删除项目都是**项目设置**,按权限表只给项目管理员与实例
// 管理员(§四)。后端本来就会 403,但把必然失败的控件摆在成员面前,他只会以为是自己点坏了
// —— 所以这一屏按 `project.myRole` 分两副面孔(第 6 轮审查 P3)。Git 配置那一段不在这条
// 线内:后端只要求「看得见这个项目」,这里就不自作主张多加一道。
export function ProjectSettingsPanel({ project, onUpdated, onDeleted, notify }: {
  project: ProjectView;
  onUpdated: (project: ProjectView) => void;
  onDeleted: () => void;
  notify: (message: string) => void;
}) {
  const { state } = useAuth();
  const canManage = project.myRole === "admin";
  const [name, setName] = useState(project.name);
  const [repoPath, setRepoPath] = useState(project.repoPath);
  const [busy, setBusy] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const pathHealth = useDebouncedPathHealth(repoPath);
  const workflows = useWorkflows();
  // 多人模式下项目默认起手式只收系统自带那几条:自建的是个人资源,别人看不见,设成项目
  // 默认只会让别人的新任务**静默**落回系统默认(后端同样这么挡,见 project-routes.ts)。
  const pickable = state.mode === "multi" ? workflows.filter((item) => item.builtin) : workflows;
  // 项目行里设着一条**选不出来**的起手式:多数人解析不出它,新任务会静默落回系统默认。
  // 库还没拉到之前(workflows 为空)不下这个结论,否则每次进页面都先闪一句假警报。
  const legacyDefault = !!project.workflowId && workflows.length > 0
    && !pickable.some((item) => item.id === project.workflowId);
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
      {!canManage && (
        <section className="settings-section"><div className="settings-card">
          <div className="settings-row"><div>
            <b>你在这个项目里是成员</b>
            <small>项目名称、工作目录、默认起手式和删除项目只有项目管理员能改；下面按只读展示。要改就找一位项目管理员。</small>
          </div></div>
        </div></section>
      )}
      <section className="settings-section"><h2>基本信息</h2><div className="settings-card">
        <label className="settings-field"><span>项目名称</span><input value={name} readOnly={!canManage} onChange={(event) => setName(event.target.value)} /></label>
        <label className="settings-field"><span>工作目录</span><span className="path-field"><input className="mono" value={repoPath} readOnly={!canManage} onChange={(event) => setRepoPath(event.target.value)} />{canManage && <DirectoryPickerButton startIn={repoPath} onPick={setRepoPath} disabled={busy} notify={notify} />}</span></label>
        <PathHealthStatus path={repoPath} state={pathHealth} />
        {canManage && <div className="settings-card-foot"><span>修改目录不会移动磁盘文件，只会改变后续任务的 cwd。</span><Button variant="primary" disabled={!dirty || !name.trim() || !repoPath.trim() || busy} onClick={() => void save()}>{busy ? "保存中…" : "保存更改"}</Button></div>}
      </div></section>
      <section className="settings-section"><h2>默认起手式</h2><div className="settings-card">
        <div className="settings-row">
          <div>
            <b>这个项目的新任务默认走哪条线</b>
            <small>
              {canManage && state.mode === "multi"
                ? "没设就跟着系统默认走；只能选系统自带的那几条——自建起手式是个人资源，别人看不见，设成项目默认对他们不生效"
                : "没设就跟着系统默认走；每张新任务仍可单独换，换了也只影响那一张"}
            </small>
            {/* 存量值:自用模式转过来的、或修复之前写进去的自建/别人的起手式。它对多数人
                解析不出来,新任务会静默落回系统默认 —— 不说破的话,项目管理员会一直以为
                这个项目统一走着那条线(第 6 轮审查 P1)。 */}
            {legacyDefault && (
              <small>当前这条已经不作数了：它不在可选清单里（自建或别人的个人起手式），大家的新任务实际走的是系统默认。{canManage ? "重新选一条即可修正。" : ""}</small>
            )}
          </div>
          <WorkflowPicker
            value={project.workflowId ?? ""}
            items={pickable}
            inheritLabel="跟着系统默认走"
            disabled={busy || !canManage}
            onChange={(workflowId) => void pickWorkflow(workflowId)}
          />
        </div>
      </div></section>
      <ProjectGitSettings projectId={project.id} notify={notify} />
      {canManage && (
        <section className="settings-section"><h2>危险操作</h2><div className="settings-card settings-danger-row"><div><b>删除项目</b><small>删除项目记录，以及它下面的任务、分组和运行记录；不会删除仓库目录。</small></div><Button variant="danger" disabled={busy} onClick={() => setConfirmDelete(true)}>删除项目</Button></div></section>
      )}
      {confirmDelete && <ConfirmDialog title="删除项目" message={`确定删除“${project.name}”？项目下的任务、分组和运行记录会一并删除，仓库目录不会被删除。`} confirmLabel="删除项目" danger busy={busy} onClose={() => setConfirmDelete(false)} onConfirm={() => void remove()} />}
    </>
  );
}
