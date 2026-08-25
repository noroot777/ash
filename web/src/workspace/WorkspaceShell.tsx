import { lazy, Suspense, useCallback, useEffect, useMemo, useState, type CSSProperties } from "react";
import type { Group, GroupMode, HandoffTarget, ProjectView, Task, TaskListItem, TaskMode } from "@ash/shared";
import { api } from "../lib/api.ts";
import { useAgentAvailability } from "../lib/agentAvailability.ts";
import { readRenamedStorage } from "../lib/renamedStorage.ts";
import { useTasks } from "../lib/useTasks.ts";
import { TaskDetail } from "../task-detail/TaskDetail.tsx";
import { TeamView } from "../team/TeamView.tsx";
import { DuetView } from "../duet/DuetView.tsx";
import { TaskPlaceholder } from "./TaskPlaceholder.tsx";
import { useTaskBody } from "../lib/useTaskBody.ts";
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
import { CreateGroupDialog } from "../overlays/CreateEntityDialog.tsx";
import { CreateProjectDialog } from "../overlays/CreateProjectDialog.tsx";
import { useWorkspaceShortcuts } from "./useWorkspaceShortcuts.ts";
import { spreadVisibleTasks, useSidebarSpread } from "./useSidebarSpread.ts";
import {
  ALL_PROJECTS_LABEL,
  inScope,
  readStoredScopeKind,
  resolveScopeKind,
  writeStoredScopeKind,
  type TaskScope,
  type TaskScopeKind,
} from "./taskScope.ts";
import {
  readWorkspaceSidebarWidth,
  WORKSPACE_SIDEBAR_STORAGE_KEY,
} from "./WorkspaceResizeHandle.tsx";
import { pushTaskHistoryEntry, selectedTaskProjectId } from "./workspaceHistory.ts";
import { TerminalToggle } from "./TerminalToggle.tsx";
import { HandoffApprovalAlert } from "../handoff/HandoffApprovalAlert.tsx";
import { visibleOnThisMachine } from "./taskTreeModel.ts";
import { HandoffDialog } from "../task-detail/HandoffDialog.tsx";
import { RemoteTaskDetail } from "../remote-task/RemoteTaskDetail.tsx";

const ProjectTerminal = lazy(() => import("./ProjectTerminal.tsx").then((module) => ({ default: module.ProjectTerminal })));

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
  const [remoteSelection, setRemoteSelection] = useState<{ task: TaskListItem; target: HandoffTarget } | null>(null);
  const [settingsSection, setSettingsSection] = useState<SettingsSection | null>(initial.settings);
  const [groups, setGroups] = useState<Group[]>([]);
  const [paletteOpen, setPaletteOpen] = useState(initial.view === "palette");
  const [notes, setNotes] = useState<{ projectId: string; noteId: string | null } | null>(initial.view === "notes" && initial.projectId ? { projectId: initial.projectId, noteId: initial.noteId } : null);
  const [groupsPanelOpen, setGroupsPanelOpen] = useState(false);
  const [composer, setComposer] = useState<{ draft?: ComposerDraft | null; mode: TaskMode } | null>(initial.view === "create" ? { mode: initial.mode } : null);
  const [reviewTaskId, setReviewTaskId] = useState<string | null>(initial.view === "review" ? initial.taskId : null);
  const [deleteTarget, setDeleteTarget] = useState<TaskListItem | null>(null);
  const [handoffTarget, setHandoffTarget] = useState<TaskListItem | null>(null);
  const [createDialog, setCreateDialog] = useState<"group" | "project" | null>(null);
  const [collapsed, setCollapsed] = useState(() => readRenamedStorage("ash:sidebar-collapsed") === "1");
  const [sidebarWidth, setSidebarWidth] = useState(readWorkspaceSidebarWidth);
  const [toast, setToast] = useState<string | null>(null);
  const [terminalOpen, setTerminalOpen] = useState(false);
  const agentDetection = useAgentAvailability();
  const cliVersionWarning = agentDetection.status === "ready"
    ? agentDetection.agents.find((agent) => agent.versionWarning)?.versionWarning ?? null
    : null;
  // 项目主仓被切分支/拉取过之后重拉一次 ProjectHealth：侧栏胶囊上的分支名和「有未提交
  // 改动」那颗点都从它来，不跟着刷就会停在操作之前的样子。
  const [gitVersion, setGitVersion] = useState(0);
  const { tasks, setTasks, loading: tasksLoading, error: tasksError, connected, settlementVersion, refetch: refetchTasks, applyStar } = useTasks();
  // 侧栏在看哪些任务：当前项目一家，还是所有项目混着看。它只影响**列表**；下面的
  // currentProject 仍是「新建任务 / 终端 / git 落在哪」的上下文，跟着选中的任务走。
  const [scopeKind, setScopeKind] = useState<TaskScopeKind>(() => resolveScopeKind(window.location.search, readStoredScopeKind()));
  const scope = useMemo<TaskScope>(
    () => scopeKind === "all" ? { kind: "all" } : { kind: "project", projectId },
    [projectId, scopeKind],
  );
  useEffect(() => { writeStoredScopeKind(scopeKind); }, [scopeKind]);
  const spread = useSidebarSpread(tasks, scope, settlementVersion);

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
    if (!projectsReady || tasksLoading || !taskId) return;
    const taskProjectId = selectedTaskProjectId(tasks, taskId);
    if (taskProjectId && taskProjectId !== projectId) {
      setProjectId(taskProjectId);
      return;
    }
    const task = tasks.find((item) => item.id === taskId);
    if (task) {
      if ((task.archived && settingsSection !== "archive") || !visibleOnThisMachine(task)) setTaskId(null);
      return;
    }
    let alive = true;
    api.task(taskId).then((loaded) => {
      if (!alive) return;
      if ((loaded.archived && settingsSection !== "archive") || !visibleOnThisMachine(loaded)) {
        setTaskId((current) => current === taskId ? null : current);
        return;
      }
      setTasks((current) => current.some((item) => item.id === loaded.id)
        ? current.map((item) => item.id === loaded.id ? loaded : item)
        : [loaded, ...current]);
      setProjectId(loaded.projectId);
    }).catch(() => {
      if (alive) setTaskId((current) => current === taskId ? null : current);
    });
    return () => { alive = false; };
  }, [projectId, projectsReady, setTasks, settingsSection, taskId, tasks, tasksLoading]);

  useEffect(() => {
    if (!projectsReady) return;
    const params = new URLSearchParams();
    if (scopeKind === "all") params.set("scope", "all");
    if (projectId) params.set("project", projectId);
    if (taskId && !settingsSection) params.set("task", taskId);
    if (settingsSection) { params.set("view", "settings"); params.set("settings", settingsSection); }
    else if (notes) { params.set("view", "notes"); if (notes.noteId) params.set("note", notes.noteId); }
    else if (composer) { params.set("view", "create"); params.set("mode", composer.mode); }
    else if (paletteOpen) params.set("view", "palette");
    else if (reviewTaskId && reviewTaskId === taskId) params.set("view", "review");
    const query = params.toString();
    window.history.replaceState(null, "", query ? `${window.location.pathname}?${query}` : window.location.pathname);
  }, [composer, notes, paletteOpen, projectId, projectsReady, reviewTaskId, scopeKind, settingsSection, taskId]);

  useEffect(() => {
    const onPopState = () => {
      const next = readUrlSelection();
      // 回退到的那条历史记录说了算，不回落 localStorage：它记的是「上次用的那档」，
      // 拿它覆盖会让后退退回一个用户没去过的作用域。
      setScopeKind(resolveScopeKind(window.location.search, null));
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

  useEffect(() => { window.localStorage.setItem("ash:sidebar-collapsed", collapsed ? "1" : "0"); }, [collapsed]);
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
  }, [currentProject?.repoPath, gitVersion, projectId, settlementVersion]);

  const selectedTask = tasks.find((task) => task.id === taskId && task.projectId === projectId && visibleOnThisMachine(task)) ?? null;
  // 列表行不带正文（TaskListItem），详情面三种视图都要完整 Task —— 选中哪个补哪个。
  // 补到之前 selectedFullTask 是 null，主区先用占位卡显示这个任务的身份（标题、状态），
  // 不是空白：正文只是详情面的一小块，没到手不该让整个任务看起来还没打开。
  const selectedFullTask = useTaskBody(selectedTask);
  const loadError = projectsError ?? tasksError;
  const activeTaskCount = useMemo(() => tasks.filter((task) => inScope(task, scope) && task.parentId === null && !task.archived && visibleOnThisMachine(task)).length, [scope, tasks]);
  // J/K 走的是「屏幕上看得见的那些行」，所以筛选开着时它也得跟着筛 —— 否则按一下就跳到
  // 一个被隐藏的任务上，看着像选中丢了。判据与 TaskTree 共用（spreadVisibleTasks）。
  const orderedTasks = useMemo(
    () => spreadVisibleTasks(tasks, scope, spread.filter),
    [scope, spread.filter, tasks],
  );
  const updateTask = useCallback((updated: TaskListItem) => setTasks((current) => current.some((task) => task.id === updated.id)
    ? current.map((task) => task.id === updated.id ? updated : task)
    : [updated, ...current]), [setTasks]);
  const openLocalOwnership = useCallback((task: TaskListItem) => {
    updateTask(task);
    pushTaskHistoryEntry(task, window, scopeKind);
    setRemoteSelection(null);
    setProjectId(task.projectId);
    setTaskId(task.id);
    setComposer(null);
    setNotes(null);
    setReviewTaskId(null);
    setSettingsSection(null);
    void refetchTasks({ silent: true });
  }, [refetchTasks, scopeKind, updateTask]);
  const deleteTask = useCallback((deletedId: string) => {
    setTasks((current) => current.filter((task) => task.id !== deletedId));
    setTaskId((current) => current === deletedId ? null : current);
  }, [setTasks]);
  // 选具体项目 = 退回单项目态：在下拉里点了某个项目，还继续混着看所有项目的话，那次点击就白点了。
  const selectProject = (nextProjectId: string) => { setScopeKind("project"); setProjectId(nextProjectId); setTaskId(null); setRemoteSelection(null); setComposer(null); setNotes(null); setReviewTaskId(null); setSettingsSection(null); };
  // 切到「全部项目」只换列表的口径，不动选中的任务和上下文项目 —— 你正看着的那条还在，
  // 只是周围多出了别家的行。
  const selectAllProjects = () => { setScopeKind("all"); setSettingsSection(null); };
  // keepSpread：J/K 在铺开态里只是挪选中行，右边那两列还得接着看；点行或按 Enter 才算「选定了」，
  // 那时候铺开自己收起来把主区还回去。
  const selectTask = (task: TaskListItem, options?: { keepSpread?: boolean }) => {
    if (!visibleOnThisMachine(task)) {
      notify("任务已接力到另一台机器，请在当前持有它的机器上继续");
      return;
    }
    pushTaskHistoryEntry(task, window, scopeKind);
    setProjectId(task.projectId);
    setTaskId(task.id);
    setRemoteSelection(null);
    setComposer(null);
    setNotes(null);
    setReviewTaskId(null);
    setSettingsSection(null);
    if (!options?.keepSpread) spread.close();
  };
  const selectRemoteTask = (task: TaskListItem, target: HandoffTarget) => {
    setProjectId(task.projectId);
    setTaskId(null);
    setRemoteSelection({ task, target });
    setComposer(null);
    setNotes(null);
    setReviewTaskId(null);
    setSettingsSection(null);
    spread.close();
  };
  const selectTaskById = (nextTaskId: string) => {
    const target = tasks.find((task) => task.id === nextTaskId);
    if (target) selectTask(target);
    else api.task(nextTaskId).then((task) => { updateTask(task); selectTask(task); }).catch(() => notify("关联任务不存在或读取失败"));
  };
  const openNotes = (nextProjectId = projectId, noteId: string | null = null) => { if (nextProjectId) { setProjectId(nextProjectId); setRemoteSelection(null); setSettingsSection(null); setComposer(null); setNotes({ projectId: nextProjectId, noteId }); } };
  const openSettings = (section: SettingsSection = "executors") => { setRemoteSelection(null); setSettingsSection(section); setComposer(null); setNotes(null); setPaletteOpen(false); };
  const openComposer = (mode: TaskMode = "single") => {
    if (!currentProject) return;
    setRemoteSelection(null);
    setSettingsSection(null);
    setNotes(null);
    setComposer((current) => current ? { ...current, mode } : { mode });
  };
  const createTask = (task: Task, draft?: ComposerDraft | null) => {
    setTasks((current) => current.some((row) => row.id === task.id) ? current.map((row) => row.id === task.id ? task : row) : [task, ...current]);
    pushTaskHistoryEntry(task, window, scopeKind);
    setTaskId(task.id);
    setRemoteSelection(null);
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
  const terminalToggle = currentProject ? (
    <TerminalToggle open={terminalOpen} onToggle={() => setTerminalOpen((open) => !open)} />
  ) : null;
  const handoffAlert = (
    <div className="handoff-approval-slot">
      <HandoffApprovalAlert notify={notify} onOpenSettings={() => openSettings("defaults")} />
    </div>
  );
  const overlays = <>
    <CommandPalette open={paletteOpen} projects={projects} currentProject={currentProject} tasks={tasks} selectedTask={selectedTask} groups={groups} onClose={() => setPaletteOpen(false)} onProject={selectProject} onAllProjects={() => { selectAllProjects(); setPaletteOpen(false); }} onTask={selectTask} onTaskUpdated={updateTask} onNote={openNotes} onComposer={openComposer} onNewGroup={() => currentProject ? setCreateDialog("group") : notify("先选择一个项目")} onNewProject={() => setCreateDialog("project")} onDeleteTask={setDeleteTarget} onSettings={openSettings} notify={notify} />
    {notes && notesProject && <NotesPanel key={`${notes.projectId}:${notes.noteId ?? "list"}`} project={notesProject} initialNoteId={notes.noteId} onClose={() => setNotes(null)} onTask={(nextTaskId) => { const task = tasks.find((row) => row.id === nextTaskId); if (task) selectTask(task); else api.task(nextTaskId).then(selectTask).catch(() => notify("关联任务读取失败")); setNotes(null); }} onConvert={(draft) => { setNotes(null); setSettingsSection(null); setComposer({ mode: "single", draft }); }} notify={notify} />}
    {groupsPanelOpen && currentProject && <GroupsPanel project={currentProject} groups={groups} tasks={tasks} onClose={() => setGroupsPanelOpen(false)} onChanged={refreshGroups} notify={notify} />}
    {deleteTarget && <DeleteTaskDialog task={deleteTarget} onClose={() => setDeleteTarget(null)} onDeleted={(ids) => { ids.forEach(deleteTask); setDeleteTarget(null); }} notify={notify} />}
    {handoffTarget && <HandoffDialog task={handoffTarget} onClose={() => setHandoffTarget(null)} onTaskUpdate={updateTask} notify={notify} />}
    {createDialog === "project" && <CreateProjectDialog projects={projects} notify={notify} onClose={() => setCreateDialog(null)} onCreated={(created) => { setProjects((current) => [...current, created]); setProjectId(created.id); setTaskId(null); setSettingsSection(null); setCreateDialog(null); notify("项目已创建"); }} />}
    {createDialog === "group" && currentProject && <CreateGroupDialog onClose={() => setCreateDialog(null)} onCreate={async (name, mode) => { try { const created = await api.createGroup({ projectId: currentProject.id, name, mode }); setGroups((current) => [...current, created]); setCreateDialog(null); notify("分组已创建"); } catch (error) { notify(error instanceof Error ? error.message : "分组创建失败"); } }} />}
    <div className={`workspace-toast${toast ? " is-visible" : ""}`} role="status" aria-live="polite">{toast}</div>
  </>;
  const cliUpgradeNotice = cliVersionWarning ? (
    <div className="workspace-cli-upgrade-notice" role="alert">
      <span>{cliVersionWarning}</span>
      <button type="button" onClick={() => openSettings("executors")}>查看执行器</button>
    </div>
  ) : null;
  if (settingsSection) return <><div className="workspace-system-layout"><div>{handoffAlert}{cliUpgradeNotice}</div><SettingsPage
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
  /></div>{overlays}</>;

  return (
    <><div className="workspace-system-layout">{handoffAlert}<div className={`workspace-shell${spread.laidOut ? " is-spread" : ""}`} style={{ "--workspace-sidebar-width": `${sidebarWidth}px` } as CSSProperties}>
      <WorkspaceSidebar projects={projects} currentProject={currentProject} scope={scope} tasks={tasks} selectedTaskId={taskId} selectedRemoteTaskId={remoteSelection?.task.id ?? null} connected={connected} collapsed={collapsed} spread={spread} width={sidebarWidth} onWidthChange={setSidebarWidth} onProject={selectProject} onAllProjects={selectAllProjects} onTask={selectTask} onRemoteTask={selectRemoteTask} onTaskStarred={applyStar} onHandoffFinished={() => refetchTasks({ silent: true }).then(() => {})} onGitChanged={() => setGitVersion((value) => value + 1)} onOpenTerminal={currentProject ? () => setTerminalOpen(true) : null} notify={notify} onToggleCollapsed={() => { spread.close(); setCollapsed((value) => !value); }} onSearch={() => setPaletteOpen(true)} onNotes={() => openNotes()} onGroups={() => setGroupsPanelOpen(true)} onCreate={() => openComposer("single")} onNewProject={() => setCreateDialog("project")} onSettings={() => openSettings("executors")} />
      <main className="workspace-main">
        {cliUpgradeNotice}
        {loadError && <div className="workspace-load-error">{loadError.message}</div>}
        {composer && currentProject ? <TaskComposerPanel project={currentProject} groups={groups} initialDraft={composer.draft} mode={composer.mode} onModeChange={(mode) => setComposer((current) => current ? { ...current, mode } : null)} onCancel={() => setComposer(null)} onCreated={createTask} onCreateGroup={createComposerGroup} notify={notify} /> : remoteSelection ? (
          <RemoteTaskDetail
            archive={remoteSelection.task}
            target={remoteSelection.target}
            notify={notify}
            onLocalOwnership={openLocalOwnership}
          />
        ) : selectedFullTask?.mode === "team" ? (
          <TeamView task={selectedFullTask} allTasks={tasks} onTaskUpdate={updateTask} onTaskDeleted={deleteTask} onSelectTask={selectTask} initialReviewOpen={reviewTaskId === selectedFullTask.id} onReviewOpenChange={(open) => setReviewTaskId(open ? selectedFullTask.id : null)} terminalToggle={terminalToggle} notify={notify} />
        ) : selectedFullTask?.mode === "duet" ? (
          <DuetView task={selectedFullTask} allTasks={tasks} onTaskUpdated={updateTask} onTaskCreated={(created) => setTasks((current) => current.some((task) => task.id === created.id) ? current.map((task) => task.id === created.id ? created : task) : [created, ...current])} onTaskDeleted={deleteTask} onSelectTask={selectTask} terminalToggle={terminalToggle} notify={notify} />
        ) : selectedFullTask ? (
          <TaskDetail task={selectedFullTask} allTasks={tasks} onTaskUpdate={updateTask} onDeleted={deleteTask} onOpenTask={selectTaskById} onHandoff={setHandoffTarget} initialReviewOpen={reviewTaskId === selectedFullTask.id} onReviewOpenChange={(open) => setReviewTaskId(open ? selectedFullTask.id : null)} terminalToggle={terminalToggle} notify={notify} />
        ) : <><header className="workspace-app-bar"><span className="workspace-kind-chip">{scopeKind === "all" ? "任务" : "项目"}</span><span className="workspace-app-title">{scopeKind === "all" ? ALL_PROJECTS_LABEL : currentProject?.name ?? "Ash"}</span>{(scopeKind === "all" || currentProject) && <span className="workspace-app-count">{activeTaskCount} 项任务</span>}{terminalToggle}</header><div className="workspace-columns"><section className="workspace-primary" aria-label="主工作区"><TaskPlaceholder project={currentProject} task={null} /></section><aside className="workspace-inspector-slot" aria-label="Inspector 占位"><div><span>Inspector</span><small>项目概览</small></div><p>选择任务后，这里会显示可操作属性、执行信息与队列。</p></aside></div></>}
        {terminalOpen && currentProject && <Suspense fallback={null}><ProjectTerminal key={currentProject.id} project={currentProject} onClose={() => setTerminalOpen(false)} notify={notify} /></Suspense>}
      </main>
    </div></div>{overlays}</>
  );
}
