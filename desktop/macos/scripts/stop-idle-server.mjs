import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isPidAlive, localGet, sleep } from "../../../scripts/platform.mjs";
import { processBirth } from "../../../scripts/process-birth.mjs";
import { lockFileFor, noVerdictReason, queryImpact } from "../../../scripts/server-control.mjs";

const here = fileURLToPath(new URL(".", import.meta.url));
const taskGroups = ["survives", "resumes", "interrupted"];

function realPath(path) {
  try { return typeof path === "string" && isAbsolute(path) ? realpathSync(path) : null; }
  catch { return null; }
}

function listeningPorts(pid) {
  try {
    const output = execFileSync("lsof", ["-nP", "-w", "-a", "-p", String(pid), "-iTCP", "-sTCP:LISTEN", "-F", "n"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    return [...new Set(output.split("\n").filter((line) => line.startsWith("n"))
      .map((line) => Number(line.match(/:(\d+)$/)?.[1])).filter((port) => port > 0 && port <= 65535))];
  } catch { return []; }
}

async function targetAt(port, pid, runtime) {
  const response = await localGet(port, "/api/health", 2000);
  const health = response.json;
  if (response.status !== 200 || health?.ok !== true || health.pid !== pid
    || realPath(health.instance?.codeDir) !== runtime) return null;
  const dataDir = realPath(health.instance?.dataDir);
  if (!dataDir) return null;
  return { port, pid, dataDir, instance: health.instance.id };
}

function descendants(pid) {
  const output = execFileSync("/bin/ps", ["-axo", "pid=,ppid=,stat="], { encoding: "utf8" });
  const rows = output.trim().split("\n").map((line) => {
    const match = line.trim().match(/^(\d+)\s+(\d+)\s+(\S+)$/);
    if (!match) throw new Error("无法确认服务的子进程状态，没有停止服务。");
    return { pid: Number(match[1]), parent: Number(match[2]), state: match[3] };
  });
  if (!rows.some((row) => row.pid === pid)) throw new Error(`服务 ${pid} 的进程身份发生变化，没有停止服务。`);
  const family = new Set([pid]);
  for (let size = 0; size !== family.size;) {
    size = family.size;
    for (const row of rows) if (family.has(row.parent)) family.add(row.pid);
  }
  return rows.filter((row) => row.pid !== pid && family.has(row.pid) && !row.state.startsWith("Z"));
}

function noDependentProcesses(pid, say) {
  const children = descendants(pid);
  if (!children.length) return true;
  say(children.some((child) => child.pid === process.pid)
    ? `  · 安装器运行在服务 ${pid} 的终端进程树中，请在 Navi 之外的终端里安装；未停止任何服务。`
    : `  · 服务 ${pid} 还有 ${children.length} 个存活后代（可能是终端或项目进程），未停止任何服务。`);
  return false;
}

async function idle(target, runtime, say) {
  const impact = await queryImpact(target.port, lockFileFor(runtime, { NAVI_DATA_DIR: target.dataDir }), { requireOk: true });
  const why = noVerdictReason(impact);
  if (why || taskGroups.some((group) => !Array.isArray(impact[group]))) {
    say(`  · 服务 ${target.pid} 的任务状态无法确认${why ? `（${why}）` : ""}，没有停止。`);
    return false;
  }
  const tasks = taskGroups.flatMap((group) => impact[group]);
  if (!tasks.length) return noDependentProcesses(target.pid, say);
  say(`  · 服务 ${target.pid} 还有 ${tasks.length} 个运行或排队中的任务，没有停止。`);
  return false;
}

export async function stopIdleServers(bundle, { say = console.log, timeoutMs = 20_000 } = {}) {
  const runtime = realPath(join(bundle, "Contents/Resources/app"));
  if (!runtime) return;
  const users = () => {
    const output = execFileSync("/bin/bash", [join(here, "bundle-users.sh"), bundle], { encoding: "utf8" });
    return [...new Set(output.split("\n").map((line) => Number(line.match(/^(\d+) /)?.[1]))
      .filter((pid) => Number.isInteger(pid) && pid > 1 && pid !== process.pid))];
  };
  const candidates = [];
  let blocked = false;
  for (const pid of users()) {
    const born = processBirth(pid);
    if (born === "gone") continue;
    let target;
    for (const port of listeningPorts(pid)) {
      target = await targetAt(port, pid, runtime);
      if (target) break;
    }
    if (!born || !target) {
      say(`  · 无法确认占用进程 ${pid} 是可安全停止的 Navi 服务，未停止任何服务。`);
      blocked = true;
    } else if (!(await idle(target, runtime, say))) blocked = true;
    else candidates.push({ ...target, born });
  }
  if (blocked) return;
  for (const target of candidates) {
    const { pid, born } = target;
    const current = await targetAt(target.port, pid, runtime);
    if (!current || current.dataDir !== target.dataDir || current.instance !== target.instance
      || !(await idle(current, runtime, say)) || processBirth(pid) !== born) {
      say(`  · 服务 ${pid} 的状态发生变化，未停止任何服务。`);
      return;
    }
  }
  const allowed = new Set(candidates.map((target) => target.pid));
  if (users().some((pid) => !allowed.has(pid)) || candidates.some(({ pid, born }) => processBirth(pid) !== born)) {
    say("  · 占用进程发生变化，未停止任何服务。");
    return;
  }
  if (candidates.some(({ pid }) => !noDependentProcesses(pid, say))) return;
  for (const { pid } of candidates) {
    say(`  ▶ 停止空闲的 Navi 服务（${pid}）…`);
    try { process.kill(pid, "SIGTERM"); }
    catch (error) { if (error.code !== "ESRCH") throw error; }
  }
  const deadline = Date.now() + timeoutMs;
  for (const { pid } of candidates) {
    while (isPidAlive(pid) && Date.now() < deadline) await sleep(100);
    if (isPidAlive(pid)) throw new Error(`服务 ${pid} 没有在 ${timeoutMs / 1000} 秒内退出，没有安装，也没有强杀。`);
    say(`  ✓ 空闲服务 ${pid} 已退出`);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (!process.argv[2]) throw new Error("缺少待替换的 Navi.app 路径");
    await stopIdleServers(resolve(process.argv[2]));
  } catch (error) {
    console.error(`✕ 没有安装：${error.message}`);
    process.exitCode = 1;
  }
}
