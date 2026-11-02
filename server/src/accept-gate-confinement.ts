import { randomUUID } from "node:crypto";
import { openConfinement, reopenConfinement, type Confinement, type ConfineRead } from "./executors/kernel-confine.js";
import { IS_MAC, IS_WINDOWS } from "./platform.js";
import { gateJobConfinement } from "./accept-gate-confinement-job.js";
import { isMacGateScope, macGateBootstrap, macGateConfinement, MAC_GATE_NOTICE } from "./accept-gate-confinement-macos.js";

export type GateConfinement = Omit<Confinement, "enroll" | "read"> & {
  enroll: (pid: number) => boolean | Promise<boolean>;
  prepare?: () => Promise<void>;
  /** 跨重启接管一条还在跑的运行时，把起跑时那份持续观察接回来（只有靠轮询记后代的实现需要）。 */
  resume?: () => Promise<void>;
  read: () => ConfineRead | { kind: "members"; members: { pid: number; gen: string | null }[]; coverage: "observed-processes" };
};

export function assertGateConfinementAvailable(): void {
  const reason = gateConfinementUnavailable();
  if (reason) throw new Error(reason);
}

export const gateConfinementUnavailable = (): string | null => null;
export const gateExecutionNotice = (): string | null => IS_MAC ? MAC_GATE_NOTICE : null;
export const gateSupervisorBootstrap = async (logPath: string) => IS_MAC ? macGateBootstrap(logPath) : {};
/**
 * 这台机器上能不能跨重启接管一条还在跑的门禁（accept-gate-exit.ts）。不能就**显式降级**为
 * 重启前的老结局「被打断」，不是漏了：Windows 上 Job 监督器跨 ash 重启重开、以及启动器退出档
 * 在那边的落盘语义都还没在真机上验过，而接管的终点可能是一次不可逆的自动合并。
 */
export const gateTakeoverUnavailable = (): string | null =>
  IS_WINDOWS ? "Windows 上跨重启接管验收前置命令尚未验证，按被打断处理" : gateConfinementUnavailable();
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
