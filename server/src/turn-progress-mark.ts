// 「这一轮**有没有过真实进展**」—— 跨得过 server 重启的那一份事实。
//
// 为什么非得落盘:静默档(`turn-stall.ts` 文件头那一节)判的是「自回合起点起一条进展都没有
// 过」。而进程内那份记录挂在**持有者**上(`lastProgress` 是按 owner 的 WeakMap),重启接管会
// 造一个新句柄 —— 旧句柄连同它见过的全部进展一起没了,已消费的输出又落在 `agentOffset`
// 之前、不会再次到达判据。于是一个正在跑长工具的健康回合(第一个动作就是 `sleep 3600`,`tool`
// 事件早在重启前就发过了)在接管之后看起来和「输入压根没送到 agent」一模一样,而静默钟仍按
// 回合真实起点算:10 分钟报警、45 分钟当场杀掉。
//
// 这是 2026-11-02 第 1 轮自由审查 F1 **实测到的误杀**(重启前 `agentOffset=454`、trace 里
// 有 `exec / sleep 3600`;接管后新进程写出「一条模型输出、思考或工具调用都没有过」并向它发了
// `turn/interrupt`)—— 正好是同一天那次 1.5 小时静默挂起的反面:一个修反了的判据,把「它压根
// 没跑起来」和「它跑得正好,只是我没看见前半段」当成了同一件事。
//
// **为什么不是库里一格**(这一条本仓踩过):库的写要过 `whenIdle`(`db/node-sqlite-client.ts`:
// 写不许借别人的事务),别人开着长事务时这条 UPDATE 排在队里 —— 既没抛错也没落盘,而重启窗口
// 正是最容易排队的那一段。熔断判决为此专门搬去了日志文件(`turn-stall-persist.ts` 文件头写的
// 就是这件事),进展事实是同一类事实,走同一条路。
//
// 形态与 `delivery-crossing.ts` 同构,**三态读也是同一道判据**。但「确证这一轮没有过进展」
// 的前提不能是**目录在**(第 2 轮自由审查 F2,已跨版本实测):接管那条路会先
// `ensureTurnProgressDir` 把目录建出来,再拿「目录在、这一轮的文件不在」判确证 —— 而目录只
// 证明「此刻建得起目录」,证明不了**上一个进程按这套协议记过这一轮的事件**。旧版本(升级前
// 那一代)压根没有这套记号:它跑着 `sleep 3600`、trace 里工具调用都在,新版接管后自己造出了
// 判据的前提,于是又把它当成「一条输出都没有过」杀掉 —— 和第 1 轮 F1 一模一样的误杀,只是
// 换了触发路径。
//
// 所以证明力绑在**逐轮的参与证明**上:`openTurnProgress` 由「从头消费这一轮」的那个进程写一张
// `.watch`,它说的是「这一轮归我盯,我会把进展记在这里」。读的时候:
//   · 进展记号在        → `seen`;
//   · 没有进展记号、`.watch` 在 → `none`(**确证**:会记的人在盯,它没记过);
//   · 两张都没有         → `unreadable`(旧代开的回合、或者记号系统坏了)。
// 接管那条路**只读不写**:它不许替上一个进程追认「从未产出」。
//
// 可靠性也算在同一道判据里:`noteTurnProgress` 写不成时**把 `.watch` 撤掉** —— 记不住进展的
// 人没资格声明「它没产出」,读侧于此退回 `unreadable`,也就退回修复前的行为(该抓的抓不到),
// 而不是误杀。
//
// ── 否证不许只靠一次「删得掉」(第 3 轮自由审查 F5)──────────────────────────
//
// 上面那条撤销自己也会失败,而且失败得**成对**:`progressed` 目录变只读、文件系统切只读、
// 配额满 —— 同一个原因让「写进展」和「撤证明」一起失败。于是 `.watch` 留在那里继续发出
// 「会记的人在盯,它没记过」这句话,而那一轮其实正在产出,输出甚至已经被消费并提交了水位;
// 恢复写权限再重启,新 owner 读到 `none`、按旧回合起点计时,长工具照样被杀。
//
// 所以「确证没产出」现在要**两个**事实同时成立:参与证明在,**而且持久消费水位没有前进过**。
// 水位就是 agent-out 的已提交字节(`sessions.agent_offset`,`executors/detached.ts` 每秒回盘),
// 它是**单调前进**的,而且**不需要任何人删得掉东西** —— 这正是撤销所缺的那一半:进展落不了盘
// 时,水位仍然替它说话。`.watch` 里记下开轮那一刻的水位,读的时候跟当下那一份比:
//   · 水位比开轮时高 → 这一轮确实产出过(被消费过),无论进展记号写成了没有 → `seen`;
//   · 一字未动       → 这才是 `none`。
// 还剩一个窗口:输出被消费、而那 1 秒的回盘没来得及发生就被杀。那一档退回旧判据(可能误杀),
// 但它要求「进展写失败 + 撤销失败 + 回盘窗口」三件同时撞上,而不再是「撤销失败」一件。
import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, rmSync, writeSync } from "node:fs";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { RUNS_DIR } from "./paths.js";

/** 读出来的三档。`none` 是**确证**没有过进展(目录在、这一轮的记号不在)。 */
export type TurnProgressRead = "seen" | "none" | "unreadable";

const progressDir = (taskId: string): string => join(RUNS_DIR, taskId, "progressed");

/** 回合身份 → 文件名。只留数字(同 `detachedPathsFor` 的 compact 口径),避免 `:` 落到文件名里。 */
const markName = (sessionId: string, turnStartedAt: string): string =>
  `${sessionId}-${turnStartedAt.replace(/[^0-9]/g, "")}`;

/** 这一轮的**参与证明**:`openTurnProgress` 落它,写不成进展时撤它(判据见文件头)。 */
const watchName = (sessionId: string, turnStartedAt: string): string =>
  `${markName(sessionId, turnStartedAt)}.watch`;

/** 已经写过的,不必每条事件都回盘一趟(写入本身幂等,这一层只是省 syscall)。 */
const written = new Set<string>();

function fsyncDir(path: string): void {
  try {
    const dir = openSync(path, "r");
    try { fsyncSync(dir); } finally { closeSync(dir); }
  } catch { /* 目录 fsync 不是必须 */ }
}

/**
 * **「这一轮归我盯」** —— 只有**从头消费这一轮**的那个进程才许调(fresh run / 本进程刚开的
 * 那一轮)。接管回来的进程一个字都不许写:它看不到 `agentOffset` 之前那一段,替上一个进程
 * 声明「它没产出过」就是第 2 轮审查 F2 那个误杀。
 *
 * 必须先于第一条事件。失败只告警:没有这张证明,读侧此后一律 `unreadable`、静默档这一轮不开
 * —— 退回修复前的行为(该抓的抓不到),不会误杀。
 *
 * `watermark` = **开轮这一刻的持久消费水位**(agent-out 的已提交字节)。记在证明里,读侧据此
 * 识破「进展写失败、证明又撤不掉」那一档(见文件头最后一节)。给不出来就不记,读侧退回只看
 * 记号的旧判据 —— 少一道保险,不会多一道误杀。
 */
export function openTurnProgress(
  taskId: string,
  sessionId: string,
  turnStartedAt: string | null,
  watermark?: number,
): void {
  if (!turnStartedAt) return; // 没有回合身份就没有可证明的对象(同 watchTurnSilence 的头一道闸)
  try {
    mkdirSync(progressDir(taskId), { recursive: true });
    const path = join(progressDir(taskId), watchName(sessionId, turnStartedAt));
    const fd = openSync(path, "w");
    try {
      const mark = Number.isFinite(watermark) ? `${Math.trunc(watermark as number)}` : "";
      writeSync(fd, `${turnStartedAt}\n${mark}\n`);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    fsyncDir(progressDir(taskId));
  } catch (error) {
    console.warn(`[ash] 落会话 ${sessionId} 本轮的进展参与证明失败(静默档这一轮按「核实不了」处理):`, error);
  }
}

/** 参与证明里记着的开轮水位(第二行)。没有/读不出 = `null`,读侧退回只看记号的旧判据。 */
function watchedWatermark(dir: string, sessionId: string, turnStartedAt: string): number | null {
  try {
    const line = readFileSync(join(dir, watchName(sessionId, turnStartedAt)), "utf8").split("\n")[1] ?? "";
    if (!line.trim()) return null;
    const value = Number(line.trim());
    return Number.isFinite(value) && value >= 0 ? value : null;
  } catch {
    return null; // 证明在不在由调用方的 existsSync 判;这里只回答「它记了水位没有」
  }
}

/** 记不住进展的人没资格声明「它没产出」:撤掉参与证明,读侧退回 `unreadable`(见文件头)。 */
function dropTurnProgressWatch(taskId: string, sessionId: string, turnStartedAt: string): void {
  try {
    rmSync(join(progressDir(taskId), watchName(sessionId, turnStartedAt)), { force: true });
  } catch (error) {
    console.warn(`[ash] 撤会话 ${sessionId} 本轮的进展参与证明失败:`, error);
  }
}

/**
 * 「这一轮真的产出过东西」。**返回落盘确认了没有** —— 看门狗据此在下一条进展事件上重试,
 * 直到它确认(同 `StallActions.project` 那条「通知是一次性的、持久状态是要确认的」)。
 *
 * 写不成做两件事:撤掉参与证明(读侧于此退回 `unreadable`,不会误杀),并响亮地说一句 ——
 * 这份记号是「接管之后别杀它」的唯一依据。
 */
export function noteTurnProgress(taskId: string, sessionId: string, turnStartedAt: string): boolean {
  const key = `${taskId}/${markName(sessionId, turnStartedAt)}`;
  if (written.has(key)) return true;
  written.add(key);
  try {
    mkdirSync(progressDir(taskId), { recursive: true });
    const path = join(progressDir(taskId), markName(sessionId, turnStartedAt));
    const fd = openSync(path, "w");
    try {
      writeSync(fd, `${turnStartedAt}\n`);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    fsyncDir(progressDir(taskId));
    return true;
  } catch (error) {
    written.delete(key); // 下一条进展事件再试一次
    dropTurnProgressWatch(taskId, sessionId, turnStartedAt);
    console.warn(`[ash] 记下会话 ${sessionId} 本轮已有进展失败(这一轮的静默档就此退回「核实不了」):`, error);
    return false;
  }
}

/**
 * 接管/起跑时问一句:这一轮在**别的进程里**已经产出过东西了吗。
 *
 * `none` 要求那张**参与证明**确实在(`openTurnProgress` 由从头消费这一轮的那个进程落的)——
 * 「进展记号不在」只证明「这一条没写过」,而只有参与证明在才排除「写记号的人压根不在这一轮」
 * (旧代、或者记号系统坏了)。少了这一道,接管方自己建个目录就能把「从未产出」追认给任何
 * 一轮 —— 第 2 轮自由审查 F2 实测到的升级误杀正是这么来的。
 *
 * **而且还要水位也没动过**:`watermark` = 当下的持久消费水位。它比证明里记的那一份高,就说明
 * 这一轮产出过并被消费过 —— 即使进展记号没写成、那张证明也撤不掉(第 3 轮自由审查 F5,理由与
 * 剩余窗口见文件头最后一节)。调用方给不出水位就只按记号判,同修复前。
 */
export function turnProgress(
  taskId: string,
  sessionId: string,
  turnStartedAt: string,
  watermark?: number,
): TurnProgressRead {
  try {
    const dir = progressDir(taskId);
    if (existsSync(join(dir, markName(sessionId, turnStartedAt)))) return "seen";
    if (!existsSync(join(dir, watchName(sessionId, turnStartedAt)))) return "unreadable";
    const opened = watchedWatermark(dir, sessionId, turnStartedAt);
    if (opened !== null && Number.isFinite(watermark) && (watermark as number) > opened) {
      console.warn(`[ash] 会话 ${sessionId} 本轮没有进展记号,但消费水位已经从 ${opened} 前进到 `
        + `${Math.trunc(watermark as number)}:按「产出过」处理(记号多半是写不进去了)`);
      return "seen";
    }
    return "none";
  } catch (error) {
    console.warn(`[ash] 读会话 ${sessionId} 本轮进展记号失败,按「核实不了」处理:`, error);
    return "unreadable";
  }
}

/** 测试用:清掉进程内那层短路缓存。 */
export function __resetTurnProgressMarks(): void {
  written.clear();
}
