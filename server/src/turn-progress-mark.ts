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
// ── 否证不许只靠一次「删得掉」,也不许拿字节冒充进展 ────────────────────────
//
// 上面那条撤销自己也会失败,而且失败得**成对**:`progressed` 目录变只读、文件系统切只读、
// 配额满 —— 同一个原因让「写进展」和「撤证明」一起失败。于是 `.watch` 留在那里继续声明
// 「会记的人在盯,它没记过」,而那一轮其实正在产出(第 1 轮自由审查 F5)。
//
// 上一版拿**已消费的 stdout 字节**当保险:水位比开轮时高就算产出过。那是错的,而且错在要命的
// 方向上 —— 那个水位是**原始 stdout 的换行位置**(executors/detached-child.ts),握手应答、
// 线程通知、错误行全算字节。审查实测:一个只做完握手、一个字正文都没有的回合,水位从 0 走到
// 249,于是读出 `seen`、静默档被永久排除 —— **正是这条任务要抓的那个 1.5 小时零输出现场**,
// 被我自己的「保险」挡在门外了(第 2 轮自由审查 F2,证据 protocol-smoke.log)。
//
// 所以进展的判据只有一个,而且在**事件语义层**:`trackTurnStall` 认的那几种事件(正文、思考、
// 工具调用)—— 也就是 `noteTurnProgress` 这张记号本身。字节一个字都不参与。
//
// 可靠性改从另一头解决:**让持久消费水位跟着进展事实一起走**。记号写不进去时,消费链就
// **不推进 `agentOffset`**(见 single-run.ts 那段注释)—— 那段还没被「确认记下」的输出于此留在
// 水位之外,接管回来的新进程会把它重放一遍,同一份语义判据在新进程里当场认出进展。于是
// 「进展写失败 + 撤销失败」不再等于「下一个进程确证它没产出」,而且不需要任何人删得掉东西。
//
// 证明本身也要**完整才算证明**(同一轮 F2 的另一半):`openSync("w")` 先截断再写,写一半就断电
// 会留下半张 `.watch`;上一代代码写的 `.watch` 压根没有版本行,升级也不迁移。两种都不是
// 「完整、可靠地记下了零进展」,所以读侧一律按 `unreadable` 处理 —— 缺失或损坏的证明只能证明
// 「我不知道」。
import {
  closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, rmSync, writeSync,
} from "node:fs";
import { join } from "node:path";
import { RUNS_DIR } from "./paths.js";
import { verifyUntilKnown, type VerifyPace } from "./verify-until-known.js";

/**
 * 参与证明的**完整性标记**。第一行认版本与回合身份,末行认「写完了」:
 * 半张证明(截断后写失败)、以及上一代没有版本行的证明,都读不出它 → `unreadable`。
 */
const WATCH_HEAD = "ash-turn-progress-watch/v2";
const WATCH_TAIL = "complete";

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
 */
export function openTurnProgress(taskId: string, sessionId: string, turnStartedAt: string | null): void {
  if (!turnStartedAt) return; // 没有回合身份就没有可证明的对象(同 watchTurnSilence 的头一道闸)
  try {
    mkdirSync(progressDir(taskId), { recursive: true });
    const path = join(progressDir(taskId), watchName(sessionId, turnStartedAt));
    const fd = openSync(path, "w");
    try {
      // 末行是「写完了」的印:截断之后写失败留下的半张证明读不出它(见 WATCH_TAIL)。
      writeSync(fd, `${WATCH_HEAD} ${turnStartedAt}\n${WATCH_TAIL}\n`);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    fsyncDir(progressDir(taskId));
  } catch (error) {
    console.warn(`[ash] 落会话 ${sessionId} 本轮的进展参与证明失败(静默档这一轮按「核实不了」处理):`, error);
  }
}

/**
 * 这张参与证明**完整吗**(判据见文件头最后一节)。不完整 = 不是证明,读侧按「核实不了」处理。
 *
 * 认两件事:版本行(上一代没有,所以不会被当成新判据的证明)、以及末行那个「写完了」的印
 * (半张证明读不出它)。回合身份也核一遍 —— 文件名已经带它,这里是第二道。
 */
function watchIsComplete(dir: string, sessionId: string, turnStartedAt: string): boolean {
  try {
    const lines = readFileSync(join(dir, watchName(sessionId, turnStartedAt)), "utf8").split("\n");
    return lines[0] === `${WATCH_HEAD} ${turnStartedAt}` && lines.includes(WATCH_TAIL);
  } catch {
    return false; // 读不动也是「说不上来」,不是「它没产出」
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
 * **而且那张证明得是完整的**:上一代写的 `.watch` 没有版本行、写一半断电的只剩半张 ——
 * 两种都只能证明「我不知道」(第 2 轮自由审查 F2)。真正把「写不进去」那条缝补上的不在这儿:
 * 记号欠着时消费链**不推进水位**,那段输出留给下一个进程重放(见文件头最后一节)。
 */
export function turnProgress(taskId: string, sessionId: string, turnStartedAt: string): TurnProgressRead {
  try {
    const dir = progressDir(taskId);
    if (existsSync(join(dir, markName(sessionId, turnStartedAt)))) return "seen";
    if (!existsSync(join(dir, watchName(sessionId, turnStartedAt)))) return "unreadable";
    return watchIsComplete(dir, sessionId, turnStartedAt) ? "none" : "unreadable";
  } catch (error) {
    console.warn(`[ash] 读会话 ${sessionId} 本轮进展记号失败,按「核实不了」处理:`, error);
    return "unreadable";
  }
}

/**
 * 同一问,但先问一句「**这一轮是谁从头看着的**」(第 2 轮自由审查 F2)。
 *
 * `watchedFromStart` = 本进程从这一轮第一条事件起就在消费它(fresh run、讨论、常驻台自己开的
 * 那一轮 —— 这三条链都没有进程接管入口,`reattach` 只接单飞)。那就**不必问盘**:事实在手上,
 * 「到此刻为止一条进展都没见过」是确证。盘上那张证明写失败了也不改变这一点 —— 拿「证明没写
 * 成」去换「这一轮可能已经产出过」,等于一次写盘故障就把静默档关掉,而那正是这一档要抓的形状。
 *
 * 只有**接管**回来的那一轮才真的需要问盘:它看不到 `agentOffset` 之前那一段,全部指望上一个
 * 进程留下的那张证明。读出 `unreadable` 时的出路见 `recoverTurnProgress`。
 */
export function turnProgressFor(opts: {
  taskId: string;
  sessionId: string;
  turnStartedAt: string | null;
  watchedFromStart: boolean;
}): TurnProgressRead {
  if (!opts.turnStartedAt) return "none";
  if (opts.watchedFromStart) return "none";
  return turnProgress(opts.taskId, opts.sessionId, opts.turnStartedAt);
}

/**
 * **「说不上来」的独立恢复路**:接着重读那张证明,直到它给出结论(第 2 轮自由审查 F2)。
 *
 * 为什么不能在 `seen` 与 `none` 里任选一边:选 `seen` = 这一轮永久排除在静默档之外(那就是
 * 原始那个 1.5 小时);选 `none` = 替上一个进程追认「它从未产出」,那是第 1 轮 F1 的误杀。所以
 * 未知自己有一条路 —— 读不出来多半是暂时的(目录权限、短暂 I/O、磁盘忙),过一会儿就好了;
 * 真恢复出 `seen` 的时候,调用方据此把那条「只为核实不了而开」的观察撤掉
 * (turn-stall.ts 的 `withdrawTurnSilence`)。
 *
 * 不设上限、计时器 `unref`:口径与另一处未知共用一份,见 ./verify-until-known.ts。
 */
export function recoverTurnProgress(
  taskId: string,
  sessionId: string,
  turnStartedAt: string,
  onKnown: (progress: "seen" | "none") => void,
  stillWatching: () => boolean,
  pace: VerifyPace = {},
): void {
  verifyUntilKnown<TurnProgressRead>({
    read: () => turnProgress(taskId, sessionId, turnStartedAt),
    fallback: "unreadable",
    known: (progress) => progress !== "unreadable",
    onKnown: (progress) => {
      if (stillWatching()) onKnown(progress as "seen" | "none");
      return true;
    },
    onUnknown: () => stillWatching(),
    pace,
  });
}

/** 测试用:清掉进程内那层短路缓存。 */
export function __resetTurnProgressMarks(): void {
  written.clear();
}
