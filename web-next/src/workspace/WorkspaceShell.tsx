import { useCallback, useEffect, useMemo, useState } from "react";
import type { ProjectView, Task } from "@harness/shared";
import { api } from "../lib/api.ts";
import { useTasks } from "../lib/useTasks.ts";
import { TaskDetail } from "../task-detail/TaskDetail.tsx";
import { TaskPlaceholder } from "./TaskPlaceholder.tsx";
import { WorkspaceSidebar } from "./WorkspaceSidebar.tsx";

function readUrlSelection() {
  const params = new URLSearchParams(window.location.search);
  return { projectId: params.get("project"), taskId: params.get("task") };
}

export function WorkspaceShell() {
  const initial = readUrlSelection();
  const [projects, setProjects] = useState<ProjectView[]>([]);
  const [projectsReady, setProjectsReady] = useState(false);
  const [projectsError, setProjectsError] = useState<Error | null>(null);
  const [projectId, setProjectId] = useState<string | null>(initial.projectId);
  const [taskId, setTaskId] = useState<string | null>(initial.taskId);
  const [collapsed, setCollapsed] = useState(
    () => window.localStorage.getItem("harness-next:sidebar-collapsed") === "1",
  );
  const [toast, setToast] = useState<string | null>(null);
  const { tasks, setTasks, loading: tasksLoading, error: tasksError, connected } = useTasks();

  const notify = useCallback((message: string) => {
    setToast(message);
    window.setTimeout(() => setToast((current) => (current === message ? null : current)), 2400);
  }, []);

  useEffect(() => {
    let alive = true;
    api.projects()
      .then((rows) => {
        if (!alive) return;
        setProjects(rows);
        setProjectId((current) =>
          current && rows.some((project) => project.id === current) ? current : (rows[0]?.id ?? null),
        );
      })
      .catch((reason) => {
        if (alive) setProjectsError(reason instanceof Error ? reason : new Error("项目列表读取失败"));
      })
      .finally(() => {
        if (alive) setProjectsReady(true);
      });
    return () => {
      alive = false;
    };
  }, []);

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
    if (taskId) params.set("task", taskId);
    const query = params.toString();
    window.history.replaceState(null, "", query ? `${window.location.pathname}?${query}` : window.location.pathname);
  }, [projectId, projectsReady, taskId]);

  useEffect(() => {
    const onPopState = () => {
      const next = readUrlSelection();
      setProjectId(next.projectId);
      setTaskId(next.taskId);
    };
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        notify("搜索将在后续实施链接入");
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [notify]);

  useEffect(() => {
    window.localStorage.setItem("harness-next:sidebar-collapsed", collapsed ? "1" : "0");
  }, [collapsed]);

  const currentProject = projects.find((project) => project.id === projectId) ?? null;
  const selectedTask = tasks.find((task) => task.id === taskId && task.projectId === projectId) ?? null;
  const loadError = projectsError ?? tasksError;
  const activeTaskCount = useMemo(
    () => tasks.filter((task) => task.projectId === projectId && task.parentId === null && !task.archived).length,
    [projectId, tasks],
  );

  const selectProject = (nextProjectId: string) => {
    setProjectId(nextProjectId);
    setTaskId(null);
  };

  const selectTask = (task: Task) => {
    setProjectId(task.projectId);
    setTaskId(task.id);
  };

  return (
    <div className="workspace-shell">
      <WorkspaceSidebar
        projects={projects}
        currentProject={currentProject}
        tasks={tasks}
        selectedTaskId={taskId}
        connected={connected}
        collapsed={collapsed}
        onProject={selectProject}
        onTask={selectTask}
        onToggleCollapsed={() => setCollapsed((value) => !value)}
        onPlaceholder={notify}
      />

      <main className="workspace-main">
        {loadError && <div className="workspace-load-error">{loadError.message}</div>}
        {selectedTask ? (
          <TaskDetail
            task={selectedTask}
            allTasks={tasks}
            onTaskUpdate={(updated) => setTasks((current) => current.map((task) => task.id === updated.id ? updated : task))}
            onDeleted={(deletedId) => {
              setTasks((current) => current.filter((task) => task.id !== deletedId));
              setTaskId(null);
            }}
            notify={notify}
          />
        ) : (
          <>
            <header className="workspace-app-bar">
              <span className="workspace-kind-chip">项目</span>
              <span className="workspace-app-title">{currentProject?.name ?? "Harness"}</span>
              {currentProject && <span className="workspace-app-count">{activeTaskCount} 项任务</span>}
            </header>
            <div className="workspace-columns">
              <section className="workspace-primary" aria-label="主工作区">
                <TaskPlaceholder project={currentProject} task={null} />
              </section>
              <aside className="workspace-inspector-slot" aria-label="Inspector 占位">
                <div><span>Inspector</span><small>项目概览</small></div>
                <p>选择任务后，这里会显示可操作属性、执行信息与队列。</p>
              </aside>
            </div>
          </>
        )}
      </main>

      <div className={`workspace-toast${toast ? " is-visible" : ""}`} role="status" aria-live="polite">
        {toast}
      </div>
    </div>
  );
}
