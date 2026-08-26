export function latestTeamLeadSession<T extends { role: string; startedAt: string }>(
  rows: readonly T[],
): T | undefined {
  return rows
    .filter((row) => row.role === "lead")
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
    .at(0);
}
