// Compact a filesystem path for display: keep the last 2–3 segments with a
// leading "…/" so long absolute paths fit in a chip/menu row. The full path
// should still be surfaced via a `title` attribute on the element.
export function shortPath(p: string | null | undefined, segments = 2): string {
  if (!p) return "";
  const parts = p.replace(/\/+$/, "").split("/").filter(Boolean);
  if (parts.length <= segments) return p;
  return "…/" + parts.slice(-segments).join("/");
}

// Group display label "<name> · 并行/串行" — shared so the create modal and the
// task detail show groups identically.
export function groupLabel(g: { name: string; mode: string }): string {
  return `${g.name} · ${g.mode === "parallel" ? "并行" : "串行"}`;
}

// The mode badge shown on task cards/rows. A 双 AI (mode "debate") task shows
// debate(violet)/collab(teal) by its style; a single task shows @agent.
export function pairBadge(t: {
  mode: string;
  agentType?: string | null;
  debate?: { style?: string } | null;
}): { label: string; cls: string } {
  if (t.mode !== "debate") return { label: `@${t.agentType ?? "—"}`, cls: "text-faint" };
  return t.debate?.style === "collaborate"
    ? { label: "collab", cls: "bg-teal-500/15 text-teal-700" }
    : { label: "debate", cls: "bg-violet-500/15 text-violet-700" };
}
