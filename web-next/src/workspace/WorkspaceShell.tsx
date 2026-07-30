import { useCallback, useEffect, useMemo, useState } from "react";
import type { Group, ProjectView, Task } from "@harness/shared";
import { api } from "../lib/api.ts";
import { useTasks } from "../lib/useTasks.ts";
import { TaskDetail } from "../task-detail/TaskDetail.tsx";
import { TeamView } from "../team/TeamView.tsx";
import { DebateView } from "../debate/DebateView.tsx";
import { TaskPlaceholder } from "./TaskPlaceholder.tsx";
import { WorkspaceSidebar } from "./WorkspaceSidebar.tsx";
import { SettingsPage, type SettingsSection } from "../settings/SettingsPage.tsx";
import { CommandPalette } from "../overlays/CommandPalette.tsx";
import { NotesPanel } from "../overlays/NotesPanel.tsx";
import { TaskComposerPanel, type ComposerDraft } from "../composer/TaskComposerPanel.tsx";

function readUrlSelection() {
  const params = new URLSearchParams(window.location.search);
  const raw = params.get("settings");
  const settings: SettingsSection | null = raw === "agents" || raw === "project" || raw === "groups" || raw === "archive" ? raw : null;
  return { projectId: params.get("project"), taskId: params.get("task"), settings };
}

export function WorkspaceShell() {
  const initial = readUrlSelection();
  const [projects, setProjects] = useState<ProjectView[]>([]);
  const [projectsReady, setProjectsReady] = useState(false);
  const [projectsError, setProjectsError] = useState<Error | null>(null);
  const [projectId, setProjectId] = useState<string | null>(initial.projectId);
  const [taskId, setTaskId] = useState<string | null>(initial.taskId);
  const [settingsSection, setSettingsSection] = useState<SettingsSection | null>(initial.settings);
  const [groups, setGroups] = useState<Group[]>([]);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [notes, setNotes] = useState<{ projectId: string; noteId: string | null } | null>(null);
  const [composer, setComposer] = useState<{ draft?: ComposerDraft | null } | null>(null);
  const [collapsed, setCollapsed] = useState(() => window.localStorage.getItem("harness-next:sidebar-collapsed") === "1");
  const [toast, setToast] = useState<string | null>(null);
  const { tasks, setTasks, loading: tasksLoading, error: tasksError, connected } = useTasks();

  const notify = useCallback((message: string) => {
    setToast(message);
    window.setTimeout(() => setToast((current) => current === message ? null : current), 2600);
  }, []);

  useEffect(() => {
    let alive = true;
    api.projects().then((rows) => {
      if (!alive) return;
      setProjects(rows);
      setProjectId((current) => current && rows.some((project) => project.id === current) ? current : rows[0]?.id ?? null);
    }).catch((reason) => { if (alive) setProjectsError(reason instanceof Error ? reason : new Error("项目列表读取失败")); }).finally(() => { if (alive) setProjectsReady(true); });
    return () => { alive = false; };
  }, []);

  const refreshGroups = useCallback(() => {
    if (!projectId) { setGroups([]); return; }
    api.groups(projectId).then(setGroups).catch((error) => notify(error instanceof Error ? error.message : "分组列表读取失败"));
  }, [notify, projectId]);
  useEffect(() => { refreshGroups(); }, [refreshGroups]);

  useEffect(() => {
    if (!projectsReady || tasksLoading) return;
    setTaskId((current) => {
      if (!current) return null;
      const task = tasks.find((item) => item.id === current && !item.archived);
      return task?.projectId === projectId ? current : null;
    });
  }, [projectId, projectsReady, tasks, tasksLoading]);

  useEffect(() => {
    if (!projectsReady) return;
    const params = new URLSearchParams();
    if (projectId) params.set("project", projectId);
    if (taskId && !settingsSection) params.set("task", taskId);
    if (settingsSection) params.set("settings", settingsSection);
    const query = params.toString();
    window.history.replaceState(null, "", query ? `${window.location.pathname}?${query}` : window.location.pathname);
  }, [projectId, projectsReady, settingsSection, taskId]);

  useEffect(() => {
    const onPopState = () => {
      const next = readUrlSelection();
      setProjectId(next.projectId);
      setTaskId(next.taskId);
      setSettingsSection(next.settings);
    };
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") { event.preventDefault(); setPaletteOpen((value) => !value); }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);
  useEffect(() => { window.localStorage.setItem("harness-next:sidebar-collapsed", collapsed ? "1" : "0"); }, [collapsed]);

  const currentProject = projects.find((project) => project.id === projectId) ?? null;
  const selectedTask = tasks.find((task) => task.id === taskId && task.projectId === projectId) ?? null;
  const loadError = projectsError ?? tasksError;
  const activeTaskCount = useMemo(() => tasks.filter((task) => task.projectId === projectId && task.parentId === null && !task.archived).length, [projectId, tasks]);
  const updateTask = useCallback((updated: Task) => setTasks((current) => current.map((task) => task.id === updated.id ? updated : task)), [setTasks]);
  const deleteTask = useCallback((deletedId: string) => {
    setTasks((current) => current.filter((task) => task.id !== deletedId));
    setTaskId((current) => current === deletedId ? null : current);
  }, [setTasks]);
  const selectProject = (nextProjectId: string) => { setProjectId(nextProjectId); setTaskId(null); setComposer(null); setSettingsSection(null); };
  const selectTask = (task: Task) => { setProjectId(task.projectId); setTaskId(task.id); setComposer(null); setSettingsSection(null); };
  const openNotes = (nextProjectId = projectId, noteId: string | null = null) => { if (nextProjectId) { setProjectId(nextProjectId); setNotes({ projectId: nextProjectId, noteId }); } };
  const openSettings = (section: SettingsSection = "agents") => { setSettingsSection(section); setComposer(null); setPaletteOpen(false); };
  const createTask = (task: Task, draft?: ComposerDraft | null) => {
    setTasks((current) => current.some((row) => row.id === task.id) ? current.map((row) => row.id === task.id ? task : row) : [task, ...current]);
    setTaskId(task.id);
    setComposer(null);
    for (const noteId of draft?.noteIds ?? []) api.patchNote(noteId, { taskId: task.id }).catch(() => notify("任务已创建，但随手记回链写入失败"));
  };

  const toastNode = <div className={`workspace-toast${toast ? " is-visible" : ""}`} role="status" aria-live="polite">{toast}</div>;
  if (settingsSection) return <><SettingsPage
    section={settingsSection}
    project={currentProject}
    tasks={tasks}
    groups={groups}
    onSection={setSettingsSection}
    onBack={() => setSettingsSection(null)}
    onProjectUpdated={(updated) => setProjects((current) => current.map((project) => project.id === updated.id ? updated : project))}
    onProjectDeleted={(deletedId) => { setProjects((current) => { const next = current.filter((project) => project.id !== deletedId); setProjectId(next[0]?.id ?? null); return next; }); setSettingsSection(null); }}
    onTaskUpdated={updateTask}
    onGroupsChanged={refreshGroups}
    notify={notify}
  />{toastNode}</>;

  return (
    <div className="workspace-shell">
      <WorkspaceSidebar projects={projects} currentProject={currentProject} tasks={tasks} selectedTaskId={taskId} connected={connected} collapsed={collapsed} onProject={selectProject} onTask={selectTask} onToggleCollapsed={() => setCollapsed((value) => !value)} onSearch={() => setPaletteOpen(true)} onNotes={() => openNotes()} onCreate={() => currentProject && setComposer({})} onSettings={() => openSettings("agents")} />
      <main className="workspace-main">
        {loadError && <div className="workspace-load-error">{loadError.message}</div>}
        {composer && currentProject ? <TaskComposerPanel project={currentProject} groups={groups} initialDraft={composer.draft} onCancel={() => setComposer(null)} onCreated={createTask} notify={notify} /> : selectedTask?.mode === "team" ? (
          <TeamView task={selectedTask} allTasks={tasks} onTaskUpdate={updateTask} onTaskDeleted={deleteTask} onSelectTask={selectTask} notify={notify} />
        ) : selectedTask?.mode === "debate" ? (
          <DebateView task={selectedTask} allTasks={tasks} onTaskUpdated={updateTask} onTaskCreated={(created) => setTasks((current) => current.some((task) => task.id === created.id) ? current.map((task) => task.id === created.id ? created : task) : [created, ...current])} onTaskDeleted={deleteTask} onSelectTask={selectTask} notify={notify} />
        ) : selectedTask ? (
          <TaskDetail task={selectedTask} allTasks={tasks} onTaskUpdate={updateTask} onDeleted={deleteTask} notify={notify} />
        ) : <><header className="workspace-app-bar"><span className="workspace-kind-chip">项目</span><span className="workspace-app-title">{currentProject?.name ?? "Harness"}</span>{currentProject && <span className="workspace-app-count">{activeTaskCount} 项任务</span>}</header><div className="workspace-columns"><section className="workspace-primary" aria-label="主工作区"><TaskPlaceholder project={currentProject} task={null} /></section><aside className="workspace-inspector-slot" aria-label="Inspector 占位"><div><span>Inspector</span><small>项目概览</small></div><p>选择任务后，这里会显示可操作属性、执行信息与队列。</p></aside></div></>}
      </main>
      <CommandPalette open={paletteOpen} projects={projects} currentProject={currentProject} tasks={tasks} selectedTask={selectedTask} groups={groups} onClose={() => setPaletteOpen(false)} onProject={selectProject} onTask={selectTask} onTaskUpdated={updateTask} onNote={openNotes} onComposer={() => currentProject && setComposer({})} onSettings={openSettings} notify={notify} />
      {notes && projects.find((project) => project.id === notes.projectId) && <NotesPanel key={`${notes.projectId}:${notes.noteId ?? "list"}`} project={projects.find((project) => project.id === notes.projectId)!} initialNoteId={notes.noteId} onClose={() => setNotes(null)} onTask={(nextTaskId) => { const task = tasks.find((row) => row.id === nextTaskId); if (task) selectTask(task); else api.task(nextTaskId).then(selectTask).catch(() => notify("关联任务读取失败")); setNotes(null); }} onConvert={(note) => { setNotes(null); setComposer({ draft: { body: note.body, attachments: note.attachments, noteIds: [note.id] } }); }} notify={notify} />}
      {toastNode}
    </div>
  );
}
