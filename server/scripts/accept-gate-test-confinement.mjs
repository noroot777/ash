import { registerHooks } from "node:module";

const platform = new URL("../src/platform.ts", import.meta.url).href;
registerHooks({
  load(url, context, nextLoad) {
    if (!/\/src\/accept-gate-confinement\.(ts|js)$/.test(url)) return nextLoad(url, context);
    return { format: "module", shortCircuit: true, source: `
      import { isProcessGroupAlive, inspectProcessSync } from ${JSON.stringify(platform)};
      export const GATE_CONFINEMENT_UNAVAILABLE = "orchestration test fixture";
      export function assertGateConfinementAvailable() {}
      export function gateConfinementUnavailable() { return null; }
      export function gateExecutionNotice() { return null; }
      export async function gateSupervisorBootstrap() { return {}; }
      export function gateScopeNotice() { return null; }
      function fixture(pid) {
        return { id: "orchestration-fixture:" + pid,
          enroll: candidate => candidate === pid,
          preExecEnv: () => null,
          read: () => ({ kind: "members", coverage: "whole-run", members: isProcessGroupAlive(pid)
            ? [{pid, startedAt: inspectProcessSync(pid)?.startedAt ?? null}] : [] }),
          killAll: signal => { try { process.kill(-pid, signal); return true; } catch { return !isProcessGroupAlive(pid); } },
          dispose() {} };
      }
      export function createGateConfinement(_logPath, pid) { return fixture(pid); }
      export function reopenGateConfinement(_logPath, id, pid) {
        return id === "orchestration-fixture:" + pid ? fixture(pid) : null;
      }
    ` };
  },
});
