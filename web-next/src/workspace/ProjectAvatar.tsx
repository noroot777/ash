import type { ProjectView } from "@harness/shared";

function toneFor(value: string): number {
  let hash = 0;
  for (const char of value) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return hash % 6;
}

export function ProjectAvatar({
  project,
  size = "medium",
}: {
  project: Pick<ProjectView, "id" | "name">;
  size?: "small" | "medium" | "large";
}) {
  return (
    <span
      className={`workspace-project-avatar workspace-project-avatar--${size} workspace-project-avatar--tone-${toneFor(project.id)}`}
      aria-hidden="true"
    >
      {project.name.trim().charAt(0).toUpperCase() || "P"}
    </span>
  );
}
