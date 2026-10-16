// 进程存活判定的单点。**PID 会被复用**,所以「这个 pid 还活着吗」永远不能只
// 问 `kill(pid,0)` —— 那只能证明「有个进程叫这个号」,不能证明还是当初那个。
// 判据是 pid + 进程启动时间(ps 的 lstart)一起对上。
//
// 使用方:
//  · singleton.ts —— 锁文件里那个 pid 还是不是当初拿锁的 server
//  · executors/detached.ts —— 重启后接管时,DB 里记的 agent pid 还是不是那个 agent
//  · 哨兵那一摊(monitor-reclaim-evidence.ts)—— 「这个号上还是不是我们起的那个命令」
//
// 「怎么问操作系统」在 platform.ts,这里只管「问到之后怎么判」。
//
// **判定只有一份,而且只查一次**(`processIdentity`):答案是三档,「问不出来」是独立的一档。
// 折成布尔的那一份(`isSameProcess`)只是它的投影,给只需要是/否的两个老使用方用 ——
// 谁都不许在投影之外再补一次查询,理由见 `processIdentity` 的注释。
import { liveMonitorUnitsSync } from "./monitor-unit-scan.js";
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
 * 「这个 pid 还是当初那个进程吗」的四种答案。**「问不出来」和「无从比对」各占一档**:
 * 它们既不是「是别人」,也不是「它已经退了」。
 *
 * 折成布尔的代价不是理论上的:上一版这里只有 `isSameProcess`,而哨兵那一层在原文不相等时
 * 会**再调它一次**去兼容 locale —— 第一次查成功、第二次查失败(ps 这一刻不可用),返回的
 * false 就被读成确证的「这个号现在是别人」,于是一条还在跑的哨兵被接回判成 `lost`、随后
 * 被回收清扫按债杀掉(第 7 轮审查 F1 实测 `SECOND_QUERY_FAILURE {"answer":"not-ours"}`)。
 *
 * `unverifiable` 是第 9 轮审查 F3 加的那一档:**当初没记启动时刻**。那时这一问退化成
 * 「这个号上现在有进程吗」,它证明得了存在、证明不了**代次** —— pid 会被复用,原命令跑完
 * 之后这个号上的新进程照样满足存在性。老使用方(拿锁、接管 agent)要的本来就是存在性,所以
 * 布尔投影 `isSameProcess` 把这一档照旧算 true;而**跨代回收**(哨兵那一摊)必须把它当
 * 「不知道」——「看见一个进程活着」不等于「已证明有权回收它」(第 9 轮审查 F3)。
 */
export type ProcessIdentity = "same" | "different" | "unverifiable" | "unqueryable";

/**
 * 身份判定的单点:**一次 ps 快照,然后纯比较**。
 *
 * - `expectedStartedAt` 为空 ⇒ 调用方当初没记启动时刻,**这一问比不出代次**(`unverifiable`,
 *   见上面那一档)。查到了就算对上的旧写法在这里被拆开:存在性由调用方自己决定够不够用。
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
  if (!expectedStartedAt) return "unverifiable";
  if (info.startedAt === expectedStartedAt) return "same";
  const expectedMs = parseStartedAt(expectedStartedAt);
  if (expectedMs === null || info.startedAtMs === null) return "unqueryable";
  return info.startedAtMs === expectedMs ? "same" : "different";
}

/**
 * 上面那一份的布尔投影:`same` 和 `unverifiable` 为真,`different` 和 `unqueryable` 为假
 * —— 跟这个函数原来的语义**逐字一致**(查不到按「不是」处理、没记启动时刻就退化成存在性
 * 检查)。使用方是拿锁(singleton)、接管 agent(detached/reattach)、claude 投影探活那几条:
 * 它们问的就是存在性,而且各自的「判不出来」后果都是多做一次恢复,不是**杀一个进程**。
 *
 * **要区分「不是」「问不出来」「无从比对」的调用方必须直接用 `processIdentity`**(哨兵的
 * 跨代回收就是),不要在这个布尔外面自己补第二次查询。
 */
export function isSameProcess(pid: number, expectedStartedAt?: string | null): boolean {
  const verdict = processIdentity(pid, expectedStartedAt);
  return verdict === "same" || verdict === "unverifiable";
}

/**
 * 「**带着这一次创建的记号的进程,现在还有没有**」——归属这一问,一次答完。
 *
 * 问的不是进程组,也不是命令原文,是**这一次创建自己的那条记号**(`MONITOR_UNIT_ENV`,
 * 见 monitor-unit-scan.ts):它随环境被整棵树继承,所以组长退掉之后还留在后台的后代仍然自证
 * 身份;它每次创建新生成,所以认不到别人身上。
 *
 * **但读到这段文字和「真有这一项」是两件事,所以答案分四档**(第 14 轮审查 F1 实测:一个只在
 * 另一个变量的**值**里写了 `ASH_MONITOR_UNIT=<记号>` 的诊断进程被当成我们的后代挨了刀):
 *
 *  · `ours` —— **真实环境项**里就有这一项(只有 Linux 的 `/proc/<pid>/environ` 给得出这份
 *    精确边界),而且它们是谁都已经知道:`members` 带着各自的**代次**(pid + 启动时刻),
 *    那是下刀的落点,也是跨等待不许复用裸 pid 的那道闸;
 *  · `suspected` —— 进程表的**展示文本**里看得见这段文字,但这个平台切不出真实环境项边界
 *    (macOS 的 `ps -E` 把 argv 和环境无分隔地拼在一起,环境各项之间也只有空格)。这一档
 *    **只授权「不许说已经没了」,不授权下刀** —— 文本匹配只有「没有」这一个方向是可靠的;
 *  · `none` —— 这些记号一个都没找到,**而且这一遍是问全了的**(扫描的 `complete`)。真实环境项
 *    必然出现在文本里,所以两个平台上这一档都成立。它仍然不是「整项资源退出已证明」:后代
 *    可以把环境清掉、也可以自己 `setsid` 离开原组,那时它既不带记号也不在组里(第 13 轮审查
 *    F1-B)。够不够收档由上层按**全部线索**判(见 monitor-reclaim-evidence 的 `traceless`),
 *    这里只说记号这一问;
 *  · `unprovable` —— 没有记号(存量行)、这一问自己答不出来(win32 读不到别的进程的环境块、
 *    POSIX 上 ps/`/proc` 失败),**或者这一遍没问全**(有活着的进程判不了:环境读不出来)。
 *    「没问全」时「一个都没有」这句话不成立 —— 不许冒充 `none`。
 *
 * `fresh` = 这次取证要用来发信号 ⇒ 不许复用备忘里的旧快照(第 13 轮审查 F1-C)。
 */
export type UnitMember = {
  pid: number;
  /** 这一刻 ps 报的启动时刻 —— **代次**。发信号之前要拿它再核一遍(见 `killProvenUnit`)。 */
  startedAt: string | null;
};

export type UnitEvidence =
  | { verdict: "ours"; members: UnitMember[] }
  | { verdict: "suspected"; pids: number[] }
  | { verdict: "none" }
  | { verdict: "unprovable" };

export function processUnitEvidence(
  unitToken?: string | null, opts: { fresh?: boolean } = {},
): UnitEvidence {
  const token = unitToken?.trim();
  if (!token) return { verdict: "unprovable" };
  const scan = liveMonitorUnitsSync(opts);
  if (!scan) return { verdict: "unprovable" };    // 问不出来 ≠ 没有
  const pids = scan.marks.get(token) ?? [];
  if (pids.length) {
    // 展示文本那一档**到此为止**:看得见不等于有这一项,所以不往下给落点(见上面 `suspected`)。
    if (scan.grade === "ambiguous") return { verdict: "suspected", pids };
    // 真实环境项这一档才给落点,而且**每个成员连代次一起交出去**:下一刀可能发生在几次 await
    // 之后,那时只认代次没变的那几个(第 14 轮审查 F1:不许给下层一份可跨等待复用的裸 pid)。
    return {
      verdict: "ours",
      members: pids.map((pid) => ({ pid, startedAt: inspectProcess(pid)?.startedAt ?? null })),
    };
  }
  // 找不到:只有**问全了**才敢说「一个都没有」。
  return scan.complete ? { verdict: "none" } : { verdict: "unprovable" };
}

/**
 * 「这个号上的进程,是不是**大约在那一刻**起来的那一个」。
 *
 * 判据跟上面那一份是同一个(一次 ps 快照、纯比较),只是**比对物换成一个时间锚**:调用方
 * 手里只有「我在这一刻 spawn 了它」,还没来得及问 ps 要启动时刻。
 *
 * 用在哨兵创建协议的恢复那一侧(第 9 轮审查 F3):`spawn` 返回 pid 的那一刻先把
 * `{pid, 这一刻}` 同步写到盘上,所以就算 ash 在回填 pid 之前整个没了,重启后仍然能拿这个
 * 锚去认它 —— **而且是真的认代次**,不是退化成「这个号上有人」。
 *
 * `toleranceMs` 的来历:`ps -o lstart` 的精度是秒,spawn 到写盘之间还隔着几毫秒,所以 ±2 秒
 * 是「同一次 spawn」的合理界。超出这个界的只有两种:这个号已经被复用(`different`),或者
 * 根本不是那次 spawn 留下的。
 *
 * **时间邻近单独不足以授权破坏性操作**(第 10 轮审查 F2-C):±2 秒是个窗口,原进程结束、这个
 * 号在窗口内被复用时它照样成立。所以调用方该交什么就交什么 —— `expectCommand` 给了就必须在
 * 这一刻的命令行里原样出现(哨兵的壳是 `sh -lc "<闸><命令原文>"`,命令原文在 argv 里),
 * 对不上一律按 `different` 处理:宁可说「认不回来」,也不拿一个窗口巧合去碰别人的进程。
 */
export function processStartedNear(
  pid: number, anchorMs: number, toleranceMs = 2_000, expectCommand?: string | null,
): { verdict: ProcessIdentity; startedAt: string | null } {
  const info = inspectProcess(pid);
  if (!info || info.startedAtMs === null) return { verdict: "unqueryable", startedAt: null };
  const want = expectCommand?.trim();
  if (want && !(info.command ?? "").includes(want)) return { verdict: "different", startedAt: null };
  // **同一份快照里把启动时刻一起交出去**:认下来的调用方正要把它存成这条记录的代次,
  // 让它再查一次就等于在两份快照之间留一道缝(同一条理由见 `processIdentity` 的注释)。
  return Math.abs(info.startedAtMs - anchorMs) <= toleranceMs
    ? { verdict: "same", startedAt: info.startedAt }
    : { verdict: "different", startedAt: null };
}
