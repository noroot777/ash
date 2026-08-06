// 进程存活判定的单点。**PID 会被复用**,所以「这个 pid 还活着吗」永远不能只
// 问 `kill(pid,0)` —— 那只能证明「有个进程叫这个号」,不能证明还是当初那个。
// 判据是 pid + 进程启动时间(ps 的 lstart)一起对上。
//
// 两个使用方:
//  · singleton.ts —— 锁文件里那个 pid 还是不是当初拿锁的 server
//  · executors/detached.ts —— 重启后接管时,DB 里记的 agent pid 还是不是那个 agent
import { execFileSync } from "node:child_process";

export type ProcessInfo = {
  pid: number;
  startedAt: string | null;
  startedAtMs: number | null;
  command: string | null;
};

// ps 一次拿到启动时间和完整命令行。查不到(进程没了 / ps 不可用)一律 null,
// 调用方按「不存在」处理 —— 宁可误判成死了(最多多做一次恢复),不能误判成活着
// (那会让 harness 一直等一个永远不会有输出的进程)。
export function inspectProcess(pid: number): ProcessInfo | null {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  try {
    const out = execFileSync("ps", ["-p", String(pid), "-o", "lstart=", "-o", "command=", "-ww"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    if (!out) return null;
    const m = /^(.{24})\s+(.*)$/.exec(out);
    const startedAt = m ? m[1]!.trim() : null;
    const parsed = startedAt ? Date.parse(startedAt) : Number.NaN;
    return {
      pid,
      startedAt,
      startedAtMs: Number.isNaN(parsed) ? null : parsed,
      command: m ? m[2]!.trim() : out,
    };
  } catch {
    return null;
  }
}

// 「这个 pid 还是当初那个进程吗」。expectedStartedAt 为空时退化成单纯的存在性
// 检查(调用方没记启动时间就只能这样),记了就必须对上 —— ps 的 lstart 精度是秒,
// 所以用字符串相等而不是数值近似。
export function isSameProcess(pid: number, expectedStartedAt?: string | null): boolean {
  const info = inspectProcess(pid);
  if (!info) return false;
  if (!expectedStartedAt) return true;
  return info.startedAt === expectedStartedAt;
}
