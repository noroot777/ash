import { spawn, spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { IPty, IPtyForkOptions } from "node-pty";

export type TerminalProcess = Pick<IPty, "pid" | "onData" | "onExit" | "write" | "resize" | "kill"> & { ptsName?: string };

export function spawnWindowsPty(
  file: string,
  args: string[],
  options: IPtyForkOptions,
  startup: { worker?: URL; timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<TerminalProcess> {
  if (startup.signal?.aborted) return Promise.reject(new Error("Windows 终端启动已取消"));
  const compiled = new URL("./terminal-pty-worker.js", import.meta.url);
  const worker = startup.worker ?? (existsSync(compiled) ? compiled : new URL("./terminal-pty-worker.ts", import.meta.url));
  const child = spawn(process.execPath, [...process.execArgv, fileURLToPath(worker)], {
    windowsHide: true,
    stdio: ["ignore", "ignore", "pipe", "ipc"],
    env: options.env,
  });
  const events = new EventEmitter();
  let stopped = false;
  let exited = false;
  let ready = false;
  let stderr = "";
  let killTimer: ReturnType<typeof setTimeout> | undefined;
  const hardStop = (synchronous = false) => {
    if (exited || (stopped && !synchronous)) return;
    stopped = true;
    if (process.platform === "win32" && child.pid) {
      if (synchronous) {
        const killed = spawnSync("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], {
          windowsHide: true, stdio: "ignore", timeout: 5000,
        });
        if (killed.status !== 0) { try { child.kill("SIGKILL"); } catch {} }
      } else {
        const killer = spawn("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], {
          detached: true, windowsHide: true, stdio: "ignore",
        });
        killer.on("error", () => { try { child.kill("SIGKILL"); } catch {} });
        killer.on("exit", (code) => { if (code !== 0) { try { child.kill("SIGKILL"); } catch {} } });
        killer.unref();
      }
    } else {
      try { child.kill("SIGKILL"); } catch {}
    }
  };
  const onParentExit = () => hardStop(true);
  process.once("exit", onParentExit);
  child.stderr?.on("data", (data: Buffer) => { stderr = (stderr + data.toString()).slice(-4000); });
  const send = (message: object) => {
    if (child.connected) child.send(message, () => {});
  };
  const on = <Payload>(name: string, listener: (value: Payload) => void) => {
    events.on(name, listener);
    return { dispose: () => { events.off(name, listener); } };
  };
  return new Promise((resolve, reject) => {
    let settled = false;
    let failure: Error | undefined;
    const cleanup = () => {
      clearTimeout(timer);
      clearTimeout(killTimer);
      process.off("exit", onParentExit);
      startup.signal?.removeEventListener("abort", onAbort);
    };
    const fail = (message: string, synchronous = false) => {
      if (settled) {
        if (synchronous) hardStop(true);
        return;
      }
      failure ??= new Error(`${message}${stderr ? `: ${stderr.trim()}` : ""}`);
      clearTimeout(timer);
      hardStop(synchronous);
      if (exited || !child.pid) {
        settled = true;
        cleanup();
        reject(failure);
      }
    };
    const onAbort = () => fail("Windows 终端启动已取消", true);
    const timer = setTimeout(() => fail("Windows 终端启动超时，已终止隔离进程；服务仍可用，请检查 node-pty 依赖"), startup.timeoutMs ?? 10_000);
    startup.signal?.addEventListener("abort", onAbort, { once: true });
    child.on("error", (error) => fail(`Windows 终端子进程失败: ${error.message}`));
    child.on("exit", (code) => {
      exited = true;
      cleanup();
      if (!settled) fail(`Windows 终端子进程提前退出(${code ?? "未知"})`);
      if (ready) { ready = false; events.emit("exit", { exitCode: code ?? 1 }); }
    });
    child.on("message", (message: { type?: string; pid?: number; data?: string; exitCode?: number; signal?: number; error?: string }) => {
      if (message.type === "ready" && !settled && !failure) {
        if (!Number.isInteger(message.pid) || message.pid! <= 0) { fail("Windows 终端返回了无效进程身份"); return; }
        settled = true;
        ready = true;
        clearTimeout(timer);
        resolve({
          pid: message.pid!,
          onData: (listener) => on("data", listener),
          onExit: (listener) => on("exit", listener),
          write: (data) => send({ type: "write", data }),
          resize: (cols, rows) => send({ type: "resize", cols, rows }),
          kill: () => {
            if (exited || killTimer) return;
            send({ type: "kill" });
            killTimer = setTimeout(hardStop, 2000);
          },
        });
      } else if (message.type === "data" && typeof message.data === "string") {
        events.emit("data", message.data);
      } else if (message.type === "exit" && ready) {
        ready = false;
        events.emit("exit", { exitCode: message.exitCode ?? 1, signal: message.signal });
      } else if (message.type === "error") {
        fail(message.error ?? "Windows 终端启动失败");
      }
    });
    send({ type: "start", file, args, options });
  });
}
