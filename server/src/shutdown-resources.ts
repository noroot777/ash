export type ShutdownResource = {
  kind: string;
  id: string;
  label: string;
  projectId?: string;
  pid?: number;
  ports?: number[];
};

type Cleanup = {
  resources: () => ShutdownResource[] | Promise<ShutdownResource[]>;
  exit: () => void;
};

const cleanups = new Set<Cleanup>();

export function registerShutdownCleanup(resources: Cleanup["resources"], exit: Cleanup["exit"]): () => void {
  const cleanup = { resources, exit };
  cleanups.add(cleanup);
  process.once("exit", exit);
  return () => {
    cleanups.delete(cleanup);
    process.removeListener("exit", exit);
  };
}

export async function shutdownResources(): Promise<{ version: 1; resources: ShutdownResource[] }> {
  const resources = [];
  for (const cleanup of cleanups) resources.push(...await cleanup.resources());
  return { version: 1, resources };
}
