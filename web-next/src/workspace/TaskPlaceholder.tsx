import type { ProjectView, Task } from "@harness/shared";
import { taskDisplayStatus } from "@harness/shared";
import { CirclesThreePlus } from "@phosphor-icons/react";

function taskKind(task: Task): string {
  if (task.mode === "team") return "团队";
  if (task.mode === "debate") return "辩论";
  return "任务";
}

export function TaskPlaceholder({
  project,
  task,
}: {
  project: ProjectView | null;
  task: Task | null;
}) {
  if (!project) {
    return (
      <section className="workspace-empty-state">
        <CirclesThreePlus size={26} weight="bold" aria-hidden="true" />
        <h1>还没有可用项目</h1>
        <p>用 ⌘K 新建项目，或从项目切换器选择现有工作区。</p>
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
