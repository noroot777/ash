import type { ChildProcess } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import net from "node:net";
import { Writable } from "node:stream";
import type { DetachedPaths } from "./detached-child.js";
import { windowsWrapPaths } from "./detached-win-wrap.js";

export function reopenWindowsControlStdin(
  paths: DetachedPaths, stillOurs: () => boolean,
): ChildProcess["stdin"] {
  const wrap = windowsWrapPaths(paths);
  if (existsSync(wrap.state)) {
    const state = JSON.parse(readFileSync(wrap.state, "utf8"));
    if (state.supported === false) return null;
  } else if (!existsSync(wrap.pipeMarker)) return null;

  let socket: net.Socket | null = null;
  let timer: NodeJS.Timeout | null = null;
  let pendingWrite: ((error?: Error | null) => void) | null = null;
  const writer = new Writable({
    write(chunk, encoding, callback) {
      const finish = (error?: Error | null) => {
        if (pendingWrite !== finish) return;
        pendingWrite = null;
        callback(error);
      };
      pendingWrite = finish;
      const deadline = Date.now() + 30_000;
      const connect = () => {
        timer = null;
        if (writer.destroyed) return finish(new Error("输入连接已关闭"));
        if (socket && !socket.destroyed) return socket.write(chunk, encoding, finish);
        if (!stillOurs()) return finish(new Error("原执行进程已经退出或换代"));
        try {
          if (existsSync(wrap.state)) {
            const state = JSON.parse(readFileSync(wrap.state, "utf8"));
            if (state.status === "failed" || state.status === "closed") {
              return finish(new Error(state.error || `输入管道已${state.status}`));
            }
          }
        } catch (error) { return finish(error as Error); }
        const connection = net.connect(wrap.pipeName);
        socket = connection;
        const retry = (error: Error) => {
          connection.destroy();
          socket = null;
          if (writer.destroyed) return finish(new Error("输入连接已关闭"));
          if (Date.now() >= deadline) return finish(new Error(`输入管道连接超时: ${error.message}`));
          timer = setTimeout(connect, 100);
        };
        connection.once("error", retry);
        connection.once("connect", () => {
          connection.removeListener("error", retry);
          connection.on("error", (error) => writer.destroy(error));
          connection.write(chunk, encoding, finish);
        });
      };
      connect();
    },
    final(callback) { socket?.end(); callback(); },
    destroy(error, callback) {
      if (timer) clearTimeout(timer);
      socket?.destroy();
      pendingWrite?.(error ?? new Error("输入连接已关闭"));
      callback(error);
    },
  });
  writer.on("error", () => {});
  return writer;
}
