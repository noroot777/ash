import { useEffect, useState, useCallback, useMemo, useRef } from "react";
import type { Task, ProjectView, Group, AgentType, ProjectHealth, SearchHit } from "@harness/shared";
import { api } from "./api";
import { orderedTasks } from "./TaskList";
import { type LogLine } from "./TaskDetail";
import { CommandPalette, type Command } from "./CommandPalette";
import { PRIORITIES } from "./constants";
import { TaskComposer } from "./TaskComposer";
import { useComposer } from "./useComposer";
import { emptyDebate, type DebateState } from "./debateState";
import { AgentsPanel } from "./AgentsPanel";
import { NewProjectModal, NewGroupModal, ConfirmModal, WorktreeCleanupModal } from "./Modal";
import { toast, Toaster } from "./toast";
import { GroupsPanel } from "./GroupsPanel";
import { ProjectSettings } from "./ProjectSettings";
import { shortPath } from "./util";
import { runAction, canStopTask } from "./taskActions";
import { canArchive } from "@harness/shared";
import { TasksWorkspace, type TaskView } from "./TasksWorkspace";
import { ProjectRail } from "./ProjectRail";
import { isDispatchedWorker } from "./taskPolicy";
import { NewNoteModal, NotesModal } from "./NotesModal";
import { runningOnly, upsertTask, useAppEvents } from "./useAppEvents";

function rejectDispatchedWorkerMutation(task: Task | undefined): boolean {
  if (!task || !isDispatchedWorker(task)) return false;
  toast("执行者任务由调度者管理；这里只保留运行、停止、重试和答复", "info");
  return true;
}

export function App() {
  // Deep-link state via the URL (?project=…&task=…): a refresh stays on the same
  // project/task, and the link is shareable. Seeded here, kept in sync below.
  const urlParams = new URLSearchParams(window.location.search);
  const [projects, setProjects] = useState<ProjectView[]>([]);
  const [projectId, setProjectId] = useState<string | null>(urlParams.get("project"));
  const projectIdRef = useRef<string | null>(projectId);
  projectIdRef.current = projectId;
  const [groups, setGroups] = useState<Group[]>([]);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [runningTasks, setRunningTasks] = useState<Task[]>([]);
  // Mirror tasks for cross-effect reads (delete handler captures projectId before
  // the row is removed — without a ref it would close over a stale snapshot).
  const tasksRef = useRef<Task[]>([]);
  tasksRef.current = tasks;
  const [selected, setSelected] = useState<string | null>(urlParams.get("task"));
  // 打开新建面板时要记住「打开前选中的是谁」，而回调不该因为换了选中就换身份。
  const selectedRef = useRef<string | null>(selected);
  selectedRef.current = selected;
  const [logs, setLogs] = useState<Record<string, LogLine[]>>({});
  const [debates, setDebates] = useState<Record<string, DebateState>>({});
  const [sessionsBump, setSessionsBump] = useState(0);
  const [curHealth, setCurHealth] = useState<ProjectHealth | null>(null);
  const [paletteOpen, setPaletteOpen] = useState(false);
  // 新建任务不是弹层：它把右侧详情区整个换成一张内嵌单子（见 TaskComposer）。
  const { composer, openComposer, setComposerMode, closeComposer, clearComposerDraft } = useComposer();
  const [notesMode, setNotesMode] = useState<"new" | "list" | null>(null);
  const [noteTarget, setNoteTarget] = useState<string | null>(null);
  const [agentsOpen, setAgentsOpen] = useState(false);
  const [newProjectOpen, setNewProjectOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [newGroupOpen, setNewGroupOpen] = useState(false);
  const [groupsOpen, setGroupsOpen] = useState(false);
  const [confirmDel, setConfirmDel] = useState<{ id: string; title: string } | null>(null);
  // After deleting a task that used a worktree, prompt to clean it up (or keep).
  const [worktreePrompt, setWorktreePrompt] = useState<
    { projectId: string; path: string; branch: string } | null
  >(null);
  const [view, setView] = useState<TaskView>("list");
  // Sidebar width is user-draggable; persist so it survives reloads. Clamp on read
  // in case of a stale/garbage value.
  const [sidebarW, setSidebarW] = useState(() => {
    const v = Number(localStorage.getItem("harness.sidebarWidth"));
    return v >= 220 && v <= 560 ? v : 300;
  });
  useEffect(() => {
    localStorage.setItem("harness.sidebarWidth", String(sidebarW));
  }, [sidebarW]);

  // Left rail can collapse to icon-only to give the task list more room. The
  // toggle lives at the rail's bottom; state persists across reloads.
  const [railCollapsed, setRailCollapsed] = useState(
    () => localStorage.getItem("harness.railCollapsed") === "1",
  );
  useEffect(() => {
    localStorage.setItem("harness.railCollapsed", railCollapsed ? "1" : "0");
  }, [railCollapsed]);

  const connected = useAppEvents({
    projectIdRef,
    setTasks,
    setRunningTasks,
    setLogs,
    setDebates,
    setSessionsBump,
  });

  useEffect(() => {
    api.projects().then((ps) => {
      setProjects(ps);
      // Honor ?project=… if it's valid, else fall back to the first project.
      setProjectId((cur) => (cur && ps.some((p) => p.id === cur) ? cur : (ps[0]?.id ?? null)));
    });
  }, []);

  // Keep the URL in sync with the current project/task (replaceState — no history
  // spam) so refresh/share lands on the same place.
  useEffect(() => {
    const p = new URLSearchParams();
    if (projectId) p.set("project", projectId);
    if (selected) p.set("task", selected);
    const qs = p.toString();
    window.history.replaceState(null, "", qs ? `?${qs}` : window.location.pathname);
  }, [projectId, selected]);

  useEffect(() => {
    if (!projectId) return;
    api.groups(projectId).then(setGroups);
    api.tasks().then((ts) => {
      setRunningTasks(runningOnly(ts));
      const mine = ts.filter((t) => t.projectId === projectId);
      setTasks(mine);
      // Switching projects no longer auto-selects a task: keep the current one
      // only if it belongs to the new project (deep-link ?task=), else clear to
      // the empty state and let the user pick.
      setSelected((cur) => (mine.some((t) => t.id === cur) ? cur : null));
    });
  }, [projectId]);

  useEffect(() => {
    if (!paletteOpen) return;
    let alive = true;
    api.tasks().then((rows) => { if (alive) setRunningTasks(runningOnly(rows)); }).catch(() => {});
    return () => { alive = false; };
  }, [paletteOpen]);

  // Live git context (branch + worktree) of the current project's working dir, for
  // the top-bar chip. Refetch on project switch and after a run settles, since a
  // commit/checkout may have moved the branch or changed the dirty state.
  useEffect(() => {
    setCurHealth(null);
    if (projectId) api.projectHealth(projectId).then(setCurHealth).catch(() => {});
  }, [projectId, sessionsBump]);

  const active = useMemo(() => tasks.filter((t) => !t.archived), [tasks]);
  const archivedTasks = useMemo(
    () => tasks.filter((t) => t.archived).sort((x, y) => (y.archivedAt ?? "").localeCompare(x.archivedAt ?? "")),
    [tasks],
  );
  const visible = view === "archived" ? archivedTasks : active;
  const ordered = useMemo(() => orderedTasks(visible), [visible]);
  const current = tasks.find((t) => t.id === selected) ?? null;
  const project = projects.find((p) => p.id === projectId) ?? null;

  const patch = useCallback(async (id: string, p: Partial<Task>) => {
    if (rejectDispatchedWorkerMutation(tasksRef.current.find((t) => t.id === id))) return;
    const updated = await api.patchTask(id, p);
    setTasks((ts) => ts.map((t) => (t.id === id ? updated : t)));
  }, []);

  // 后端拒绝(409 等)必须让用户看见——静默吞掉就成了「点了没反应」。
  const showErr = (e: unknown) => toast(e instanceof Error ? e.message : String(e));

  const run = useCallback(async (id: string) => {
    setLogs((m) => ({ ...m, [id]: [] }));
    setDebates((m) => ({ ...m, [id]: emptyDebate() }));
    try { await api.runTask(id); } catch (e) { showErr(e); }
  }, []);

  // Manually stop a running task (kill its agent). The backend flips it to
  // canceled and broadcasts the status; it stays re-runnable / continuable.
  const stop = useCallback(async (id: string) => {
    try { await api.stopTask(id); } catch (e) { showErr(e); }
  }, []);

  // Retry a failed debate: drop the failed (last) turn from the live timeline so
  // the re-run doesn't duplicate it, then ask the backend to resume.
  const retry = useCallback(async (id: string) => {
    setDebates((m) => {
      const d = m[id];
      return d ? { ...m, [id]: { ...d, turns: d.turns.slice(0, -1), gate: null } } : m;
    });
    try { await api.retryTask(id); } catch (e) { showErr(e); }
  }, []);

  const archive = useCallback(async (id: string) => {
    if (rejectDispatchedWorkerMutation(tasksRef.current.find((t) => t.id === id))) return;
    try { const t = await api.archiveTask(id); setTasks((ts) => ts.map((x) => (x.id === id ? t : x))); }
    catch (e) { showErr(e); }
  }, []);
  const unarchive = useCallback(async (id: string) => {
    if (rejectDispatchedWorkerMutation(tasksRef.current.find((t) => t.id === id))) return;
    try { const t = await api.unarchiveTask(id); setTasks((ts) => ts.map((x) => (x.id === id ? t : x))); }
    catch (e) { showErr(e); }
  }, []);

  // 重新排队:服务端一次做完「回 backlog + 被越过则移到队尾 + 推进队列」。
  // 返回的 task 带最新 queuePosition(SSE 只推 status,不推队列位置),直接覆盖行。
  const requeue = useCallback(async (id: string) => {
    if (rejectDispatchedWorkerMutation(tasksRef.current.find((t) => t.id === id))) return;
    try {
      const r = await api.requeueTask(id);
      setTasks((ts) => ts.map((x) => (x.id === id ? r.task : x)));
      const at = r.position === null ? "" : `（第 ${r.position + 1}/${r.queueSize} 位）`;
      toast(
        r.movedToEnd
          ? `已排到队尾${at}：前面的任务跑完后自动启动`
          : `已重新排队${at}：轮到它时自动启动`,
      );
    } catch (e) { showErr(e); }
  }, []);

  // The single primary action for a task, dispatched by its status — used by the
  // `r` key and Cmd-K so they agree with the buttons (no re-running a done task).
  const primary = useCallback(
    (t: Task) => {
      const a = runAction(t.status, t.archived);
      if (a.kind === "run") run(t.id);
      else if (a.kind === "retry") retry(t.id);
    },
    [run, retry],
  );

  // Reply to a single task: show the human turn immediately, then resume its
  // session so the agent continues (used when an agent stopped to ask).
  const reply = useCallback(async (id: string, text: string, opts?: { attachments?: string[]; agent?: AgentType }) => {
    const display = text + (opts?.agent ? `  ·  指派给 @${opts.agent}` : "");
    setLogs((m) => ({
      ...m,
      [id]: [
        ...(m[id] ?? []),
        { kind: "user", text: display, attachments: opts?.attachments, at: new Date().toISOString() },
      ],
    }));
    try { await api.replyTask(id, text, opts); } catch (e) { showErr(e); }
  }, []);

  const gate = useCallback((id: string, action: Parameters<typeof api.gate>[1]) => api.gate(id, action), []);

  // Open a task from a ⌘K search hit or task-to-task link, fetching it (and
  // switching to its project) if the loaded list lacks it. Archived hits also
  // flip the view so the task is actually visible in the list.
  const openTask = useCallback(async (taskId: string) => {
    closeComposer();
    setSelected(taskId);
    const local = tasksRef.current.find((t) => t.id === taskId);
    let target = local;
    if (!local) {
      try {
        const t = await api.task(taskId);
        setProjectId(t.projectId);
        setTasks((ts) => (ts.some((x) => x.id === t.id) ? ts : [t, ...ts]));
        target = t;
      } catch {
        /* task gone */
      }
    }
    if (target) {
      if (target.archived) setView("archived");
      else setView((v) => (v === "archived" ? "list" : v));
    }
  }, [closeComposer]);

  // Search hits may live in another project. Notes open their own notepad detail;
  // task hits retain the archived/list handling in openTask.
  const openHit = useCallback((h: SearchHit) => {
    if (h.kind === "note") {
      setProjectId(h.projectId);
      setNoteTarget(h.id);
      setNotesMode("list");
    } else void openTask(h.id);
  }, [openTask]);

  const del = useCallback((id: string, title: string) => {
    if (rejectDispatchedWorkerMutation(tasksRef.current.find((t) => t.id === id))) return;
    setConfirmDel({ id, title });
  }, []);
  const doDelete = useCallback(async (id: string) => {
    // The task row carries projectId — capture it BEFORE setTasks removes the row,
    // so the cleanup prompt knows which project's git to act against.
    const victim = tasksRef.current.find((t) => t.id === id);
    if (rejectDispatchedWorkerMutation(victim)) return;
    const res = await api.deleteTask(id);
    setTasks((ts) => ts.filter((t) => t.id !== id));
    setSelected((cur) => (cur === id ? null : cur));
    if (res.worktreeHint && victim) {
      setWorktreePrompt({ projectId: victim.projectId, ...res.worktreeHint });
    }
  }, []);

  const onTaskCreated = useCallback((t: Task, doRun = false, select = true) => {
    // POST 的响应和 task.created SSE 可能任意一个先到；统一 upsert 避免重复行。
    setTasks((ts) => upsertTask(ts, t));
    if (select) setSelected(t.id);
    if (doRun) {
      setDebates((m) => ({ ...m, [t.id]: emptyDebate() }));
      api.runTask(t.id);
    }
  }, []);
  // 打开内嵌新建面板：右侧切成 composer，同时清掉选中（左侧列表不再高亮某一行），
  // 并记下原来选中的那个，取消时切回去。已经开着时只换模式、不动已填内容。
  const openComposerAt = useCallback(
    (mode: Parameters<typeof openComposer>[0]) => {
      openComposer(mode, { returnTo: selectedRef.current });
      setSelected(null);
    },
    [openComposer],
  );
  const openCreate = useCallback(() => openComposerAt("single"), [openComposerAt]);
  const openDebateCreate = useCallback(() => openComposerAt("debate"), [openComposerAt]);
  // 选中任务 = 离开新建面板（草稿丢弃，和原来点遮罩关闭是一个语义）。
  const selectTask = useCallback(
    (id: string | null) => {
      closeComposer();
      setSelected(id);
    },
    [closeComposer],
  );
  // 放弃这张单子：回到打开前选中的任务（它若已被删掉就落回空态）。开着「再建一个」
  // 建过任务的话 selected 已经指向刚建出来的那个 —— 那才是用户想回到的地方。
  const cancelComposer = useCallback(() => {
    const back = selectedRef.current ?? composer?.returnTo ?? null;
    closeComposer();
    setSelected(back && tasksRef.current.some((t) => t.id === back) ? back : null);
  }, [composer, closeComposer]);
  const openNewNote = useCallback(() => { setNoteTarget(null); setNotesMode("new"); }, []);
  const openNotes = useCallback(() => { setNoteTarget(null); setNotesMode("list"); }, []);
  const onCreateTaskCreated = useCallback((task: Task) => {
    onTaskCreated(task);
    const ids = composer?.draft?.noteIds ?? [];
    if (!ids.length) return;
    clearComposerDraft();
    void Promise.all(ids.map((noteId) => api.patchNote(noteId, { taskId: task.id })))
      .then(() => toast(`已关联 ${ids.length} 条随手记`))
      .catch(showErr);
  }, [composer, onTaskCreated, clearComposerDraft]);

  const doCreateProject = useCallback(async (name: string, repoPath: string) => {
    const p = await api.createProject(name, repoPath);
    setProjects((ps) => [...ps, p]);
    setProjectId(p.id);
    setNewProjectOpen(false);
  }, []);

  const doUpdateProject = useCallback(
    async (patch: { name: string; repoPath: string }) => {
      if (!projectId) return;
      const p = await api.updateProject(projectId, patch);
      setProjects((ps) => ps.map((x) => (x.id === p.id ? p : x)));
      setSettingsOpen(false);
    },
    [projectId],
  );

  const doDeleteProject = useCallback(async () => {
    if (!projectId) return;
    try {
      await api.deleteProject(projectId);
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e)); // e.g. 409 有任务在跑
      return;
    }
    setProjects((ps) => {
      const rest = ps.filter((x) => x.id !== projectId);
      setProjectId(rest[0]?.id ?? null);
      return rest;
    });
    setSettingsOpen(false);
  }, [projectId]);

  const addGroup = useCallback(
    async (name: string, mode: "parallel" | "serial") => {
      if (!projectId) return;
      const g = await api.createGroup({ projectId, name, mode });
      setGroups((gs) => [...gs, g]);
    },
    [projectId],
  );
  const doCreateGroup = useCallback(
    async (name: string, mode: "parallel" | "serial") => {
      await addGroup(name, mode);
      setNewGroupOpen(false);
    },
    [addGroup],
  );
  const updateGroup = useCallback(async (id: string, patch: Partial<Pick<Group, "name" | "mode">>) => {
    const g = await api.updateGroup(id, patch);
    setGroups((gs) => gs.map((x) => (x.id === id ? g : x)));
  }, []);
  const deleteGroup = useCallback(async (id: string) => {
    await api.deleteGroup(id);
    setGroups((gs) => gs.filter((x) => x.id !== id));
    setTasks((ts) => ts.map((t) => (t.groupId === id ? { ...t, groupId: null } : t))); // members kept, just ungrouped
  }, []);
  // Run a group (also clears a pause → doubles as resume). Optimistically reflect
  // the un-paused state so the panel button flips back immediately.
  const runGroup = useCallback(async (id: string) => {
    setGroups((gs) => gs.map((x) => (x.id === id ? { ...x, paused: false } : x)));
    try { await api.runGroup(id); } catch (e) { console.warn("runGroup rejected:", e); }
  }, []);
  const pauseGroup = useCallback(async (id: string) => {
    setGroups((gs) => gs.map((x) => (x.id === id ? { ...x, paused: true } : x)));
    try { const g = await api.pauseGroup(id); setGroups((gs) => gs.map((x) => (x.id === id ? g : x))); }
    catch (e) { console.warn("pauseGroup rejected:", e); }
  }, []);
  // composer 不在其中：它是内嵌面板不是弹层，j/k/c 这些全局键在它开着时照样管用
  // （光标落在正文里时由下面的 INPUT/TEXTAREA 判断挡住）。
  const anyModal = !!notesMode || agentsOpen || newProjectOpen || settingsOpen || newGroupOpen || groupsOpen || !!confirmDel || !!worktreePrompt;

  // ── keyboard navigation ────────────────────────────────────────────────
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setPaletteOpen((o) => !o);
        return;
      }
      const el = e.target as HTMLElement;
      if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT")) return;
      if (paletteOpen || anyModal) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return; // don't hijack ⌘C/⌘V/etc.
      const idx = ordered.findIndex((t) => t.id === selected);
      if (e.key === "j" || e.key === "ArrowDown") {
        e.preventDefault();
        if (ordered.length) selectTask(ordered[Math.min(idx + 1, ordered.length - 1)]?.id ?? selected);
      } else if (e.key === "k" || e.key === "ArrowUp") {
        e.preventDefault();
        if (ordered.length) selectTask(ordered[Math.max(idx - 1, 0)]?.id ?? selected);
      } else if (e.key === "c") {
        e.preventDefault();
        openCreate();
      } else if (e.key === "r" && current && !composer) {
        // composer 开着时右侧根本看不到那个任务，别让 r 悄悄把它跑起来。
        e.preventDefault();
        primary(current);
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [ordered, selected, current, paletteOpen, anyModal, primary, openCreate, selectTask, composer]);

  useEffect(() => {
    if (selected) document.querySelector(`[data-task-id="${selected}"]`)?.scrollIntoView({ block: "nearest" });
  }, [selected]);

  // ── command palette ──────────────────────────────────────────────────────
  // Grouped so current-task actions read separately from global ones (the
  // palette renders a header per `group`, in first-appearance order).
  const commands = useMemo<Command[]>(() => {
    const cmds: Command[] = [];
    // Current task first — the most contextual block.
    if (current) {
      const a = runAction(current.status, current.archived);
      const g = `当前任务 · ${current.title}`;
      const dispatchedWorker = isDispatchedWorker(current);
      if (a.canClick) cmds.push({ id: "run", group: g, label: a.label, hint: "R", run: () => primary(current) });
      if (canStopTask(current.status)) cmds.push({ id: "stop", group: g, label: "停止运行", run: () => stop(current.id) });
      if (!dispatchedWorker) {
        if (current.archived) cmds.push({ id: "unarchive", group: g, label: "取消归档", run: () => unarchive(current.id) });
        else if (canArchive(current.status)) cmds.push({ id: "archive", group: g, label: "归档任务", run: () => archive(current.id) });
        cmds.push({ id: "del", group: g, label: "删除任务", run: () => del(current.id, current.title) });
        for (const p of PRIORITIES)
          cmds.push({ id: "pr-" + p.key, group: "设为优先级", label: p.label, run: () => patch(current.id, { priority: p.key }) });
      }
    }
    // Global: create / manage.
    cmds.push({ id: "new", group: "新建", label: "新建任务", hint: "C", run: openCreate });
    if (project) cmds.push({ id: "new-note", group: "新建", label: "新建随手记", keys: "NI", run: openNewNote });
    cmds.push(
      { id: "new-debate", group: "新建", label: "新建辩论 · 给你答案", run: openDebateCreate },
      { id: "newgroup", group: "新建", label: "新建分组", run: () => setNewGroupOpen(true) },
      { id: "newproject", group: "新建", label: "新建项目", run: () => setNewProjectOpen(true) },
      { id: "groups", group: "管理", label: "分组管理", run: () => setGroupsOpen(true) },
      { id: "agents", group: "管理", label: "管理智能体执行器", run: () => setAgentsOpen(true) },
    );
    if (project) cmds.push({ id: "notes", group: "管理", label: "随手记列表", keys: "NL", run: openNotes });
    if (project) cmds.push({ id: "projsettings", group: "管理", label: `项目设置：${project.name}`, run: () => setSettingsOpen(true) });
    for (const p of projects)
      if (p.id !== projectId)
        cmds.push({ id: "proj-" + p.id, group: "切换项目", label: p.name, hint: shortPath(p.repoPath), run: () => setProjectId(p.id) });
    for (const g of groups)
      cmds.push({
        id: "rg-" + g.id,
        group: "运行分组",
        label: `${g.name} · ${g.mode === "parallel" ? "并行" : "串行"}`,
        run: () => api.runGroup(g.id),
      });
    return cmds;
  }, [current, projects, projectId, groups, project, primary, stop, del, patch, archive, unarchive, openCreate, openDebateCreate, openNewNote, openNotes]);

  return (
    <div className="flex h-full">
      <ProjectRail
        projects={projects}
        projectId={projectId}
        railCollapsed={railCollapsed}
        taskCount={active.length}
        connected={connected}
        onProject={setProjectId}
        onSettings={() => setSettingsOpen(true)}
        onNewProject={() => setNewProjectOpen(true)}
        onAgents={() => setAgentsOpen(true)}
        onPalette={() => setPaletteOpen(true)}
        onToggleCollapsed={() => setRailCollapsed((v) => !v)}
      />

      <main className="flex min-h-0 min-w-0 flex-1 flex-col">
        <TasksWorkspace
          view={view}
          setView={setView}
          visible={visible}
          allTasks={tasks}
          current={current}
          groups={groups}
          selected={selected}
          onSelect={selectTask}
          logs={logs}
          debates={debates}
          sessionsBump={sessionsBump}
          curHealth={curHealth}
          sidebarW={sidebarW}
          setSidebarW={setSidebarW}
          archivedCount={archivedTasks.length}
          onNewTask={openCreate}
          onNotes={openNotes}
          onGroups={() => setGroupsOpen(true)}
          onRun={run}
          onStop={stop}
          onRetry={retry}
          onReply={reply}
          onPatch={patch}
          onCreateGroup={() => setNewGroupOpen(true)}
          onDelete={del}
          onArchive={archive}
          onUnarchive={unarchive}
          onRequeue={requeue}
          onGate={gate}
          onOpenTask={openTask}
          onTaskCreated={onTaskCreated}
          composer={composer && project ? (
            <TaskComposer
              key={composer.seq}
              project={project}
              groups={groups}
              mode={composer.mode}
              onMode={setComposerMode}
              initialBody={composer.draft?.body}
              initialAttachments={composer.draft?.attachments}
              onCancel={cancelComposer}
              onDone={closeComposer}
              onCreated={onCreateTaskCreated}
              onCreateGroup={() => setNewGroupOpen(true)}
              onOpenAgents={() => setAgentsOpen(true)}
            />
          ) : null}
        />
      </main>

      <CommandPalette
        open={paletteOpen}
        commands={commands}
        runningTasks={runningTasks}
        projects={projects}
        onOpenHit={openHit}
        onOpenTask={(taskId) => { void openTask(taskId); }}
        onClose={() => setPaletteOpen(false)}
      />
      {agentsOpen && <AgentsPanel onClose={() => setAgentsOpen(false)} />}
      {newProjectOpen && <NewProjectModal onClose={() => setNewProjectOpen(false)} onCreate={doCreateProject} />}
      {settingsOpen && project && (
        <ProjectSettings project={project} onClose={() => setSettingsOpen(false)} onSave={doUpdateProject} onDelete={doDeleteProject} />
      )}
      {newGroupOpen && <NewGroupModal onClose={() => setNewGroupOpen(false)} onCreate={doCreateGroup} />}
      {groupsOpen && (
        <GroupsPanel
          groups={groups}
          tasks={visible}
          onClose={() => setGroupsOpen(false)}
          onRun={runGroup}
          onPause={pauseGroup}
          onUpdate={updateGroup}
          onDelete={deleteGroup}
          onCreate={addGroup}
        />
      )}
      {confirmDel && (
        <ConfirmModal
          title="删除任务"
          message={`确定删除任务「${confirmDel.title}」？此操作不可撤销。`}
          confirmLabel="删除"
          danger
          onConfirm={() => doDelete(confirmDel.id)}
          onClose={() => setConfirmDel(null)}
        />
      )}
      {worktreePrompt && (
        <WorktreeCleanupModal
          projectId={worktreePrompt.projectId}
          path={worktreePrompt.path}
          branch={worktreePrompt.branch}
          onClose={() => setWorktreePrompt(null)}
        />
      )}
      {notesMode === "new" && project && <NewNoteModal project={project} onClose={() => setNotesMode(null)} />}
      {notesMode === "list" && project && (
        <NotesModal
          project={project}
          initialNoteId={noteTarget}
          onClose={() => { setNotesMode(null); setNoteTarget(null); }}
          onOpenTask={(taskId) => { setNotesMode(null); void openTask(taskId); }}
          onCreateTask={(draft) => {
            setNotesMode(null);
            setNoteTarget(null);
            setView("list");
            openComposer("single", { draft, returnTo: selectedRef.current });
            setSelected(null);
          }}
        />
      )}
      <Toaster />
    </div>
  );
}
