import { randomUUID } from "node:crypto";
import { openConfinement, reopenConfinement, type Confinement } from "./executors/kernel-confine.js";
import { IS_MAC, IS_WINDOWS } from "./platform.js";
import { gateJobConfinement } from "./accept-gate-confinement-job.js";

export type GateConfinement = Omit<Confinement, "enroll"> & { enroll: (pid: number) => boolean | Promise<boolean> };

export const GATE_CONFINEMENT_UNAVAILABLE = "macOS 没有门禁整次运行所需的 cgroup/Job 内核围栏；"
  + "进程组或进程扫描不能证明 detached/setsid 后代全部退出。为避免工作区被过早合并或删除，"
  + "本机不执行验收前置命令，请在支持内核围栏的 Windows/Linux 机器执行，或明确选择跳过门禁。";

export function assertGateConfinementAvailable(): void {
  const reason = gateConfinementUnavailable();
  if (reason) throw new Error(reason);
}

export const gateConfinementUnavailable = (): string | null => IS_MAC ? GATE_CONFINEMENT_UNAVAILABLE : null;

export function createGateConfinement(logPath: string, pid: number, startedAt: string): GateConfinement | null {
  assertGateConfinementAvailable();
  const token = `accept-gate-${randomUUID()}`;
  return IS_WINDOWS
    ? gateJobConfinement(logPath, `Local\\ash-${token}`, pid, true, startedAt)
    : openConfinement(token);
}

export function reopenGateConfinement(logPath: string, id: string, pid: number, startedAt: string | null): GateConfinement | null {
  if (IS_MAC) return null;
  return IS_WINDOWS && id.startsWith("Local\\ash-accept-gate-")
    ? gateJobConfinement(logPath, id, pid, false, startedAt)
    : reopenConfinement(id);
}
