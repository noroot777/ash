import type { ProjectView, Task } from "@harness/shared";
import { ArrowCounterClockwise, Archive } from "@phosphor-icons/react";
import { Button } from "../components/ui.tsx";
import { api } from "../lib/api.ts";

export function ArchiveSettings({ project, tasks, onTaskUpdated, notify }: {
  project: ProjectView;
  tasks: Task[];
  onTaskUpdated: (task: Task) => void;
  notify: (message: string) => void;
}) {
  const archived = tasks.filter((task) => task.projectId === project.id && task.parentId === null && task.archived).sort((a, b) => (b.archivedAt ?? "").localeCompare(a.archivedAt ?? ""));
  const restore = async (task: Task) => {
    try { onTaskUpdated(await api.unarchiveTask(task.id)); notify("任务已取回"); }
    catch (error) { notify(error instanceof Error ? error.message : "任务取回失败"); }
  };
  return (
    <>
      <header className="settings-heading"><div><h1>已归档</h1><p>归档会结束任务在主工作区的生命周期；历史内容仍可查看并取回。</p></div></header>
      <section className="settings-section"><h2>{archived.length} 个归档任务</h2><div className="settings-card settings-archive-card">
        {!archived.length && <div className="settings-empty"><Archive size={22} /><span>这里还没有归档任务。</span></div>}
        {archived.map((task) => <article key={task.id}><span className="settings-archive-icon"><Archive size={14} /></span><div><b>{task.title}</b><small>{task.mode === "team" ? "团队" : task.mode === "debate" ? "辩论" : "任务"} · {task.archivedAt ? new Date(task.archivedAt).toLocaleString("zh-CN") : "归档时间未知"}</small></div><Button onClick={() => void restore(task)}><ArrowCounterClockwise size={13} />取回</Button></article>)}
      </div></section>
    </>
  );
}
