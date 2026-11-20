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

async function idle(target, runtime, say) {
  const impact = await queryImpact(target.port, lockFileFor(runtime, { NAVI_DATA_DIR: target.dataDir }), { requireOk: true });
  const why = noVerdictReason(impact);
  if (why || taskGroups.some((group) => !Array.isArray(impact[group]))) {
    say(`  · 服务 ${target.pid} 的任务状态无法确认${why ? `（${why}）` : ""}，没有停止。`);
    return false;
  }
  const tasks = taskGroups.flatMap((group) => impact[group]);
  if (!tasks.length) return true;
  say(`  · 服务 ${target.pid} 还有 ${tasks.length} 个运行或排队中的任务，没有停止。`);
  return false;
}

export async function stopIdleServers(bundle, { say = console.log, timeoutMs = 20_000 } = {}) {
  const runtime = realPath(join(bundle, "Contents/Resources/app"));
  if (!runtime) return;
  const users = execFileSync("/bin/bash", [join(here, "bundle-users.sh"), bundle], { encoding: "utf8" });
  const pids = [...new Set(users.split("\n").map((line) => Number(line.match(/^(\d+) /)?.[1]))
    .filter((pid) => Number.isInteger(pid) && pid > 1 && pid !== process.pid))];
  for (const pid of pids) {
    const born = processBirth(pid);
    if (!born || born === "gone") continue;
    let target;
    for (const port of listeningPorts(pid)) {
      target = await targetAt(port, pid, runtime);
      if (target) break;
    }
    if (!target || !(await idle(target, runtime, say))) continue;
    const current = await targetAt(target.port, pid, runtime);
    if (!current || current.dataDir !== target.dataDir || current.instance !== target.instance
      || !(await idle(current, runtime, say)) || processBirth(pid) !== born) continue;
    say(`  ▶ 停止空闲的 Navi 服务（${pid}）…`);
    try { process.kill(pid, "SIGTERM"); }
    catch (error) { if (error.code !== "ESRCH") throw error; }
    const deadline = Date.now() + timeoutMs;
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
