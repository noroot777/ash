// Pull projects + tasks into the store — the unit of work the list/status poll
// repeats on a timer (and that pull-to-refresh / settings-save trigger once).
// Keeps the current project selection when still valid (else falls back to the
// first). Flips `online` so the drawer dot reflects whether the last sync reached
// the backend.
import { api } from "./api";
import { useStore } from "./store";

export async function refreshAll(): Promise<void> {
  try {
    const [projects, tasks] = await Promise.all([api.projects(), api.tasks()]);
    const st = useStore.getState();
    st.setProjects(projects);
    const cur = st.projectId;
    st.setProjectId(cur && projects.some((p) => p.id === cur) ? cur : (projects[0]?.id ?? null));
    st.setTasks(tasks);
    st.setOnline(true);
  } catch (e) {
    useStore.getState().setOnline(false);
    throw e;
  }
}
