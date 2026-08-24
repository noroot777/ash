import type { HandoffTarget, TaskHandoff } from "@ash/shared";

export function handoffTargetsForTask(
  targets: HandoffTarget[],
  handoff: TaskHandoff | null | undefined,
): HandoffTarget[] {
  if (handoff?.direction !== "in") return targets;
  if (!handoff.peerFp) return [];
  return targets.filter((target) => target.peerFp === handoff.peerFp);
}
