// Compact a filesystem path for display: keep the last 2–3 segments with a
// leading "…/" so long absolute paths fit in a chip/menu row. The full path
// should still be surfaced via a `title` attribute on the element.
export function shortPath(p: string | null | undefined, segments = 2): string {
  if (!p) return "";
  const parts = p.replace(/\/+$/, "").split("/").filter(Boolean);
  if (parts.length <= segments) return p;
  return "…/" + parts.slice(-segments).join("/");
}
