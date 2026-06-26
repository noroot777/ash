import { useEffect, useState, useCallback, useMemo, useRef } from "react";
import type { Task, ProjectView, Group, AgentEvent, DebateStyle, AgentType, ProjectHealth, Issue } from "@harness/shared";
import { CaretDown, MagnifyingGlass, GearSix, Plus, ListChecks, PencilSimpleLine } from "@phosphor-icons/react";
import { api } from "./api";
import { useServerEvents } from "./useEvents";
import { orderedTasks } from "./TaskList";
import { type LogLine } from "./TaskDetail";
import { CommandPalette, type Command } from "./CommandPalette";
import { PRIORITIES } from "./constants";
import { CreateTask } from "./CreateTask";
import { DebateModal } from "./DebateComposer";
import { applyDebateEvent, emptyDebate, type DebateState } from "./debateState";
import { AgentsPanel } from "./AgentsPanel";
import { Menu } from "./Menu";
import { NewProjectModal, NewGroupModal, ConfirmModal, WorktreeCleanupModal } from "./Modal";
import { toast, Toaster } from "./toast";
import { GroupsPanel } from "./GroupsPanel";
import { ProjectSettings } from "./ProjectSettings";
import { HealthDot, ProjectAvatar } from "./ui";
import { shortPath } from "./util";
import { runAction, canStopTask } from "./taskActions";
import { canArchive } from "@harness/shared";
import { TasksWorkspace } from "./TasksWorkspace";
import { IssuesWorkspace } from "./IssuesWorkspace";
import { SettingsPanel } from "./SettingsPanel";

export function App() {
  // Deep-link state via the URL (?project=…&task=…): a refresh stays on the same
  // project/task, and the link is shareable. Seeded here, kept in sync below.
  const urlParams = new URLSearchParams(window.location.search);
  const [projects, setProjects] = useState<ProjectView[]>([]);
  const [projectId, setProjectId] = useState<string | null>(urlParams.get("project"));
  const [groups, setGroups] = useState<Group[]>([]);
  const [tasks, setTasks] = useState<Task[]>([]);
  // Mirror tasks for cross-effect reads (delete handler captures projectId before
  // the row is removed — without a ref it would close over a stale snapshot).
  const tasksRef = useRef<Task[]>([]);
  tasksRef.current = tasks;
  const [selected, setSelected] = useState<string | null>(urlParams.get("task"));
  const [logs, setLogs] = useState<Record<string, LogLine[]>>({});
  const [debates, setDebates] = useState<Record<string, DebateState>>({});
  const [sessionsBump, setSessionsBump] = useState(0);
  const [curHealth, setCurHealth] = useState<ProjectHealth | null>(null);
  const [projSearch, setProjSearch] = useState("");
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [agentsOpen, setAgentsOpen] = useState(false);
  const [newProjectOpen, setNewProjectOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [newGroupOpen, setNewGroupOpen] = useState(false);
  const [groupsOpen, setGroupsOpen] = useState(false);
  const [sysOpen, setSysOpen] = useState(false); // 系统设置面板(大模型连接等)
  const [debateOpen, setDebateOpen] = useState<DebateStyle | null>(null);
  const [confirmDel, setConfirmDel] = useState<{ id: string; title: string } | null>(null);
  // After deleting a task that used a worktree, prompt to clean it up (or keep).
  const [worktreePrompt, setWorktreePrompt] = useState<
    { projectId: string; path: string; branch: string } | null
  >(null);
  const [view, setView] = useState<"list" | "board" | "archived">("list");
  // Sidebar width is user-draggable; persist so it survives reloads. Clamp on read
  // in case of a stale/garbage value.
  const [sidebarW, setSidebarW] = useState(() => {
    const v = Number(localStorage.getItem("harness.sidebarWidth"));
    return v >= 220 && v <= 560 ? v : 300;
  });
  useEffect(() => {
    localStorage.setItem("harness.sidebarWidth", String(sidebarW));
  }, [sidebarW]);

  // Top-level plane: 规划(事项) vs 执行(任务). Issues are project-scoped, but the
  // 未归类 (staging) ones surface across projects. Kept in the URL like project/task.
  const [section, setSection] = useState<"issue" | "task">((urlParams.get("section") as "issue" | "task") || "task");
  const [issues, setIssues] = useState<Issue[]>([]);
  const [selectedIssue, setSelectedIssue] = useState<string | null>(urlParams.get("issue"));
  // Bumps on every task.status so an open issue's derived-task list stays live
  // without giving issues their own SSE channel.
  const [taskBump, setTaskBump] = useState(0);

  const connected = useServerEvents(
    useCallback((ev) => {
      if (ev.type === "task.status") {
        setTasks((ts) =>
          ts.map((t) =>
            t.id === ev.taskId
              ? {
                  ...t,
                  status: ev.status,
                  startedAt: ev.startedAt !== undefined ? ev.startedAt : t.startedAt,
                  endedAt: ev.endedAt !== undefined ? ev.endedAt : t.endedAt,
                  activeMs: ev.activeMs !== undefined ? ev.activeMs : t.activeMs,
                  liveSince: ev.liveSince !== undefined ? ev.liveSince : t.liveSince,
                }
              : t,
          ),
        );
        if (ev.status === "done" || ev.status === "failed" || ev.status === "canceled") setSessionsBump((n) => n + 1);
        setTaskBump((n) => n + 1); // keep an open issue's derived-task list live
      } else if (ev.type === "task.title") {
        setTasks((ts) => ts.map((t) => (t.id === ev.taskId ? { ...t, title: ev.title } : t)));
      } else if (ev.type === "agent.event") {
        if (ev.role === "single") {
          const line = renderEvent(ev.event, ev.agentType, ev.sessionId);
          if (line) setLogs((m) => ({ ...m, [ev.taskId]: [...(m[ev.taskId] ?? []), line] }));
        } else {
          setDebates((m) => ({ ...m, [ev.taskId]: applyDebateEvent(m[ev.taskId] ?? emptyDebate(), ev) }));
        }
      } else if (ev.type === "debate.progress" || ev.type === "debate.gate" || ev.type === "debate.user") {
        setDebates((m) => ({ ...m, [ev.taskId]: applyDebateEvent(m[ev.taskId] ?? emptyDebate(), ev) }));
      }
    }, []),
  );

  useEffect(() => {
    api.projects().then((ps) => {
      setProjects(ps);
      // Honor ?project=… if it's valid, else fall back to the first project.
      setProjectId((cur) => (cur && ps.some((p) => p.id === cur) ? cur : (ps[0]?.id ?? null)));
    });
  }, []);

  // Issues load once (not per-project): they're project-scoped in the list, but
  // 未归类 staging issues surface across projects, so the client filters locally.
  useEffect(() => {
    api.issues().then(setIssues).catch(() => {});
  }, []);

  // A selected issue must belong to the current project view (its own project, or
  // 未归类 which surfaces everywhere). Switching projects without clearing ?issue=,
  // or landing on a stale/mismatched URL, would otherwise keep another project's
  // issue selected — clear it once issues have loaded so both state and URL self-heal.
  useEffect(() => {
    if (!selectedIssue || !issues.length) return;
    const iss = issues.find((i) => i.id === selectedIssue);
    if (iss && iss.projectId != null && iss.projectId !== projectId) setSelectedIssue(null);
  }, [projectId, selectedIssue, issues]);

  // Keep the URL in sync with the current project/task (replaceState — no history
  // spam) so refresh/share lands on the same place.
  useEffect(() => {
    const p = new URLSearchParams();
    if (projectId) p.set("project", projectId);
    if (section !== "task") p.set("section", section);
    if (section === "task" && selected) p.set("task", selected);
    if (section === "issue" && selectedIssue) p.set("issue", selectedIssue);
    const qs = p.toString();
    window.history.replaceState(null, "", qs ? `?${qs}` : window.location.pathname);
  }, [projectId, selected, section, selectedIssue]);

  useEffect(() => {
    if (!projectId) return;
    api.groups(projectId).then(setGroups);
    api.tasks().then((ts) => {
      const mine = ts.filter((t) => t.projectId === projectId);
      setTasks(mine);
      // Switching projects no longer auto-selects a task: keep the current one
      // only if it belongs to the new project (deep-link ?task=), else clear to
      // the empty state and let the user pick.
      setSelected((cur) => (mine.some((t) => t.id === cur) ? cur : null));
    });
  }, [projectId]);

  // Live git context (branch + worktree) of the current project's working dir, for
  // the top-bar chip. Refetch on project switch and after a run settles, since a
  // commit/checkout may have moved the branch or changed the dirty state.
  useEffect(() => {
    setCurHealth(null);
    if (projectId) api.projectHealth(projectId).then(setCurHealth).catch(() => {});
  }, [projectId, sessionsBump]);

  const active = useMemo(() => tasks.filter((t) => !t.archived), [tasks]);
  // Issue count for the rail: current project's issues + cross-project 未归类.
  const issueCount = useMemo(
    () => issues.filter((i) => i.projectId === projectId || i.projectId == null).length,
    [issues, projectId],
  );
  const archivedTasks = useMemo(
    () => tasks.filter((t) => t.archived).sort((x, y) => (y.archivedAt ?? "").localeCompare(x.archivedAt ?? "")),
    [tasks],
  );
  const visible = view === "archived" ? archivedTasks : active;
  const ordered = useMemo(() => orderedTasks(visible), [visible]);
  const current = tasks.find((t) => t.id === selected) ?? null;
  const project = projects.find((p) => p.id === projectId) ?? null;
  const projectName = project?.name ?? "项目";

  // Other projects to switch to (current lives in the switcher header), filtered
  // by the search box when there are enough to warrant it.
  const otherProjects = useMemo(() => {
    const q = projSearch.trim().toLowerCase();
    return projects.filter(
      (p) => p.id !== projectId && (!q || p.name.toLowerCase().includes(q) || p.repoPath.toLowerCase().includes(q)),
    );
  }, [projects, projectId, projSearch]);

  const patch = useCallback(async (id: string, p: Partial<Task>) => {
    const updated = await api.patchTask(id, p);
    setTasks((ts) => ts.map((t) => (t.id === id ? updated : t)));
  }, []);

  const run = useCallback(async (id: string) => {
    setLogs((m) => ({ ...m, [id]: [] }));
    setDebates((m) => ({ ...m, [id]: emptyDebate() }));
    try { await api.runTask(id); } catch (e) { console.warn("run rejected:", e); }
  }, []);

  // Manually stop a running task (kill its agent). The backend flips it to
  // canceled and broadcasts the status; it stays re-runnable / continuable.
  const stop = useCallback(async (id: string) => {
    try { await api.stopTask(id); } catch (e) { console.warn("stop rejected:", e); }
  }, []);

  // Retry a failed debate: drop the failed (last) turn from the live timeline so
  // the re-run doesn't duplicate it, then ask the backend to resume.
  const retry = useCallback(async (id: string) => {
    setDebates((m) => {
      const d = m[id];
      return d ? { ...m, [id]: { ...d, turns: d.turns.slice(0, -1), gate: null } } : m;
    });
    try { await api.retryTask(id); } catch (e) { console.warn("retry rejected:", e); }
  }, []);

  const archive = useCallback(async (id: string) => {
    try { const t = await api.archiveTask(id); setTasks((ts) => ts.map((x) => (x.id === id ? t : x))); }
    catch (e) { console.warn("archive rejected:", e); }
  }, []);
  const unarchive = useCallback(async (id: string) => {
    try { const t = await api.unarchiveTask(id); setTasks((ts) => ts.map((x) => (x.id === id ? t : x))); }
    catch (e) { console.warn("unarchive rejected:", e); }
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
    const display = (text || "[附件]") + (opts?.agent ? `  ·  指派给 @${opts.agent}` : "");
    setLogs((m) => ({ ...m, [id]: [...(m[id] ?? []), { kind: "user", text: display, at: new Date().toISOString() }] }));
    try { await api.replyTask(id, text, opts); } catch (e) { console.warn("reply rejected:", e); }
  }, []);

  const gate = useCallback((id: string, action: Parameters<typeof api.gate>[1]) => api.gate(id, action), []);

  // Open a task from an issue's 派生执行 link: switch to the 执行 plane and select
  // it, fetching it (and switching to its project) if the loaded list lacks it —
  // e.g. a task just spawned by @-executing the issue isn't in `tasks` yet.
  const openTask = useCallback(async (taskId: string) => {
    setSection("task");
    setSelected(taskId);
    if (!tasksRef.current.some((t) => t.id === taskId)) {
      try {
        const t = await api.task(taskId);
        setProjectId(t.projectId);
        setTasks((ts) => (ts.some((x) => x.id === t.id) ? ts : [t, ...ts]));
      } catch {
        /* task gone */
      }
    }
  }, []);

  // The reverse jump: a task's 「← 来自事项」 backlink opens its source issue.
  const openIssue = useCallback((issueId: string) => {
    setSection("issue");
    setSelectedIssue(issueId);
  }, []);

  const del = useCallback((id: string, title: string) => setConfirmDel({ id, title }), []);
  const doDelete = useCallback(async (id: string) => {
    // The task row carries projectId — capture it BEFORE setTasks removes the row,
    // so the cleanup prompt knows which project's git to act against.
    const victim = tasksRef.current.find((t) => t.id === id);
    const res = await api.deleteTask(id);
    setTasks((ts) => ts.filter((t) => t.id !== id));
    setSelected((cur) => (cur === id ? null : cur));
    if (res.worktreeHint && victim) {
      setWorktreePrompt({ projectId: victim.projectId, ...res.worktreeHint });
    }
  }, []);

  const onTaskCreated = useCallback((t: Task, doRun = false) => {
    setTasks((ts) => [t, ...ts]);
    setSelected(t.id);
    if (doRun) {
      setDebates((m) => ({ ...m, [t.id]: emptyDebate() }));
      api.runTask(t.id);
    }
  }, []);

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

  const anyModal = createOpen || agentsOpen || newProjectOpen || settingsOpen || newGroupOpen || groupsOpen || sysOpen || !!debateOpen || !!confirmDel || !!worktreePrompt;

  // ── keyboard navigation ────────────────────────────────────────────────
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        if (anyModal) return;
        e.preventDefault();
        setPaletteOpen((o) => !o);
        return;
      }
      const el = e.target as HTMLElement;
      if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT")) return;
      if (paletteOpen || anyModal) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return; // don't hijack ⌘C/⌘V/etc.
      if (section !== "task") return; // j/k/c/r task nav only in the 执行 plane
      const idx = ordered.findIndex((t) => t.id === selected);
      if (e.key === "j" || e.key === "ArrowDown") {
        e.preventDefault();
        if (ordered.length) setSelected(ordered[Math.min(idx + 1, ordered.length - 1)]?.id ?? selected);
      } else if (e.key === "k" || e.key === "ArrowUp") {
        e.preventDefault();
        if (ordered.length) setSelected(ordered[Math.max(idx - 1, 0)]?.id ?? selected);
      } else if (e.key === "c") {
        e.preventDefault();
        setCreateOpen(true);
      } else if (e.key === "r" && current) {
        e.preventDefault();
        primary(current);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [ordered, selected, current, paletteOpen, anyModal, primary, section]);

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
      if (a.canClick) cmds.push({ id: "run", group: g, label: a.label, hint: "R", run: () => primary(current) });
      if (canStopTask(current.status)) cmds.push({ id: "stop", group: g, label: "停止运行", run: () => stop(current.id) });
      if (current.archived) cmds.push({ id: "unarchive", group: g, label: "取消归档", run: () => unarchive(current.id) });
      else if (canArchive(current.status)) cmds.push({ id: "archive", group: g, label: "归档任务", run: () => archive(current.id) });
      cmds.push({ id: "del", group: g, label: "删除任务", run: () => del(current.id, current.title) });
      for (const p of PRIORITIES)
        cmds.push({ id: "pr-" + p.key, group: "设为优先级", label: p.label, run: () => patch(current.id, { priority: p.key }) });
    }
    // Global: create / manage.
    cmds.push(
      { id: "new", group: "新建", label: "新建任务", hint: "C", run: () => setCreateOpen(true) },
      { id: "pair-debate", group: "新建", label: "新建辩论 · 给你答案 (/pair)", run: () => setDebateOpen("debate") },
      { id: "pair-collab", group: "新建", label: "新建协作 · 给你代码 (/pair)", run: () => setDebateOpen("collaborate") },
      { id: "newgroup", group: "新建", label: "新建分组", run: () => setNewGroupOpen(true) },
      { id: "newproject", group: "新建", label: "新建项目", run: () => setNewProjectOpen(true) },
      { id: "groups", group: "管理", label: "分组管理", run: () => setGroupsOpen(true) },
      { id: "agents", group: "管理", label: "管理智能体执行器", run: () => setAgentsOpen(true) },
      { id: "settings", group: "管理", label: "系统设置 · 大模型连接(中转站)", run: () => setSysOpen(true) },
    );
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
  }, [current, projects, projectId, groups, project, primary, stop, del, patch, archive, unarchive]);

  return (
    <div className="flex h-full">
      {/* Left rail (Linear-style): project switcher + 规划/执行 sections + tools */}
      <aside className="flex w-[228px] shrink-0 flex-col border-r border-line bg-panel p-2">
        <Menu
          value={projectId ?? ""}
          onChange={(v) => { setProjSearch(""); setProjectId(v); }}
          menuWidth={300}
          maxHeight={520}
          options={otherProjects.map((p) => ({
            value: p.id,
            label: p.name,
            detail: shortPath(p.repoPath),
            icon: (
              <span className="relative">
                <ProjectAvatar name={p.name} size={22} />
                {!p.health.isRepo && (
                  <span className="absolute -bottom-0.5 -right-0.5 rounded-full ring-2 ring-panel">
                    <HealthDot health={p.health} size={7} />
                  </span>
                )}
              </span>
            ),
          }))}
          header={({ close }) => (
            <div className="flex flex-col gap-1.5">
              {project && (
                <div className="flex items-center gap-2 rounded-md px-1 py-0.5">
                  <ProjectAvatar name={project.name} size={30} />
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className="truncate text-[13px] font-semibold text-ink">{project.name}</span>
                    <span className="truncate text-[11px] text-faint">{shortPath(project.repoPath) || "未设置路径"}</span>
                  </span>
                  <button
                    onClick={() => { close(); setSettingsOpen(true); }}
                    title="项目设置"
                    className="grid h-7 w-7 shrink-0 place-items-center rounded-md text-muted hover:bg-raised hover:text-ink"
                  >
                    <GearSix size={15} />
                  </button>
                </div>
              )}
              {projects.length > 6 && (
                <input
                  autoFocus
                  value={projSearch}
                  onChange={(e) => setProjSearch(e.target.value)}
                  placeholder="搜索项目…"
                  className="w-full rounded-md border border-line bg-canvas px-2 py-1 text-[12px] text-ink outline-none placeholder:text-faint focus:border-accent"
                />
              )}
              {otherProjects.length > 0 && (
                <div className="px-1 text-[10px] font-medium uppercase tracking-wide text-faint">切换到</div>
              )}
            </div>
          )}
          footer={({ close }) => (
            <button
              onClick={() => { close(); setNewProjectOpen(true); }}
              className="flex w-full items-center gap-2 rounded-md px-1 py-1 text-left text-[13px] text-muted hover:bg-raised hover:text-ink"
            >
              <span className="grid h-[22px] w-[22px] shrink-0 place-items-center rounded-md border border-dashed border-line2">
                <Plus size={13} />
              </span>
              新建项目
            </button>
          )}
          triggerClassName="flex items-center gap-2 rounded-md px-1.5 py-1.5 hover:bg-raised"
        >
          <ProjectAvatar name={projectName} size={24} />
          <span className="max-w-[150px] truncate text-[13px] font-semibold text-ink">{projectName}</span>
          {project && !project.health.isRepo && <HealthDot health={project.health} />}
          <CaretDown size={12} className="ml-auto text-faint" />
        </Menu>

        <nav className="mt-1.5 flex flex-col gap-px">
          <div className="px-2 pb-1 pt-3 text-[10px] font-semibold uppercase tracking-[0.07em] text-faint">规划</div>
          <button
            onClick={() => setSection("issue")}
            className={`group flex items-center gap-2.5 rounded-md px-2 py-1.5 text-[13px] ${section === "issue" ? "bg-raised font-medium text-ink" : "text-muted hover:bg-raised hover:text-ink"}`}
          >
            <PencilSimpleLine size={16} className={section === "issue" ? "text-accent" : ""} /> 事项
            <span className="ml-auto rounded-full bg-overlay px-1.5 text-[11px] text-faint">{issueCount}</span>
          </button>
          <div className="px-2 pb-1 pt-3 text-[10px] font-semibold uppercase tracking-[0.07em] text-faint">执行</div>
          <button
            onClick={() => setSection("task")}
            className={`flex items-center gap-2.5 rounded-md px-2 py-1.5 text-[13px] ${section === "task" ? "bg-raised font-medium text-ink" : "text-muted hover:bg-raised hover:text-ink"}`}
          >
            <ListChecks size={16} className={section === "task" ? "text-accent" : ""} /> 任务
            <span className="ml-auto rounded-full bg-overlay px-1.5 text-[11px] text-faint">{active.length}</span>
          </button>
        </nav>

        <div className="flex-1" />

        <div className="flex flex-col gap-px border-t border-line pt-1.5">
          <button onClick={() => setAgentsOpen(true)} className="flex items-center gap-2.5 rounded-md px-2 py-1.5 text-[13px] text-muted hover:bg-raised hover:text-ink">智能体</button>
          <button onClick={() => setSysOpen(true)} className="flex items-center gap-2.5 rounded-md px-2 py-1.5 text-[13px] text-muted hover:bg-raised hover:text-ink"><GearSix size={14} /> 设置</button>
          <button onClick={() => setPaletteOpen(true)} className="flex items-center gap-2.5 rounded-md px-2 py-1.5 text-[13px] text-muted hover:bg-raised hover:text-ink">
            <MagnifyingGlass size={14} /> 搜索 <kbd className="ml-auto">⌘K</kbd>
          </button>
          <div className="flex items-center gap-2 px-2 py-1.5 text-[12px] text-faint">
            <span className={`h-1.5 w-1.5 rounded-full ${connected ? "bg-emerald-500" : "bg-faint"}`} />
            {connected ? "实时已连接" : "未连接"}
          </div>
        </div>
      </aside>

      <main className="flex min-h-0 flex-1 flex-col">
        {section === "issue" ? (
          <IssuesWorkspace
            projects={projects}
            projectId={projectId}
            issues={issues}
            setIssues={setIssues}
            selectedIssue={selectedIssue}
            onSelectIssue={setSelectedIssue}
            onOpenTask={openTask}
            taskBump={taskBump}
            onOpenSettings={() => setSysOpen(true)}
          />
        ) : (
          <TasksWorkspace
            view={view}
            setView={setView}
            visible={visible}
            current={current}
            groups={groups}
            selected={selected}
            onSelect={setSelected}
            logs={logs}
            debates={debates}
            sessionsBump={sessionsBump}
            curHealth={curHealth}
            sidebarW={sidebarW}
            setSidebarW={setSidebarW}
            archivedCount={archivedTasks.length}
            onNewTask={() => setCreateOpen(true)}
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
            onGate={gate}
            onOpenIssue={openIssue}
          />
        )}
      </main>

      <CommandPalette open={paletteOpen} commands={commands} onClose={() => setPaletteOpen(false)} />
      {agentsOpen && <AgentsPanel onClose={() => setAgentsOpen(false)} />}
      {sysOpen && <SettingsPanel onClose={() => setSysOpen(false)} />}
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
      {debateOpen && project && <DebateModal project={project} initialStyle={debateOpen} onClose={() => setDebateOpen(null)} onCreated={onTaskCreated} />}
      {createOpen && project && (
        <CreateTask
          project={project}
          groups={groups}
          onClose={() => setCreateOpen(false)}
          onCreated={(t) => onTaskCreated(t)}
          onCreateGroup={() => setNewGroupOpen(true)}
          onDebate={(style) => {
            setCreateOpen(false);
            setDebateOpen(style);
          }}
        />
      )}
      <Toaster />
    </div>
  );
}

function renderEvent(e: AgentEvent, agent?: AgentType, sessionId?: string): LogLine | null {
  const base = (l: LogLine): LogLine => ({ ...l, agent, sessionId });
  switch (e.kind) {
    case "text":
      return base({ kind: "text", text: e.text });
    case "thinking":
      return base({ kind: "thinking", text: e.text });
    case "system":
      return base({ kind: "system", text: e.text, at: new Date().toISOString() });
    case "tool":
      return base({ kind: "tool", name: e.name, text: e.detail ?? "" });
    case "error":
      return base({ kind: "error", text: e.message });
    case "done":
      return base({ kind: "done", text: `— 结束 (exit ${e.exitStatus}) —` });
    default:
      return null;
  }
}
