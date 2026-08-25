import type { HandoffTarget, TaskHandoff } from "@ash/shared";

export function handoffTargetsForTask(
  targets: HandoffTarget[],
  handoff: TaskHandoff | null | undefined,
  automaticReturnTarget?: HandoffTarget | null,
): HandoffTarget[] {
  if (handoff?.direction !== "in") return targets;
  if (automaticReturnTarget && automaticReturnTarget.peerFp === handoff.peerFp) return [automaticReturnTarget];
  if (!handoff.peerFp) return [];
  return targets.filter((target) => target.peerFp === handoff.peerFp);
}
