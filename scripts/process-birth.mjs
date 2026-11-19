// 一个进程的「出生时刻」:pid 会被复用,pid + 出生时刻才认得出「还是当初那一个」。
// 升级起服务时记下它,退回命令里的 `stop.mjs --pid <n> --born <它>` 动手之前再读一遍比对(stop-pid.mjs)。
// POSIX 用 ps 的 lstart(固定 C locale 才解析得了,精确到秒 —— 同一个进程两次读数严格相等,下一秒出生的就是另一个);
// Windows 用进程表里的 CreationDate(FILETIME,精确到 100ns)。只交出数字(Windows 前面加 w),照抄进哪种 shell 都不用引号。
import { spawnSync } from "node:child_process";
import { IS_WINDOWS, isPidAlive, listProcesses } from "./platform.mjs";

/** 出生时刻;已经不在了返回 "gone";读不出来返回 null(调用方按认不准处理,不当成「对得上」)。 */
export function processBirth(pid) {
  if (!isPidAlive(pid)) return "gone";
  if (IS_WINDOWS) {
    const row = listProcesses().find((r) => r.pid === pid);
    return row?.created && /^\d+$/.test(row.created) ? `w${row.created}` : null;
  }
  const r = spawnSync("ps", ["-p", String(pid), "-o", "lstart="], { encoding: "utf8", env: { ...process.env, LC_ALL: "C", LANG: "C" } });
  const text = (r.stdout ?? "").trim();
  if (r.status === 1 && !text) return "gone";
  const ms = r.status === 0 ? Date.parse(text) : NaN;
  return Number.isFinite(ms) ? String(ms) : null;
}
