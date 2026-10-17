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
export async function adoptSpawnIdentity(row: Row): Promise<Row | null> {
  const side = readSpawnIdentity(row.logPath);
  if (!side) return null;
  const authz = await authorizeRecoveredIdentity({
    monitorId: row.id, pid: side.pid, unitToken: row.unitToken,
  });
  // `proven`:号已证明。换算答不出启动时刻时只回填 pid —— 跟下面时间锚那一档的 `unqueryable`
  // 同一个出路(落在 `unverifiable` 档上:看得见、停得掉、记得下责任,但谁都不许据此下刀)。
  if (authz.strong.grade === "proven") return writeAdopted(row, side.pid, authz.strong.startedAt);
  // 反证(含盘上记着的那一次)⇒ 不认,由调用方照实写掉。
  if (!authz.weakAllowed) return null;
  // 记号这一问答不出来(存量行没有记号、只看得见展示文本、ps/`/proc` 失败)⇒ 照旧走时间锚。
  // 命令原文一起交过去:±2 秒是个窗口,原进程结束、号在窗口内被复用时时间锚照样成立
  // (第 10 轮审查 F2-C)。壳的 argv 里带着命令原文,对不上就一律不认。
  const { verdict, startedAt } = processStartedNear(side.pid, side.spawnedAtMs, 2_000, row.command);
  if (verdict === "different") return null;
  return writeAdopted(row, side.pid, startedAt);
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
