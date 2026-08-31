import { lazy, Suspense, useCallback, useEffect, useMemo, useState, type CSSProperties } from "react";
import { useIsInstanceAdmin, useIsMultiUser } from "../auth/authContext.ts";
import type { Group, GroupMode, HandoffTarget, ProjectView, Task, TaskListItem, TaskMode } from "@ash/shared";
import { outboundHolder } from "@ash/shared/handoff";
import { api } from "../lib/api.ts";
import { readRenamedStorage } from "../lib/renamedStorage.ts";
import { useTasks } from "../lib/useTasks.ts";
import { handedOut, useOutboundState } from "./useOutboundState.ts";
import { TaskDetail } from "../task-detail/TaskDetail.tsx";
import { TeamView } from "../team/TeamView.tsx";
import { DuetView } from "../duet/DuetView.tsx";
import { TaskPlaceholder } from "./TaskPlaceholder.tsx";
import { useTaskBody } from "../lib/useTaskBody.ts";
import { WorkspaceSidebar } from "./WorkspaceSidebar.tsx";
import {
  parseSettingsSection,
  projectSectionLabel,
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
  readStoredScopeKind,
  resolveScopeKind,
  scopeTasks,
  TASK_MODE_LABEL,
  visibleInScope,
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
  // 新建项目的弹层带着「为什么会弹出来」：被门禁拦下时是一句因果，用户主动点新建项目时是 null。
  const [createDialog, setCreateDialog] = useState<{ kind: "group" } | { kind: "project"; reason: string | null } | null>(null);
  const [collapsed, setCollapsed] = useState(() => readRenamedStorage("ash:sidebar-collapsed") === "1");
  const [sidebarWidth, setSidebarWidth] = useState(readWorkspaceSidebarWidth);
  const [toast, setToast] = useState<string | null>(null);
  const [terminalOpen, setTerminalOpen] = useState(false);
  const isMultiUser = useIsMultiUser();
  const isInstanceAdmin = useIsInstanceAdmin();
  const canUseTerminal = !isMultiUser || isInstanceAdmin;
  // 项目主仓被切分支/拉取过之后重拉一次 ProjectHealth：侧栏胶囊上的分支名和「有未提交
  // 改动」那颗点都从它来，不跟着刷就会停在操作之前的样子。
  const [gitVersion, setGitVersion] = useState(0);
  const { tasks: localTasks, setTasks, loading: tasksLoading, error: tasksError, connected, settlementVersion, refetch: refetchTasks, applyStar } = useTasks();
  // 接力出去的行，状态要跨机器问持有机才知道 —— 本机那一行停在交出去那一刻。
  // **这一问由用户按**（见 useOutboundState 顶部：自动轮询会没完没了地敲别人的服务器），
  // 所以没问过时列表里就是接力当时的状态，由 OutboundStatusBar 如实说出来。
  const {
    tasks, targets: handoffTargets, refreshTargets,
    refreshRemote, refreshing: outboundRefreshing, asked: outboundAsked, offline: offlinePeers,
  } = useOutboundState(localTasks);
  const outboundBar = useMemo(() => ({
    outboundCount: tasks.filter(handedOut).length,
    offlinePeers,
    asked: outboundAsked,
    refreshing: outboundRefreshing,
    onRefresh: () => { void refreshRemote(); },
  }), [tasks, offlinePeers, outboundAsked, outboundRefreshing, refreshRemote]);
  // 侧栏在看哪些任务：当前项目一家，还是进「任务模式」看所有项目里在跑 / 待验收的那些。
  // 它只影响**列表**；下面的 currentProject 仍是「新建任务 / 终端 / git 落在哪」的上下文，
  // 跟着选中的任务走。
  const [scopeKind, setScopeKind] = useState<TaskScopeKind>(() => resolveScopeKind(window.location.search, readStoredScopeKind()));
  const scope = useMemo<TaskScope>(
    () => scopeKind === "tasks" ? { kind: "tasks" } : { kind: "project", projectId },
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
    if (scopeKind === "tasks") params.set("scope", "tasks");
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
  const activeTaskCount = useMemo(
    () => scopeTasks(tasks.filter((task) => !task.archived && visibleInScope(task, scope)), scope)
      .filter((task) => task.parentId === null).length,
    [scope, tasks],
  );
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
  // 选具体项目 = 退回单项目态：在下拉里点了某个项目，还继续按任务模式的口径列表的话，那次点击就白点了。
  const selectProject = (nextProjectId: string) => { setScopeKind("project"); setProjectId(nextProjectId); setTaskId(null); setRemoteSelection(null); setComposer(null); setNotes(null); setReviewTaskId(null); setSettingsSection(null); };
  // 切到「任务模式」只换列表的口径，不动选中的任务和上下文项目 —— 你正看着的那条还在，
  // 只是周围换成了所有项目里在跑 / 待验收的行（它自己若不在这两档里，列表上不出现，但仍开着）。
  const selectTaskMode = () => { setScopeKind("tasks"); setSettingsSection(null); };
  // G T 是**来回**切而不是单向进入：一个按两下就能进的档位，得能用同样两下退出去，否则
  // 第二次按下去没反应，只会被读成「快捷键坏了」。退回单项目态时同样不动选中的任务 ——
  // 上下文项目一直跟着它走，所以退出去看到的就是它所在的那个项目。设置页不用在这里让路：
  // 快捷键在那儿本来就是关的（见下面 useWorkspaceShortcuts 的 enabled）。
  const toggleTaskMode = () => setScopeKind((kind) => kind === "tasks" ? "project" : "tasks");
  // 任务模式里出站行就摆在列表里，点开当然得能进去 —— 进的是持有机上那份实时会话
  // （RemoteTaskDetail），跟点开本机任务一样是「打开这条任务」，只是活在别的机器上。
  // 认哪台机器由 shared 的 outboundHolder 说了算（换过地址的按名字认回同一台）。
  //
  // **先把接力设置现取一遍**再认：`handoffTargets` 是跟着轮询走的缓存，用户在设置页改完
  // 地址、页面没重新挂载时它还是旧的。而后端解析持有机用的是当前设置 —— 拿旧地址发过去
  // 只会换回一个「持有机与请求目标不一致」的 409，屏幕上就成了「状态看着恢复了，点开却
  // 打不开」。取不到就退回缓存那份，总比不让点强。
  const openOutboundTask = async (task: TaskListItem) => {
    const latest = await refreshTargets().catch(() => handoffTargets);
    const holder = outboundHolder(task.handoff, latest);
    if (holder) { selectRemoteTask(task, holder); return; }
    notify("任务已接力到另一台机器，请在当前持有它的机器上继续");
  };
  // keepSpread：J/K 在铺开态里只是挪选中行，右边那两列还得接着看；点行或按 Enter 才算「选定了」，
  // 那时候铺开自己收起来把主区还回去。
  const selectTask = (task: TaskListItem, options?: { keepSpread?: boolean }) => {
    if (!visibleOnThisMachine(task)) {
      void openOutboundTask(task);
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
  // 新建任务 / 随手记 / 分组都得先有个项目落脚。首次装完一个项目都没有时，这些入口以前是
  // 静默 return —— 屏幕上什么都不动，只会被读成「按钮坏了」。统一在这里挡：说清为什么，
  // 并把唯一能往下走的那一步（新建项目）直接摆出来；已有项目只是没选中时才只提示。
  //
  // 原因得说**两遍**且落点不同：toast 两秒多就自己走了，而弹层会一直开着 —— 只靠 toast
  // 的话，用户一眨眼错过，剩下的就是一个没头没尾的「新建项目」框，照样答不上「我点的是
  // 新建任务，怎么跳这儿来了」。所以同一句因果也交给弹层带着（reason）。
  const requireProject = (action: string): ProjectView | null => {
    if (currentProject) return currentProject;
    if (projects.length) { notify(`先选择一个项目再${action}`); return null; }
    notify(`还没有项目，先创建一个项目再${action}`);
    setCreateDialog({ kind: "project", reason: `还没有项目，${action}得先有一个落脚的项目。` });
    return null;
  };
  const openNotes = (nextProjectId = projectId, noteId: string | null = null) => {
    if (!nextProjectId) { requireProject(noteId ? "写随手记" : "看随手记"); return; }
    setProjectId(nextProjectId);
    setRemoteSelection(null);
    setSettingsSection(null);
    setComposer(null);
    setNotes({ projectId: nextProjectId, noteId });
  };
  const openGroups = () => { if (requireProject("管理分组")) setGroupsPanelOpen(true); };
  // 设置页里项目那几节（项目设置 / 成员 / 分组 / 已归档）没有项目就只有一句空话，进去等于
  // 撞墙 —— 命令面板里的「分组管理」「项目设置」走的正是这里，所以门禁挡在入口而不是页内。
  const openSettings = (section: SettingsSection = "executors") => {
    const scopedLabel = projectSectionLabel(section);
    if (scopedLabel && !requireProject(`打开「${scopedLabel}」`)) return;
    setRemoteSelection(null);
    setSettingsSection(section);
    setComposer(null);
    setNotes(null);
    setPaletteOpen(false);
  };
  const openComposer = (mode: TaskMode = "single") => {
    if (!requireProject(`新建${mode === "team" ? "团队" : mode === "duet" ? "讨论" : "任务"}`)) return;
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
    onToggleTaskMode: toggleTaskMode,
  });

  const notesProject = notes ? projects.find((project) => project.id === notes.projectId) ?? null : null;
  // 终端开的是**宿主机上的一个真 shell**,项目目录只是起始 cwd(一条 `cd /` 就出去了),
  // 所以多人模式下它是实例管理员专属(§四)。后端已经 403,这里连入口一起收掉 ——
  // 留一颗按不动的按钮只会让人以为功能坏了。
  const terminalToggle = currentProject && canUseTerminal ? (
    <TerminalToggle open={terminalOpen} onToggle={() => setTerminalOpen((open) => !open)} />
  ) : null;
  const handoffAlert = (
    <div className="handoff-approval-slot">
      <HandoffApprovalAlert notify={notify} onOpenSettings={() => openSettings("defaults")} />
    </div>
  );
  const overlays = <>
    <CommandPalette open={paletteOpen} projects={projects} currentProject={currentProject} tasks={tasks} selectedTask={selectedTask} groups={groups} onClose={() => setPaletteOpen(false)} onProject={selectProject} onTaskMode={() => { selectTaskMode(); setPaletteOpen(false); }} onTask={selectTask} onTaskUpdated={updateTask} onNote={openNotes} onComposer={openComposer} onNewGroup={() => { if (requireProject("新建分组")) setCreateDialog({ kind: "group" }); }} onNewProject={() => setCreateDialog({ kind: "project", reason: null })} onDeleteTask={setDeleteTarget} onSettings={openSettings} notify={notify} />
    {notes && notesProject && <NotesPanel key={`${notes.projectId}:${notes.noteId ?? "list"}`} project={notesProject} initialNoteId={notes.noteId} onClose={() => setNotes(null)} onTask={(nextTaskId) => { const task = tasks.find((row) => row.id === nextTaskId); if (task) selectTask(task); else api.task(nextTaskId).then(selectTask).catch(() => notify("关联任务读取失败")); setNotes(null); }} onConvert={(draft) => { setNotes(null); setSettingsSection(null); setComposer({ mode: "single", draft }); }} notify={notify} />}
    {groupsPanelOpen && currentProject && <GroupsPanel project={currentProject} groups={groups} tasks={tasks} onClose={() => setGroupsPanelOpen(false)} onChanged={refreshGroups} notify={notify} />}
    {deleteTarget && <DeleteTaskDialog task={deleteTarget} onClose={() => setDeleteTarget(null)} onDeleted={(ids) => { ids.forEach(deleteTask); setDeleteTarget(null); }} notify={notify} />}
    {handoffTarget && <HandoffDialog task={handoffTarget} onClose={() => setHandoffTarget(null)} onTaskUpdate={updateTask} onOpenRemote={selectRemoteTask} notify={notify} />}
    {createDialog?.kind === "project" && <CreateProjectDialog projects={projects} reason={createDialog.reason} notify={notify} onClose={() => setCreateDialog(null)} onCreated={(created) => { setProjects((current) => [...current, created]); setProjectId(created.id); setTaskId(null); setSettingsSection(null); setCreateDialog(null); notify("项目已创建"); }} />}
    {createDialog?.kind === "group" && currentProject && <CreateGroupDialog onClose={() => setCreateDialog(null)} onCreate={async (name, mode) => { try { const created = await api.createGroup({ projectId: currentProject.id, name, mode }); setGroups((current) => [...current, created]); setCreateDialog(null); notify("分组已创建"); } catch (error) { notify(error instanceof Error ? error.message : "分组创建失败"); } }} />}
    <div className={`workspace-toast${toast ? " is-visible" : ""}`} role="status" aria-live="polite">{toast}</div>
  </>;
  if (settingsSection) return <><div className="workspace-system-layout"><div>{handoffAlert}</div><SettingsPage
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
      <WorkspaceSidebar projects={projects} currentProject={currentProject} scope={scope} tasks={tasks} selectedTaskId={taskId} selectedRemoteTaskId={remoteSelection?.task.id ?? null} connected={connected} collapsed={collapsed} spread={spread} width={sidebarWidth} onWidthChange={setSidebarWidth} onProject={selectProject} onTaskMode={selectTaskMode} onTask={selectTask} onRemoteTask={selectRemoteTask} onTaskStarred={applyStar} onHandoffFinished={() => refetchTasks({ silent: true }).then(() => {})} outbound={outboundBar} onGitChanged={() => setGitVersion((value) => value + 1)} onOpenTerminal={currentProject && canUseTerminal ? () => setTerminalOpen(true) : null} notify={notify} onToggleCollapsed={() => { spread.close(); setCollapsed((value) => !value); }} onSearch={() => setPaletteOpen(true)} onNotes={() => openNotes()} onGroups={openGroups} onCreate={() => openComposer("single")} onNewProject={() => setCreateDialog({ kind: "project", reason: null })} onSettings={() => openSettings("executors")} />
      <main className="workspace-main">
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
        ) : <><header className="workspace-app-bar"><span className="workspace-kind-chip">{scopeKind === "tasks" ? "任务" : "项目"}</span><span className="workspace-app-title">{scopeKind === "tasks" ? TASK_MODE_LABEL : currentProject?.name ?? "Ash"}</span>{(scopeKind === "tasks" || currentProject) && <span className="workspace-app-count">{activeTaskCount} 项{scopeKind === "tasks" ? "还没落地" : "任务"}</span>}{terminalToggle}</header><div className="workspace-columns"><section className="workspace-primary" aria-label="主工作区"><TaskPlaceholder project={currentProject} task={null} onCreateProject={() => setCreateDialog({ kind: "project", reason: null })} /></section><aside className="workspace-inspector-slot" aria-label="Inspector 占位"><div><span>Inspector</span><small>项目概览</small></div><p>选择任务后，这里会显示可操作属性、执行信息与队列。</p></aside></div></>}
        {terminalOpen && currentProject && <Suspense fallback={null}><ProjectTerminal key={currentProject.id} project={currentProject} onClose={() => setTerminalOpen(false)} notify={notify} /></Suspense>}
      </main>
    </div></div>{overlays}</>
  );
}
