import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Confinement } from "./executors/kernel-confine.js";
import { inspectProcessSync } from "./platform.js";
import { createGateConfinement, reopenGateConfinement } from "./accept-gate-confinement.js";

export type GateLaunch = {
  version: 1;
  phase: "prepared" | "armed" | "stopped";
  pid?: number;
  startedAt?: string | null;
  confinementId?: string | null;
  confinementEnrolled?: boolean;
  stoppedEvidence?: "never-authorized" | "kernel-empty";
};

const confinements = new Map<string, Confinement>();
const launches = new Map<number, string>();
export const gateLaunchPath = (logPath: string): string => `${logPath}.launch.json`;
export const gateAbortPath = (logPath: string): string => `${logPath}.abort`;
export const gateGoPath = (logPath: string): string => `${logPath}.go`;

export function prepareGateLaunch(logPath: string): void {
  mkdirSync(dirname(logPath), { recursive: true });
  writeFileSync(gateLaunchPath(logPath), JSON.stringify({ version: 1, phase: "prepared" }), { flag: "wx" });
}

export function readGateLaunch(logPath: string | undefined): GateLaunch | null {
  if (!logPath) return null;
  try {
    const value = JSON.parse(readFileSync(gateLaunchPath(logPath), "utf8")) as GateLaunch;
    return value.version === 1 && ["prepared", "armed", "stopped"].includes(value.phase) ? value : null;
  } catch { return null; }
}

export function writeGateLaunch(logPath: string, launch: GateLaunch): void {
  const temporary = `${gateLaunchPath(logPath)}.tmp`;
  writeFileSync(temporary, JSON.stringify(launch));
  renameSync(temporary, gateLaunchPath(logPath));
}

export function gateConfinement(logPath: string, launch: GateLaunch): Confinement | null {
  if (!launch.confinementId) return null;
  const confinement = confinements.get(logPath) ?? reopenGateConfinement(logPath, launch.confinementId, launch.pid ?? 0, launch.startedAt ?? null);
  if (confinement) confinements.set(logPath, confinement);
  return confinement;
}

export function registerGateLaunch(logPath: string, pid: number, startedAt: string | null): void {
  launches.set(pid, logPath);
  writeGateLaunch(logPath, { version: 1, phase: "prepared", pid, startedAt });
}

export const gateLaunchOf = (pid: number | null | undefined, logPath?: string): string | undefined =>
  logPath ?? (pid ? launches.get(pid) : undefined);

export function authorizeGateLaunch(logPath: string): boolean {
  const launch = readGateLaunch(logPath);
  if (!launch || launch.phase !== "prepared" || !launch.pid || !launch.startedAt) {
    throw new Error("验收前置命令的启动身份尚未确认，不能放行命令");
  }
  if (existsSync(gateAbortPath(logPath))) return false;
  if (inspectProcessSync(launch.pid)?.startedAt !== launch.startedAt) throw new Error("验收前置命令的启动器身份已变化，不能放行命令");
  const confinement = createGateConfinement(logPath, launch.pid, launch.startedAt);
  if (!confinement) throw new Error("无法建立门禁整次运行的内核围栏，验收前置命令没有启动");
  confinements.set(logPath, confinement);
  launch.confinementId = confinement.id;
  writeGateLaunch(logPath, launch);
  const enrolled = confinement.enroll(launch.pid);
  const reading = enrolled ? confinement.read() : null;
  if (reading?.kind !== "members" || !reading.members.some(member => member.pid === launch.pid)) {
    throw new Error("进程归属尚未确认，验收前置命令没有启动");
  }
  launch.confinementEnrolled = true;
  if (existsSync(gateAbortPath(logPath))) return false;
  if (inspectProcessSync(launch.pid)?.startedAt !== launch.startedAt) throw new Error("门禁启动器已退出，不能放行命令");
  writeGateLaunch(logPath, { ...launch, phase: "armed" });
  writeFileSync(gateGoPath(logPath), "go", { flag: "wx" });
  return true;
}

export function finishGateLaunch(logPath: string, stoppedEvidence: GateLaunch["stoppedEvidence"]): void {
  const launch = readGateLaunch(logPath);
  if (!launch) return;
  writeGateLaunch(logPath, { ...launch, phase: "stopped", stoppedEvidence });
  confinements.get(logPath)?.dispose();
  confinements.delete(logPath);
  if (launch.pid) launches.delete(launch.pid);
}

export const GATE_BOOTSTRAP = String.raw`
const fs = require("node:fs");
const { spawn } = require("node:child_process");
const config = JSON.parse(Buffer.from(process.argv[1], "base64").toString("utf8"));
const deadline = Date.now() + 120000;
const timer = setInterval(() => {
  if (fs.existsSync(config.abort) || Date.now() > deadline) process.exit(125);
  if (!fs.existsSync(config.go)) return;
  clearInterval(timer);
  const child = spawn(config.file, config.args, {
    cwd: config.cwd, stdio: ["ignore", 1, 2], windowsHide: true,
    env: { ...process.env, ...config.restoreEnv },
    windowsVerbatimArguments: config.windowsVerbatimArguments
  });
  child.once("error", error => { console.error(error.message); process.exit(127); });
  child.once("exit", (code, signal) => process.exit(code ?? (signal ? 128 : 127)));
}, 20);
`;
