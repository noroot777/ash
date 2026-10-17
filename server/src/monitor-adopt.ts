// **pid 还空着的那一行:把它认回来** —— 身份恢复这一件事,从 monitors.ts 拆出来的那一摊。
//
// 拆出来的理由是行数(单文件 700 行的约定)加上它自己就是一个完整的判断:**哪一条判据有资格
// 认下一个号**。它只被 `reattachMonitors` 用一次,运行时仍然只有 monitors.ts 那一份。
import { and, eq, isNull } from "drizzle-orm";
import { db } from "./db/index.js";
import { monitors } from "./db/schema.js";
import type { Row } from "./monitors.js";
import { authorizeRecoveredIdentity } from "./monitor-identity-authz.js";
import { readSpawnIdentity } from "./monitor-spawn.js";
import { processStartedNear } from "./proc.js";

/**
 * 认领的结论。认不下来时带上**这一刻的事实**,措辞由调用方据此挑:
 *  · `settled: true` —— 当初那个壳一定不在了(没留边条 / 反证过 / 那个号现在是另一个进程);
 *  · `settled: false` —— 只是**这一刻核实不了**(反证账本读不出来),不许说成「它不在了」。
 */
export type AdoptOutcome =
  | { row: Row; why?: undefined; settled?: undefined }
  | { row: null; why: string; settled: boolean };

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
export async function adoptSpawnIdentity(row: Row): Promise<AdoptOutcome> {
  const side = readSpawnIdentity(row.logPath);
  if (!side) return { row: null, why: "（连身份边条都没留下）", settled: true };
  const authz = await authorizeRecoveredIdentity({
    monitorId: row.id, pid: side.pid, unitToken: row.unitToken,
  });
  // `proven`:号已证明。换算答不出启动时刻时只回填 pid —— 跟下面那一档同一个出路(落在
  // `unverifiable` 档上:看得见、停得掉、记得下责任,但谁都不许据此下刀)。
  if (authz.ownership === "proven") return { row: await writeAdopted(row, side.pid, authz.startedAt) };
  // 已反证,或者反证账本这一刻读不出来 ⇒ 连号都不认,由调用方照实写掉。**两种的事实不同**:
  // 反证是「这个号不是它」(当初那个壳一定不在了);账本读不出来只是「这一刻核实不了」——
  // 后者不许被措辞成前者,否则又是「问不出来被写成它不在了」(第 6 轮审查 F1)。
  if (authz.refuse) {
    return authz.ownership === "disproved"
      ? { row: null, why: `（身份边条记的 pid=${side.pid} 不是它：记号那一问反证过这个号）`, settled: true }
      : { row: null, why: `（身份边条记的 pid=${side.pid} 这一刻核实不了：反证记录读不出来）`, settled: false };
  }
  // 剩下的是「归属证不出来」那一档(存量行没有记号、只看得见展示文本、ps/`/proc` 失败)。
  // **时间锚在这里只投否决票**(第 18 轮审查 F1):命令文本对不上、或者这个号上的进程明显不是
  // 那一次 spawn 留下的 ⇒ 不认;对得上也只认**号**,启动时刻一律留空 —— 一个窗口巧合不配当
  // 下刀凭证,而把它写进 `pid_started_at` 就等于让 `reclaimEvidence` 第 ② 步据此开刀。
  // 号认下来这件事本身仍然要做(第 9 轮审查 F3):否则这一行连「能用来定位那个进程的身份」
  // 都没有,只剩 id、命令和日志路径。
  const { verdict } = processStartedNear(side.pid, side.spawnedAtMs, 2_000, row.command);
  if (verdict === "different") {
    return { row: null, why: `（身份边条记的 pid=${side.pid} 现在是另一个进程）`, settled: true };
  }
  return { row: await writeAdopted(row, side.pid, null) };
}

/** 认下来之后把 pid(和拿得到的启动时刻)回填进库。写不进去也要继续,见下。 */
async function writeAdopted(row: Row, pid: number, startedAt: string | null): Promise<Row> {
  const adopted: Row = { ...row, pid, pidStartedAt: startedAt };
  try {
    await db.update(monitors)
      .set({ pid: adopted.pid, pidStartedAt: adopted.pidStartedAt })
      .where(and(eq(monitors.id, row.id), eq(monitors.status, "running"), isNull(monitors.pid)));
  } catch (e) {
    // 回填不进去也要继续:本进程这一轮照旧按这份身份收尾/接回,比当它不存在强。
    console.error(`[ash] 哨兵身份边条认回来了但写不进库 monitor=${row.id} pid=${pid}:`, e);
  }
  return adopted;
}
