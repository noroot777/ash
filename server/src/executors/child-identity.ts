// **「这个号此刻还是不是它」** —— agent 句柄的身份判据,全仓唯一一份。
//
// 从 kill.ts 搬出来是因为它有三个互不相识的使用方(击杀、追踪证据的租约、逃逸后代枚举),
// 而那三摊各自都在往 700 行上限靠;更要紧的是**依赖方向**:判据不许反过来依赖它们中的
// 任何一个,否则「租约复核要问身份、身份要问租约」就成了环。
import type { ChildProcess } from "node:child_process";
import { isPidRunning } from "../platform.js";
import { runningIdentity } from "../proc.js";
import { canShoot, reclaimState } from "../monitor-reclaim-evidence.js";
import { unitTokenOf } from "./unit-token.js";

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

/**
 * 接回来那一档的**身份本体**(号 + 接管时核下来的启动时刻),不是接回来的就给 null。
 *
 * 开给外面是因为「这个号当初是哪一代」只有这里有权威答案:真进程那一档可以现查(还在我们
 * 手里就一定是它),接回来那一档**不能现查** —— 它早就不在我们的 reap 范围里,根先退出、号
 * 被系统分给别人之后,现查到的是那个陌生进程的代次。(第 6 轮审查 N10)
 */
export function adoptedIdentityOf(child: ChildProcess): { pid: number; startedAt: string | null } | null {
  const identity = childIdentities.get(child);
  return identity?.kind === "adopted" ? { pid: identity.pid, startedAt: identity.startedAt } : null;
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
export function childKillAuthorized(child: ChildProcess): boolean {
  const identity = childIdentities.get(child);
  if (!identity) return ownExitState(child);
  if (identity.kind === "real") return ownExitState(identity.source);
  return canShoot(reclaimState(identity.pid, identity.startedAt, { unitToken: unitTokenOf(child) }));
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
  switch (runningIdentity(pid, startedAt)) {
    // `unverifiable` = 调用方当初没记启动时刻,这一问只能退化成存在性检查 —— 老使用方
    // (拿锁、接管)要的本来就是存在性(第 2 轮审查 F1)。
    case "same": case "unverifiable": return "alive";
    case "different": return "gone";              // 号换了主人 ⇒ 当初那个一定没了
    // 僵尸:它 `exit` 过了,收不到信号也不会再写 —— 探活这一问要的正是这个(判据在
    // `runningIdentity`;这一档接进来之前,没人收割的根会永远答「还活着」)。
    case "exited": return "gone";
    default: return isPidRunning(pid) ? "unknown" : "gone";
  }
}
