// 可引导单飞回合的 stdin 具名管道（POSIX）：`<rc>.stdin.fifo`。它的寿命跟着这一轮的根 shell
// 走 —— server 只在根还活着时重开它（spawn 当场、重启后 reattach），根一走这个路径就再没人用。
//
// 只靠 shell 自己的 `trap … EXIT` 删不干净：回合收台、停止、清理都是给整个进程组发信号，
// SIGKILL 下 trap 根本不跑，于是每轮留一根，攒在 data/runs 里，连带着让按文件复制 data/ 的
// 地方（mac 版的导入）碰上就失败。所以 server 这一侧自己收：根退出时收一次，启动时
// （run-logs-gc）再扫一遍上一辈子没来得及收的。
//
// **判据是「有没有人开着它」，由内核答**：以 O_WRONLY|O_NONBLOCK 打开一个没有读端的 FIFO，
// 内核回 ENXIO。这条路上的持有者全都带读端 —— 根 shell 的 `3<>`、CLI 从它 dup 来的 stdin、
// server 的 writer（`r+`）—— 所以 ENXIO = 一个持有者都没有。根被单独杀了而 CLI 还活着的
// 那种也照样答「有人」。探测本身只开不写，关掉它也不会给读端送 EOF（读端自己就占着写端）。
// 其余任何答复（打开成功、别的错误、路径上不是 FIFO）一律留着。
import { closeSync, constants, lstatSync, openSync, unlinkSync } from "node:fs";
import { IS_WINDOWS } from "../platform.js";

export const CONTROL_FIFO_SUFFIX = ".agent-rc.stdin.fifo";

export const controlFifoPath = (rc: string) => `${rc}.stdin.fifo`;

export type FifoSweep = "removed" | "busy" | "absent" | "unknown";

/** 没人开着才删。拿不准（不是 FIFO、探测答不上来）就留着。 */
export function removeIdleControlFifo(path: string): FifoSweep {
  if (IS_WINDOWS) return "unknown";
  try {
    if (!lstatSync(path).isFIFO()) return "unknown";
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "ENOENT" ? "absent" : "unknown";
  }
  let fd: number;
  try {
    fd = openSync(path, constants.O_WRONLY | constants.O_NONBLOCK);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENXIO") return "unknown";
    try {
      unlinkSync(path);
      return "removed";
    } catch (e) {
      return (e as NodeJS.ErrnoException).code === "ENOENT" ? "absent" : "unknown";
    }
  }
  closeSync(fd);
  return "busy";
}

/**
 * 根 shell 已经退出：先把 server 自己这一端关掉（它也算一个持有者），关完再按上面的判据收。
 * 还有别人开着（CLI 甩出去的后代还攥着 stdin）就留给下次启动的那一扫。
 */
export function retireControlFifo(path: string, writer: NodeJS.WritableStream | null | undefined): void {
  const stream = writer as (NodeJS.WritableStream & { closed?: boolean; destroy?: () => void }) | null | undefined;
  if (!stream || stream.closed || typeof stream.destroy !== "function") {
    removeIdleControlFifo(path);
    return;
  }
  stream.once("close", () => removeIdleControlFifo(path));
  stream.destroy();
}
