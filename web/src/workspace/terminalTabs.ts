export type TerminalStatus = "starting" | "ready" | "reconnecting" | "ended" | "error";

export type ProjectTerminalTab = {
  id: string;
  ordinal: number;
  label: string;
  status: TerminalStatus;
  cwd: string;
};

export function createTerminalTab(
  id: string,
  ordinal: number,
  projectName: string,
  cwd: string,
): ProjectTerminalTab {
  return {
    id,
    ordinal,
    label: ordinal === 1 ? projectName : `${projectName} ${ordinal}`,
    status: "starting",
    cwd,
  };
}

export function withoutTerminalTab(
  tabs: ProjectTerminalTab[],
  activeId: string,
  closingId: string,
): { tabs: ProjectTerminalTab[]; activeId: string | null } {
  const closingIndex = tabs.findIndex((tab) => tab.id === closingId);
  if (closingIndex < 0) return { tabs, activeId };
  const next = tabs.filter((tab) => tab.id !== closingId);
  if (activeId !== closingId) return { tabs: next, activeId };
  return {
    tabs: next,
    activeId: next[Math.min(closingIndex, next.length - 1)]?.id ?? null,
  };
}
