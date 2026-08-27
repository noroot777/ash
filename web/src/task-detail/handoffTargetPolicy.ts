import type { HandoffTarget, TaskHandoff } from "@ash/shared";

const normalizedTargetUrl = (url: string): string => url.trim().replace(/\/+$/, "");

export function handoffTargetsForTask(
  targets: HandoffTarget[],
  handoff: TaskHandoff | null | undefined,
  automaticReturnTarget?: HandoffTarget | null,
): HandoffTarget[] {
  if (handoff?.direction !== "in") return targets;
  if (!handoff.peerFp) return [];
  const registered = targets.filter((target) => target.peerFp === handoff.peerFp);
  if (!automaticReturnTarget || automaticReturnTarget.peerFp !== handoff.peerFp) return registered;
  const automaticUrl = normalizedTargetUrl(automaticReturnTarget.url);
  return [
    automaticReturnTarget,
    ...registered.filter((target) => normalizedTargetUrl(target.url) !== automaticUrl),
  ];
}

export function nextUntriedHandoffTarget(
  targets: HandoffTarget[],
  attemptedUrls: ReadonlySet<string>,
): HandoffTarget | null {
  return targets.find((target) => !attemptedUrls.has(normalizedTargetUrl(target.url))) ?? null;
}
