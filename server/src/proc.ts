// 进程存活判定的单点。**PID 会被复用**,所以「这个 pid 还活着吗」永远不能只
// 问 `kill(pid,0)` —— 那只能证明「有个进程叫这个号」,不能证明还是当初那个。
// 判据是 pid + 进程启动时间(ps 的 lstart)一起对上。
//
// 两个使用方:
//  · singleton.ts —— 锁文件里那个 pid 还是不是当初拿锁的 server
//  · executors/detached.ts —— 重启后接管时,DB 里记的 agent pid 还是不是那个 agent
//
// 「怎么问操作系统」在 platform.ts,这里只管「问到之后怎么判」。
import { inspectProcessSync } from "./platform.js";

export type ProcessInfo = {
  pid: number;
  startedAt: string | null;
  startedAtMs: number | null;
  command: string | null;
};

// `ps -o lstart` 跟随 locale。旧 server 可能把「六  8月/ 8 11:11:17 2026」存进 DB，
// 新 server 若以 LC_ALL=C 启动会读到「Sat Aug  8 11:11:17 2026」；字符串不等但其实
// 是同一秒。先认标准 Date.parse，再兼容 macOS 中文 lstart，供已有 session 平滑接回。
function parseStartedAt(raw: string): number | null {
  const standard = Date.parse(raw);
  if (!Number.isNaN(standard)) return standard;
  const zh = /^\S+\s+(\d{1,2})月\/?\s*(\d{1,2})\s+(\d{2}):(\d{2}):(\d{2})\s+(\d{4})$/.exec(raw);
  if (!zh) return null;
  const [, month, day, hour, minute, second, year] = zh.map(Number);
  return new Date(year!, month! - 1, day!, hour!, minute!, second!).getTime();
}

// ps 一次拿到启动时间和完整命令行。查不到(进程没了 / ps 不可用)一律 null,
// 调用方按「不存在」处理 —— 宁可误判成死了(最多多做一次恢复),不能误判成活着
// (那会让 harness 一直等一个永远不会有输出的进程)。
export function inspectProcess(pid: number): ProcessInfo | null {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  const raw = inspectProcessSync(pid);
  if (!raw) return null;
  return {
    pid,
    startedAt: raw.startedAt,
    startedAtMs: raw.startedAt ? parseStartedAt(raw.startedAt) : null,
    command: raw.command,
  };
}

// 「这个 pid 还是当初那个进程吗」。expectedStartedAt 为空时退化成单纯的存在性
// 检查(调用方没记启动时间就只能这样),记了就必须对上。先走原文快路径；locale 不同
// 时把两边都还原到本机时间戳比较。ps 的 lstart 精度是秒，所以必须精确相等。
export function isSameProcess(pid: number, expectedStartedAt?: string | null): boolean {
  const info = inspectProcess(pid);
  if (!info) return false;
  if (!expectedStartedAt) return true;
  if (info.startedAt === expectedStartedAt) return true;
  const expectedMs = parseStartedAt(expectedStartedAt);
  return expectedMs !== null && info.startedAtMs !== null && info.startedAtMs === expectedMs;
}
