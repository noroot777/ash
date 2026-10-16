// 哨兵的**进程**这一层：怎么把一条用户命令起成「ash 死了它也还活着」的长跑进程，
// 以及怎么跟着它的输出文件按行往下读。编排（什么时候推、推给谁、什么时候停）在
// monitors.ts，这里一个业务判断都没有。
//
// 脱离 ash 靠两件事，缺一不可（跟 executors/detached.ts 是同一招，理由见那里的文件头）：
//   ① `detached: true` —— POSIX 上 setsid 自成会话/进程组，ash 退出时的那串信号打不到它
//   ② **输出写文件、不给它任何管道** —— 唯一真正的生死绑定是 stdout 匿名管道：ash 一死
//      读端关闭，它下次往 stdout 写就吃 SIGPIPE 当场毙命。换成文件这条绑定就断了。
// 再加一个 `unref()`，ash 自己的事件循环也不会被它吊着不退。
//
// ── 放行闸：**命令开工之前，身份必须已经落库**（第 7 轮审查 F3）─────────────────
//
// 「起进程」和「把它记下来」是两件事，顺序决定了失败时会不会留下无主资源。原来是先 spawn
// 再 insert：登记失败时命令已经独立跑了几十毫秒，只能事后去追（落责任、发信号、确认退出），
// 而当身份查询也不可用、责任表又写不进去时，那个进程的唯一线索只剩一个 unref 定时器的内存
// 参数 —— 进程一退它就没了，重启恢复只枚举 monitors 和债表，两张表都没有它（实测：命令还
// 活着，三处全空）。
//
// 所以 spawn 出来的壳**先停在一道闸前面**：它第一件事是从 fd 3 读一行，读到才 exec 用户的
// 命令。ash 只有在身份行（含 pid）落库之后才写那一行。于是：
//   · 登记失败 ⇒ 不放行 ⇒ 用户的命令**从未开工**，没有任何需要回收的外部资源；
//   · ash 在放行前自己没了 ⇒ 写端随进程关闭 ⇒ 壳读到 EOF ⇒ 自己退出，同上；
//   · 放行之后 ⇒ 身份早已在库里，照旧由接回/债表那一圈兜。
// 壳是我们自己拼的一行 `sh`，不会 trap 信号，所以不放行时那一刀必中。
//
// **win32 没有这道闸**：`cmd.exe` 里没有可靠的「从第 3 号句柄读一行」写法，硬凑出来的
// `for /l` + `if exist` 轮询要把用户命令嵌进括号里（命令里一个 `)` 就炸）。那一侧只保留
// 「先落行、再 spawn、再回填 pid」的顺序。**未在 Windows 真机验证**（约定见根 AGENTS.md）。
//
// ── 身份边条：**pid 在任何一次 await 之前就已经在盘上**（第 9 轮审查 F3）────────────
//
// 闸管得住「命令什么时候开工」，管不住「ash 死在 spawn 和回填 pid 之间」这一档的 win32：
// 那一侧命令已经在跑，而库里那行 pid 还空着 —— 重启只剩一条没有 pid 的行，说明、命令文字、
// 日志路径都在，却**没有任何能用来找回那个进程的身份**（审查原话：「留下 id、命令和日志
// 路径，不等于留下了能定位原进程的持久身份」）。
//
// 所以 `spawn` 一返回就**同步**把 `{pid, 这一刻}` 写到 `<日志>.spawn.json`：中间一个 await
// 都没有，所以除了硬崩在这几行里，这份身份一定比命令的第一个字节先落盘。重启那一侧
// (`reattachMonitors`) 拿它去认进程 —— 用的是 `processStartedNear`，**真的比代次**
// （ps 的启动时刻 vs 这个锚，±2 秒），不是退化成「这个号上有人」。认下来就把 pid 回填进
// 行里，这条哨兵从此跟正常接回的一样能停、能收、能记责任。
//
// 它在 POSIX 上是多余的（闸已经保证命令没开工），但**代码一份、两边同一条路**：平台差异
// 只剩「有没有闸」这一处，不再多出一条只有 Windows 走的恢复分支。
//
// ── 资源单位的身份:**这一次创建独有的一条记号,种在环境里**(第 12 轮审查 F1)────────
//
// 「这些进程属于这一次创建」要有凭证,而命令原文不是 —— 它是要干的活:同一条命令可以合法
// 地被创建两次,前缀还会撞(记录 `sleep 1`、现存 `sleep 120`,包含判断照样认作自己的后代)。
// 所以这里把 `ASH_MONITOR_UNIT=<记号>` 种进那个壳的环境:环境随 `exec` 继承、后代各自带一
// 份,于是**组长死了之后留在后台的那些仍然自证身份**(它们的 argv 早就换成别的程序了)。
// 记号本身在起进程之前就随意图行落库,所以跨重启也认得回来。判定在 proc.ts
// (`processUnitEvidence`),扫描在 monitor-unit-scan.ts(`liveMonitorUnitsSync`)。
//
// ── 交接必须可恢复，否则这次创建就该拒（第 10 轮审查 F2-C）────────────────────────
//
// 上面两件事（闸、边条）各自会失败，而**失败的后果取决于另一件在不在**：边条写不下来时，
// POSIX 还有闸兜着（命令没开工，撒手即无残留）；win32 两样都没有时，命令可能已经在后台跑
// 着，而重启后没有任何东西能定位它。所以「这次交接可不可恢复」是一个要**显式回答**的问题
// （`handoverRecoverable`），答不出是就拒这次创建 —— 带着一个找不回来的进程放行，等于把
// 「以后谁都收不掉它」写进系统。判据住在这一层（只有这里知道闸装没装、边条写没写成）。
import { spawn } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { agentBaseEnv } from "./executors/spawn.js";
import { MONITOR_UNIT_ENV, invalidateMonitorUnitScan } from "./monitor-unit-scan.js";
import { IS_WINDOWS, killTree, userShellLaunch } from "./platform.js";
import { RUNS_DIR } from "./paths.js";

/** 输出落在任务自己的 run 目录下，跟会话正文、trace 同一处，归档清理不必另记一份路径。 */
export function monitorLogPath(taskId: string, monitorId: string): string {
  return join(RUNS_DIR, taskId, `monitor-${monitorId}.log`);
}

/** 身份边条的路径：跟日志同目录、同一个 monitorId，所以归档清理会把它一起带走。 */
export const monitorSpawnIdentityPath = (logPath: string): string => `${logPath}.spawn.json`;

/** 边条里记的那两样：**这次 spawn 的 pid**，和 spawn 返回的那一刻（时间锚，见文件头）。 */
export type SpawnIdentity = { pid: number; spawnedAtMs: number };

/**
 * **这一次交接可不可恢复** —— ash 要是在「回填 pid」之前整个没了,还有没有东西能定位那个进程。
 *
 * 两条路任一条成立就够:
 *  · `gated` —— 装了放行闸(POSIX):命令还没开工,ash 一死写端就关、壳在 exec 之前自退,
 *    不存在需要定位的残留;
 *  · `identitySaved` —— 身份边条落盘了:命令可能已经开工,但重启后按代次认得回来。
 *
 * 两条都不成立(win32 + 边条写失败)⇒ 命令可能在后台跑着而我们手里什么都没有。这一档只有一个
 * 正确答案:**拒这次创建**(第 10 轮审查 F2-C)。
 */
export const handoverRecoverable = (p: { gated: boolean; identitySaved: boolean }): boolean =>
  p.gated || p.identitySaved;

/** 读回那份边条。坏了/没了一律 null —— 调用方按「没有身份可用」走诚实的那一支。 */
export function readSpawnIdentity(logPath: string): SpawnIdentity | null {
  try {
    const raw = JSON.parse(readFileSync(monitorSpawnIdentityPath(logPath), "utf8")) as unknown;
    const o = raw as { pid?: unknown; spawnedAtMs?: unknown };
    if (!Number.isInteger(o.pid) || (o.pid as number) <= 0) return null;
    if (typeof o.spawnedAtMs !== "number" || !Number.isFinite(o.spawnedAtMs)) return null;
    return { pid: o.pid as number, spawnedAtMs: o.spawnedAtMs };
  } catch {
    return null;
  }
}

/**
 * 身份已经稳稳落在库里了,边条可以撤。**撤不掉也不要紧**:它只在「行还 running 而 pid 空着」
 * 时才被读(见 `reattachMonitors`),那一刻库里那份才是权威。
 */
export function clearSpawnIdentity(logPath: string): void {
  try { unlinkSync(monitorSpawnIdentityPath(logPath)); } catch { /* 没有就算了 */ }
}

export type SpawnedMonitor = {
  pid: number;
  /**
   * **这一次交接可不可恢复**(`handoverRecoverable` 的结论)。false = 命令可能已经开工,而
   * ash 要是现在没了就再没有东西能定位它 —— 创建层必须据此拒掉这次创建(第 10 轮审查 F2-C)。
   */
  recoverable: boolean;
  /** 命令自己跑完时回调一次（仅限本进程起的那次；跨 server 重启接回来的拿不到）。 */
  onExit: (cb: (code: number | null) => void) => void;
  /**
   * **拿句柄杀它**,不经过 pid 身份判定。
   *
   * 创建期的撤销只能走这一条:那一刻 ash 手里**真的还握着这个 ChildProcess**,所有权是
   * 句柄本身证明的 —— 而 pid 那条路要先问 ps 要启动时刻,ps 不可用(或还没问到)时按第 9 轮
   * 审查 F3 的判据一律不许下刀。于是「身份记不全」这种失败里,句柄是唯一还能动手的凭据。
   */
  kill: () => void;
  /**
   * **这条命令有没有可能已经开工了。**
   *
   * true 的两种来由:① 已经放行(`release()` 调过);② 这一侧**没有闸**(win32)—— 那里命令在
   * `spawn` 返回之前就可能跑起来了。
   *
   * 它回答的是一个资源问题:**根进程退出算不算整项资源退出**。命令从未开工 ⇒ 壳底下什么都
   * 没有,根的 `exit` 就是全部;开工过 ⇒ 它可能已经派生了后台进程,那些进程不随根退出而消失,
   * 根的 `exit` 只证明根走了(第 11 轮审查 F1-B)。所以创建期的撤销要按这一问分档:前者敢当场
   * 判收干净,后者一律交回收圈按**当前归属证据**处理(见 monitor-create.ts 的 `releaseProcess`)。
   */
  commandMayHaveStarted: () => boolean;
  /**
   * **拿句柄确认它退了**(有界等待)。注意它证明的是**这个 ChildProcess**(壳的根)退了 ——
   * 不是「这条命令派生的一切都没了」。两者只有在命令从未开工时才等价,判据见
   * `commandMayHaveStarted`。同理:不查 ps、不比 pid,`exit` 事件本身就是那一份证明。
   * 返回 false = 这个期限内没等到,调用方照旧落回收责任。
   */
  waitExit: (deadlineMs: number) => Promise<boolean>;
  /**
   * **让用户的命令开工**。只有身份已经落库的那条路径才许调（见文件头的放行闸）。
   * win32 上是空操作：那一侧没有闸，命令在 spawn 的那一刻就已经在跑了。
   */
  release: () => void;
  /**
   * **这次不放行**：关掉写端让壳自己退出（它还没 exec 用户的命令），调用方随后照旧走回收圈
   * 兜一刀。POSIX 上这意味着用户的命令一行都没跑过。
   */
  abandon: () => void;
};

/** 放行闸的那段壳前缀：先从 fd 3 读一行，读不到（ash 没了）就退出，绝不执行用户的命令。 */
const GATE_PREFIX = "IFS= read -r __ash_go <&3 || exit 97; exec 3<&-; ";

export function spawnMonitor(
  /** `unitToken` = 这一次创建独有的资源记号(见文件头)。缺省只出现在测试台子上。 */
  opts: { command: string; cwd: string; logPath: string; unitToken?: string | null },
): SpawnedMonitor | { error: string } {
  // 工作目录先自己判一句。它失效是**最常见**的一种失败（项目目录被移走、旧任务的
  // worktree 被清掉），而 `spawn` 对坏 cwd 的报错是**异步**的：那条路在下面要靠两道
  // 防线才接得住，没必要为一个一句话就能判出来的情况去赌那两道。
  try {
    if (!statSync(opts.cwd).isDirectory()) return { error: `哨兵的工作目录不是一个目录：${opts.cwd}` };
  } catch {
    return { error: `哨兵的工作目录不在了：${opts.cwd}` };
  }
  let fd: number;
  try {
    // **建目录和开文件在同一道错误边界里**。上一版 `mkdirSync` 在 try 外面:runs 目录那一段
    // 路径上有个同名文件、或者权限不允许时它直接抛出整个函数 —— 而那时创建层已经把身份行
    // 落好了,于是留下一条 pid 永远空着的 running 行:没有 tail、没有到期定时器、还占着每个
    // 任务 4 个的名额,只能等人手动清(第 8 轮审查 F3 的同类项)。这一层的契约是
    // **要么返回句柄、要么返回一句话**,不抛。
    mkdirSync(dirname(opts.logPath), { recursive: true });
    fd = openSync(opts.logPath, "a");
  } catch (e) {
    return { error: `建不了哨兵日志文件 ${opts.logPath}：${e instanceof Error ? e.message : String(e)}` };
  }
  try {
    // 闸只装在 POSIX 那一侧（见文件头）。拼在**命令前面**而不是包一层括号：用户的命令原样
    // 跟在后面，它自己的引号、换行、`&&` 的语义一个字都不变。
    const gated = !IS_WINDOWS;
    const launch = userShellLaunch(gated ? `${GATE_PREFIX}${opts.command}` : opts.command);
    // stdin 给 ignore 而不是继承：哨兵命令不该有机会去读 ash 的标准输入（闸走的是 fd 3，
    // 所以用户的命令拿到的 stdin 仍然是 /dev/null）。
    // stdout/stderr 都指向同一个 fd —— 合流是刻意的，命令自己报的错也该成为事件。
    const child = spawn(launch.file, launch.args, {
      cwd: opts.cwd,
      // 记号跟着环境走 —— 这是整棵树唯一的身份凭证(见文件头)。
      env: opts.unitToken ? { ...agentBaseEnv(), [MONITOR_UNIT_ENV]: opts.unitToken } : agentBaseEnv(),
      detached: true,
      stdio: gated ? ["ignore", fd, fd, "pipe"] : ["ignore", fd, fd],
      ...(launch.windowsVerbatimArguments ? { windowsVerbatimArguments: true as const } : {}),
    });
    // **结局只发生一次,所以这里把它存下来,而不是等订阅者来了再听。**
    //
    // 两个监听都必须**此刻**就挂上:
    //  · `error` —— spawn 的失败是异步报的(坏 cwd 在 fork 之后才 chdir 失败),这一刻没有
    //    监听者的话 Node 把它升级成 uncaughtException,整个 ash 当场退出,一次失败的创建把
    //    所有任务页一起带下线(第 2 轮审查实测:退出码 143、`uncaughtException: spawn sh ENOENT`);
    //  · `exit` —— 它是**一次性事件**。上一版在 `onExit(cb)` 里才 `child.on("exit")`,而
    //    订阅发生在「回填 pid」这一次 await 之后:壳在那之前就退掉的话(命令有语法错误、
    //    `sh` 解析完当场失败),那一次 exit 没有任何人听见,之后挂上的监听器永远不会再被叫 ——
    //    于是一条已经死掉的哨兵在库里和界面上都写着 running,一直挂到约定的时长到期才收尾
    //    (第 8 轮审查 F3 实测 `alive=false` 而 `row.status=running`)。放行闸管的是「用户的
    //    命令什么时候开工」,证明不了「这个 ChildProcess 还活着」。
    // 放行过没有 —— `gated` 为假时(win32)命令在这一刻之前就可能已经跑起来了,所以那一侧
    // 从头就算「可能开工过」(见 `commandMayHaveStarted`)。
    let released = !gated;
    let settled: { code: number | null } | null = null;
    // **多订阅者**:运行时(`attach`)订一个,创建期撤销那条路要等退出确认(`waitExit`)也订一个。
    // 上一版只存一个 subscriber,后挂的会把前一个顶掉 —— 两条路同时在场时必然丢一个。
    const subscribers = new Set<(code: number | null) => void>();
    const settle = (code: number | null) => {
      if (settled) return;                 // 结局只认第一个:error 之后往往还跟一个 exit
      settled = { code };
      for (const cb of subscribers) cb(code);
      subscribers.clear();
    };
    child.on("error", () => settle(null));
    child.on("exit", (code, signal) => settle(code ?? (signal ? null : 0)));
    if (!child.pid) {
      // **绝不能 `child.kill()`**：没有 pid 就没有进程可杀，这一步会走到
      // `uv_process_kill(0, SIGTERM)`，而 POSIX 的 `kill(0, …)` 是「发给自己所在的
      // 整个进程组」—— ash 把自己连同它起的一切一起 SIGTERM 掉（同上，实测）。
      return { error: `哨兵起不来：${opts.command}` };
    }
    child.unref();
    // **资源扫描立刻作废**:比这个进程还老的一次扫描里没有它的记号,而那会被读成「整项资源
    // 已退出」(见 monitor-unit-scan.ts 的 `invalidateMonitorUnitScan`)。
    invalidateMonitorUnitScan();
    // **身份边条:这里到 return 之间一个 await 都没有**(见文件头)。写失败不致命 —— 它是
    // 「库还没写进去」那一档的兜底,所以只出声,不把一次正常创建搞失败。
    let identitySaved = false;
    try {
      writeFileSync(
        monitorSpawnIdentityPath(opts.logPath),
        JSON.stringify({ pid: child.pid, spawnedAtMs: Date.now() } satisfies SpawnIdentity),
      );
      identitySaved = true;
    } catch (e) {
      // 写失败**不一定**致命:有闸的那一侧命令还没开工。致不致命由 `handoverRecoverable` 判,
      // 创建层据此决定放行还是拒(第 10 轮审查 F2-C)。
      console.error(`[ash] 哨兵身份边条写不下来 ${monitorSpawnIdentityPath(opts.logPath)}:`, e);
    }
    // 闸的写端：**也要 unref**，不然 ash 的事件循环会被这个 pipe 吊着不退（`child.unref()`
    // 只管进程句柄，stdio 流是另一个 handle）。
    const gate = (child.stdio as Array<{
      write?: (chunk: string) => void; end?: () => void; destroy?: () => void; unref?: () => void;
      on?: (event: string, cb: (e: unknown) => void) => void;
    } | null>)[3];
    gate?.unref?.();
    // 写端是一个 socket:对端先死时 EPIPE 是**'error' 事件**,不是 `write()` 的同步异常 ——
    // 没人听就会升级成 uncaughtException。壳先退了只说明「没放行成」,不该把 ash 带走。
    gate?.on?.("error", () => { /* 壳已经没了 = 这次没放行,调用方照旧走回收圈 */ });
    return {
      pid: child.pid,
      recoverable: handoverRecoverable({ gated, identitySaved }),
      release: () => {
        if (!gate?.write) return;      // win32：没有闸，命令早就在跑了
        // **先记下「放行过」,再去写**:写失败只说明这一次没放行成功,而那一刻命令是否已经
        // 开工我们并不知道(对端可能刚好读到了那一行就死了)。记在前面 = 宁可按「可能开工过」
        // 保守处理,也不把一条可能有后代的命令当成「什么都没起」(第 11 轮审查 F1-B)。
        released = true;
        try { gate.write("go\n"); gate.end?.(); } catch { /* 它已经没了：那就是没放行 */ }
      },
      abandon: () => {
        // 关掉写端 = 壳那边读到 EOF = 它在 exec 之前就退出。调用方仍会补一刀兜底。
        try { gate?.destroy?.(); } catch { /* 已经关了 */ }
      },
      onExit: (cb) => {
        // **晚订阅也必须拿到已经发生的结局**(见上面 `settled` 的注释)。同步叫回来是安全的:
        // 调用方 `attach` 在调这一步之前已经把运行时登记好了,而回调自己是 `void finish(...)`。
        if (settled) { cb(settled.code); return; }
        subscribers.add(cb);
      },
      commandMayHaveStarted: () => released,
      kill: () => {
        // **要覆盖它派生的后代,不能只打根进程**:根进程退出不证明这条命令结束了
        // (第 10 轮审查 F2-C)。`killTree` 两边各走各的 —— POSIX 打组信号(组号就是 pid,
        // 因为壳是 `detached` 的),win32 打 `taskkill /T` 那棵树(跟 ash 收 agent 进程树用的
        // 是同一个函数)。**win32 这一侧未在真机验证**(根 AGENTS.md:那台机器现在连不上)。
        // 所有权在这里由**句柄**证明,不必去问 ps 的启动时刻(第 9 轮审查 F3)。
        //
        // **根已经退了就不在这里下刀**:那时组号(POSIX)或那个 pid(win32)随时可能被复用,
        // 句柄证明的是「那个根曾经是我们的」,不是「这个号现在还是我们的」。那一档的收尾交给
        // 回收层按当前归属证据判(proc.ts 的 `processUnitEvidence`:整棵树带着的那条记号),
        // 调用方也不许据此判收干净(第 11 轮审查 F1-A/F1-B、第 12 轮 F1 同一条判据)。
        if (settled) return;
        try { killTree(child.pid!, "SIGKILL"); } catch { /* 已经空了 */ }
        try { child.kill("SIGKILL"); } catch { /* 它已经没了 */ }
      },
      waitExit: (deadlineMs: number) => new Promise<boolean>((resolve) => {
        if (settled) { resolve(true); return; }
        const done = () => { subscribers.delete(listener); clearTimeout(timer); };
        const listener = () => { done(); resolve(true); };
        // **这一发不能 unref**:调用方正在 await 它。unref 掉的话,当它是事件循环里唯一的
        // 待办时进程直接退出 —— 等待本身就没了(同一条坑见 `confirmReclaimed` 的注释)。
        const timer = setTimeout(() => { done(); resolve(false); }, deadlineMs);
        subscribers.add(listener);
      }),
    };
  } catch (e) {
    return { error: `哨兵起不来：${e instanceof Error ? e.message : String(e)}` };
  } finally {
    // 父进程立刻交还 fd：子进程已经各自持有一份复制品，留着只会在日志被删后拖住 inode。
    try { closeSync(fd); } catch { /* 已经关了 */ }
  }
}

/** tail 的轮询间隔。事件要的是「几百毫秒内知道」，不是实时，250ms 足够且近乎零开销。 */
export const TAIL_POLL_MS = 250;

export type Tailer = { stop: () => void; drain: () => void };

/**
 * 从 `startOffset` 开始跟着文件尾巴走，**只吐完整的行**。
 *
 * 「只吐完整的行」是硬要求而不是讲究：offset 要落库，它必须永远停在换行处，否则 server
 * 重启后从半行接着读，那一行会被劈成两条事件。全程在 Buffer 上按 0x0A 切，也就不会在半个
 * UTF-8 字符中间下刀。
 *
 * `onLines` 拿到的是这一轮新读到的所有整行，以及**读完之后**的绝对字节位置——调用方按它
 * 落库，于是「这些行已经推出去了」和「读到了这里」是同一次写入，不会各记各的。
 */
export function tailLines(
  path: string,
  startOffset: number,
  onLines: (lines: string[], offset: number) => void,
): Tailer {
  let offset = startOffset;
  let pending = Buffer.alloc(0);
  let fd: number | null = null;
  let stopped = false;

  const openFd = (): number | null => {
    if (fd !== null) return fd;
    if (!existsSync(path)) return null;
    try { fd = openSync(path, "r"); } catch { fd = null; }
    return fd;
  };

  const pump = () => {
    if (stopped) return;
    const f = openFd();
    if (f === null) return;
    // 文件被截断/换掉了（有人 `>` 了它）：从头再来，否则 offset 永远超过文件长度，
    // 之后写进去的内容一个字节都读不到，哨兵看起来就像「静默了」。
    try {
      const size = statSync(path).size;
      if (size < offset) { offset = 0; pending = Buffer.alloc(0); }
    } catch { /* stat 失败就按老路走 */ }
    const lines: string[] = [];
    for (;;) {
      const buf = Buffer.allocUnsafe(64 * 1024);
      let n = 0;
      try { n = readSync(f, buf, 0, buf.length, offset); } catch { break; }
      if (n <= 0) break;
      offset += n;
      pending = Buffer.concat([pending, buf.subarray(0, n)]);
      const nl = pending.lastIndexOf(0x0a);
      if (nl >= 0) {
        for (const line of pending.subarray(0, nl).toString("utf8").split("\n")) lines.push(line);
        pending = pending.subarray(nl + 1);
      }
      if (n < buf.length) break;
    }
    if (lines.length) {
      // 已读但还没凑够一行的那几个字节不算数：报出去的 offset 一定落在换行处。
      onLines(lines, offset - pending.length);
    }
  };

  const timer = setInterval(pump, TAIL_POLL_MS);
  (timer as { unref?: () => void }).unref?.();
  return {
    stop: () => {
      stopped = true;
      clearInterval(timer);
      if (fd !== null) { try { closeSync(fd); } catch { /* ignore */ } fd = null; }
    },
    // 收尾前再吸一次：进程刚死那一瞬写进去的最后几行，不该因为「哨兵已停」就丢掉。
    drain: () => pump(),
  };
}

/**
 * 从文件**尾部**回读一段，切成完整的行。给界面看「它这会儿在吐什么」用。
 *
 * 不从头读的理由不只是省内存：哨兵盯的东西一跑就是几小时，日志动辄几十上百兆，而人想看
 * 的永远是最后那几十行。从尾部截一段再把开头那半行丢掉（`start > 0` 时），比按行遍历
 * 整个文件便宜几个数量级，代价只是最旧的那一行可能缺个头——那一行本来也不在视野里。
 */
export function readLogTail(path: string, maxBytes: number): { lines: string[]; truncated: boolean } {
  let size = 0;
  try { size = statSync(path).size; } catch { return { lines: [], truncated: false }; }
  const start = Math.max(0, size - maxBytes);
  let fd: number;
  try { fd = openSync(path, "r"); } catch { return { lines: [], truncated: false }; }
  try {
    const buf = Buffer.allocUnsafe(size - start);
    let filled = 0;
    while (filled < buf.length) {
      const n = readSync(fd, buf, filled, buf.length - filled, start + filled);
      if (n <= 0) break;
      filled += n;
    }
    const text = buf.subarray(0, filled).toString("utf8");
    const lines = text.split("\n");
    // 截断点多半落在某一行中间：那半行不是一行，丢掉而不是当成一行展示。
    if (start > 0) lines.shift();
    if (lines.at(-1) === "") lines.pop();
    return { lines, truncated: start > 0 };
  } finally {
    try { closeSync(fd); } catch { /* ignore */ }
  }
}
