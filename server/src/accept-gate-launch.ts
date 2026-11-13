import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { inspectProcessSync } from "./platform.js";
import { createGateConfinement, reopenGateConfinement, type GateConfinement } from "./accept-gate-confinement.js";

export type GateLaunch = {
  version: 1;
  phase: "prepared" | "armed" | "stopped";
  pid?: number;
  startedAt?: string | null;
  confinementId?: string | null;
  confinementEnrolled?: boolean;
  stoppedEvidence?: "never-authorized" | "kernel-empty" | "observed-empty";
  /** 启动器起来的墙上时间。跨重启接管时从它折算已经跑掉多久（时限从这一刻算）。 */
  launchedAt?: string;
};

const confinements = new Map<string, GateConfinement>();
const launches = new Map<number, string>();
export const gateLaunchPath = (logPath: string): string => `${logPath}.launch.json`;
export const gateAbortPath = (logPath: string): string => `${logPath}.abort`;
export const gateGoPath = (logPath: string): string => `${logPath}.go`;
/** 启动器替命令留下的退出结果（读口和可信条件在 accept-gate-exit.ts）。 */
export const gateExitPath = (logPath: string): string => `${logPath}.exit.json`;

export function prepareGateLaunch(logPath: string): void {
  mkdirSync(dirname(logPath), { recursive: true });
  // 同一路径上一次留下的退出档绝不能被这一次认领：它会把一次没跑完的运行结算成那一次的结果。
  rmSync(gateExitPath(logPath), { force: true });
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

export function gateConfinement(logPath: string, launch: GateLaunch): GateConfinement | null {
  if (!launch.confinementId) return null;
  const confinement = confinements.get(logPath) ?? reopenGateConfinement(logPath, launch.confinementId, launch.pid ?? 0, launch.startedAt ?? null);
  if (confinement) confinements.set(logPath, confinement);
  return confinement;
}

export function migrateGateLaunch(logPath: string, launch: GateLaunch): GateLaunch {
  if (launch.phase !== "armed" || launch.confinementEnrolled !== undefined || !launch.confinementId) return launch;
  const reading = gateConfinement(logPath, launch)?.read();
  if (reading?.kind !== "members") return launch;
  const migrated = { ...launch, confinementEnrolled: true };
  writeGateLaunch(logPath, migrated);
  return migrated;
}

export function registerGateLaunch(logPath: string, pid: number, startedAt: string | null): void {
  launches.set(pid, logPath);
  writeGateLaunch(logPath, { version: 1, phase: "prepared", pid, startedAt, launchedAt: new Date().toISOString() });
}

export const gateLaunchOf = (pid: number | null | undefined, logPath?: string): string | undefined =>
  logPath ?? (pid ? launches.get(pid) : undefined);

export async function authorizeGateLaunch(logPath: string): Promise<boolean> {
  const launch = readGateLaunch(logPath);
  if (!launch || launch.phase !== "prepared" || !launch.pid || !launch.startedAt) {
    throw new Error("验收前置命令的启动身份尚未确认，不能放行命令");
  }
  if (existsSync(gateAbortPath(logPath))) return false;
  if (inspectProcessSync(launch.pid)?.startedAt !== launch.startedAt) throw new Error("验收前置命令的启动器身份已变化，不能放行命令");
  const confinement = createGateConfinement(logPath, launch.pid, launch.startedAt);
  if (!confinement) throw new Error("无法建立验收前置命令的进程监督，命令没有启动");
  confinements.set(logPath, confinement);
  launch.confinementId = confinement.id;
  writeGateLaunch(logPath, launch);
  const enrolled = await confinement.enroll(launch.pid);
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
  abandonGateSupervision(logPath);
}

export function abandonGateSupervision(logPath: string): void {
  confinements.get(logPath)?.dispose();
  confinements.delete(logPath);
  const launch = readGateLaunch(logPath);
  if (launch?.pid) launches.delete(launch.pid);
}

export const GATE_BOOTSTRAP = String.raw`
const fs = require("node:fs");
const { spawn } = require("node:child_process");
const config = JSON.parse(Buffer.from(process.argv[1], "base64").toString("utf8"));
if (config.macGuard) {
  const guard = spawn(config.macGuard, ["guard", String(process.pid), config.go], { stdio: "ignore" });
  guard.once("error", error => { console.error(error.message); process.exit(125); });
  if (guard.pid) fs.writeFileSync(config.macGuardFile, String(guard.pid));
  guard.unref();
}
const deadline = Date.now() + 120000;
const timer = setInterval(() => {
  if (fs.existsSync(config.abort) || Date.now() > deadline) process.exit(125);
  if (!fs.existsSync(config.go)) return;
  clearInterval(timer);
  run(config.prepare ? "prepare" : "command");
}, 20);
// 配了准备命令就先跑它（同一个 cwd、同一份环境、同一棵受监督的进程树），rc=0 才接着起前置命令；
// 中间 ash 要停它（abort）就不再起下一段。退出档记下停在哪一段：「准备没过」和「测试红了」是两件事。
function run(phase) {
  const launch = phase === "prepare" ? config.prepare : config;
  const child = spawn(launch.file, launch.args, {
    cwd: config.cwd, stdio: ["ignore", 1, 2], windowsHide: true,
    env: { ...process.env, ...config.restoreEnv },
    windowsVerbatimArguments: launch.windowsVerbatimArguments
  });
  child.once("error", error => { console.error(error.message); finish(127, null, phase); });
  child.once("exit", (code, signal) => {
    const rc = code ?? (signal ? 128 : 127);
    if (phase !== "prepare" || rc !== 0) return finish(rc, signal, phase);
    if (fs.existsSync(config.abort)) return finish(125, null, phase);
    fs.writeSync(1, config.prepared);
    run("command");
  });
}
// 退出码除了转发给起我的那个 ash，还要**先落盘**：那个 ash 可能已经重启了，新实例只能从这里
// 认领结果。tmp+rename 保证要么整份、要么没有；写不进去也照常转发，不拿落盘失败改写结论。
// elapsedMs 是本进程起来到现在的单调用时：时限按它判，跟 ash 在不在场、墙上时间有没有被校正都无关。
function finish(code, childSignal, phase) {
  if (config.exit) try {
    const temporary = config.exit + "." + process.pid + ".tmp";
    const fd = fs.openSync(temporary, "w");
    fs.writeSync(fd, JSON.stringify({ version: 1, pid: process.pid, code, childSignal: childSignal || null, phase,
      elapsedMs: Math.round(performance.now()), finishedAt: new Date().toISOString() }));
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fs.renameSync(temporary, config.exit);
  } catch {}
  process.exit(code);
}
`;
