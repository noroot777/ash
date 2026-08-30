import type { ProjectView, Task } from "@ash/shared";
import { taskDisplayStatus } from "@ash/shared";
import { CirclesThreePlus, FolderPlus } from "@phosphor-icons/react";
import { Button } from "../components/ui.tsx";
import { workspaceModifierLabel } from "./useWorkspaceShortcuts.ts";

function taskKind(task: Task): string {
  if (task.mode === "team") return "团队";
  if (task.mode === "duet") return "讨论";
  return "任务";
}

export function TaskPlaceholder({
  project,
  task,
  onCreateProject,
}: {
  project: ProjectView | null;
  task: Task | null;
  /** 一个项目都没有时,空状态得自己给出下一步 —— 只写一句「用 ⌘K 新建项目」等于让人先学快捷键。 */
  onCreateProject?: () => void;
}) {
  const modifier = workspaceModifierLabel();
  if (!project) {
    return (
      <section className="workspace-empty-state">
        <CirclesThreePlus size={26} weight="bold" aria-hidden="true" />
        <h1>还没有可用项目</h1>
        <p>任务、随手记和分组都挂在项目下，先建一个项目才能开工。也可以按 {modifier} K 从命令面板新建。</p>
        {onCreateProject && (
          <Button variant="primary" className="workspace-empty-action" onClick={onCreateProject}>
            <FolderPlus size={14} weight="bold" aria-hidden="true" />
            新建项目
          </Button>
        )}
      </section>
    );
  }

  if (!task) {
    return (
      <section className="workspace-empty-state">
        <span className="workspace-empty-project">{project.name}</span>
        <h1>从任务树选择一项</h1>
        <p>选择任务查看完整会话与 Inspector，或按 C 新建任务。</p>
      </section>
    );
  }

  const display = taskDisplayStatus(task.status, task.stage, !!task.question);
  return (
    <article className="workspace-task-placeholder">
      <div className="workspace-task-placeholder-kicker">
        <span>{taskKind(task)}</span>
        <i aria-hidden="true" />
        <b>{display.label}</b>
      </div>
      <h1>{task.title || "未命名任务"}</h1>
      <p>{task.body.trim() || "这个任务没有正文说明。"}</p>
      <dl>
        <div>
          <dt>项目</dt>
          <dd>{project.name}</dd>
        </div>
        <div>
          <dt>状态</dt>
          <dd>{display.label}</dd>
        </div>
        <div>
          <dt>模式</dt>
          <dd>{taskKind(task)}</dd>
        </div>
      </dl>
    </article>
  );
}
