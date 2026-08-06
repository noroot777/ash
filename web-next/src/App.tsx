import { WorkspaceShell } from "./workspace/WorkspaceShell.tsx";

export function App() {
  if (window.location.pathname !== "/") {
    window.history.replaceState(null, "", `/${window.location.search}${window.location.hash}`);
  }
  return <WorkspaceShell />;
}
