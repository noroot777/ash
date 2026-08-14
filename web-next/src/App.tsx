import { PreviewBadge } from "./components/PreviewBadge.tsx";
import { TaskReplyDraftProvider } from "./task-detail/TaskReplyDrafts.tsx";
import { WorkspaceShell } from "./workspace/WorkspaceShell.tsx";

export function App() {
  if (window.location.pathname !== "/") {
    window.history.replaceState(null, "", `/${window.location.search}${window.location.hash}`);
  }
  return (
    <>
      <TaskReplyDraftProvider>
        <WorkspaceShell />
      </TaskReplyDraftProvider>
      <PreviewBadge />
    </>
  );
}
