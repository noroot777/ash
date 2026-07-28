import type { AgentType } from "@harness/shared";
import { AGENT_TYPES, TEAM_DEFAULTS } from "@harness/shared";
import type { ExecutorSelection } from "./ExecutorPicker";

export type DetectedAgent = {
  type: AgentType;
  available: boolean;
  resident: boolean;
};

// Shared by TaskComposer's /team mode and debate handoff. A lead must support a
// resident session; the default worker deliberately prefers another available
// type so the team starts with a second perspective.
export function teamExecutorDefaults(
  detected: DetectedAgent[] | null,
  leadPick: ExecutorSelection | null,
  workerPick: ExecutorSelection | null,
) {
  const resident = (detected ?? []).filter((item) => item.available && item.resident).map((item) => item.type);
  const available = (detected ?? []).filter((item) => item.available).map((item) => item.type);
  const leadTypes = resident.length ? resident : [TEAM_DEFAULTS.lead];
  const workerTypes = available.length ? available : [...AGENT_TYPES];
  const leadSelection = leadPick && leadTypes.includes(leadPick.agentType)
    ? leadPick
    : { agentType: leadTypes[0]!, executorId: null };
  const workerSelection = workerPick && workerTypes.includes(workerPick.agentType)
    ? workerPick
    : {
        agentType: workerTypes.find((type) => type !== leadSelection.agentType) ?? leadSelection.agentType,
        executorId: null,
      };
  return { leadTypes, workerTypes, leadSelection, workerSelection };
}
