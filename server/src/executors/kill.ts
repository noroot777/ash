// agent 进程的**生命周期收口**:三层击杀、逃逸后代追踪、「这个号此刻还是不是它」的身份
// 判据、以及追踪证据的寿命。从 spawn.ts 搬出来是因为那边是「怎么把 CLI 起起来」(环境、
// 命令解析、输出流水线),这边是「怎么把它和它甩出去的东西收干净」——两件事各自都在往
// 700 行上限靠,挤在一个文件里每改一处都要把另一摊整份读进上下文。
// 老使用方照旧从 `spawn.js` import:那边把这里的导出原样转出去。
import { execFile, execFileSync } from "node:child_process";
import type { ChildProcess, ExecFileException } from "node:child_process";
import { tmpdir } from "node:os";
import { openSync, closeSync, existsSync, readdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { IS_WINDOWS, isPidAlive, killOne, killTree } from "../platform.js";
import { processIdentity } from "../proc.js";
import { canShoot, killProvenUnit, reclaimState } from "../monitor-reclaim-evidence.js";
import { unitTokenOf } from "./unit-token.js";
import {
  processGroupMembersSync, processTreeMembers, stillSameGeneration,
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

/**
 * **「谁还握着这个文件」这一问的三档回答** —— 上一版把它折成了 `number[]`,于是
 * 「确证没人握着」和「这一问自己失败了」长得一模一样(空数组)。审查实测的后果:注入一个
 * 退出码 2、零输出的 `lsof`,周期复核与启动清扫**两条路都把还有活持有者的证据删掉了** ——
 * 而在 POSIX 上根退出、后代重父之后,这个文件名正是继续找回那些后台持有者的唯一线索。
 *
 * 所以这一层的规矩跟记号那一问同源(proc.ts 的四档):**只有「问全了、确实没有」才允许
 * 销毁证据**;问不出来要保留文件、保留清理责任,安排下一次重试。
 */
type HolderProbe =
  /** 确证有人握着(至少这几个号)。 */
  | { kind: "held"; pids: number[] }
  /** 确证**问全了**、而且一个持有者都没有 —— 唯一允许销毁证据的那一档。 */
  | { kind: "empty" }
  /** 这一问自己没答出来(lsof 不在、报错、超时、输出不完整)。**不等于没有**。 */
  | { kind: "unknown" };

/**
 * `lsof -t <file>`:此刻还握着这次运行那个继承 fd 的号。
 *
 * 退出码分档按 lsof 自己的约定:`1` = 没有匹配(文件不存在也算,那就是确证空);`≥2` = 它自己
 * 出错;`ENOENT` = 这台机器上没有 lsof ⇒ 后两者都只能答「问不出来」。
 */
async function trackHolders(trackPath: string): Promise<HolderProbe> {
  const probe = await new Promise<{ err: ExecFileException | null; out: string }>((res) =>
    execFile("lsof", ["-t", "--", trackPath], (err, stdout) => res({ err, out: stdout || "" })),
  );
  if (probe.err && !probeExitCodeMeansEmpty(probe.err)) return { kind: "unknown" };
  const pids: number[] = [];
  for (const line of probe.out.split("\n")) {
    const pid = Number(line.trim());
    if (pid > 1 && pid !== process.pid) pids.push(pid);
  }
  return pids.length ? { kind: "held", pids } : { kind: "empty" };
}

/**
 * lsof 这次非零退出,算不算「问全了、没找到」。
 *
 * 只有它自己约定的「无匹配」(退出码 1)算 —— 包括「那个文件根本不在了」,那确实是确证空。
 * `≥2` 是它自己出错,`ENOENT`(字符串)是这台机器上没有 lsof:两者都只能答「问不出来」。
 */
function probeExitCodeMeansEmpty(err: ExecFileException): boolean {
  return err.code === 1;
}

/** 只想知道「还有没有活着的持有者」的那几处:`unknown` 必须**当成有**(不许据此释放)。 */
const holdersMayExist = (probe: HolderProbe): boolean =>
  probe.kind === "unknown" || (probe.kind === "held" && probe.pids.some(isPidAlive));

/**
 * 这一刻能证明属于本次运行的后代,**各自带着代次**(见上面那段的①)。
 *
 * 证据有两种,都跟号码无关:继承了本次运行那个追踪 fd(文件对象),或者挂在一个身份已确认
 * 的根下面(ppid 树)。根进程的号不是证据 —— 只有它还是它(`treeRootUsable`)才能当树根,
 * 否则这棵「后代树」是别人的子进程(第 1 轮审查 F2)。
 */
async function collectEscapees(child: ChildProcess): Promise<ProcessMember[]> {
  const trackPath = trackFiles.get(child);
  const probe = trackPath ? await trackHolders(trackPath) : ({ kind: "empty" } as HolderProbe);
  // `unknown` 在这里的后果只是「这一轮少了一批树根」,不会误杀 —— 但它**不许**顺势变成
  // 「清理成功」,所以 cleanupAfterRun 那边据此不释放证据(见那个函数)。
  const holders = probe.kind === "held" ? probe.pids : [];
  const roots = [...holders];
  if (child.pid && treeRootUsable(child)) roots.push(child.pid);
  if (!roots.length) return [];
  const found = await processTreeMembers(roots);
  if (!found) return [];                          // 问不出来 ≠ 没有后代:不杀也不记账
  // fd 持有者:**第二次 lsof 夹住**上面那次代次读数(理由见本文件的归属事实那段)。
  const recheck = trackPath && holders.length ? await trackHolders(trackPath) : ({ kind: "empty" } as HolderProbe);
  // 夹住那一问失败时**整份丢掉 fd 这条候选**(只留 ppid 树那条):拿不到第二次读数就等于
  // 没夹住,代次可能已经换了。宁可这一轮少补一刀,也不拿一份没夹住的名单下刀。
  const confirmed = recheck.kind === "held" ? new Set(recheck.pids) : new Set<number>();
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
  if (childKillAuthorized(child)) return true;
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
  const swept = await sweepAfterRun(child);
  // **只有「这一轮真的问清楚了」才放手证据。** 抛错不放手之外还有一类:外部查询自己失败
  // (lsof 报错/不在、进程表问不出来)——那种失败被 `trackHolders`/`processTreeMembers` 吞在
  // 里面,不会抛到这里,于是上一版照样走到下面这句,把「问不出来」当成了「清扫成功」
  // (第 2 轮审查 F2 的同类出口)。现在它如实往上传,这一档留着文件和责任,下一轮再试。
  if (!swept) return;
  releaseTrackEvidence(child);
}

/** 返回值 = **这一轮的清扫问清楚了没有**(false ⇒ 外部查询失败过,证据不许释放)。 */
async function sweepAfterRun(child: ChildProcess): Promise<boolean> {
  const trackPath = trackFiles.get(child);
  // 清扫前先问一次:这一问失败就说明「还有没有逃逸者」这件事这一轮没有答案。
  const probed = trackPath ? (await trackHolders(trackPath)).kind !== "unknown" : true;
  const targets = new Set(await killEscapees(child, "SIGTERM"));
  // 判据与 killChild 同一条(childStillOurs):以前这里问的是 `isPidAlive`,那只能证明
  // 「有人占着这个号」—— 根进程先退出、号被复用之后,它指向的已经是别人(第 1 轮审查
  // F2)。根进程已退出就只扫后代,一刀都不往那个号上发。
  if (child.pid && childKillAuthorized(child)) {
    targets.add(child.pid);
    killTree(child.pid, "SIGTERM");
  }
  if (!targets.size) return probed;

  const survivors = await waitForPidsGone([...targets], 2000);
  if (!survivors.length) return probed;
  const killed: number[] = [];
  // 等的这 2 秒里根进程可能自己退了,号随时会被复用 —— 补刀前按同一判据再确认一次。
  if (child.pid && survivors.includes(child.pid) && childKillAuthorized(child)) {
    killTree(child.pid, "SIGKILL");
    killed.push(child.pid);
  }
  // 后代的补刀**按账上那份身份事实**:这 2 秒里它们正被 SIGTERM 催着退出,有的会顺手把
  // 继承 fd 关掉 —— 以前这里要求「此刻仍能取到证据」,于是那种进程被当成「号已换主」放过,
  // 活着继续写文件(第 3 轮审查 F1)。现在是「账上记过 + 代次仍对得上」⇒ 照杀;代次变了
  // ⇒ 号换了主人,一刀不发。
  killed.push(...(await killEscapees(child, "SIGKILL")));
  await waitForPidsGone(killed, 2000);
  return probed;
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
  // **问不出来也算有**(`holdersMayExist`):一次失败的查询不配当销毁证据的依据,它只说明
  // 「这一问没答出来」。这一档安排下一轮复核,证据与清理责任都留着(第 2 轮审查 F2)。
  if (holdersMayExist(await trackHolders(path))) {
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
    const probe = await new Promise<{ err: ExecFileException | null; out: string }>((res) =>
      execFile("lsof", ["-F", "pn", "--", ...chunk], { maxBuffer: 8 << 20 },
        (err, stdout) => res({ err, out: stdout || "" })),
    );
    // **一个分片答不出来就整问作废**(返回 null):没法只把这一片排除掉 —— 调用方拿到的集合
    // 是「谁有人握着」,少了一片就等于把那一片默认成「没人握着」,正是要避免的那一下。
    if (probe.err && !probeExitCodeMeansEmpty(probe.err)) return null;
    for (const line of probe.out.split("\n")) {
      if (line.startsWith("n")) held.add(line.slice(1).split("/").pop() ?? "");
    }
  }
  return held;
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

/**
 * **「这个号此刻还是它吗」—— 探活档。**
 *
 * 跟下面那个 `childKillAuthorized` 是两个问题,别合成一个(第 2 轮审查 F2 的同类教训):
 * 这一问的使用方是「要不要继续扫它」「证据还该留着吗」,**判不出来的后果是多留一会儿**;
 * 那一问要授权破坏性操作,判不出来就必须一刀不发。合成一个的代价是方向相反的两种错误里
 * 必有一种:要么拿探活档去下刀(杀到别人),要么拿授权档去判存活 —— 后者会让「证不出」
 * 走向**删掉还有用的证据**,正是 F2 要堵的那个出口。
 */
export function childStillOurs(child: ChildProcess): boolean {
  const identity = childIdentities.get(child);
  if (!identity) return ownExitState(child);
  if (identity.kind === "real") return ownExitState(identity.source);
  return pidRunStillAlive(identity.pid, identity.startedAt) !== "gone";
}

/**
 * **「敢不敢对它发信号」—— 授权档。**
 *
 * 自己 spawn 的孩子有内核权威答案(父进程 reap 之前这个号不会给别人),所以 `real` 那两档
 * 照旧。接回来的号只有 pid + 启动时刻,POSIX 上那是粗档 —— 归属要问共用那一层:记号,
 * 或者这一次运行独有的输出文件(见 `killByPid` 的两级证据)。
 */
function childKillAuthorized(child: ChildProcess): boolean {
  const identity = childIdentities.get(child);
  if (!identity) return ownExitState(child);
  if (identity.kind === "real") return ownExitState(identity.source);
  return canShoot(reclaimState(identity.pid, identity.startedAt, { unitToken: unitTokenOf(child) }));
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
    // 身份先于信号:已经 reap 过的号可能已经是别人的了(判据见 childKillAuthorized)。
    if (!childKillAuthorized(child)) return;
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
export function killByPid(
  pid: number,
  startedAt?: string | null,
  proof?: { unitToken?: string | null; outPath?: string | null },
): void {
  if (!Number.isInteger(pid) || pid <= 1) return;
  const unit = { unitToken: proof?.unitToken ?? null };
  // ① 记号那一问。判档这一次只为分流;**下刀本身不吃这份快照** —— killProvenUnit 自己
  // `fresh` 取证,授权不跨出它那个同步段(理由见那边第 13/14 轮审查那几段注释)。
  if (canShoot(reclaimState(pid, startedAt ?? null, unit))) {
    killProvenUnit(pid, startedAt ?? null, unit);
    return;
  }
  // ② 记号证不出来(最常见的是这一行建在记号上线之前,库里只有 pid)。POSIX 的秒级启动
  // 时刻是粗档,单凭它下刀就是在赌一次秒级碰撞 —— 那是明确实测过的误杀。
  //
  // 但 agent 这一侧还有一条哨兵没有的线索,而且它比记号**更硬**:这一次运行独有的输出文件。
  // 根进程的 stdout 就重定向在它上面,所以「谁还握着它」问的正是「这一次运行的根还在不在」;
  // 路径里带着 sessionId + 回合起点,别的运行不会碰它,而且它跟记号一样跨得过 server 重启
  // (`sessions.agent_out_path`)。关键区别:这是 `lsof` 的**真实 fd 表**,不是 macOS 上
  // 那种无边界的展示文本 ⇒ 精确可答,够当粗档要的那第二份独立证据。
  //
  // 注意它只证明得了**根**(fd 1 无条件继承,但 CLI 会把它自己子进程的 stdout 接成管道),
  // 而这条路要的恰好就是根:下刀打的是根的进程组。
  if (outPathProvesRoot(pid, proof?.outPath ?? null)) {
    // **第一刀之前把组成员连代次一起记下来** —— 就在根仍被证明着的这一刻。少了这一步,
    // 「外层壳吃了 TERM 老实退场、它派生的那个忽略 TERM 的东西还留在原组里」这个现场就
    // 收不干净:根一死,组号成了空号,两秒后那一刀打在空组上(ESRCH),而那个进程还在写文件。
    // 结构跟 killProvenUnit 一致(它对记号那一档做的是同一件事)。
    const held = processGroupMembersSync(pid) ?? [];
    killTree(pid, "SIGTERM");
    const t = setTimeout(() => {
      // 补刀前**重新取一次同一份证据**:这两秒里根可能已经退了、号可能被接手。
      // 以前这一刀是无条件的 —— 哨兵那边的注释早就点过这个毛病。
      if (outPathProvesRoot(pid, proof?.outPath ?? null)) killTree(pid, "SIGKILL");
      // 再把第一刀那会儿记下的成员补上:**代次没变才打**(变了就是号换了主人)。
      // 这一下不要求根现在还活着 —— 第一刀本来就是来结束它的。
      signalMembers(held.filter((m) => m.pid !== pid), "SIGKILL");
    }, 2000);
    (t as { unref?: () => void }).unref?.();
    return;
  }
  // ③ 两条线索都证不出来:不下刀,但要留下痕迹 —— 根约定「停止/暂停必须留下持久可见的
  // 状态」,静默失败会让用户只能得出「按钮坏了」。
  console.warn(
    `[ash] 没能证明 pid=${pid} 属于这一次运行(记号${unit.unitToken ? "对不上" : "缺失"}、`
    + `输出文件${proof?.outPath ? "也问不出持有者" : "未提供"}),`
    + "按「证不出就不下刀」处理:没有发送任何信号",
  );
}

/**
 * **这个号此刻还握着这一次运行的输出文件吗** —— 粗档 pid 要的那第二份独立证据。
 *
 * 同步实现是刻意的:取证与下刀必须在同一个同步段里完成,中间隔一次 `await`,这个号就可能
 * 已经退出并被别人接手(那是哨兵第 13/14 轮审查反复实测的同一条缝)。单文件 `lsof` 比那边
 * 的全表 `ps` 便宜得多。
 *
 * 三档里只有「确证握着」返回 true:问不出来(lsof 不在、报错)一律当证不出 —— 这一问是用来
 * **授权破坏性操作**的,不许让一次失败的查询变成放行票。
 */
function outPathProvesRoot(pid: number, outPath: string | null): boolean {
  if (!outPath || IS_WINDOWS) return false;       // win32 没有 lsof;那边 pid 时刻本来就是排他档
  try {
    const out = execFileSync("lsof", ["-t", "--", outPath], {
      encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 4000,
    });
    for (const line of out.split("\n")) {
      if (Number(line.trim()) === pid) return true;
    }
    return false;
  } catch {
    return false;                                 // 非零退出(无匹配)与查询失败都不算证明
  }
}

// ── 只有 pid 时的归属:判据不在这里,在共用的那一层 ─────────────────────────────
//
// 这一段原先自己实现了一套三档归属判定,外加一个「60 秒内正面确认过就放行空号」的备忘
// (`confirmedPids`)。两样都删了,理由是审查实测出来的同一件事:**确认过一个号上有活进程,
// 不等于确认它属于这一次运行**。那份备忘只按 pid 键控,于是另一次调用明确判定「这不是你的」
// 之后,先前那条确认记录会把它洗回通过;而「刚刚确认过」本身也从来不是对一个现存进程组的
// 所有权证明,缩短那个时间窗只是把同一个漏洞变窄。
//
// 现在归属与「敢不敢下刀」统一问 `monitor-reclaim-evidence.ts`:
//
//  · 判据是**这一次运行独有的资源记号**(executors/unit-token.ts 种进环境,`reclaimEvidence`
//    判档),粗档的 pid + 秒级启动时刻只有在记号给出第二份独立证据时才算授权;
//  · 下刀只打**这一刻证明过**的那几个:根还活着就打整组(覆盖期间新派生的),根已经不在就
//    **逐个打证明过的成员、绝不打组** —— 孤儿后代的组号是那个已经死掉的根的号,`kill(-member)`
//    打的是「组号恰好等于这个成员 pid」的另一组(那是第 12 轮审查实测过的误杀);
//  · 两秒后那一刀自己重新取证,名单按代次复核,对不上一刀都不发。
//
// 那一层的注释里早就点出过这边的毛病:「不借用 executors/spawn.ts 的 killByPid:它的 +2 秒
// 那一刀是无条件的」。现在这条路反过来接到它上面,无条件补刀随之消失。

/**
 * 只有 pid 时的**退出探活**(接回的那一轮靠它收尾)。三档,别折成布尔:
 *  · `alive`   —— 还是它(或者当初没记启动时刻、此刻号上有人);
 *  · `gone`    —— 号已经换了主人,或者号上没有进程 ⇒ 当初那个一定已经退了;
 *  · `unknown` —— 这一刻问不出来(ps 不可用)。**不许据此宣布退出**,它可能还活着。
 *
 * **这个函数不再给击杀留任何记录。** 上一版它每答一次「还是它」就把这次确认记进备忘,让
 * 紧随其后的补刀据此对一个空号下刀 —— 审查实测那份备忘只按 pid 键控,会把另一次明确的
 * 「这不是你的」洗回通过。探活和授权是两个问题:这里只答「它还在不在」,敢不敢下刀由
 * `reclaimEvidence` 按记号独立判(见上面那段)。「组长刚退、忽略 TERM 的后代还在组里」那个
 * 真实现场由 killProvenUnit 的两秒复核收掉,不需要这边垫一张票。
 */
export function pidRunStillAlive(pid: number, startedAt: string | null): "alive" | "gone" | "unknown" {
  if (!Number.isInteger(pid) || pid <= 1) return "gone";
  switch (processIdentity(pid, startedAt)) {
    // `unverifiable` = 调用方当初没记启动时刻,这一问只能退化成存在性检查 —— 老使用方
    // (拿锁、接管)要的本来就是存在性(第 2 轮审查 F1)。
    case "same": case "unverifiable": return "alive";
    case "different": return "gone";              // 号换了主人 ⇒ 当初那个一定没了
    default: return isPidAlive(pid) ? "unknown" : "gone";
  }
}
