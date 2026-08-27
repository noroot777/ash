import type { ProjectView } from "@ash/shared";

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
  // dot = 只留一颗项目色的小圆点，不写首字母。给「说一句就够、不能抢戏」的地方用
  //（任务模式里的项目分组头）—— 带字母的方块在那种一行高的弱化标题上太重了。
  size?: "dot" | "small" | "medium" | "large";
}) {
  return (
    <span
      className={`workspace-project-avatar workspace-project-avatar--${size} workspace-project-avatar--tone-${toneFor(project.id)}`}
      aria-hidden="true"
    >
      {size === "dot" ? null : project.name.trim().charAt(0).toUpperCase() || "P"}
    </span>
  );
}
