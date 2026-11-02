/**
 * 端口兜底那一档的**共享夹具**:真守护进程、真端口、真停止。
 *
 * 单独成文件只因为单文件 700 行的上限 —— 用例按「谁动手」分了两家(默认停止那条路在
 * test-service-ports.ts,用户自己写停止命令那条路在 test-service-ports-script.ts),
 * 两边要的现场完全一样:一个双 fork + setsid + stdio 重定向的服务,外加一个同组的工人。
 *
 * 每个测试文件是**独立进程**,所以这里的临时目录、`strays`、会话管理器各自一份,互不打扰。
 */
import { readFileSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SERVICE_COMMAND_ID } from "@ash/shared/project-commands";
import { listeningPids } from "../src/service-ports.js";
import { terminalSessions } from "../src/terminal.js";
import type { RunnableCommand } from "../src/terminal-commands.js";

export const cwd = realpathSync(mkdtempSync(join(tmpdir(), "ash-ports-")));
export const outside = realpathSync(mkdtempSync(join(tmpdir(), "ash-outside-")));
/** 整场跑完都要确认没留下任何活口。 */
export const strays = new Set<number>();

/** 一个只管听端口、把自己 pid 写进文件的小服务。 */
writeFileSync(join(cwd, "serve.js"), `
const http = require("node:http");
const fs = require("node:fs");
const [port, pidfile, worker, workerPort] = process.argv.slice(2);
// worker:再 fork 一个**同进程组**的工人,但用 env -i 洗掉环境 —— 它是记号断掉的那一类
// (service-ports.ts 顶部写明的已知空洞)。回归要钉住:这种成员宁可停不掉,也不许连坐。
// workerPort 给了的话它**自己也听一个端口**:那样回头核端口时它核不上归属,整次停止落在
// 「没法确认」那一档 —— ⑬ 要的就是这个失败分支。
if (worker) {
  const { spawn } = require("node:child_process");
  const body = workerPort
    ? "const h=require('node:http'),f=require('node:fs');const a=process.argv.slice(1);h.createServer((_,r)=>r.end('w')).listen(Number(a[1]),'127.0.0.1',()=>f.writeFileSync(a[0],String(process.pid)));"
    : "fs=require('node:fs');fs.writeFileSync(process.argv[1],String(process.pid));setInterval(()=>{},1000)";
  const args = workerPort ? [worker, workerPort] : [worker];
  const child = spawn("/usr/bin/env", ["-i", process.argv[0], "-e", body, ...args], { stdio: "ignore" });
  child.unref();
}
http.createServer((_, res) => res.end("ok")).listen(Number(port), "127.0.0.1", () => {
  fs.writeFileSync(pidfile, String(process.pid));
});
`);

/**
 * 一个什么都不打印、也不听端口的常驻进程:detached + stdio ignore,父进程立刻退出。
 * ash 手里**一条线索都没有** —— 进程归属断了、端口也没有。这一类只能靠「配了停止命令 +
 * 上次正常退出又没被停过」认它还开着(openSession 的第四档)。
 */
writeFileSync(join(cwd, "quiet.js"), `
const { spawn } = require("node:child_process");
const [pidfile] = process.argv.slice(2);
const child = spawn(process.argv[0], [
  "-e",
  "const fs=require('node:fs');fs.writeFileSync(process.argv[1],String(process.pid));setInterval(()=>{},1000)",
  pidfile,
], { detached: true, stdio: "ignore" });
child.unref();
`);

/** 没人用的端口:先听一下再让开,拿到号码。 */
export async function freePort(): Promise<number> {
  const net = await import("node:net");
  return await new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.on("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const port = (probe.address() as { port: number }).port;
      probe.close(() => resolve(port));
    });
  });
}

export async function waitFor(label: string, check: () => boolean | Promise<boolean>, ms = 15_000): Promise<void> {
  const deadline = Date.now() + ms;
  for (;;) {
    if (await check()) return;
    if (Date.now() > deadline) throw new Error(`等不到:${label}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

export const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
export const pidIn = (file: string) => Number(readFileSync(file, "utf8").trim());
export const listening = async (port: number) => {
  const found = await listeningPids(port);
  return found.ok ? found.pids : [];
};
/**
 * 账上还活着的号。**返回 null 表示这笔账根本不是 unresolved** —— 跟「号都退了、但那句
 * 「没能确认停净」还得留着」是两回事(第 3 轮审查发现 1:空列表以前被读成「干净」)。
 */
export const leftoversOf = (projectId: string): number[] | null => {
  const stop = serviceSession(projectId)?.stop;
  return stop && stop.kind === "unresolved" ? stop.pids : null;
};

export const serviceSession = (projectId: string) => terminalSessions.listCommandSessions()
  .filter((session) => session.projectId === projectId && session.commandId === SERVICE_COMMAND_ID)
  .sort((a, b) => b.startedAt - a.startedAt)[0] ?? null;

/**
 * 一条守护化的启动脚本:双 fork(detached = setsid)+ stdio 全丢掉,父进程立刻退出,
 * 服务挂到 PID 1 名下 —— 与 kb.sh 的 daemonize() 同形。最后自报端口,那是唯一的线索。
 */
export function daemonScript(
  port: number, pidfile: string, extra: string[] = [], worker?: string, workerPort?: number,
  /** 跑哪个脚本。默认那个只管听端口;要别的形状(比如收到 TERM 才现 fork)就自己写一个传进来。 */
  script = "serve.js",
): string {
  const tail = worker ? [worker, ...(workerPort ? [String(workerPort)] : [])] : [];
  const args = [script, String(port), pidfile, ...tail].map((arg) => `"${arg}"`).join(",");
  return [
    `node -e 'const {spawn}=require("node:child_process");`
    + `const c=spawn(process.argv[1],[${args}],{detached:true,stdio:"ignore"});c.unref();'`
    + ` ${process.execPath}`,
    ...extra,
    `echo "[svc] 已启动 http://127.0.0.1:${port}"`,
  ].join("\n");
}

export const service = (command: string, stopScript: string | null = null): RunnableCommand =>
  ({ id: SERVICE_COMMAND_ID, name: "服务", command, restartCommand: null, stopCommand: stopScript });

/** 整场收尾:停掉会话管理器、杀光活口、删掉临时目录。每个测试文件的 finally 都调它。 */
export function cleanup(): void {
  terminalSessions.shutdown();
  for (const pid of strays) { try { process.kill(pid, "SIGKILL"); } catch { /* 已经走了 */ } }
  rmSync(cwd, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
}
