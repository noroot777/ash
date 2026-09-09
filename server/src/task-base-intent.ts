export type BaseUpdateIntent = { head: string; rebased: string; target: string; branch: string; backup: string };
export const commitId = (value: unknown): string | null => typeof value === "string" && /^[a-f0-9]{40,64}$/.test(value) ? value : null;

export function parseBaseUpdateIntent(raw: string): BaseUpdateIntent | null {
  try {
    const value = JSON.parse(raw);
    if (!value || typeof value !== "object" || !commitId(value.head) || !commitId(value.rebased) || !commitId(value.target)
      || typeof value.branch !== "string" || !value.branch || typeof value.backup !== "string" || !value.backup) return null;
    return value;
  } catch { return null; }
}
