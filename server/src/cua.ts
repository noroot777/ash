import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { eq, inArray, or } from "drizzle-orm";
import { db } from "./db/index.js";
import { sessions, tasks } from "./db/schema.js";

const CUA_ROOT = join(homedir(), ".codex", "computer-use", "Codex Computer Use.app");
const CUA_CLIENT = join(
  CUA_ROOT,
  "Contents",
  "SharedSupport",
  "SkyComputerUseClient.app",
  "Contents",
  "MacOS",
  "SkyComputerUseClient",
);
const CUA_SERVICE = join(CUA_ROOT, "Contents", "MacOS", "SkyComputerUseService");
const TURN_ENDED_TIMEOUT_MS = 2500;

export type CuaProcess = {
  pid: number;
  ppid: number;
  command: string;
};

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

export type CuaTurnEndedResult = {
  threadId: string;
  ok: boolean;
  skipped?: boolean;
  error?: string;
  stdout?: string;
  stderr?: string;
};

const residualByScope = new Map<string, CuaResidualStatus>();

const sideEffect =
  "SkyComputerUseService 是 ChatGPT.app 的全局 computer-use 服务；harness 自动流程不会终止它。显式强制清理会影响用户在 ChatGPT 桌面版里的其它 computer-use 会话。";

function key(scopeType: "task" | "team", scopeId: string): string {
  return `${scopeType}:${scopeId}`;
}

function nowIso(): string {
  return new Date().toISOString();
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function execFileText(file: string, args: string[], timeout = TURN_ENDED_TIMEOUT_MS): Promise<{
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

async function taskIdsForTeam(teamTaskId: string): Promise<string[]> {
  const rows = await db
    .select({ id: tasks.id })
    .from(tasks)
    .where(or(eq(tasks.id, teamTaskId), eq(tasks.parentId, teamTaskId)));
  return rows.map((r) => r.id);
}

async function codexThreadIdsForTasks(taskIds: string[]): Promise<string[]> {
  if (!taskIds.length) return [];
  const rows = await db
    .select({ threadId: sessions.cliSessionId, agentType: sessions.agentType })
    .from(sessions)
    .where(inArray(sessions.taskId, taskIds));
  return [
    ...new Set(
      rows
        .filter((s) => s.agentType === "codex")
        .map((s) => s.threadId?.trim())
        .filter((id): id is string => !!id),
    ),
  ];
}

async function notifyCodexTurnsEnded(threadIds: string[]): Promise<CuaTurnEndedResult[]> {
  const unique = [...new Set(threadIds.filter(Boolean))];
  if (!existsSync(CUA_CLIENT)) {
    return unique.map((threadId) => ({
      threadId,
      ok: false,
      skipped: true,
      error: `missing CUA client: ${CUA_CLIENT}`,
    }));
  }
  return Promise.all(
    unique.map(async (threadId) => {
      const payload = JSON.stringify({ thread_id: threadId });
      const res = await execFileText(CUA_CLIENT, ["turn-ended", payload]);
      return { threadId, ...res };
    }),
  );
}

async function detectCuaProcesses(): Promise<CuaProcess[]> {
  const res = await execFileText("ps", ["-ww", "-axo", "pid=,ppid=,command="], 1500);
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

async function recordResidual(scopeType: "task" | "team", scopeId: string): Promise<CuaResidualStatus> {
  const processes = await detectCuaProcesses();
  const status: CuaResidualStatus = {
    scopeId,
    scopeType,
    checkedAt: nowIso(),
    detected: processes.length > 0,
    servicePath: CUA_SERVICE,
    processes,
    message: processes.length
      ? "检测到 ChatGPT Computer Use 全局服务仍在运行；harness 不会在自动停止流程中终止它。"
      : "未检测到 ChatGPT Computer Use 全局服务残留。",
    sideEffect,
  };
  residualByScope.set(key(scopeType, scopeId), status);
  if (status.detected) {
    console.warn(
      `[cua] residual SkyComputerUseService after ${scopeType} ${scopeId}; not killing automatically. ${sideEffect}`,
      processes,
    );
  }
  return status;
}

async function cleanupScope(scopeType: "task" | "team", scopeId: string, threadIds: string[]): Promise<void> {
  try {
    const results = await notifyCodexTurnsEnded(threadIds);
    for (const r of results) {
      if (!r.ok) {
        console.warn(`[cua] turn-ended best-effort failed for thread ${r.threadId}: ${r.error ?? "unknown error"}`);
      }
    }
  } catch (err) {
    console.warn(`[cua] turn-ended best-effort failed for ${scopeType} ${scopeId}:`, err);
  }
  await sleep(300);
  try {
    await recordResidual(scopeType, scopeId);
  } catch (err) {
    console.warn(`[cua] residual detection failed for ${scopeType} ${scopeId}:`, err);
  }
}

export function cleanupTaskCuaSessionsSoon(taskId: string): void {
  void (async () => {
    const threadIds = await codexThreadIdsForTasks([taskId]);
    await cleanupScope("task", taskId, threadIds);
  })().catch((err) => console.warn(`[cua] task cleanup failed for ${taskId}:`, err));
}

export function cleanupTeamCuaSessionsSoon(teamTaskId: string): void {
  void (async () => {
    const taskIds = await taskIdsForTeam(teamTaskId);
    const threadIds = await codexThreadIdsForTasks(taskIds);
    await cleanupScope("team", teamTaskId, threadIds);
  })().catch((err) => console.warn(`[cua] team cleanup failed for ${teamTaskId}:`, err));
}

export async function refreshCuaResidualStatus(
  scopeType: "task" | "team",
  scopeId: string,
): Promise<CuaResidualStatus> {
  return recordResidual(scopeType, scopeId);
}

export function lastCuaResidualStatus(scopeType: "task" | "team", scopeId: string): CuaResidualStatus | null {
  return residualByScope.get(key(scopeType, scopeId)) ?? null;
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
  residualByScope.set(key(scopeType, scopeId), status);
  return { killed, before, after, status, sideEffect };
}
