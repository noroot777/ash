import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import type { ProjectHealth } from "@ash/shared";
import { GitWorkbench } from "../../src/git-workbench/GitWorkbench.tsx";
import { readGitLocation } from "../../src/git-workbench/navigation.ts";
import { ProjectGitContext } from "../../src/workspace/ProjectGitContext.tsx";
import "../../src/styles/global.css";
import "../../src/styles/workspace.css";
import "../../src/styles/project-git.css";
import "../../src/styles/dialogs.css";
import "../../src/styles/git-workbench.css";

const projectId = new URLSearchParams(location.search).get("project") || "fixture-project";
const health: ProjectHealth = {
  exists: true,
  isRepo: true,
  isWorktree: false,
  branch: "main",
  dirty: true,
};

function Ash() {
  const [locationKey, setLocationKey] = useState(() => location.href);
  const [notice, setNotice] = useState("");
  const [openedTask, setOpenedTask] = useState("");
  useEffect(() => {
    const changed = () => setLocationKey(location.href);
    window.addEventListener("popstate", changed);
    return () => window.removeEventListener("popstate", changed);
  }, []);
  const params = new URL(locationKey).searchParams;
  const workbench = params.get("view") === "git";
  const git = readGitLocation();

  return (
    <main className={workbench ? "fixture-workbench" : "fixture-project"}>
      {workbench ? (
        <GitWorkbench
          projectId={projectId}
          projectName="Git Workbench Fixture"
          root={git.root}
          taskId={git.taskId}
          view={git.view}
          initialRef={git.ref}
          notify={setNotice}
          onExit={() => history.back()}
          openTask={(taskId) => setOpenedTask(taskId)}
        />
      ) : (
        <section className="fixture-project-card">
          <p>项目主区</p>
          <div className="workspace-sidebar-top">
            <div className="workspace-sidebar-selectors">
              <ProjectGitContext
                projectId={projectId}
                health={health}
                canManage
                onOpenTerminal={null}
              />
            </div>
          </div>
        </section>
      )}
      <output data-testid="fixture-notice">{notice}</output>
      <output data-testid="fixture-opened-task">{openedTask}</output>
    </main>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Ash />
  </StrictMode>,
);
