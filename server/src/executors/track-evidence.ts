// **追踪证据**:本次运行专属的那个继承 fd(文件)、「谁还握着它」这一问的三档回答、以及
// 这份证据的寿命(租约 + 启动期清扫)。
//
// 从 kill.ts 搬出来的理由同 child-identity.ts:三摊各自顶着 700 行,而这一摊的使用方
// (击杀、逃逸枚举、清理责任)谁都只用得到它的几个入口。
import { execFile } from "node:child_process";
import type { ChildProcess, ExecFileException } from "node:child_process";
import { tmpdir } from "node:os";
import { openSync, closeSync, existsSync, readdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { IS_WINDOWS, isPidAlive } from "../platform.js";
import { processUnitEvidence } from "../proc.js";
import { childStillOurs } from "./child-identity.js";
import { unitTokenOf } from "./unit-token.js";

// ── 逃逸进程追踪(继承 fd,systemd 同款思路)──────────────────────────────
// 进程组击杀(kill -pid)只覆盖「还留在 agent 进程组里」的后代。但 codex/claude
// 的 exec 层会给命令另开进程组,命令再 nohup/& 一放、父进程一退,整条流水线就
// 变成 ppid=1、自成一组的孤儿 —— 组杀和树遍历都追不到(真实案例:暂停分组后
// TTS 流水线 run_youtube_pipeline.sh 一家五口继续后台跑)。
// 解法:spawn 时塞一个指向「本次运行专属追踪文件」的继承 fd(stdio[3])。所有
// 后代都会带着这个 fd(bash/nohup 不关高位 fd),无论怎么改组、被谁收养;停止
// 时 `lsof -t <file>` 反查持有者,再从每个持有者向下走 ppid 树补上被 python
// close_fds 掐断继承的孙进程。局限:双 fork 且中间
// 层已死、又恰好隔着一层 close_fds 的深孤儿仍可能漏(实践中极少)。
//
// **Windows 上这一层仍然比 POSIX 弱,但正常收尾那条路可以补。** 两个差异:
//  · 继承 fd 反查没有零依赖等价物(handle.exe 要单独装、要管理员),所以
//    Windows 上根本不开追踪文件,只剩 ppid 树遍历这一半。
//  · Windows 不做 reparent,孤儿的 ParentProcessId 保留着已死父进程的号 ——
//    CLI 活着时从它往下走得到;CLI 已死以后如果把它的 pid 一起忘了,就再也找不到入口。
//    RunHandle 因此在事件流收尾时调用 cleanupAfterRun:ChildProcess 还握在手里,哪怕根
//    进程刚退出,仍能拿它的旧 pid 走这棵保留下来的 ppid 树。server 重启后句柄丢了、
//    或 pid 已经被复用的深孤儿仍然无解,所以 Windows 依旧是尽力而为,不是等价保证。
const trackFiles = new WeakMap<ChildProcess, string>();

/** 这个句柄的追踪文件路径(`null` = 没开成 / Windows)。清扫与清理责任都按它取证。 */
export const trackPathOf = (child: ChildProcess): string | null => trackFiles.get(child) ?? null;

/**
 * 「谁还握着这个运行专属文件」—— 三档,**`unknown` 不许读成没有**(见 `HolderProbe`)。
 *
 * 这一问现在有**两个**运行专属文件要问:追踪文件(高位继承 fd)和这一次运行的输出文件
 * (根的 stdout,`unit-token.ts` 的 `runOutPathOf`)。名字因此不再带 `track` —— 判据对两者
 * 完全相同,而「只问了其中一条就宣布清空」正是第 2 轮审查 F1 实测的那个漏洞。
 */
export const probeFileHolders = (path: string): Promise<HolderProbe> => trackHolders(path);

// ── 归属事实 + 同源代次:**一份身份事实,探活 / 扩树 / TERM / 补刀共用** ──────────
//
// 号码不是身份。以前这一层对后代只有「号码」一个抓手,于是两头都错:
//
//  · **漏杀** —— 补刀前重新取证,取不到就当「这个号已经换了主人」而放过。可一个还活着的
//    后代完全可以**自己把那个继承 fd 关掉**(收到 SIGTERM 时顺手 close 的程序不少),它于此
//    一刻从 lsof 名单里消失,却继续在用户的工作目录里写文件(第 3 轮审查 F1 用生产
//    `openResident` + 真后台 Node 实测:心跳从 17 涨到 156,`stopResult=false`);
//  · **误杀** —— 反过来,先读到裸号码、隔着一次 await 再去问进程表要启动时刻,那个号这期间

/**
 * **「谁还握着这个文件」这一问的三档回答** —— 上一版把它折成了 `number[]`,于是
 * 「确证没人握着」和「这一问自己失败了」长得一模一样(空数组)。审查实测的后果:注入一个
 * 退出码 2、零输出的 `lsof`,周期复核与启动清扫**两条路都把还有活持有者的证据删掉了** ——
 * 而在 POSIX 上根退出、后代重父之后,这个文件名正是继续找回那些后台持有者的唯一线索。
 *
 * 所以这一层的规矩跟记号那一问同源(proc.ts 的四档):**只有「问全了、确实没有」才允许
 * 销毁证据**;问不出来要保留文件、保留清理责任,安排下一次重试。
 */
export type HolderProbe =
  /** 确证有人握着(至少这几个),**每个都带着它是怎么握着的**(见 `FileHolder`)。 */
  | { kind: "held"; holders: FileHolder[] }
  /** 确证**问全了**、而且一个持有者都没有 —— 唯一允许销毁证据的那一档。 */
  | { kind: "empty" }
  /**
   * 这一问自己没答出来(lsof 不在、报错、超时、输出不完整)。**不等于没有**。
   *
   * `lost` 把这一档再分两种,因为它们该导向不同的处置:
   *  · `lost: false`(默认)—— 这一次查询失败,**下一次还问得出来** ⇒ 留证据、排重试;
   *  · `lost: true`   —— 路径名这条线索**本身没了**(文件已被删),再问多少次都是同一个
   *    答案 ⇒ 证据和责任照样不许当成「已清空」销掉,但别再排无穷的重试,按「追到这里
   *    为止」收档(语义同 `monitor_reclaim_debts.closed_at`)。
   */
  | { kind: "unknown"; reason: string; lost?: boolean };

/**
 * **一个持有者是「怎么」握着这个文件的** —— 光有号不够。
 *
 * 第 3 轮审查 F1 实测的那一下:`lsof -t` 只回号码,于是「这个号打开过这个文件」被当成了
 * 「这个号属于这一次运行」,用户拿来看日志的程序**只读**打开同一个输出文件,也照样拿到了
 * 整组击杀的授权。号码不是身份,**打开过也不是归属**。
 *
 * 所以这一问改成按持有者逐个回答,由调用方自己挑门槛 —— 两种用途的门槛本来就不一样:
 *  · **授权破坏性操作**:只认写模式(追踪文件是 `w` 打开的、输出文件是根的 stdout),
 *    而且输出文件那一路还要求落在 fd 1 上 —— 只读查看者两条都不满足;
 *  · **残留检测**:问的是「还有没有东西在往这次运行的文件里写」,所以同样只数写模式的;
 *    只读的看客不是残留,把它算进去只会凭空落一笔债。
 *
 * 模式答不出来(字段缺失)时一律 `unknown`:授权那一侧按「证不出」处理(不放行),检测那一侧
 * 按「这一问没答全」处理(留着重试)。两边都不许把它读成「没有」。
 */
export type FileHolder = {
  pid: number;
  /** 它是用哪个 fd 握着的。`null` = 非数字 fd(`mem`/`txt` 这类)或者这一问没给出。 */
  fd: number | null;
  /** `write` = 写(`w`/`u`);`read` = 只读;`unknown` = 这一问没给出模式。 */
  mode: "write" | "read" | "unknown";
};

/** 授权用的那一档:**写模式才算**(见 `FileHolder`)。 */
export const holderMayOwn = (holder: FileHolder): boolean => holder.mode === "write";

/**
 * 这台机器上「谁还握着这个文件」这一问**答得了吗**。
 *
 * win32 没有零依赖的等价物(`handle.exe` 要单独装、要管理员),见本文件顶部。那是**结构性
 * 答不了**,跟「这一次查询失败」是两件事,而两者的正确处置相反:后者该留着重试,前者重试
 * 一万次也是同一个答案。把它记成「没答出来」的后果是 Windows 上**每一个正常收尾的回合**都
 * 欠一笔永远追不动的债,真正的残留反而被淹掉(第 3 轮审查 N2)。所以调用方在这一档上
 * **不问**,这条线索按「本次运行没有这条线索」处理 —— 那边本来就只剩 ppid 树这一半能力,
 * 顶部那段写明了它是尽力而为、不是等价保证。
 */
export const fileHoldersAnswerable = (): boolean => !IS_WINDOWS;

/**
 * 问系统工具的时限。**不设时限的那个版本会把整条路拖住**(第 4 轮审查 N4):`lsof` 在网络
 * 文件系统上挂死是常见现场,而这一问排在清理、同键那把锁、以及等着它的回合结算前面。
 * 超时的处置是「这一次没答出来」(留着重试),不是「没有持有者」。
 */
const PROBE_TIMEOUT_MS = 10_000;

/**
 * `lsof -F pfan <file>`:此刻还握着这次运行那个继承 fd 的号,**连 fd 与访问模式一起**。
 *
 * **退出码 1 不等于「查全了、没找到」**(本轮审查 F2 实测):路径不存在时 lsof 打印
 * `status error ... No such file or directory` 之后**也退 1**。上一版把全部退出 1 读成确证空,
 * 于是这两件事长得一模一样 —— 而它们的后果相反:真的没人握着可以销毁证据,查询出错只能重试。
 *
 * 所以分档看的是 **stdout 有没有号 + stderr 有没有报错**,退出码只用来排除「它自己崩了」:
 *  · stdout 里有号 ⇒ `held`(哪怕同时报了错 —— 报错的可能是别的路径);
 *  · 退出 0、或退出 1 且 stderr 干净 ⇒ `empty`;
 *  · 其余一律 `unknown`,并区分「文件还在、只是这一问没答出来」与「文件已经没了」(`lost`)。
 *
 * **文件已经没了为什么不算确证空**:`unlink` 只摘掉名字,仍握着那个 fd 的进程继续活着、继续
 * 写它 —— 只是再也没法按路径名把它们查出来。那是「线索断了」,不是「人走了」。
 */
async function trackHolders(trackPath: string): Promise<HolderProbe> {
  const probe = await new Promise<{ err: ExecFileException | null; out: string; errOut: string }>(
    (res) => execFile("lsof", ["-F", "pfan", "--", trackPath], { timeout: PROBE_TIMEOUT_MS },
      (err, stdout, stderr) => res({ err, out: stdout || "", errOut: stderr || "" })),
  );
  const holders = parseHolders(probe.out);
  if (holders.length) return { kind: "held", holders };
  if (!probe.err) return { kind: "empty" };
  // 被时限掐掉的那一次:**没答出来**,而且文件可能还在(第 4 轮审查 N4)。挂死的 lsof 会
  // 把这一问、同键那把锁、以及等着它的结算一起拖住,所以宁可按「这一次没答出来」收场。
  if (probe.err.killed || probe.err.signal) {
    return { kind: "unknown", reason: `lsof 超过 ${PROBE_TIMEOUT_MS} 毫秒没回,已中止`, lost: !existsSync(trackPath) };
  }
  if (probe.err.code !== 1) {
    // `≥2` 是它自己出错;`ENOENT`(字符串码)是这台机器上根本没有 lsof。
    return { kind: "unknown", reason: `lsof 退出码 ${String(probe.err.code)}` };
  }
  const fault = lsofFault(probe.errOut);
  if (!fault) return { kind: "empty" };           // 退出 1 + stderr 干净 = 真的没人握着
  return { kind: "unknown", reason: fault, lost: !existsSync(trackPath) };
}

/**
 * lsof 的 stderr 里有没有**指向这一问本身**的故障。
 *
 * 认的是它自己那几句定型话(`status error`、`no such file`、权限)。不认成故障的那些是它
 * 平时就会絮絮叨叨的告警(`WARNING: can't stat() ... file system`)—— 把那些也算上会让
 * 「有没有持有者」这一问在不少机器上永远答不出来,证据于是永远留着、责任永远挂着。
 */
function lsofFault(stderr: string): string | null {
  const line = stderr.split("\n").map((l) => l.trim()).find(
    (l) => /status error|no such file|permission denied|not found/i.test(l),
  );
  return line ? line.slice(0, 200) : null;
}

/**
 * `-F pfan` 的输出:`p<pid>` 起一个进程段,段内每个 fd 一组 `f<fd>` / `a<模式>` / `n<路径>`。
 *
 * 自己这个进程一律剔掉(追踪文件的父侧 fd 在 `registerTrackFd` 里就关了,输出文件却是 ash
 * 自己在读 —— 把它算成持有者会让每一次清理都答「还有残留」)。
 *
 * **`a` 字段缺席时这个持有者照样要出列,模式记 `unknown`**(第 4 轮审查 N10)。上一版只在
 * 见到 `a` 时才落一条,于是某个 lsof 只回 `p`/`f`/`n` 时整条被丢掉,上一层又把「查询成功、
 * 零个持有者」读成确证空 —— 又是一次「没有证明存在」被当成「已经证明不存在」。缺模式的
 * 持有者在两侧都按「证不出」处理:授权那边不放行,检测那边留着重试(见 `FileHolder`)。
 */
function parseHolders(out: string): FileHolder[] {
  const holders: FileHolder[] = [];
  let pid = 0;
  let fd: number | null = null;
  let pending = false;                            // 这一段 fd 还没落账
  const flush = (mode: FileHolder["mode"]) => {
    if (!pending) return;
    pending = false;
    if (pid <= 1 || pid === process.pid) return;
    holders.push({ pid, fd, mode });
  };
  for (const raw of out.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    const tag = line[0], value = line.slice(1);
    if (tag === "p") { flush("unknown"); pid = Number(value) || 0; fd = null; continue; }
    if (tag === "f") {
      flush("unknown");                           // 上一段没见到模式 ⇒ 按「问不出来」记下
      fd = Number.isInteger(Number(value)) ? Number(value) : null;
      pending = true;
      continue;
    }
    if (tag !== "a") continue;
    flush(/[wu]/.test(value) ? "write" : /r/.test(value) ? "read" : "unknown");
  }
  flush("unknown");
  return holders;
}

/** 只想知道「还有没有活着的持有者」的那几处:`unknown` 必须**当成有**(不许据此释放)。 */
export const holdersMayExist = (probe: HolderProbe): boolean =>
  probe.kind === "unknown"
  || (probe.kind === "held" && probe.holders.some((h) => isPidAlive(h.pid)));

// 追踪 fd(见 killEscapees):打开一个本次运行专属文件,把 fd 作为 stdio[3] 传给
// 子进程 —— 后代无论怎么换组/被收养都带着它,stop 时可按文件名 lsof 反查。
// best-effort:开不出来就照旧 spawn,只是丢掉逃逸追踪能力。
// 抽成一对函数是为了让 detached.ts 那条路(输出走文件)复用同一套逃逸追踪,
// 而不是各写一份 —— 少一份就意味着那条路上的孤儿没人管。
// Windows 上直接返回空:反查手段不存在(见 killEscapees 顶部),开了也没人用,
// 还会平白留下一堆临时文件。
const TRACK_PREFIX = "ash-track-";

export function openTrackFd(): { fd: number | null; path: string | null } {
  if (IS_WINDOWS) return { fd: null, path: null };
  try {
    const path = join(tmpdir(), `${TRACK_PREFIX}${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
    return { fd: openSync(path, "w"), path };
  } catch {
    return { fd: null, path: null };
  }
}

// ── 追踪文件什么时候可以删:**只按「还能不能取到人」判,不按时长判** ─────────────
//
// 这个文件唯一的用途是「按文件名 lsof 反查还握着它的后代」。所以它该活到**它再也问不出
// 东西**那一刻,而那是一个可验证的事实,不是一个时长:
//
//   删得掉 ⇔ 此刻没有活着的持有者,而且(清扫方已经扫完 ‖ 根进程已经不在了)
//
// 两条倒计时都只是**复核的时机**,到点先问一遍上面那句,不成立就接着等:
//  · 清扫方扫完之后排一截尾巴(60s),那是 killChild 的 SIGTERM→2s→SIGKILL 补刀窗口,
//    它也要靠文件名取证;
//  · 谁都还没放手时按一个长间隔periodic 复核(默认 10 分钟)。
//
// 以前这里是两档**无条件删除**:先是 close + 60s(第 2 轮审查 F2:codex 会话级常驻每回合
// 一个进程,会话长过一分钟,早已 close 的回合的证据就全没了),改成「注册后 24 小时」之后
// 判据还是时长 —— 团队没有 24 小时寿命上限,持续有消息就能跨过去,跨过之后清理还在用这个
// 文件取证(第 3 轮审查 F2 实测:心跳从 86 涨到 225,`stopResult=false`)。
const TRACK_TAIL_MS = Number(process.env.ASH_TRACK_EVIDENCE_MS ?? 60_000);
const TRACK_RECHECK_MS = Number(process.env.ASH_TRACK_EVIDENCE_RECHECK_MS ?? 10 * 60 * 1000);

// 按**路径**记而不是按 ChildProcess 记:shareTrackFdRegistration 会让合成句柄和真进程两个
// 对象指向同一个文件,它们说的是同一份租约。`WeakRef` 是为了不让租约反过来钉住句柄 ——
// 句柄被 GC 掉就等于「再也不会有人来放手了」,那时只剩「有没有持有者」这一问。
type TrackLease = {
  child: WeakRef<ChildProcess>;
  released: boolean;
  timer: ReturnType<typeof setTimeout> | null;
};
const leases = new Map<string, TrackLease>();

function armRecheck(path: string, delayMs: number): void {
  const lease = leases.get(path);
  if (!lease) return;
  if (lease.timer) clearTimeout(lease.timer);
  const t = setTimeout(() => {
    lease.timer = null;
    void recheckLease(path).catch(() => { /* 下一次复核再试 */ });
  }, delayMs);
  (t as { unref?: () => void }).unref?.();
  lease.timer = t;
}

async function recheckLease(path: string): Promise<void> {
  const lease = leases.get(path);
  if (!lease) return;
  const child = lease.child.deref();
  // 还有活着的持有者 ⇒ 证据还问得出东西,一个字都不能删。
  // **问不出来也算有**(`holdersMayExist`):一次失败的查询不配当销毁证据的依据,它只说明
  // 「这一问没答出来」。这一档安排下一轮复核,证据与清理责任都留着(第 2 轮审查 F2)。
  if (holdersMayExist(await trackHolders(path))) {
    armRecheck(path, TRACK_RECHECK_MS);
    return;
  }
  // **记号这一问也要过** —— fd 查不到人**不等于**这项资源空了:后代被系统改挂到 1 号名下、
  // 又顺手关掉高位 fd 之后,它从 lsof 名单里彻底消失,而记号两层都还带着(本轮审查 F2 实测:
  // 清理之后记号仍明确指出那个孤儿,追踪文件照样被删掉了)。所以这里跟着问一句,免得证据
  // 在还问得出东西的时候就被销毁。
  if (child && unitMayHaveMembers(unitTokenOf(child))) {
    armRecheck(path, TRACK_RECHECK_MS);
    return;
  }
  // 没人握着了:清扫方扫完过、或者根进程已经不在(句柄被 GC 掉同理)⇒ 这个文件再也
  // 问不出东西,删。都不成立就是「还在跑、只是这一轮没有逃逸者」⇒ 留着等它。
  if (!lease.released && child && childStillOurs(child)) {
    armRecheck(path, TRACK_RECHECK_MS);
    return;
  }
  leases.delete(path);
  try {
    unlinkSync(path);
  } catch {
    /* already gone */
  }
}

/**
 * 记号那一问:这项资源**可能**还有成员吗。
 *
 * 四档里只有确证的 `none` 答「没有」;`ours`/`suspected` 是确有、`unprovable` 是问不出来,
 * 两者在「该不该留证据」这个问题上导向同一个答案(留)。没有记号时这一问**不发表意见**
 * (返回 false),否则老会话行会让每份证据永久留着。
 */
function unitMayHaveMembers(token: string | null): boolean {
  if (!token) return false;
  return processUnitEvidence(token, { fresh: true }).verdict !== "none";
}

export function registerTrackFd(child: ChildProcess, track: { fd: number | null; path: string | null }): void {
  if (track.fd === null || !track.path) return;
  closeSync(track.fd); // 子进程已持有副本,父进程这份立即关掉
  trackFiles.set(child, track.path);
  leases.set(track.path, { child: new WeakRef(child), released: false, timer: null });
  armRecheck(track.path, TRACK_RECHECK_MS);
}

/** 清扫方已经扫完这个句柄:再留一截补刀窗口,到点仍要确认无人持有才删(见上面那段)。 */
export function releaseTrackEvidence(child: ChildProcess): void {
  const path = trackFiles.get(child);
  if (!path) return;
  const lease = leases.get(path);
  if (!lease) return;
  lease.released = true;
  armRecheck(path, TRACK_TAIL_MS);
}

// detached.ts 对外返回的是合成 ChildProcess；把真进程上的追踪文件映射复制过去，
// cleanupAfterRun 才能在根进程退出后继续按继承 fd 找回已经 reparent 的后代。
export function shareTrackFdRegistration(source: ChildProcess, target: ChildProcess): void {
  const path = trackFiles.get(source);
  if (path) trackFiles.set(target, path);
}

/**
 * 启动时清掉**上一个 ash 留下的**追踪文件。
 *
 * 租约没有硬期限了(见上面那段),所以「进程整个没了、内存里的租约跟着没了」这条路必须有人
 * 收 —— 否则 tmpdir 里会慢慢积空文件(第 3 轮审查 N4:实测攒到了三千多个)。判据两条,都不猜:
 *  · 文件名里那个创建者 pid **已经不在了**(还在就可能是另一个 ash 实例正用着它,
 *    多实例共用同一个 tmpdir);
 *  · 此刻**没有持有者**(有就说明那一摊后代还在,证据得留着让人能查)。
 *
 * 持有者那一问**批量问**:一个文件一次 `lsof` 的话,三千多个候选要跑掉一分钟 —— 启动期
 * 不该为清垃圾付这个钱。`lsof -F pn` 一次给出「哪个进程 / 哪些路径」,按块喂给它。
 */
export async function sweepOrphanTrackFiles(): Promise<number> {
  if (IS_WINDOWS) return 0;                       // 那边不开追踪文件
  let names: string[];
  try {
    names = readdirSync(tmpdir());
  } catch {
    return 0;
  }
  const candidates: string[] = [];
  for (const name of names) {
    if (!name.startsWith(TRACK_PREFIX)) continue;
    const owner = Number(name.slice(TRACK_PREFIX.length).split("-")[0]);
    if (!Number.isInteger(owner) || owner === process.pid || isPidAlive(owner)) continue;
    const path = join(tmpdir(), name);
    if (!leases.has(path) && existsSync(path)) candidates.push(path);
  }
  if (!candidates.length) return 0;
  const held = await heldNames(candidates);
  // 这一批没问清楚 ⇒ **整批留着**,下次启动再扫。上一版这里把「批量查询失败」和「这一批
  // 谁都没人握着」当成了同一件事,于是一次 lsof 故障就能删掉一批还在被活进程使用的证据
  // (第 2 轮审查 F2 实测)。漏删的代价只是文件多留一会儿 —— 它们本来就靠这一轮清扫兜底。
  if (!held) return 0;
  let removed = 0;
  for (const path of candidates) {
    if (held.has(path.split("/").pop() ?? "")) continue;
    try {
      unlinkSync(path);
      removed += 1;
    } catch {
      /* 别人先删了 / 没权限:下次启动再说 */
    }
  }
  return removed;
}

/**
 * 这些路径里,此刻**有人握着**的是哪些(一次 `lsof` 问一批)。
 *
 * 认的是**文件名**而不是整条路径:`lsof` 回的是解析过的真实路径(macOS 上 `/var/...` 会变成
 * `/private/var/...`),拿整条路径进集合一个都对不上 —— 那等于「有持有者」这一问永远答否,
 * 正要留下的证据会被当成垃圾删掉。追踪文件的名字自带 pid + 时间戳 + 随机串,本来就唯一。
 */
async function heldNames(paths: readonly string[]): Promise<Set<string> | null> {
  const held = new Set<string>();
  const CHUNK = 128;                              // argv 有长度上限,别一把梭
  for (let i = 0; i < paths.length; i += CHUNK) {
    const chunk = paths.slice(i, i + CHUNK);
    const probe = await new Promise<{ err: ExecFileException | null; out: string; errOut: string }>(
      (res) => execFile("lsof", ["-F", "pn", "--", ...chunk],
        { maxBuffer: 8 << 20, timeout: PROBE_TIMEOUT_MS },
        (err, stdout, stderr) => res({ err, out: stdout || "", errOut: stderr || "" })),
    );
    // **一个分片答不出来就整问作废**(返回 null):没法只把这一片排除掉 —— 调用方拿到的集合
    // 是「谁有人握着」,少了一片就等于把那一片默认成「没人握着」,正是要避免的那一下。
    // 判据同 `trackHolders`:**退出 1 也可能是它自己出错**。批量这一侧更要紧 —— 一片里只要
    // 有一个路径没问清楚,「谁有人握着」这个集合就少了那一片,而调用方会把缺席读成「没人
    // 握着」然后删掉文件。所以这一片的 stderr 一有故障就整问作废。
    // 超时被中止也算这一片没问清楚(判据同 `trackHolders`:退出 1 也可能是它自己出错)。
    if (probe.err && (probe.err.code !== 1 || probe.err.killed || lsofFault(probe.errOut))) return null;
    for (const line of probe.out.split("\n")) {
      if (line.startsWith("n")) held.add(line.slice(1).split("/").pop() ?? "");
    }
  }
  return held;
}
