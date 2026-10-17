// **pid 还空着的那一行:把它认回来** —— 身份恢复这一件事,从 monitors.ts 拆出来的那一摊。
//
// 拆出来的理由是行数(单文件 700 行的约定)加上它自己就是一个完整的判断:**哪一条判据有资格
// 认下一个号**。它有两个消费点(重启接回、回收层那一侧的 pid 还空着的行),判据只有这一份。
import { and, eq, isNull } from "drizzle-orm";
import { db } from "./db/index.js";
import { monitors } from "./db/schema.js";
import { authorizeRecoveredIdentity } from "./monitor-identity-authz.js";
import { readSpawnIdentity, type SpawnIdentity } from "./monitor-spawn.js";
import { processStartedNear } from "./proc.js";

/**
 * 认领要用到的那几列。**不是整行**(第 19 轮审查 F2):回收层那一侧手里只有自己 `select` 的
 * 几列,上一版这个函数要求整行 `Row`,于是那一侧压根没法问这一问 —— pid 空着就被当成
 * 「没有进程、也没有责任」一笔带过。
 */
export type AdoptSubject = { id: string; logPath: string; unitToken: string | null; command: string };

/** 认下来的身份。启动时刻可能为空 —— 那一档的出路见下面的 `unqueryable`。 */
export type AdoptIdentity = { pid: number; pidStartedAt: string | null };

/**
 * 认领的结论。认不下来时带上**这一刻的事实**,措辞由调用方据此挑:
 *  · `settled: true` —— 当初那个壳一定不在了(没留边条 / 反证过 / 那个号现在是另一个进程);
 *  · `settled: false` —— 只是**这一刻核实不了**(反证账本读不出来),不许说成「它不在了」。
 *
 * **两档都要把 `candidate` 带出来**(第 19 轮审查 F2):边条上记着的那个号虽然不配当发信号的
 * 凭证,它仍然是这次创建**唯一的落点线索**。调用方拿它去记意图级责任 —— 丢掉它就等于让一条
 * 「结局还没确认」的创建意图彻底失忆(审查实测:行写成 lost、pid 空、债表空,命令还在跑)。
 * 没有边条时它是 `null`:那种行连线索都没有(claude 的投影行就落在这里)。
 */
export type AdoptOutcome =
  | { identity: AdoptIdentity; why?: undefined; settled?: undefined; candidate?: undefined }
  | { identity: null; why: string; settled: boolean; candidate: SpawnIdentity | null };

/**
 * **pid 还空着的那一行:拿身份边条把它认回来**(第 9 轮审查 F3)。
 *
 * 边条是 `spawn` 一返回就同步写下的 `{pid, 那一刻}`(见 monitor-spawn.ts 文件头):ash 恰好
 * 死在「落了身份」和「回填 pid」之间时,库里只剩一行没有 pid 的记录 —— 而 win32 那一侧没有
 * 放行闸,命令可能已经在跑。上一版到这里只能说一句「认不回来」,留下 id、命令、日志路径,
 * 却**没有任何能用来定位那个进程的身份**(审查原话)。
 *
 * 认的判据是**代次**,不是存在性:`processStartedNear` 比的是「这个号上的进程是不是大约在
 * 那一刻起来的」。三档各有出路:
 *  · `same` ⇒ 连启动时刻一起回填,这一行从此跟正常接回的一样能停、能收、能记责任;
 *  · `unqueryable`(ps 这一刻不可用)⇒ **只回填 pid**,启动时刻留空 —— 写一个猜的进去就是把
 *    「无从比对」伪造成「已验证」,而那正是第 9 轮 F3 的那条判据。它随后落在 `unverifiable`
 *    档上:看得见、停得掉、记得下责任,但谁都不许据此下刀;
 *  · `different` ⇒ 这个号现在是另一个进程。一个号同时只能有一个进程,所以**当初那个壳一定
 *    不在了** —— 不认,由调用方照实写掉。
 *
 * **时间锚这条弱判据的资格要先界定**(第 16 轮审查 F1-B 的同族入口):记号那一问能答出来时
 * 它更强,而且它的**反证不许被「手里有个时间锚」洗掉** —— 否则一个在那两秒窗口里起来、
 * 命令文本又恰好对得上的陌生进程会被认成这条哨兵的身份(F1-B 在另一个消费点实测到了这一刀)。
 *
 * 那套判据**不在这个文件里**:它和实时回收/债务恢复那一侧共用 `monitor-identity-authz.ts`
 * 的 `authorizeRecoveredIdentity`(第 17 轮审查 F1 —— 上一版两边各写一份,`completeIdentity`
 * 那一份漏了 `none` 和「名单里没有这个号」两种反证)。
 */
export async function adoptSpawnIdentity(subject: AdoptSubject): Promise<AdoptOutcome> {
  const side = readSpawnIdentity(subject.logPath);
  if (!side) return { identity: null, why: "（连身份边条都没留下）", settled: true, candidate: null };
  const authz = await authorizeRecoveredIdentity({
    monitorId: subject.id, pid: side.pid, unitToken: subject.unitToken,
  });
  // `proven`:号已证明。换算答不出启动时刻时只回填 pid —— 跟下面那一档同一个出路(落在
  // `unverifiable` 档上:看得见、停得掉、记得下责任,但谁都不许据此下刀)。
  if (authz.ownership === "proven") return { identity: await writeAdopted(subject, side.pid, authz.startedAt) };
  // 已反证,或者反证账本这一刻读不出来 ⇒ 连号都不认,由调用方照实写掉。**两种的事实不同**:
  // 反证是「这个号不是它」(当初那个壳一定不在了);账本读不出来只是「这一刻核实不了」——
  // 后者不许被措辞成前者,否则又是「问不出来被写成它不在了」(第 6 轮审查 F1)。
  if (authz.refuse) {
    return authz.ownership === "disproved"
      ? { identity: null, why: `（身份边条记的 pid=${side.pid} 不是它：记号那一问反证过这个号）`, settled: true, candidate: side }
      : { identity: null, why: `（身份边条记的 pid=${side.pid} 这一刻核实不了：反证记录读不出来）`, settled: false, candidate: side };
  }
  // 剩下的是「归属证不出来」那一档(存量行没有记号、只看得见展示文本、ps/`/proc` 失败)。
  // **时间锚在这里只投否决票**(第 18 轮审查 F1):命令文本对不上、或者这个号上的进程明显不是
  // 那一次 spawn 留下的 ⇒ 不认;对得上也只认**号**,启动时刻一律留空 —— 一个窗口巧合不配当
  // 下刀凭证,而把它写进 `pid_started_at` 就等于让 `reclaimEvidence` 第 ② 步据此开刀。
  // 号认下来这件事本身仍然要做(第 9 轮审查 F3):否则这一行连「能用来定位那个进程的身份」
  // 都没有,只剩 id、命令和日志路径。
  const { verdict } = processStartedNear(side.pid, side.spawnedAtMs, 2_000, subject.command);
  if (verdict === "different") {
    return { identity: null, why: `（身份边条记的 pid=${side.pid} 现在是另一个进程）`, settled: true, candidate: side };
  }
  return { identity: await writeAdopted(subject, side.pid, null) };
}

/**
 * 认下来之后把 pid(和拿得到的启动时刻)回填进库。写不进去也要继续,见下。
 *
 * **守的是「这一列还空着」,不是状态**(第 19 轮审查 F2):创建意图行在点停、归档、删除那几条
 * 路上也要认得回来,而那时它早就不是 running 了。这一句只填空,永远不会动一个已经有号的行。
 */
async function writeAdopted(
  subject: AdoptSubject, pid: number, startedAt: string | null,
): Promise<AdoptIdentity> {
  try {
    await db.update(monitors)
      .set({ pid, pidStartedAt: startedAt })
      .where(and(eq(monitors.id, subject.id), isNull(monitors.pid)));
  } catch (e) {
    // 回填不进去也要继续:本进程这一轮照旧按这份身份收尾/接回,比当它不存在强。
    console.error(`[ash] 哨兵身份边条认回来了但写不进库 monitor=${subject.id} pid=${pid}:`, e);
  }
  return { pid, pidStartedAt: startedAt };
}

/**
 * **pid 还空着、这一刻又认不回来的那一行:原样留着**(第 19 轮审查 F2)。
 *
 * 行仍然是 running —— 那是实话:这一刻没有任何证据说它退了,而记号、日志路径和身份边条都还
 * 在原处,下一次启动、下一次点停、下一次删除都会重新问一遍(认领那一问在
 * `adoptSpawnIdentity`,销毁前的那一问在 `accountForLiveProcesses`)。
 *
 * 为什么不写成 lost:那一档的 pid 是空的,**此后谁都不会再问第二遍** —— 启动只选 running、
 * 回收层见 pid 空就返回「没有进程、也没有责任」、删除按 pid 非空过滤。于是「下一次启动会再问
 * 一遍」变成一句假话(审查实测:第二次启动 attached=0、清扫 0 条、债表空,任务删掉之后那个
 * 进程仍然活着)。
 *
 * 为什么也不顺手记一笔回收债:债是**补刀授权**(清扫会把能证明的都收掉),而这一行的进程多半
 * 正常跑着,只是 ash 这一刻认不回它的号 —— 候选号一个信号都不授权(见 `candidate`)。责任要在
 * 「有人要结束它」的那一刻才记:点停、归档、删除都会走回收层,那时它才是该收的。
 *
 * 话写在 `ended_reason` 上:那一列是卡片上「原因」那一行,**running 的行也照样显示**
 * (web/src/monitors/MonitorCard.tsx),所以这件事刷新页面之后仍然看得出来。
 */
export async function notePendingIntent(subject: { id: string }, why: string): Promise<string> {
  const note = `server 重启后这一刻认不回它：起进程时没来得及记下 pid${why}`
    + `，所以一个信号都没发；这条创建意图原样留着，下一次启动、点停或删除都会再问一遍（日志路径见这一行）`;
  try {
    await db.update(monitors).set({ endedReason: note })
      .where(and(eq(monitors.id, subject.id), eq(monitors.status, "running"), isNull(monitors.pid)));
  } catch (e) {
    console.error(`[ash] 哨兵认领受阻这件事写不进库 monitor=${subject.id}:`, e);
  }
  console.error(`[ash] 哨兵这一刻认不回身份，创建意图原样留着 monitor=${subject.id}：${note}`);
  return note;
}
