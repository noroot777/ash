import { ArrowSquareOut } from "@phosphor-icons/react";

export function LegacyLink({
  projectId,
  taskId,
  compact = false,
}: {
  projectId: string | null;
  taskId: string | null;
  compact?: boolean;
}) {
  const params = new URLSearchParams();
  if (projectId) params.set("project", projectId);
  if (taskId) params.set("task", taskId);
  const query = params.toString();
  const href = query ? `/legacy/?${query}` : "/legacy/";

  return (
    <a
      className={`workspace-legacy-link${compact ? " workspace-legacy-link--compact" : ""}`}
      href={href}
      aria-label="用旧版打开此页"
    >
      <ArrowSquareOut size={13} aria-hidden="true" />
      {!compact && "用旧版打开"}
    </a>
  );
}
