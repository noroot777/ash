import { spawn } from "node:child_process";
import { closeSync, existsSync, openSync, readFileSync, writeFileSync } from "node:fs";
import type { GateConfinement } from "./accept-gate-confinement.js";
import { reopenConfinement } from "./executors/kernel-confine.js";
import { gateJobSupervisorExecutable } from "./accept-gate-confinement-supervisor.js";

export const gateJobEvidencePath = (logPath: string): string => `${logPath}.job.json`;

type JobEvidence = { version: 2; id: string; rootPid: number; rootStartedAt: string; supervisorPid: number; state: "held" | "empty" };

export function readGateJobEvidence(logPath: string, id: string): JobEvidence | null {
  try {
    const value = JSON.parse(readFileSync(gateJobEvidencePath(logPath), "utf8")) as JobEvidence;
    return value.version === 2 && value.id === id && value.rootPid > 1 && typeof value.rootStartedAt === "string" && value.supervisorPid > 1
      && ["held", "empty"].includes(value.state) ? value : null;
  } catch { return null; }
}

export function gateJobConfinement(logPath: string, id: string, rootPid: number, fresh = false, rootStartedAt: string | null = null): GateConfinement {
  const abort = `${logPath}.abort`;
  const probe = reopenConfinement(id);
  return {
    id,
    async enroll(pid) {
      if (!fresh || !rootStartedAt || pid !== rootPid || existsSync(gateJobEvidencePath(logPath))) return false;
      const executable = await gateJobSupervisorExecutable();
      if (existsSync(abort)) return false;
      const output = openSync(`${logPath}.supervisor.log`, "a");
      let child;
      try {
        child = spawn(executable, [id, String(rootPid), gateJobEvidencePath(logPath), abort, rootStartedAt], {
          detached: true, stdio: ["ignore", output, output], windowsHide: true,
        });
      } finally { closeSync(output); }
      child.once("error", () => undefined);
      child.unref();
      if (!child.pid) return false;
      const deadline = Date.now() + 15_000;
      while (Date.now() < deadline) {
        const evidence = readGateJobEvidence(logPath, id);
        if (evidence?.state === "held" && evidence.rootPid === rootPid && evidence.rootStartedAt === rootStartedAt) return true;
        if (existsSync(abort)) return false;
        await new Promise(resolve => setTimeout(resolve, 25));
      }
      return false;
    },
    preExecEnv: () => null,
    read() {
      const evidence = readGateJobEvidence(logPath, id);
      if (evidence?.rootPid === rootPid && evidence.rootStartedAt === rootStartedAt && evidence.state === "empty") {
        return { kind: "members", members: [], coverage: "whole-run" };
      }
      if (!evidence || evidence.rootPid !== rootPid || evidence.rootStartedAt !== rootStartedAt) {
        return { kind: "unqueryable", why: "门禁 Job 的独立 supervisor 归属凭据缺失，不能确认整次退出" };
      }
      return probe?.read() ?? { kind: "unqueryable", why: "门禁 Job 尚无终结凭据" };
    },
    killAll() {
      try { writeFileSync(abort, "abort"); return 1; } catch { return -1; }
    },
    dispose() {},
  };
}
