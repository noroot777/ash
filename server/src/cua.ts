import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";

// Codex CUA cleanup findings (verified against an active CUA session on
// 2026-07-27): SkyComputerUseClient `turn-ended` is not a usable cleanup API.
// We called it with the real cliSessionId as `thread_id`, then tried three
// variants (an empty `turn_id`, `codex.app_session_id`, and `threadID`). Every
// call exited 0 while SkyComputerUseService stayed alive and the worker kept
// taking screenshots. The client also silently exits 0 for arbitrary input,
// including invalid JSON and nonexistent threads, so exit 0 is a false signal,
// not an acknowledgement. Do not restore that call chain without new evidence.
//
// What did work: stopTask's normal killChild path killed the agent process;
// SkyComputerUseService then exited on its own, matching its
// `shouldTerminateWhenNoClientsRemain` behavior. Harness therefore only kills
// processes it spawned and relies on the CUA service to notice that its client
// disappeared. This module intentionally contains no automatic cleanup hook.
//
// Still unverified: whether SkyComputerUseService can remain after an agent
// finishes normally instead of being killed. Two attempted control runs never
// activated CUA because Codex chose Orca for screenshots. Do not turn that lack
// of reproduction into a claim that normal completion cannot leave a service.
// Detection and the explicit, user-triggered global kill below remain as the
// truthful fallback for that unknown case.

const CUA_ROOT = join(homedir(), ".codex", "computer-use", "Codex Computer Use.app");
const CUA_SERVICE = join(CUA_ROOT, "Contents", "MacOS", "SkyComputerUseService");
const PS_TIMEOUT_MS = 1500;

export type CuaProcess = {
  pid: number;
  ppid: number;
  command: string;
};

// The legacy "Residual" name is kept for the existing web API shape. A
// detected process is global and cannot be attributed to this scope.
export type CuaResidualStatus = {
  scopeId: string;
  scopeType: "task" | "team";
  checkedAt: string;
  detected: boolean;
  servicePath: string;
  processes: CuaProcess[];
  message: string;
  sideEffect: string;
};

const statusByScope = new Map<string, CuaResidualStatus>();

const sideEffect =
  "SkyComputerUseService 是 ChatGPT.app 的全局 computer-use 服务；当前检测只能确认全局进程存在，不能证明它属于这个团队。harness 自动停止只终止自己启动的 agent 进程树，不会强杀该服务；显式强制清理会影响用户在 ChatGPT 桌面版里的其它 computer-use 会话。";

function key(scopeType: "task" | "team", scopeId: string): string {
  return `${scopeType}:${scopeId}`;
}

function nowIso(): string {
  return new Date().toISOString();
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function execFileText(file: string, args: string[], timeout: number): Promise<{
  ok: boolean;
  stdout: string;
  stderr: string;
  error?: string;
}> {
  return new Promise((resolve) => {
    execFile(file, args, { timeout, maxBuffer: 128 * 1024 }, (err, stdout, stderr) => {
      resolve({
        ok: !err,
        stdout: stdout ?? "",
        stderr: stderr ?? "",
        error: err ? (err instanceof Error ? err.message : String(err)) : undefined,
      });
    });
  });
}

export async function detectCuaProcesses(): Promise<CuaProcess[]> {
  const res = await execFileText("ps", ["-ww", "-axo", "pid=,ppid=,command="], PS_TIMEOUT_MS);
  if (!res.ok) return [];
  const found: CuaProcess[] = [];
  for (const line of res.stdout.split("\n")) {
    const m = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    if (!m) continue;
    const command = m[3].trim();
    if (command === CUA_SERVICE || command.startsWith(`${CUA_SERVICE} `)) {
      found.push({ pid: Number(m[1]), ppid: Number(m[2]), command });
    }
  }
  return found;
}

async function recordStatus(scopeType: "task" | "team", scopeId: string): Promise<CuaResidualStatus> {
  const processes = await detectCuaProcesses();
  const status: CuaResidualStatus = {
    scopeId,
    scopeType,
    checkedAt: nowIso(),
    detected: processes.length > 0,
    servicePath: CUA_SERVICE,
    processes,
    message: processes.length
      ? "检测到 ChatGPT Computer Use 全局服务正在运行；无法从这个全局进程判断它是否由当前团队留下。"
      : "未检测到 ChatGPT Computer Use 全局服务进程。",
    sideEffect,
  };
  statusByScope.set(key(scopeType, scopeId), status);
  if (status.detected) {
    console.warn(
      `[cua] global SkyComputerUseService detected while checking ${scopeType} ${scopeId}; not killing automatically. ${sideEffect}`,
      processes,
    );
  }
  return status;
}

export async function refreshCuaResidualStatus(
  scopeType: "task" | "team",
  scopeId: string,
): Promise<CuaResidualStatus> {
  return recordStatus(scopeType, scopeId);
}

export function lastCuaResidualStatus(scopeType: "task" | "team", scopeId: string): CuaResidualStatus | null {
  return statusByScope.get(key(scopeType, scopeId)) ?? null;
}

export async function forceKillCuaService(scopeType: "task" | "team", scopeId: string): Promise<{
  killed: CuaProcess[];
  before: CuaProcess[];
  after: CuaProcess[];
  status: CuaResidualStatus;
  sideEffect: string;
}> {
  const before = await detectCuaProcesses();
  const killed: CuaProcess[] = [];
  for (const p of before) {
    try {
      process.kill(p.pid, "SIGKILL");
      killed.push(p);
    } catch (err) {
      console.warn(`[cua] failed to SIGKILL SkyComputerUseService pid ${p.pid}:`, err);
    }
  }
  await sleep(300);
  const after = await detectCuaProcesses();
  const status: CuaResidualStatus = {
    scopeId,
    scopeType,
    checkedAt: nowIso(),
    detected: after.length > 0,
    servicePath: CUA_SERVICE,
    processes: after,
    message: after.length
      ? "已尝试强制终止 ChatGPT Computer Use 全局服务，但仍检测到存活进程。"
      : before.length
        ? "已强制终止 ChatGPT Computer Use 全局服务。"
        : "未检测到 ChatGPT Computer Use 全局服务，无需强制清理。",
    sideEffect,
  };
  statusByScope.set(key(scopeType, scopeId), status);
  return { killed, before, after, status, sideEffect };
}
