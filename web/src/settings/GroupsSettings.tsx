import { useEffect, useState } from "react";
import type { Group, GroupMode, ProjectView, Task } from "@ash/shared";
import { Pause, Play, Plus, Trash } from "@phosphor-icons/react";
import { Button } from "../components/ui.tsx";
import { api } from "../lib/api.ts";
import { ConfirmDialog } from "../task-detail/ConfirmDialog.tsx";
import { activeGroupTasks, resumeQueueModel } from "./groupQueueModel.ts";

function ResumeQueue({ tasks }: { tasks: Task[] }) {
  const queue = resumeQueueModel(tasks);
  if (!queue) return null;
  const marker = (task: Task) => task.status === "done" ? "✓" : task.status === "running" || task.status === "queued" ? "●" : task.status === "failed" ? "×" : "○";
  return <div className="settings-resume-queue"><span>续跑队列</span><div className="settings-resume-dots">{queue.ordered.map((task) => <span className={`is-${task.status}`} title={`${task.title} · ${task.status}`} key={task.id}>{marker(task)}</span>)}</div><strong>{queue.doneCount}/{tasks.length}</strong></div>;
}

type GroupManagerProps = {
  project: ProjectView;
  groups: Group[];
  tasks: Task[];
  onChanged: () => void;
  notify: (message: string) => void;
  onNestedDialogChange?: (open: boolean) => void;
};

export function GroupManager({ project, groups, tasks, onChanged, notify, onNestedDialogChange }: GroupManagerProps) {
  const [name, setName] = useState("");
  const [mode, setMode] = useState<GroupMode>("parallel");
  const [confirmDelete, setConfirmDelete] = useState<Group | null>(null);
  useEffect(() => {
    onNestedDialogChange?.(confirmDelete !== null);
    return () => onNestedDialogChange?.(false);
  }, [confirmDelete, onNestedDialogChange]);
  const visible = groups.filter((group) => !group.ownerTaskId);
  const groupTasks = (groupId: string) => activeGroupTasks(tasks, groupId);
  const count = (groupId: string) => groupTasks(groupId).length;
  const action = async (promise: Promise<unknown>, success: string) => {
    try { await promise; notify(success); onChanged(); }
    catch (error) { notify(error instanceof Error ? error.message : "分组操作失败"); }
  };
  const create = async () => {
    if (!name.trim()) return;
    await action(api.createGroup({ projectId: project.id, name: name.trim(), mode }), "分组已创建");
    setName("");
  };
  return (
    <>
      <div className="settings-card settings-groups-card">
        {!visible.length && <p className="settings-muted">还没有分组。团队内部自动创建的分组不会出现在这里。</p>}
        {visible.map((group) => { const members = groupTasks(group.id); return (
          <article className="settings-group-row" key={group.id}><div className="settings-group-main">
            <input defaultValue={group.name} aria-label="分组名称" onBlur={(event) => { const next = event.target.value.trim(); if (next && next !== group.name) void action(api.updateGroup(group.id, { name: next }), "分组名称已更新"); else event.target.value = group.name; }} />
            <select value={group.mode} onChange={(event) => void action(api.updateGroup(group.id, { mode: event.target.value as GroupMode }), "分组模式已更新")}><option value="parallel">并行</option><option value="serial">串行</option></select>
            <span>{members.length} 个任务</span>
            {group.paused ? <span className="settings-paused">已暂停</span> : null}
            <Button variant="primary" onClick={() => void action(api.runGroup(group.id), group.paused ? "分组已继续" : "分组已启动")}><Play size={12} weight="fill" />{group.paused ? "继续" : "运行"}</Button>
            {!group.paused && <Button onClick={() => void action(api.pauseGroup(group.id), "分组已暂停")}><Pause size={12} weight="fill" />暂停</Button>}
            <button className="settings-icon-danger" type="button" aria-label={`删除 ${group.name}`} onClick={() => setConfirmDelete(group)}><Trash size={14} /></button>
          </div><ResumeQueue tasks={members} /></article>
        ); })}
        <div className="settings-group-create"><input value={name} onChange={(event) => setName(event.target.value)} onKeyDown={(event) => event.key === "Enter" && void create()} placeholder="新分组名称…" /><select value={mode} onChange={(event) => setMode(event.target.value as GroupMode)}><option value="parallel">并行</option><option value="serial">串行</option></select><Button variant="primary" disabled={!name.trim()} onClick={() => void create()}><Plus size={13} weight="bold" />新建</Button></div>
      </div>
      <p className="settings-note">运行分组会按服务端现有调度语义处理队列、暂停点和失败重试。</p>
      {confirmDelete && <ConfirmDialog title="删除分组" message={`确定删除“${confirmDelete.name}”？组内 ${count(confirmDelete.id)} 个任务会保留并取消分组。`} confirmLabel="删除" danger onClose={() => setConfirmDelete(null)} onConfirm={() => { const group = confirmDelete; setConfirmDelete(null); void action(api.deleteGroup(group.id), "分组已删除"); }} />}
    </>
  );
}

export function GroupsSettings(props: GroupManagerProps) {
  return (
    <>
      <header className="settings-heading"><div><h1>分组</h1><p>把同类任务装进并行或串行容器，并在这里运行或暂停整组。</p></div></header>
      <section className="settings-section">
        <h2>项目分组</h2>
        <GroupManager {...props} />
      </section>
    </>
  );
}
