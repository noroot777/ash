import { PreviewBadge } from "./components/PreviewBadge.tsx";
import { TaskReplyDraftProvider } from "./task-detail/TaskReplyDrafts.tsx";
import { WorkspaceShell } from "./workspace/WorkspaceShell.tsx";
import { normalizedWorkspaceUrl } from "./workspace/workspaceHistory.ts";

export function App() {
  const normalizedUrl = normalizedWorkspaceUrl(
    window.location.pathname,
    window.location.search,
    window.location.hash,
  );
  if (normalizedUrl) window.history.replaceState(null, "", normalizedUrl);
  return (
    <>
      <TaskReplyDraftProvider>
        <WorkspaceShell />
      </TaskReplyDraftProvider>
      <PreviewBadge />
    </>
  );
}
