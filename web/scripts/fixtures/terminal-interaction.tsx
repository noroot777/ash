import { useCallback, useState } from "react";
import { createRoot } from "react-dom/client";
import type { ProjectView } from "@navi/shared";
import { ProjectTerminal } from "../../src/workspace/ProjectTerminal.tsx";
import { useTerminalDock } from "../../src/workspace/useTerminalDock.ts";
import { useWorkspaceShortcuts } from "../../src/workspace/useWorkspaceShortcuts.ts";
import "../../src/styles/global.css";
import "../../src/styles/status-bar.css";
import "../../src/styles/terminal.css";

const project = {
  id: "terminal-interaction", name: "交互验证", repoPath: "/workspace/terminal-interaction", myRole: "admin",
  workflowId: null, useWorktreeDefault: false, previewCommand: null, previewConfig: null,
  commandsConfig: null, acceptCommit: true, createdAt: "2026-11-21T00:00:00.000Z",
  health: { exists: true, isRepo: true, dirty: false, branch: "main" },
} satisfies ProjectView;

function Fixture() {
  const [notices, setNotices] = useState<string[]>([]);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const notify = useCallback((message: string) => setNotices((previous) => [...previous, message]), []);
  const dock = useTerminalDock({ project, enabled: true, notify });
  const ignore = () => {};
  useWorkspaceShortcuts({
    enabled: true, paletteOpen, composerOpen: false, spreadOpen: false,
    onNavigate: ignore, onTogglePalette: () => setPaletteOpen((value) => !value),
    onCreate: ignore, onToggleSpread: ignore, onCloseSpread: ignore, onToggleTaskMode: ignore,
    onOpenSettings: ignore, onToggleCommands: ignore, onToggleTerminal: dock.toggle, onOpenRecall: ignore,
  });

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100vh" }}>
      <main style={{ flex: 1, padding: 20 }}>
        <button type="button" onClick={dock.toggle}>终端</button>
        <output data-testid="palette">{String(paletteOpen)}</output>
        <output data-testid="notices">{notices.join("\n")}</output>
      </main>
      {(dock.open || dock.tabs.length > 0) && <ProjectTerminal project={project} dock={dock} notify={notify} />}
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<Fixture />);
