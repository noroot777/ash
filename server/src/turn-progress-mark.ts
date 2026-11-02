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
// 形态与 `delivery-crossing.ts` 同构,**三态读也是同一道判据**:目录在、文件不在,才算「确证
// 这一轮没有过进展」;目录不在就是「读不出来」—— 那一档不许用来开熔断(宁可漏判,不可误杀)。
// 目录由回合开始时的 `ensureTurnProgressDir` 建好并 fsync,所以「目录在」本身是一个可信前提。
import { closeSync, fsyncSync, mkdirSync, openSync, writeSync } from "node:fs";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { RUNS_DIR } from "./paths.js";

/** 读出来的三档。`none` 是**确证**没有过进展(目录在、这一轮的记号不在)。 */
export type TurnProgressRead = "seen" | "none" | "unreadable";

const progressDir = (taskId: string): string => join(RUNS_DIR, taskId, "progressed");

/** 回合身份 → 文件名。只留数字(同 `detachedPathsFor` 的 compact 口径),避免 `:` 落到文件名里。 */
const markName = (sessionId: string, turnStartedAt: string): string =>
  `${sessionId}-${turnStartedAt.replace(/[^0-9]/g, "")}`;

/** 已经写过的,不必每条事件都回盘一趟(写入本身幂等,这一层只是省 syscall)。 */
const written = new Set<string>();

function fsyncDir(path: string): void {
  try {
    const dir = openSync(path, "r");
    try { fsyncSync(dir); } finally { closeSync(dir); }
  } catch { /* 目录 fsync 不是必须 */ }
}

/**
 * 回合开始时建好这棵树。**必须先于第一条事件**,否则「目录不在」分不出「这一轮没进展」和
 * 「这棵树压根没建起来」—— 那正是 `delivery-crossing.ts` 里 `ensureCrossingDir` 存在的理由。
 *
 * 失败只告警:建不起来的代价是此后读到 `unreadable`,而那一档不开熔断 —— 退回修复前的行为
 * (该抓的抓不到),不会误杀。
 */
export function ensureTurnProgressDir(taskId: string): void {
  try {
    mkdirSync(progressDir(taskId), { recursive: true });
    fsyncDir(progressDir(taskId));
  } catch (error) {
    console.warn(`[ash] 建任务 ${taskId} 的回合进展记号目录失败(静默档将按「核实不了」处理):`, error);
  }
}

/**
 * 「这一轮真的产出过东西」。由消费链在**本轮第一条进展事件**上调一次(判据共用
 * `@ash/shared/waiting` 的 `producesWork`,由 `turn-stall.ts` 转过来)。
 *
 * 尽力而为 —— 但写不成要**响亮地说**:这份记号是「接管之后别误杀它」的唯一依据,丢了就等于
 * 把一个健康的长回合重新暴露在静默档下面。
 */
export function noteTurnProgress(taskId: string, sessionId: string, turnStartedAt: string): void {
  const key = `${taskId}/${markName(sessionId, turnStartedAt)}`;
  if (written.has(key)) return;
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
  } catch (error) {
    written.delete(key); // 下一条进展事件再试一次
    console.warn(`[ash] 记下会话 ${sessionId} 本轮已有进展失败(重启接管后可能被静默档误杀):`, error);
  }
}

/**
 * 接管/起跑时问一句:这一轮在**别的进程里**已经产出过东西了吗。
 *
 * `none` 要求目录确实在 —— 同 `readDeliveryCrossing` 的那道判据:文件不在只证明「这一条没
 * 写过」,而只有目录在才排除「整棵树没建起来」。
 */
export function turnProgress(taskId: string, sessionId: string, turnStartedAt: string): TurnProgressRead {
  try {
    if (existsSync(join(progressDir(taskId), markName(sessionId, turnStartedAt)))) return "seen";
    return existsSync(progressDir(taskId)) ? "none" : "unreadable";
  } catch (error) {
    console.warn(`[ash] 读会话 ${sessionId} 本轮进展记号失败,按「核实不了」处理:`, error);
    return "unreadable";
  }
}

/** 测试用:清掉进程内那层短路缓存。 */
export function __resetTurnProgressMarks(): void {
  written.clear();
}
