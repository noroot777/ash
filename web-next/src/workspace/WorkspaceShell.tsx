import { useCallback, useEffect, useMemo, useState, type CSSProperties } from "react";
import type { Group, GroupMode, ProjectView, Task, TaskMode } from "@harness/shared";
import { api } from "../lib/api.ts";
import { useTasks } from "../lib/useTasks.ts";
import { TaskDetail } from "../task-detail/TaskDetail.tsx";
import { TeamView } from "../team/TeamView.tsx";
import { DuetView } from "../duet/DuetView.tsx";
import { TaskPlaceholder } from "./TaskPlaceholder.tsx";
import { WorkspaceSidebar } from "./WorkspaceSidebar.tsx";
import {
  parseSettingsSection,
  SettingsPage,
  type SettingsSection,
} from "../settings/SettingsPage.tsx";
import { CommandPalette } from "../overlays/CommandPalette.tsx";
import { NotesPanel } from "../overlays/NotesPanel.tsx";
import { GroupsPanel } from "../overlays/GroupsPanel.tsx";
import { TaskComposerPanel, type ComposerDraft } from "../composer/TaskComposerPanel.tsx";
import { DeleteTaskDialog } from "../task-detail/DeleteTaskDialog.tsx";
import { CreateGroupDialog, CreateProjectDialog } from "../overlays/CreateEntityDialog.tsx";
import { orderedTopLevelTasks } from "./taskTreeModel.ts";
import { useWorkspaceShortcuts } from "./useWorkspaceShortcuts.ts";
import { spreadBucket, useSidebarSpread } from "./useSidebarSpread.ts";
import {
  readWorkspaceSidebarWidth,
  WORKSPACE_SIDEBAR_STORAGE_KEY,
} from "./WorkspaceResizeHandle.tsx";
import { pushTaskHistoryEntry } from "./workspaceHistory.ts";

type ContextView = "review" | "settings" | "palette" | "notes" | "create";

function readUrlSelection() {
  const params = new URLSearchParams(window.location.search);
  const settings = parseSettingsSection(params.get("settings"));
  const rawView = params.get("view");
  const view: ContextView | null = rawView === "review" || rawView === "settings" || rawView === "palette" || rawView === "notes" || rawView === "create" ? rawView : null;
  const rawMode = params.get("mode");
  const mode: TaskMode = rawMode === "team" || rawMode === "duet" ? rawMode : "single";
  return { projectId: params.get("project"), taskId: params.get("task"), settings, view, noteId: params.get("note"), mode };
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
  const [paletteOpen, setPaletteOpen] = useState(initial.view === "palette");
  const [notes, setNotes] = useState<{ projectId: string; noteId: string | null } | null>(initial.view === "notes" && initial.projectId ? { projectId: initial.projectId, noteId: initial.noteId } : null);
  const [groupsPanelOpen, setGroupsPanelOpen] = useState(false);
  const [composer, setComposer] = useState<{ draft?: ComposerDraft | null; mode: TaskMode } | null>(initial.view === "create" ? { mode: initial.mode } : null);
  const [reviewTaskId, setReviewTaskId] = useState<string | null>(initial.view === "review" ? initial.taskId : null);
  const [deleteTarget, setDeleteTarget] = useState<Task | null>(null);
  const [createDialog, setCreateDialog] = useState<"group" | "project" | null>(null);
  const [collapsed, setCollapsed] = useState(() => window.localStorage.getItem("harness-next:sidebar-collapsed") === "1");
  const [sidebarWidth, setSidebarWidth] = useState(readWorkspaceSidebarWidth);
  const [toast, setToast] = useState<string | null>(null);
  const { tasks, setTasks, loading: tasksLoading, error: tasksError, connected, settlementVersion } = useTasks();
  const spread = useSidebarSpread(tasks, projectId, settlementVersion);

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
      const task = tasks.find((item) => item.id === current && (!item.archived || settingsSection === "archive"));
      return task?.projectId === projectId ? current : null;
    });
  }, [projectId, projectsReady, settingsSection, tasks, tasksLoading]);

  useEffect(() => {
    if (!projectsReady) return;
    const params = new URLSearchParams();
    if (projectId) params.set("project", projectId);
    if (taskId && !settingsSection) params.set("task", taskId);
    if (settingsSection) { params.set("view", "settings"); params.set("settings", settingsSection); }
    else if (notes) { params.set("view", "notes"); if (notes.noteId) params.set("note", notes.noteId); }
    else if (composer) { params.set("view", "create"); params.set("mode", composer.mode); }
    else if (paletteOpen) params.set("view", "palette");
    else if (reviewTaskId && reviewTaskId === taskId) params.set("view", "review");
    const query = params.toString();
    window.history.replaceState(null, "", query ? `${window.location.pathname}?${query}` : window.location.pathname);
  }, [composer, notes, paletteOpen, projectId, projectsReady, reviewTaskId, settingsSection, taskId]);

  useEffect(() => {
    const onPopState = () => {
      const next = readUrlSelection();
      setProjectId(next.projectId);
      setTaskId(next.taskId);
      setSettingsSection(next.settings);
      setPaletteOpen(next.view === "palette");
      setNotes(next.view === "notes" && next.projectId ? { projectId: next.projectId, noteId: next.noteId } : null);
      setComposer(next.view === "create" ? { mode: next.mode } : null);
      setReviewTaskId(next.view === "review" ? next.taskId : null);
    };
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  useEffect(() => { window.localStorage.setItem("harness-next:sidebar-collapsed", collapsed ? "1" : "0"); }, [collapsed]);
  useEffect(() => { window.localStorage.setItem(WORKSPACE_SIDEBAR_STORAGE_KEY, String(sidebarWidth)); }, [sidebarWidth]);

  const currentProject = projects.find((project) => project.id === projectId) ?? null;
  useEffect(() => {
    if (!projectId || !currentProject) return;
    let alive = true;
    api.projectHealth(projectId).then((health) => {
      if (!alive) return;
      setProjects((current) => current.map((project) => project.id === projectId ? { ...project, health } : project));
    }).catch(() => {});
    return () => { alive = false; };
  }, [currentProject?.repoPath, projectId, settlementVersion]);

  const selectedTask = tasks.find((task) => task.id === taskId && task.projectId === projectId) ?? null;
  const loadError = projectsError ?? tasksError;
  const activeTaskCount = useMemo(() => tasks.filter((task) => task.projectId === projectId && task.parentId === null && !task.archived).length, [projectId, tasks]);
  // J/K 走的是「屏幕上看得见的那些行」，所以筛选开着时它也得跟着筛 —— 否则按一下就跳到
  // 一个被隐藏的任务上，看着像选中丢了。
  const orderedTasks = useMemo(
    () => orderedTopLevelTasks(
      tasks.filter((task) => task.projectId === projectId && !task.archived),
      { unifiedPinned: true },
    ).filter((task) => spread.filter === "all" || spreadBucket(task) === spread.filter),
    [projectId, spread.filter, tasks],
  );
  const updateTask = useCallback((updated: Task) => setTasks((current) => current.some((task) => task.id === updated.id)
    ? current.map((task) => task.id === updated.id ? updated : task)
    : [updated, ...current]), [setTasks]);
  const deleteTask = useCallback((deletedId: string) => {
    setTasks((current) => current.filter((task) => task.id !== deletedId));
    setTaskId((current) => current === deletedId ? null : current);
  }, [setTasks]);
  const selectProject = (nextProjectId: string) => { setProjectId(nextProjectId); setTaskId(null); setComposer(null); setNotes(null); setReviewTaskId(null); setSettingsSection(null); };
  // keepSpread：J/K 在铺开态里只是挪选中行，右边那两列还得接着看；点行或按 Enter 才算「选定了」，
  // 那时候铺开自己收起来把主区还回去。
  const selectTask = (task: Task, options?: { keepSpread?: boolean }) => {
    pushTaskHistoryEntry(task);
    setProjectId(task.projectId);
    setTaskId(task.id);
    setComposer(null);
    setNotes(null);
    setReviewTaskId(null);
    setSettingsSection(null);
    if (!options?.keepSpread) spread.close();
  };
  const selectTaskById = (nextTaskId: string) => {
    const target = tasks.find((task) => task.id === nextTaskId);
    if (target) selectTask(target);
    else api.task(nextTaskId).then((task) => { updateTask(task); selectTask(task); }).catch(() => notify("关联任务不存在或读取失败"));
  };
  const openNotes = (nextProjectId = projectId, noteId: string | null = null) => { if (nextProjectId) { setProjectId(nextProjectId); setSettingsSection(null); setComposer(null); setNotes({ projectId: nextProjectId, noteId }); } };
  const openSettings = (section: SettingsSection = "executors") => { setSettingsSection(section); setComposer(null); setNotes(null); setPaletteOpen(false); };
  const openComposer = (mode: TaskMode = "single") => {
    if (!currentProject) return;
    setSettingsSection(null);
    setNotes(null);
    setComposer((current) => current ? { ...current, mode } : { mode });
  };
  const createTask = (task: Task, draft?: ComposerDraft | null) => {
    setTasks((current) => current.some((row) => row.id === task.id) ? current.map((row) => row.id === task.id ? task : row) : [task, ...current]);
    pushTaskHistoryEntry(task);
    setTaskId(task.id);
    setComposer(null);
    for (const noteId of draft?.noteIds ?? []) api.patchNote(noteId, { taskId: task.id }).catch(() => notify("任务已创建，但随手记回链写入失败"));
  };
  const createComposerGroup = async (name: string, mode: GroupMode): Promise<Group> => {
    if (!currentProject) throw new Error("先选择一个项目");
    const created = await api.createGroup({ projectId: currentProject.id, name, mode });
    try {
      setGroups(await api.groups(currentProject.id));
    } catch {
      setGroups((current) => current.some((group) => group.id === created.id) ? current : [...current, created]);
      notify("分组已创建，但分组列表刷新失败");
    }
    return created;
  };

  useWorkspaceShortcuts({
    enabled: !settingsSection && !groupsPanelOpen,
    paletteOpen,
    composerOpen: composer !== null,
    spreadOpen: spread.open,
    orderedTasks,
    selectedTaskId: taskId,
    onTogglePalette: () => setPaletteOpen((value) => !value),
    onCreate: () => openComposer("single"),
    onTask: (task) => selectTask(task, { keepSpread: true }),
    onToggleSpread: () => { if (collapsed) setCollapsed(false); spread.toggle(); },
    onCloseSpread: spread.close,
  });

  const notesProject = notes ? projects.find((project) => project.id === notes.projectId) ?? null : null;
  const overlays = <>
    <CommandPalette open={paletteOpen} projects={projects} currentProject={currentProject} tasks={tasks} selectedTask={selectedTask} groups={groups} onClose={() => setPaletteOpen(false)} onProject={selectProject} onTask={selectTask} onTaskUpdated={updateTask} onNote={openNotes} onComposer={openComposer} onNewGroup={() => currentProject ? setCreateDialog("group") : notify("先选择一个项目")} onNewProject={() => setCreateDialog("project")} onDeleteTask={setDeleteTarget} onSettings={openSettings} notify={notify} />
    {notes && notesProject && <NotesPanel key={`${notes.projectId}:${notes.noteId ?? "list"}`} project={notesProject} initialNoteId={notes.noteId} onClose={() => setNotes(null)} onTask={(nextTaskId) => { const task = tasks.find((row) => row.id === nextTaskId); if (task) selectTask(task); else api.task(nextTaskId).then(selectTask).catch(() => notify("关联任务读取失败")); setNotes(null); }} onConvert={(draft) => { setNotes(null); setSettingsSection(null); setComposer({ mode: "single", draft }); }} notify={notify} />}
    {groupsPanelOpen && currentProject && <GroupsPanel project={currentProject} groups={groups} tasks={tasks} onClose={() => setGroupsPanelOpen(false)} onChanged={refreshGroups} notify={notify} />}
    {deleteTarget && <DeleteTaskDialog task={deleteTarget} onClose={() => setDeleteTarget(null)} onDeleted={() => { deleteTask(deleteTarget.id); setDeleteTarget(null); }} notify={notify} />}
    {createDialog === "project" && <CreateProjectDialog onClose={() => setCreateDialog(null)} onCreate={async (name, repoPath) => { try { const created = await api.createProject(name, repoPath); setProjects((current) => [...current, created]); setProjectId(created.id); setTaskId(null); setSettingsSection(null); setCreateDialog(null); notify("项目已创建"); } catch (error) { notify(error instanceof Error ? error.message : "项目创建失败"); } }} />}
    {createDialog === "group" && currentProject && <CreateGroupDialog onClose={() => setCreateDialog(null)} onCreate={async (name, mode) => { try { const created = await api.createGroup({ projectId: currentProject.id, name, mode }); setGroups((current) => [...current, created]); setCreateDialog(null); notify("分组已创建"); } catch (error) { notify(error instanceof Error ? error.message : "分组创建失败"); } }} />}
    <div className={`workspace-toast${toast ? " is-visible" : ""}`} role="status" aria-live="polite">{toast}</div>
  </>;
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
  />{overlays}</>;

  return (
    <><div className={`workspace-shell${spread.laidOut ? " is-spread" : ""}`} style={{ "--workspace-sidebar-width": `${sidebarWidth}px` } as CSSProperties}>
      <WorkspaceSidebar projects={projects} currentProject={currentProject} tasks={tasks} selectedTaskId={taskId} connected={connected} collapsed={collapsed} spread={spread} width={sidebarWidth} onWidthChange={setSidebarWidth} onProject={selectProject} onTask={selectTask} onToggleCollapsed={() => { spread.close(); setCollapsed((value) => !value); }} onSearch={() => setPaletteOpen(true)} onNotes={() => openNotes()} onGroups={() => setGroupsPanelOpen(true)} onCreate={() => openComposer("single")} onNewProject={() => setCreateDialog("project")} onSettings={() => openSettings("executors")} />
      <main className="workspace-main">
        {loadError && <div className="workspace-load-error">{loadError.message}</div>}
        {composer && currentProject ? <TaskComposerPanel project={currentProject} groups={groups} initialDraft={composer.draft} mode={composer.mode} onModeChange={(mode) => setComposer((current) => current ? { ...current, mode } : null)} onCancel={() => setComposer(null)} onCreated={createTask} onCreateGroup={createComposerGroup} notify={notify} /> : selectedTask?.mode === "team" ? (
          <TeamView task={selectedTask} allTasks={tasks} onTaskUpdate={updateTask} onTaskDeleted={deleteTask} onSelectTask={selectTask} initialReviewOpen={reviewTaskId === selectedTask.id} onReviewOpenChange={(open) => setReviewTaskId(open ? selectedTask.id : null)} notify={notify} />
        ) : selectedTask?.mode === "duet" ? (
          <DuetView task={selectedTask} allTasks={tasks} onTaskUpdated={updateTask} onTaskCreated={(created) => setTasks((current) => current.some((task) => task.id === created.id) ? current.map((task) => task.id === created.id ? created : task) : [created, ...current])} onTaskDeleted={deleteTask} onSelectTask={selectTask} notify={notify} />
        ) : selectedTask ? (
          <TaskDetail task={selectedTask} allTasks={tasks} onTaskUpdate={updateTask} onDeleted={deleteTask} onOpenTask={selectTaskById} initialReviewOpen={reviewTaskId === selectedTask.id} onReviewOpenChange={(open) => setReviewTaskId(open ? selectedTask.id : null)} notify={notify} />
        ) : <><header className="workspace-app-bar"><span className="workspace-kind-chip">项目</span><span className="workspace-app-title">{currentProject?.name ?? "Harness"}</span>{currentProject && <span className="workspace-app-count">{activeTaskCount} 项任务</span>}</header><div className="workspace-columns"><section className="workspace-primary" aria-label="主工作区"><TaskPlaceholder project={currentProject} task={null} /></section><aside className="workspace-inspector-slot" aria-label="Inspector 占位"><div><span>Inspector</span><small>项目概览</small></div><p>选择任务后，这里会显示可操作属性、执行信息与队列。</p></aside></div></>}
      </main>
    </div>{overlays}</>
  );
}
