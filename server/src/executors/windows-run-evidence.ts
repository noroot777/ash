import type { ChildProcess } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import type { ProcessTableSnapshot } from "../process-generation.js";
import { genStartedAtMs } from "../process-subtrees.js";
import type { LineageStand } from "./lineage.js";
import { windowsWrapPaths } from "./detached-win-wrap.js";
import type { DetachedPaths } from "./detached-child.js";

const ownershipPaths = new WeakMap<ChildProcess, string>();

export function registerWindowsOwnership(child: ChildProcess, paths: DetachedPaths): void {
  const wrap = windowsWrapPaths(paths);
  if (existsSync(wrap.ownership) || existsSync(wrap.state)) ownershipPaths.set(child, wrap.ownership);
}

export function windowsExecutionRoot(child: ChildProcess, table: ProcessTableSnapshot): {
  root?: { pid: number; stand: LineageStand };
  fault?: string;
} {
  const path = ownershipPaths.get(child);
  if (!path) return {};
  try {
    const value = JSON.parse(readFileSync(path, "utf8"));
    if (value.wrapperPid !== child.pid || !Number.isInteger(value.pid) || value.pid <= 1
      || !Number.isFinite(value.from) || !Number.isFinite(value.bornBefore)
      || value.bornBefore < value.from) throw new Error("执行进程归属证据尚未就绪或无效");
    if (value.exitedAt !== null) {
      if (!Number.isFinite(value.exitedAt) || value.exitedAt < value.bornBefore) throw new Error("执行进程退出区间无效");
      return { root: { pid: value.pid, stand: {
        state: "exited", from: value.from, fromRes: 1, to: value.exitedAt, toRes: 1,
      } } };
    }
    const generation = table.gens.get(value.pid);
    const born = generation ? genStartedAtMs(generation) : null;
    if (born === null || born < value.from - 1 || born > value.bornBefore + 1) {
      throw new Error("执行进程尚未封口且核验不了原来的代次");
    }
    return { root: { pid: value.pid, stand: { state: "live", from: born, fromRes: 1 } } };
  } catch (error) {
    return { fault: `Windows 执行进程归属未确认: ${error instanceof Error ? error.message : String(error)}` };
  }
}
