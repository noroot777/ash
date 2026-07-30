import { ArrowSquareOut } from "@phosphor-icons/react";

export function LegacyLink({
  projectId,
  taskId,
  view,
  settings,
  noteId,
  mode,
  compact = false,
}: {
  projectId: string | null;
  taskId: string | null;
  view?: "review" | "settings" | "palette" | "notes" | "create";
  settings?: "agents" | "project" | "groups" | "archive";
  noteId?: string | null;
  mode?: "single" | "team" | "debate";
  compact?: boolean;
}) {
  const params = new URLSearchParams();
  if (projectId) params.set("project", projectId);
  if (taskId) params.set("task", taskId);
  if (view) params.set("view", view);
  if (settings) params.set("settings", settings);
  if (noteId) params.set("note", noteId);
  if (mode) params.set("mode", mode);
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
