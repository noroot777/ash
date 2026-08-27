import { AuthGate } from "./auth/AuthGate.tsx";
import { ExecutorGateProvider } from "./task-detail/ExecutorGate.tsx";
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
    // AuthGate 包在最外面:未登录时必须**先**换成登录屏,而不是把工作台渲染出来
    // 再由一堆 401 把它打成一片错误提示。自用模式下它整体透明。
    <AuthGate>
      <TaskReplyDraftProvider>
        {/* 「这一轮会换执行器」的确认闸装在这一层:每个会起一轮的入口都用得上它,
            连命令面板那种点完就把自己关掉的入口也是(对话框不跟着调用方卸载)。 */}
        <ExecutorGateProvider>
          <WorkspaceShell />
        </ExecutorGateProvider>
      </TaskReplyDraftProvider>
      <PreviewBadge />
    </AuthGate>
  );
}
