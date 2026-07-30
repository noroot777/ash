import { ComponentsPage } from "./dev/ComponentsPage.tsx";
import { WorkspaceShell } from "./workspace/WorkspaceShell.tsx";

export function App() {
  return window.location.pathname === "/dev/components" ? <ComponentsPage /> : <WorkspaceShell />;
}
