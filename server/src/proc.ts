// 进程存活判定的单点。**PID 会被复用**,所以「这个 pid 还活着吗」永远不能只
// 问 `kill(pid,0)` —— 那只能证明「有个进程叫这个号」,不能证明还是当初那个。
// 判据是 pid + 进程启动时间(ps 的 lstart)一起对上。
//
// 使用方:
//  · singleton.ts —— 锁文件里那个 pid 还是不是当初拿锁的 server
//  · executors/detached.ts —— 重启后接管时,DB 里记的 agent pid 还是不是那个 agent
//  · 哨兵那一摊(monitor-reclaim-debts.ts)—— 「这个号上还是不是我们起的那个命令」
//
// 「怎么问操作系统」在 platform.ts,这里只管「问到之后怎么判」。
//
// **判定只有一份,而且只查一次**(`processIdentity`):答案是三档,「问不出来」是独立的一档。
// 折成布尔的那一份(`isSameProcess`)只是它的投影,给只需要是/否的两个老使用方用 ——
// 谁都不许在投影之外再补一次查询,理由见 `processIdentity` 的注释。
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
// (那会让 ash 一直等一个永远不会有输出的进程)。
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

/**
 * 「这个 pid 还是当初那个进程吗」的三种答案。**「问不出来」是独立的一档**:它既不是
 * 「是别人」,也不是「它已经退了」。
 *
 * 折成布尔的代价不是理论上的:上一版这里只有 `isSameProcess`,而哨兵那一层在原文不相等时
 * 会**再调它一次**去兼容 locale —— 第一次查成功、第二次查失败(ps 这一刻不可用),返回的
 * false 就被读成确证的「这个号现在是别人」,于是一条还在跑的哨兵被接回判成 `lost`、随后
 * 被回收清扫按债杀掉(第 7 轮审查 F1 实测 `SECOND_QUERY_FAILURE {"answer":"not-ours"}`)。
 */
export type ProcessIdentity = "same" | "different" | "unqueryable";

/**
 * 身份判定的单点:**一次 ps 快照,然后纯比较**。
 *
 * - `expectedStartedAt` 为空 ⇒ 调用方当初没记启动时刻,只能退化成存在性检查(查到就算对上)。
 * - 原文相等 ⇒ 对上。这是绝大多数情况的快路径。
 * - 原文不等 ⇒ **不等于不是同一个**:`ps -o lstart` 跟随 locale,旧 server 可能把
 *   「五 10月/ 16 17:50:16 2026」存进了 DB,而现在是 `LC_ALL=C` 的「Fri Oct 16 17:50:16 2026」。
 *   两边各还原成本机时间戳再比 —— 但**还原用的是同一份快照,不再查第二次**。
 * - 任何一侧还原不出时间戳 ⇒ 这一次**比不出来**(`unqueryable`),不许写成 `different`。
 *
 * ps 的 lstart 精度是秒,所以对得上的判据是精确相等。
 */
export function processIdentity(pid: number, expectedStartedAt?: string | null): ProcessIdentity {
  const info = inspectProcess(pid);
  if (!info) return "unqueryable";
  if (!expectedStartedAt) return "same";
  if (info.startedAt === expectedStartedAt) return "same";
  const expectedMs = parseStartedAt(expectedStartedAt);
  if (expectedMs === null || info.startedAtMs === null) return "unqueryable";
  return info.startedAtMs === expectedMs ? "same" : "different";
}

/**
 * 上面那一份的布尔投影:`same` 为真,`different` 和 `unqueryable` 都为假 —— 跟这个函数
 * 原来的语义逐字一致(查不到一律按「不是」处理,宁可多做一次恢复)。
 *
 * **要区分「不是」和「问不出来」的调用方必须直接用 `processIdentity`**,不要在这个布尔
 * 外面自己补第二次查询。
 */
export function isSameProcess(pid: number, expectedStartedAt?: string | null): boolean {
  return processIdentity(pid, expectedStartedAt) === "same";
}
