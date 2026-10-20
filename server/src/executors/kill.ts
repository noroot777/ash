// agent 进程的**生命周期收口**:三层击杀、逃逸后代追踪、「这个号此刻还是不是它」的身份
// 判据、以及追踪证据的寿命。从 spawn.ts 搬出来是因为那边是「怎么把 CLI 起起来」(环境、
// 命令解析、输出流水线),这边是「怎么把它和它甩出去的东西收干净」——两件事各自都在往
// 700 行上限靠,挤在一个文件里每改一处都要把另一摊整份读进上下文。
// 老使用方照旧从 `spawn.js` import:那边把这里的导出原样转出去。
import { execFile } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { tmpdir } from "node:os";
import { openSync, closeSync, existsSync, readdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { IS_WINDOWS, isPidAlive, killOne, killTree } from "../platform.js";
import { processIdentity } from "../proc.js";
import {
  processGenerationSync, processTreeMembers, stillSameGeneration,
  type ProcessGeneration, type ProcessMember,
} from "../process-generation.js";

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

// ── 归属事实 + 同源代次:**一份身份事实,探活 / 扩树 / TERM / 补刀共用** ──────────
//
// 号码不是身份。以前这一层对后代只有「号码」一个抓手,于是两头都错:
//
//  · **漏杀** —— 补刀前重新取证,取不到就当「这个号已经换了主人」而放过。可一个还活着的
//    后代完全可以**自己把那个继承 fd 关掉**(收到 SIGTERM 时顺手 close 的程序不少),它于此
//    一刻从 lsof 名单里消失,却继续在用户的工作目录里写文件(第 3 轮审查 F1 用生产
//    `openResident` + 真后台 Node 实测:心跳从 17 涨到 156,`stopResult=false`);
//  · **误杀** —— 反过来,先读到裸号码、隔着一次 await 再去问进程表要启动时刻,那个号这期间
//    换了主人时,新进程的代次就被写到了旧事实上,TERM 和补刀照着它下刀。
//
// 两头的根因是同一个:**事实和它那一代没有绑在一起**。所以这一层照 process-generation.ts
// 的规矩来 ——
//
//  ① 取证那一次读数**自己把代次带出来**(`processTreeMembers`:Linux 一次 `/proc/<pid>/stat`
//     同时给出 ppid 和 starttime,其它 POSIX 是 `ps` 的同一行,Windows 的进程表行自带);
//  ② 认过的后代**记在账上**(`escapeeLedger`),它丢掉 fd 也不会从账上消失;
//  ③ **每一刀之前拿账上那个戳重问一遍这个号**(`stillSameGeneration`)——
//     对得上就照杀(fd 丢了也杀),换代了就一刀都不发(号换了主人不杀)。
//
// fd 持有者那一步还隔着一次 `lsof`(它给不出启动时刻),所以用**两次取证夹住中间那次代次
// 读数**:只有前后两次 lsof 都认的号才进账。中间换了主人的号进不来 —— 新主人要同时握着
// 这个运行专属的文件,除非它本来就是我们的后代。
const escapeeLedger = new WeakMap<ChildProcess, Map<number, ProcessGeneration>>();

function rememberEscapees(child: ChildProcess, members: readonly ProcessMember[]): void {
  let ledger = escapeeLedger.get(child);
  if (!ledger) escapeeLedger.set(child, (ledger = new Map()));
  // 同一个号的代次变了 = 原来那个退了、这个号现在是另一个进程:**用这一次取证的那一代覆盖**
  // (能取到证就说明它也是我们的后代),而不是守着旧戳。
  for (const member of members) ledger.set(member.pid, member.gen);
}

/** 账上记过的 + 这一刻刚取到的,去重。丢了 fd 的那些就靠账上这一份留住。 */
function escapeeTargets(child: ChildProcess, fresh: readonly ProcessMember[]): ProcessMember[] {
  const merged = new Map<number, ProcessGeneration>(escapeeLedger.get(child) ?? []);
  for (const member of fresh) merged.set(member.pid, member.gen);
  return [...merged].map(([pid, gen]) => ({ pid, gen }));
}

/** 发这一刀。**每个成员各自重核代次** —— 对不上的一刀都不发,也不从账上划掉(它可能只是
 * 这一刻问不出来;下一次复核会再试)。 */
function signalMembers(members: readonly ProcessMember[], sig: NodeJS.Signals): number[] {
  const hit: number[] = [];
  for (const member of members) {
    if (member.pid <= 1 || member.pid === process.pid) continue;
    if (!stillSameGeneration(member)) continue;
    killOne(member.pid, sig);
    hit.push(member.pid);
  }
  return hit;
}

async function killEscapees(child: ChildProcess, sig: NodeJS.Signals): Promise<number[]> {
  const fresh = await collectEscapees(child);
  rememberEscapees(child, fresh);
  return signalMembers(escapeeTargets(child, fresh), sig);
}

/** `lsof -t <file>`:此刻还握着这次运行那个继承 fd 的号。查不到 / lsof 不可用都是空。 */
async function trackHolders(trackPath: string): Promise<number[]> {
  const out = await new Promise<string>((res) =>
    execFile("lsof", ["-t", trackPath], (_e, stdout) => res(stdout || "")),
  );
  const pids: number[] = [];
  for (const line of out.split("\n")) {
    const pid = Number(line.trim());
    if (pid > 1 && pid !== process.pid) pids.push(pid);
  }
  return pids;
}

/**
 * 这一刻能证明属于本次运行的后代,**各自带着代次**(见上面那段的①)。
 *
 * 证据有两种,都跟号码无关:继承了本次运行那个追踪 fd(文件对象),或者挂在一个身份已确认
 * 的根下面(ppid 树)。根进程的号不是证据 —— 只有它还是它(`treeRootUsable`)才能当树根,
 * 否则这棵「后代树」是别人的子进程(第 1 轮审查 F2)。
 */
async function collectEscapees(child: ChildProcess): Promise<ProcessMember[]> {
  const trackPath = trackFiles.get(child);
  const holders = trackPath ? await trackHolders(trackPath) : [];
  const roots = [...holders];
  if (child.pid && treeRootUsable(child)) roots.push(child.pid);
  if (!roots.length) return [];
  const found = await processTreeMembers(roots);
  if (!found) return [];                          // 问不出来 ≠ 没有后代:不杀也不记账
  // fd 持有者:**第二次 lsof 夹住**上面那次代次读数(理由见本文件的归属事实那段)。
  const confirmed = trackPath && holders.length ? new Set(await trackHolders(trackPath)) : new Set<number>();
  const out: ProcessMember[] = [];
  for (const member of found.roots) {
    if (member.pid === child.pid) continue;       // CLI 本体走进程组信号,不在这里补刀
    if (confirmed.has(member.pid)) out.push(member);
  }
  for (const member of found.descendants) {
    if (member.pid === child.pid) continue;
    out.push(member);
  }
  return out;
}

/**
 * 这个根的号能不能当「后代树」的树根。
 *
 * POSIX:只有身份对得上才行(根一退出,它的孩子立刻被重父到 init,以旧号为根的树本来就是
 * 空的,所以这一道闸不损失能力)。
 *
 * **Windows 分两档**,不能一句 `IS_WINDOWS` 全放过(第 3 轮审查 F1):那边退出后仍保留的
 * `ParentProcessId` 是唯一的找回手段(见本文件顶部),所以**号空着**时照旧走这棵残留的树;
 * 可**号被别人占着**时那棵树是人家的子进程,一个都不许扩。
 */
function treeRootUsable(child: ChildProcess): boolean {
  if (childStillOurs(child)) return true;
  return IS_WINDOWS && !!child.pid && !isPidAlive(child.pid);
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitForPidsGone(pids: readonly number[], timeoutMs: number): Promise<number[]> {
  const deadline = Date.now() + timeoutMs;
  let alive = pids.filter(isPidAlive);
  while (alive.length && Date.now() < deadline) {
    await wait(50);
    alive = pids.filter(isPidAlive);
  }
  return alive;
}

/**
 * 一次性 agent 的事件流已经收完:CLI 本体按理已经退出,但它用 `&` / `start /b`
 * 甩出去的后台后代可能还活着。此刻 ChildProcess 还在手里,是 Windows 上利用已死
 * ParentProcessId 找回它们的最后窗口;再往后只剩一个 worktree 路径,已经无法可靠
 * 区分「agent 遗留」和「用户自己开的终端」。
 *
 * 先给 SIGTERM/Windows taskkill,最多等 2 秒;残存者再补 SIGKILL。正常没有逃逸者时
 * 只做一次进程表快照,不会给每个回合平白加等待。
 *
 * **扫完了才放手证据,抛错不放手**(第 3 轮审查 F2):清理失败的那条路上调用方会再试一次
 * (codex 常驻把这个 child 留在 `unfinalized` 等下一轮 cleanup),那时还得靠同一个追踪文件
 * 取证。以前这一句挂在 `finally` 上,等于「失败也按成功放手」。
 */
export async function cleanupAfterRun(child: ChildProcess): Promise<void> {
  await sweepAfterRun(child);
  releaseTrackEvidence(child);
}

async function sweepAfterRun(child: ChildProcess): Promise<void> {
  const targets = new Set(await killEscapees(child, "SIGTERM"));
  // 判据与 killChild 同一条(childStillOurs):以前这里问的是 `isPidAlive`,那只能证明
  // 「有人占着这个号」—— 根进程先退出、号被复用之后,它指向的已经是别人(第 1 轮审查
  // F2)。根进程已退出就只扫后代,一刀都不往那个号上发。
  if (child.pid && childStillOurs(child)) {
    targets.add(child.pid);
    killTree(child.pid, "SIGTERM");
  }
  if (!targets.size) return;

  const survivors = await waitForPidsGone([...targets], 2000);
  if (!survivors.length) return;
  const killed: number[] = [];
  // 等的这 2 秒里根进程可能自己退了,号随时会被复用 —— 补刀前按同一判据再确认一次。
  if (child.pid && survivors.includes(child.pid) && childStillOurs(child)) {
    killTree(child.pid, "SIGKILL");
    killed.push(child.pid);
  }
  // 后代的补刀**按账上那份身份事实**:这 2 秒里它们正被 SIGTERM 催着退出,有的会顺手把
  // 继承 fd 关掉 —— 以前这里要求「此刻仍能取到证据」,于是那种进程被当成「号已换主」放过,
  // 活着继续写文件(第 3 轮审查 F1)。现在是「账上记过 + 代次仍对得上」⇒ 照杀;代次变了
  // ⇒ 号换了主人,一刀不发。
  killed.push(...(await killEscapees(child, "SIGKILL")));
  await waitForPidsGone(killed, 2000);
}

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
  const holders = await trackHolders(path);
  if (holders.some(isPidAlive)) {
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
 * 收 —— 否则 tmpdir 里会慢慢积空文件。判据两条,都不猜:
 *  · 文件名里那个创建者 pid **已经不在了**(还在就可能是另一个 ash 实例正用着它,
 *    多实例共用同一个 tmpdir);
 *  · 此刻**没有活着的持有者**(有就说明那一摊后代还在,证据得留着让人能查)。
 */
export async function sweepOrphanTrackFiles(): Promise<number> {
  if (IS_WINDOWS) return 0;                       // 那边不开追踪文件
  let names: string[];
  try {
    names = readdirSync(tmpdir());
  } catch {
    return 0;
  }
  let removed = 0;
  for (const name of names) {
    if (!name.startsWith(TRACK_PREFIX)) continue;
    const owner = Number(name.slice(TRACK_PREFIX.length).split("-")[0]);
    if (!Number.isInteger(owner) || owner === process.pid || isPidAlive(owner)) continue;
    const path = join(tmpdir(), name);
    if (leases.has(path) || !existsSync(path)) continue;
    if ((await trackHolders(path)).some(isPidAlive)) continue;
    try {
      unlinkSync(path);
      removed += 1;
    } catch {
      /* 别人先删了 / 没权限:下次启动再说 */
    }
  }
  return removed;
}

// ── 「这个号此刻还是它吗」:kill 与 cleanup 共用的唯一判据 ──────────────────────
//
// 自己 spawn 出来的孩子有**权威答案**:内核在父进程 reap 之前不会把 pid 分给别人,而
// Node 正是在 reap 到它时才填上 exitCode/signalCode —— 两个都还是 null,就等于这个号现在
// 一定还是它;任一个有值,就等于这个号已经可以被任意复用了。
//
// 反过来 `isPidAlive(pid)` 只能证明「有人占着这个号」,证明不了是谁:根进程先自己退出
// (落库那几百毫秒里完全来得及)、号被系统分给用户的别的程序之后,拿它当依据发信号就是
// 在杀无关进程。「它从登记集合里注销过没有」更答不了这个问题 —— 那只是 isRunning 的真假。
// 所以本文件里 kill 与 cleanup 两条路问的都是这一个函数。
//
// **合成 ChildProcess 没有这个权威答案**(detached.ts 对外返回的都是拼出来的对象):它的
// exitCode 是回调里补写的,真进程退出到回调之间有一段窗口;被信号带走而又没写下 rc 时它
// 永远停在 null,signalCode 则从来没人填 —— 拿它当「还是我们的进程」用,等于在一个早已
// 退出(号随时被复用)的号上发信号(第 2 轮审查 F1 实测复现)。所以合成品必须在出厂时声明
// 自己的身份来源,见 shareChildIdentity / markAdoptedChild。
//
// 后代不受这条限制:killEscapees 认的是「继承了我们那个追踪 fd / 挂在已确认的根下面」,
// 而且每个后代各自带着自己那一代(见本文件的归属事实那段)—— 所以根进程已经退出时
// **照样要扫后代**,只是不许再对那个号发信号。(第 1 轮审查 F2)
type ChildIdentity =
  /** 真进程还在我们手里(新起的 detached):身份委托给它,内核状态仍是权威答案。 */
  | { kind: "real"; source: ChildProcess }
  /** 只接管了一个号(重启后接回):身份就是号 + 启动时间,每次发信号前现查 ps。 */
  | { kind: "adopted"; pid: number; startedAt: string | null };
const childIdentities = new WeakMap<ChildProcess, ChildIdentity>();

/** 合成句柄与真进程成对出厂时调用:两者是同一个进程,身份以真的那份为准。 */
export function shareChildIdentity(source: ChildProcess, target: ChildProcess): void {
  childIdentities.set(target, { kind: "real", source });
}

/** 接管一个还活着的号时调用:此后对它的每一次信号都按 pid + 启动时间核身份。 */
export function markAdoptedChild(child: ChildProcess, pid: number, startedAt: string | null): void {
  childIdentities.set(child, { kind: "adopted", pid, startedAt });
}

const ownExitState = (child: ChildProcess): boolean => child.exitCode === null && child.signalCode === null;

export function childStillOurs(child: ChildProcess): boolean {
  const identity = childIdentities.get(child);
  if (!identity) return ownExitState(child);
  if (identity.kind === "real") return ownExitState(identity.source);
  return pidOwnership(identity.pid, identity.startedAt) === "ours";
}

// Terminate a running agent subprocess (manual stop). SIGTERM first so the CLI
// can wind down; a short fallback SIGKILL guarantees the process — and thus our
// output stream — actually ends even if the CLI ignores SIGTERM. Safe to call on
// the pre-flight failedChild stub (it has no real pid) and after exit.
// 三层击杀:①信号发给整个进程组(-pid,spawn 时 detached 使 child 为组长);
// ②killEscapees 按继承 fd / 已确认的根反查逃出进程组的后代(nohup 孤儿等),各自按代次
// 复核后处理;③2s 后对残存者(含期间新逃逸的、以及中途把 fd 关掉的)统一补 SIGKILL。
//
// **Windows 上第①层换成 `taskkill /T /F`,而且没有「优雅」这一档。** Windows 只有
// GUI 窗口收得到 WM_CLOSE,控制台程序不吃;Ctrl+C 只能发给同一个控制台组,而 agent
// 是 DETACHED_PROCESS 起的(没有控制台)。所以第一发就是强杀,CLI 没有落盘/收尾的
// 机会 —— 这是平台限制,如实记在这里。第②层退化成纯 ppid 树遍历(见 killEscapees),
// 第③层仍在(确认死透)。
export function killChild(child: ChildProcess): void {
  if (typeof child.kill !== "function") return;
  const signal = (sig: NodeJS.Signals) => {
    // 身份先于信号:已经 reap 过的号可能已经是别人的了(判据见 childStillOurs)。
    if (!childStillOurs(child)) return;
    if (child.pid) {
      killTree(child.pid, sig);
      return;
    }
    try {
      child.kill(sig);
    } catch {
      /* already gone */
    }
  };
  signal("SIGTERM");
  void killEscapees(child, "SIGTERM").catch(() => {});
  const t = setTimeout(() => {
    signal("SIGKILL");
    // 无论 CLI 死没死透,逃逸者一律补 SIGKILL —— stop 的语义就是全家结束。
    void killEscapees(child, "SIGKILL").catch(() => {});
  }, 2000);
  // Don't keep the event loop alive just for the fallback timer.
  (t as { unref?: () => void }).unref?.();
}

// 只有 pid 时的击杀(重启后接管的 agent 走这条 —— ChildProcess 句柄随上一个
// server 进程一起没了,追踪 fd 的 WeakMap 也没了)。
// 只剩三层里的第①③层:进程组信号 + 2s 后补 SIGKILL。第②层(继承 fd 反查逃逸者)
// 做不到,因为那份映射是内存态的。代价:重启前就已经逃出进程组的孤儿杀不到 ——
// 如实记在这里,别让以后的人以为这条路和 killChild 等价。
export function killByPid(pid: number, startedAt: string | null): void {
  if (!Number.isInteger(pid) || pid <= 1) return;
  if (pidOwnership(pid, startedAt) !== "ours") return;
  killTree(pid, "SIGTERM");
  const t = setTimeout(() => {
    // **补刀不看组长死没死。** 以前这里是 `if (isPidAlive(pid))`，等于拿「组长还在吗」
    // 当「这一组还在吗」——可这两件事恰恰在最该补刀的现场分开：外层 shell / 包管理器
    // 收到 SIGTERM 老老实实退了，它派生的那个**忽略 SIGTERM** 的东西（用户仓库里的
    // preinstall/postinstall 是任意代码，node-gyp、自己管子进程的脚本都算）还留在原
    // 进程组里。组长一死，补刀被跳过，那个进程就永远留下了——而接口已经回了句「已停止」。
    // killTree 打的是进程组（POSIX 上 `kill(-pid)`），组空了是 ESRCH，被它自己吞掉，
    // 所以无条件发这一刀没有副作用。但**号被别人占去了就不能发**——那一刀会打到人家
    // 的进程组上(判据见 pidOwnership)。
    if (pidOwnership(pid, startedAt) === "ours") killTree(pid, "SIGKILL");
  }, 2000);
  (t as { unref?: () => void }).unref?.();
}

// ── 只有 pid 时的归属判定:三档,「证不出来」独立成档 ─────────────────────────────
//
//   · `ours`       —— 号上就是那一代(启动时刻对得上);或者调用方当初没记启动时刻、
//                     而这个号此刻有人占着(退化成存在性检查,见下面那段);或者**号空着、
//                     但这一刀发生在我们刚刚确认过它的那一小会儿之内**;
//   · `foreign`    —— 号上是别人,一刀都不许发;
//   · `unprovable` —— 这一刻证不出来(ps 不可用),或者**号空着而且我们并没有刚确认过它**。
//
// 最后那一档是第 3 轮审查 F1 指出的缝。以前「号没人占」是无条件放行的,理由是「新进程不会
// 跑进一个以空号为 id 的进程组」—— 可那条推理漏了一步:这个号被复用成**新的组长**、新组长
// 自己又先退了,这时它留下的那一组的组 id 同样是个空号。停止按钮在组长死了几小时之后按下
// 来,那一刀就打在人家的组上。
//
// 所以「号空着」只在**我们自己这一次击杀序列里**作数:首发之前必须拿到正面身份(那一刻它
// 还活着、而且就是它),登记进 `confirmedPids`;2 秒后的补刀发现号空了,靠这条刚登记的事实
// 放行 —— 正是「组长收到 TERM 退了、忽略 TERM 的后代还在原组里」那个真实现场。超出这个窗口
// (比如接回之后它早就死了)就只能说「证不出来」,不下刀。
const PID_CONFIRM_GRACE_MS = Number(process.env.ASH_PID_CONFIRM_GRACE_MS ?? 60_000);
const confirmedPids = new Map<number, { gen: ProcessGeneration | null; at: number }>();

type PidOwnership = "ours" | "foreign" | "unprovable";

function pidOwnership(pid: number, startedAt: string | null): PidOwnership {
  if (!Number.isInteger(pid) || pid <= 1) return "foreign";
  switch (pidIdentity(pid, startedAt)) {
    case "ours": return "ours";
    case "foreign": return "foreign";
    case "unknown": return "unprovable";             // 还活着、这一刻问不出来 ⇒ 不下刀
    case "empty": break;
  }
  // 号空着:只认**刚刚正面确认过它**的那一次(探活或这次击杀的首发)。
  const seen = confirmedPids.get(pid);
  if (!seen) return "unprovable";
  if (Date.now() - seen.at > PID_CONFIRM_GRACE_MS) {
    confirmedPids.delete(pid);
    return "unprovable";
  }
  return "ours";
}

/**
 * **探活与击杀共用的那一次身份读数。**
 *
 * 为什么非得是同一份:接回的那条路上,「这个号还是不是它」要被问两种人 —— 退出轮询
 * (它该不该宣布这一轮结束)和击杀(这一刀能不能发)。两边各读一次、各自解释,就又回到
 * 「号码当身份」:轮询拿 `kill(pid,0)` 当活着,击杀拿「号空着」当自家的组(第 3 轮审查 F1
 * 的第 4、5 条)。现在是一个函数:**它每答一次「还是它」,这次确认就记在册上**,所以紧接着
 * 发生的补刀能据此放行 ——「组长刚刚还活着、这一刀发出时它已经退了」那个真实现场因此仍然
 * 收得干净,而「几小时前就死了的号」仍然证不出、不下刀。
 */
function pidIdentity(pid: number, startedAt: string | null): "ours" | "foreign" | "unknown" | "empty" {
  const verdict = processIdentity(pid, startedAt);
  // `unverifiable` = 调用方当初没记启动时刻。这一问因此比不出代次,只能退化成存在性检查
  // —— 老使用方(拿锁、接管 agent)要的本来就是存在性;传 null 的含义是「我没记」,不是
  // 「不用查」(第 2 轮审查 F1)。
  if (verdict === "same" || verdict === "unverifiable") {
    confirmedPids.set(pid, { gen: processGenerationSync(pid), at: Date.now() });
    return "ours";
  }
  if (verdict === "different") return "foreign";      // 号换了主人 ⇒ 当初那个已经没了
  return isPidAlive(pid) ? "unknown" : "empty";
}

/**
 * 只有 pid 时的**退出探活**(接回的那一轮靠它收尾)。三档,别折成布尔:
 *  · `alive`   —— 还是它(或者当初没记启动时刻、此刻号上有人);
 *  · `gone`    —— 号空了,或者号已经换了主人 ⇒ 当初那个一定已经退了;
 *  · `unknown` —— 这一刻问不出来(ps 不可用)。**不许据此宣布退出**,它可能还活着。
 */
export function pidRunStillAlive(pid: number, startedAt: string | null): "alive" | "gone" | "unknown" {
  if (!Number.isInteger(pid) || pid <= 1) return "gone";
  switch (pidIdentity(pid, startedAt)) {
    case "ours": return "alive";
    case "unknown": return "unknown";
    default: return "gone";
  }
}
