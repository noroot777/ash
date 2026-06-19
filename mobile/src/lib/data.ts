// Initial / refresh data load shared by boot (_layout) and SSE reconnect. Pulls
// projects + tasks into the store, keeping the current project selection when
// it's still valid (else falling back to the first project).
import { api } from "./api";
import { useStore } from "./store";

export async function refreshAll(): Promise<void> {
  const [projects, tasks] = await Promise.all([api.projects(), api.tasks()]);
  const st = useStore.getState();
  st.setProjects(projects);
  const cur = st.projectId;
  st.setProjectId(cur && projects.some((p) => p.id === cur) ? cur : (projects[0]?.id ?? null));
  st.setTasks(tasks);
}
