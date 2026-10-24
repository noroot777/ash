import { randomUUID } from "node:crypto";
import { openConfinement, reopenConfinement, type Confinement, type ConfineRead } from "./executors/kernel-confine.js";
import { IS_MAC, IS_WINDOWS } from "./platform.js";
import { gateJobConfinement } from "./accept-gate-confinement-job.js";
import { isMacGateScope, macGateConfinement, MAC_GATE_NOTICE } from "./accept-gate-confinement-macos.js";

export type GateConfinement = Omit<Confinement, "enroll" | "read"> & {
  enroll: (pid: number) => boolean | Promise<boolean>;
  prepare?: () => Promise<void>;
  read: () => ConfineRead | { kind: "members"; members: { pid: number; gen: string | null }[]; coverage: "observed-processes" };
};

export function assertGateConfinementAvailable(): void {
  const reason = gateConfinementUnavailable();
  if (reason) throw new Error(reason);
}

export const gateConfinementUnavailable = (): string | null => null;
export const gateExecutionNotice = (): string | null => IS_MAC ? MAC_GATE_NOTICE : null;
export const gateScopeNotice = (id: string | null | undefined): string | null =>
  id === "macos-observed" || isMacGateScope(id) ? MAC_GATE_NOTICE : null;

export function createGateConfinement(logPath: string, pid: number, startedAt: string): GateConfinement | null {
  assertGateConfinementAvailable();
  if (IS_MAC) return macGateConfinement(logPath, pid, startedAt);
  const token = `accept-gate-${randomUUID()}`;
  return IS_WINDOWS
    ? gateJobConfinement(logPath, `Local\\ash-${token}`, pid, true, startedAt)
    : openConfinement(token);
}

export function reopenGateConfinement(logPath: string, id: string, pid: number, startedAt: string | null): GateConfinement | null {
  if (IS_MAC) return isMacGateScope(id) ? macGateConfinement(logPath, pid, startedAt, id) : null;
  return IS_WINDOWS && id.startsWith("Local\\ash-accept-gate-")
    ? gateJobConfinement(logPath, id, pid, false, startedAt)
    : reopenConfinement(id);
}
