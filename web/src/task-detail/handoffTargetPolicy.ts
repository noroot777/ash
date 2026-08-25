import type { HandoffTarget, TaskHandoff } from "@ash/shared";

export function handoffTargetsForTask(
  targets: HandoffTarget[],
  handoff: TaskHandoff | null | undefined,
  automaticReturnTarget?: HandoffTarget | null,
): HandoffTarget[] {
  if (handoff?.direction !== "in") return targets;
  if (!handoff.peerFp) return [];
  const registered = targets.filter((target) => target.peerFp === handoff.peerFp);
  if (!automaticReturnTarget || automaticReturnTarget.peerFp !== handoff.peerFp) return registered;
  const automaticUrl = automaticReturnTarget.url.replace(/\/+$/, "");
  return [
    automaticReturnTarget,
    ...registered.filter((target) => target.url.replace(/\/+$/, "") !== automaticUrl),
  ];
}
