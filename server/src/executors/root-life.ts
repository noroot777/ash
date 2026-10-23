// **根这一代的生命周期** —— 「活着才取得到」的那份证据,登记在**创建那一刻**。
//
// Windows 上根退出之后 `ParentProcessId` 仍然留着,那是找回逃逸后代的唯一入口(见
// `escapees.ts` 顶部)。可父号是个裸数字,证明不了「这棵残留的树是我们那一代生的」——
// 能补上的证据只有一份:**我们那一代根的存活区间**。孩子的启动时刻落在区间里、父号又对
// 得上,它才算我们那一代的孩子(判据与真机读数见 `lineage.ts` 的 ②)。
//
// 上一版把这份区间记在「清扫时顺手取证」那条路上,于是两头都错,而且错的方向相反:
//
//  · **登记太晚**(第 17 轮审查 F3):`cleanupAfterRun` 跑在根 reap **之后** —— 正常完成那条
//    路压根建不起区间,Windows 上每一次正常完成都收不回逃逸后代。真机实测:根 11832、
//    真实直接孩子 7848 `ppid=11832`,两次 cleanup 都答 unknown,孩子还活着、心跳 14→83;
//    而额外先扫一次活根的对照组就能回收。这不只影响重启接管 —— 刚由同一个 ash 创建、没有
//    重启、身份没伪造的进程走的就是这条路。
//  · **封口太早**(第 17 轮审查 F2):上界的判据是「这一轮没在表上读到那一代」,而那一问
//    合法地会答「读不到」(Windows 的 `CreationDate` 给得出空串 ⇒ `tableFromRows` 把它放进
//    `unverified`)。根其实还活着,它之后才派生的真后代于是落在区间之外、被判成外人,既不
//    进名单也不留债,清理答 `empty`。真机实测:根 24388 活着时注入一次空 CreationDate,
//    后代 21788 的 `ppid` 确实是 24388,最终 `targets=[] open=[] answered=true`、债表空,
//    而它心跳 10→42 还在写。
//
// 所以这一摊的两条规矩,正是上面两条的反面:
//
//  ① **下界在创建那一刻登记**。那一刻的证据比任何一次查表都硬 —— 号就是内核刚发给我们的,
//    不需要「证明这个号此刻是我们那一代」这一步。而且 `Date.now()` 取在 `spawn()` 之前,
//    它一定不晚于根的真实出生,当下界是安全的。
//  ② **只有确证退出能封上界**。三种来源都是正面证明:`exit` 事件(内核 reap,最紧)、
//    表上**同源换代**(这个号上已经是另一代了)、号上压根没人。「这一轮读不到」既不是
//    证明也不是反证 —— 它只让这一刻的落点答 `unknown`,下一轮再问。
//
// 于是「我们那一代此刻在哪」有三档(`RootStand`),处置各不相同:存活已确认 ⇒ 上界开着;
// 退出已确认 ⇒ 区间两端齐全;这一轮未知 ⇒ **一个成员都不按父号扩**(调用方按「认不下也
// 否不掉」留债,见 `escapees.ts` 的 `reportUnattributableTree`)。
//
// **重启后接回的根落在第三档,那是合法状态不是 bug**:它不是我们创建的,①那一刻早就过去
// 了;Windows 上又读不到别人的环境块(记号这一问结构性 `unprovable`),所以 `childKillAuthorized`
// 永远答不出 ours。那一档如实退化成「留债、不下刀」。
import type { ChildProcess } from "node:child_process";
import { isPidAlive } from "../platform.js";
import {
  sameGenerationSource,
  type ProcessGeneration, type ProcessTableSnapshot,
} from "../process-generation.js";
import { genResolutionMs, genStartedAtMs } from "../process-subtrees.js";
import { childKillAuthorized, childStillOurs } from "./child-identity.js";
import type { LineageStand } from "./lineage.js";

type RootLife = {
  pid: number;
  /** 创建那一刻(内核权威的下界,见①)。 */
  from: number;
  /** 表上读到过的**我们那一代**(第一次读到才填):下界于是能换成与孩子同坐标系的那个。 */
  gen: ProcessGeneration | null;
  /** 确证退出的那一刻。`null` = 还没有任何一份**正面**退出证据(见②)。 */
  exitedAt: number | null;
};

// 合成句柄与真进程共享**同一个对象**(不是拷贝):两边任一处更新都看得见,而且不必让每个
// 创建入口记得把更新转发一遍。
const rootLives = new WeakMap<ChildProcess, RootLife>();

/**
 * **创建那一刻**登记这一代的下界(四个 spawn 入口各一处)。
 *
 * `bornAtMs` 要取在 `spawn()` **之前**:它只当「不可能更早」的下界,早一点安全、晚一点就会
 * 把根自己刚生的孩子判成外人。
 */
export function registerRootLife(child: ChildProcess, bornAtMs: number): void {
  if (!child.pid) return;                         // 起不来的桩:没有号就没有生命周期
  const life: RootLife = { pid: child.pid, from: bornAtMs, gen: null, exitedAt: null };
  rootLives.set(child, life);
  // 最紧的那份上界:`exit` 是内核 reap 的那一刻。句柄是刚出厂的,所以这个监听一定挂得上
  // (上一版把登记放在清扫时,那时句柄可能早就退了 —— Node 不会补发 `exit`)。
  if (typeof child.once === "function") {
    child.once("exit", () => closeRootLife(life));
  }
}

/** 合成句柄与真进程成对出厂:生命周期以真的那份为准(同 `shareChildIdentity` 的理由)。 */
export function shareRootLife(source: ChildProcess, target: ChildProcess): void {
  const life = rootLives.get(source);
  if (life) rootLives.set(target, life);
}

/** 上界只在这里写,而且只接**正面**退出证据(见②)。写过一次就不再改。 */
function closeRootLife(life: RootLife): void {
  if (life.exitedAt === null) life.exitedAt = Date.now();
}

/**
 * 每一次取证都来一遍:把这一张表里能确证的东西记下来。
 *
 * 三件事,**全都只写正面结论**:
 *  · 第一次读到我们那一代(要内核还认它是我们的,否则表上那一行可能已经是新主人);
 *  · 同源换代 ⇒ 我们那一代一定退了(跨问法的不等只是比不出来,不算反证);
 *  · 号上压根没人 ⇒ 我们那一代一定退了。
 *
 * **读不到一律不动上界** —— 那正是 F2 的形状。
 */
export function observeRootLife(child: ChildProcess, table: ProcessTableSnapshot): void {
  const life = rootLives.get(child);
  if (!life) return;
  const seen = table.gens.get(life.pid);
  if (life.gen === null) {
    if (seen && childStillOurs(child)) life.gen = seen;
  } else if (seen && seen !== life.gen && sameGenerationSource(seen, life.gen)) {
    closeRootLife(life);
  }
  if (!isPidAlive(life.pid)) closeRootLife(life);
}

/**
 * **我们那一代此刻在哪**(见文件头的三档)。`unknown` ⇒ 不许按父号扩树。
 *
 * 「还在这个号上」有两种证法,各自充分:内核权威的句柄状态(自己 spawn、还没 reap),以及
 * 表上那一行**就是我们记下的那一代**。前者在表读不到那一行时也成立 —— 那时下界退回登记
 * 那一刻(`from` 可能给不出同坐标系的值,于是在没有内核重父的平台上整棵树只能判 `murky`,
 * 那是对的:确实证不出)。
 */
export type RootStand = LineageStand | { state: "unknown" };

export function rootStand(child: ChildProcess, table: ProcessTableSnapshot): RootStand {
  const life = rootLives.get(child);
  const pid = life?.pid ?? child.pid ?? 0;
  const seen = pid ? table.gens.get(pid) : undefined;
  if (childKillAuthorized(child) || (life?.gen != null && seen === life.gen)) {
    return seen
      ? { state: "live", from: genStartedAtMs(seen), fromRes: genResolutionMs(seen) }
      // 表上没读到那一行、内核却说还是它:下界退回登记那一刻(`Date.now()` 与表上的墙上
      // 时钟同一把尺,精度 1ms)。没登记过就给不出下界。
      : { state: "live", from: life?.from ?? null, fromRes: 1 };
  }
  if (life?.exitedAt != null) {
    const fromGen = life.gen ? genStartedAtMs(life.gen) : null;
    return {
      state: "exited",
      from: fromGen ?? life.from,
      fromRes: fromGen !== null ? genResolutionMs(life.gen!) : 1,
      to: life.exitedAt,
      toRes: 1,
    };
  }
  return { state: "unknown" };
}
