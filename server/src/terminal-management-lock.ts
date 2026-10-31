import { AsyncLocalStorage } from "node:async_hooks";

type Lease = { key: string; active: boolean };
type ManagedSession = { id: string; projectId: string; commandId: string | null };

const leases = new AsyncLocalStorage<Lease[]>();
const pending = new Map<string, Promise<unknown>>();

function withLock<Value>(key: string, operation: () => Promise<Value>): Promise<Value> {
  const inherited = leases.getStore() ?? [];
  if (inherited.some((lease) => lease.key === key && lease.active)) return operation();
  const previous = pending.get(key) ?? Promise.resolve();
  const run = () => {
    const lease = { key, active: true };
    return leases.run([...inherited, lease], async () => {
      try { return await operation(); }
      finally { lease.active = false; }
    });
  };
  const next = previous.then(run, run);
  const tail = next.catch(() => undefined);
  pending.set(key, tail);
  void tail.finally(() => { if (pending.get(key) === tail) pending.delete(key); });
  return next;
}

export function withCommandLock<Value>(
  projectId: string, commandId: string, operation: () => Promise<Value>,
): Promise<Value> {
  return withLock(JSON.stringify(["command", projectId, commandId]), operation);
}

export function withSessionLock<Value>(session: ManagedSession, operation: () => Promise<Value>): Promise<Value> {
  return withLock(JSON.stringify(["session", session.id]), operation);
}

export function withLaunchHandover<Value>(session: ManagedSession, operation: () => Promise<Value>): Promise<Value> {
  const handover = () => withSessionLock(session, operation);
  return session.commandId === null ? handover() : withCommandLock(session.projectId, session.commandId, handover);
}
