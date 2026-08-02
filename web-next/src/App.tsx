import { ComponentsPage } from "./dev/ComponentsPage.tsx";
import { WorkspaceShell } from "./workspace/WorkspaceShell.tsx";

export function App() {
  if (window.location.pathname === "/dev/components") return <ComponentsPage />;
  const variant = /^\/next2(?:\/|$)/.test(window.location.pathname) ? "next2" : "next";
  return <WorkspaceShell variant={variant} />;
}
