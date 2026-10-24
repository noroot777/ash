type TaskSnapshot = {
  updatedAt: string;
  backgroundRevision?: number;
  acceptGateRunning?: boolean;
  monitorRunning?: boolean;
};

export function mergeTaskSnapshotFields<T extends TaskSnapshot>(current: T, incoming: T, keepEqual = false): T {
  const base = current.updatedAt > incoming.updatedAt || (keepEqual && current.updatedAt === incoming.updatedAt)
    ? current : incoming;
  const background = (current.backgroundRevision ?? -1) > (incoming.backgroundRevision ?? -1) ? current : incoming;
  if (background.backgroundRevision === undefined) return base;
  return { ...base, backgroundRevision: background.backgroundRevision,
    acceptGateRunning: background.acceptGateRunning, monitorRunning: background.monitorRunning };
}
