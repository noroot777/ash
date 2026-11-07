// duet 收敛闸口的**版本号**:这场讨论第几次开门。
//
// 为什么要有它:闸口在内存里只按 taskId 找(`gates.ts`),而点按钮的卡片可能是很久以前
// 推出去的(飞书消息、另一个标签页)。两种旧卡点下去会生效、却不该生效:
//   ① 第 N 扇门注入意见之后开了第 N+1 扇,第 N 张卡上的「放行」会把新方案放行掉;
//   ② 第 N 扇门已放行、讨论 done,第 N 张卡上的「注入」会走验收打回那条路,把整场讨论
//      重新拉起来。
// 带上版本号,服务端就能说出「你点的那扇门已经不在了」。
//
// 为什么不用 round:讨论 done 之后被定时/`/fire` 重跑时,runDuet 从第 1 轮重新数,
// 而 transcript 不清空,轮次会重复;开门次数只增不减。
//
// 为什么记在数据库列里(`tasks.duet_gate_version`)而不从 transcript 数:版本号就是「你点的是哪一扇门」的身份,
// 发出去就不能再发第二次。transcript 里的开门行是尽力写的(`recordGateEvent`),某次追加失败(磁盘满)之后文件里
// 少一扇门,server 一重启就把同一个号再发一次,旧卡上的「放行」又对上了新门(审查第 3 轮实测)。所以每开一扇门
// 之前先在库里把号领走,领不到就不开门 —— 不拿内存、不拿时钟凑一个号。transcript 里的开门/关门行照写,那是历史
// 和界面用的,不再是发号的依据。加列之前开过门的老讨论列是空的:第一次领号时拿 transcript 里数出来的最大版本垫底。
//
// 开门时给人看的那几句(两位的结论、是不是共识)也跟着号一起落进同一行(`tasks.duet_gate_shown`),同一条语句写:
// 飞书卡片上的「放行」认的是版本号,卡上的正文就必须是同一扇门的。从 transcript 里「最近一次开门」去拿正文,
// 那一行恰好没写上时拿到的是上一扇门的方案 —— 人看着旧方案按下放行,放行的却是没给他看过的新方案(审查实测)。
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { DuetConsensusBy } from "@ash/shared";
import { eq, sql } from "drizzle-orm";
import { db } from "../db/index.js";
import { tasks } from "../db/schema.js";
import { RUNS_DIR } from "../paths.js";
import { isTurnClaimed } from "../turn-lock.js";
import { openGateVersion } from "./gates.js";

const isVersion = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v >= 1;

/** 开门那一刻摆给人看的方案摘要(界面与飞书卡片同一份)。 */
export interface GateShown {
  consensus: boolean;
  consensusBy?: DuetConsensusBy;
  conclusionA: string | null;
  conclusionB: string | null;
}

type GateRow = { type?: unknown; open?: unknown; version?: unknown; consensus?: unknown; consensusBy?: unknown; conclusionA?: unknown; conclusionB?: unknown };

/**
 * transcript 里每一次开门(版本 + 那一行),按出现顺序。
 *
 * 同时认 `duet.gate` 和改名前的 `debate.gate`(老记录,见 transcript-reads.ts 的归一)。
 * 行上带了 version 就用它;没带(加版本之前的老记录)就按开门序号补 —— 老记录全没带时
 * 补出来就是 1、2、3…,和新记录的发号规则同一套,两种算法在新老交界处接得上。
 * 坏行(半截写入)跳过,不让一行坏数据把版本判断整个掀翻。
 *
 * 文件不存在 = 从没开过门;**读不了**(权限、句柄耗尽、IO 错)往外抛,不能当成没开过:那样重启后版本从 1 重发,
 * 旧卡又对上新门,开着的门也会被判成「没开」、卡片被收起(审查第 2 轮同类:读失败当成「没有」)。
 */
function openedGates(taskId: string): { version: number; row: GateRow }[] {
  let raw: string;
  try {
    raw = readFileSync(join(RUNS_DIR, taskId, "transcript.jsonl"), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const out: { version: number; row: GateRow }[] = [];
  let last = 0;
  for (const line of raw.split("\n")) {
    // 先按字面筛一遍:发言行带着整段执行过程,逐行 JSON.parse 一份几 MB 的 transcript 不划算。
    // 闸口行由 JSON.stringify 写出,`"type":"duet.gate"` 里必然有这几个字;误中的照样走下面的判断。
    if (!line.includes('.gate"')) continue;
    let row: GateRow;
    try { row = JSON.parse(line); } catch { continue; }
    if (row?.type !== "duet.gate" && row?.type !== "debate.gate") continue;
    if (row.open !== true) continue;
    last = isVersion(row.version) ? row.version : last + 1;
    out.push({ version: last, row });
  }
  return out;
}

/** 加列之前开过的门:transcript 里最大的那个版本,从没开过 = 0。读不了往外抛(见 openedGates)。 */
function legacyGateVersion(taskId: string): number {
  return openedGates(taskId).reduce((max, gate) => Math.max(max, gate.version), 0);
}

const text = (v: unknown) => (typeof v === "string" ? v : null);
const shownOf = (row: GateRow): GateShown => ({
  consensus: row.consensus === true,
  ...(row.consensusBy === "both" || row.consensusBy === "A" || row.consensusBy === "B" ? { consensusBy: row.consensusBy as DuetConsensusBy } : {}),
  conclusionA: text(row.conclusionA),
  conclusionB: text(row.conclusionB),
});

/**
 * 第 version 扇门开门时摆出来的方案;找不到**这一扇**的返回 null —— 调用方不许拿别的门的顶上。
 *
 * 先看库里那份:它和 `duet_gate_version` 是同一条语句写的,版本对得上就一定是这扇门的。对不上(读的这一下
 * 门又往下开了一扇,或是加列之前开的老门)才去 transcript 里找带着同一个版本的开门行。读不了往外抛,不当成没有。
 */
export async function shownAtGate(taskId: string, version: number): Promise<GateShown | null> {
  const task = (await db.select({ version: tasks.duetGateVersion, shown: tasks.duetGateShown }).from(tasks)
    .where(eq(tasks.id, taskId))).at(0);
  if (task?.version === version && task.shown) {
    try { return shownOf(JSON.parse(task.shown) as GateRow); } catch { /* 坏了就退到 transcript 里那一行 */ }
  }
  const opened = openedGates(taskId).filter((gate) => gate.version === version).at(-1);
  return opened ? shownOf(opened.row) : null;
}

/** 最近一次发出去的门版本;这场讨论从没开过门返回 0。读不了(库或老讨论的 transcript)时抛错。 */
export async function lastOpenedGateVersion(taskId: string): Promise<number> {
  const row = (await db.select({ version: tasks.duetGateVersion }).from(tasks).where(eq(tasks.id, taskId))).at(0);
  return row?.version ?? legacyGateVersion(taskId);
}

/**
 * 给即将打开的那扇门领号,**在库里落定之后才返回**:调用方拿到号再开门、再推卡片;抛错就别开门。
 * 列还空着时以 transcript 里的最大版本垫底,transcript 读不了同样抛错 —— 垫错了就会重发老号。
 * shown = 这扇门要摆给人看的方案,和号同一条语句落下(理由见文件头);不给就清空,不留上一扇门的。
 */
export async function nextGateVersion(taskId: string, shown: GateShown | null = null): Promise<number> {
  const row = (await db.select({ version: tasks.duetGateVersion }).from(tasks).where(eq(tasks.id, taskId))).at(0);
  if (!row) throw new Error(`任务 ${taskId} 不在库里,闸口领不到版本号`);
  const floor = row.version ?? legacyGateVersion(taskId);
  // coalesce:垫底只在列还空着的那一次生效,之后一律接着库里的往下发。
  const issued = (await db.update(tasks)
    .set({ duetGateVersion: sql`coalesce(${tasks.duetGateVersion}, ${floor}) + 1`, duetGateShown: shown ? JSON.stringify(shown) : null })
    .where(eq(tasks.id, taskId))
    .returning({ version: tasks.duetGateVersion })).at(0)?.version;
  if (!isVersion(issued)) throw new Error(`任务 ${taskId} 的闸口版本号没有落进库里`);
  return issued;
}

/**
 * 「这场讨论的闸口此刻开着第几版」—— 只读,给要推卡片的那一侧(飞书)判断用;null = 现在
 * 没有能点的门。
 *
 *  · 内存里有开着的门:就是它的版本(讨论正在 `runGate` 里等)。
 *  · 内存里没有、任务停在 duet 的 awaiting_review、回合锁也没人占:server 重启丢了内存里的门,
 *    `/gate` 会走重启补救那一路(`resumeAtGate`),版本取最近一次发出去的那个号。
 *  · 锁被占着而内存里又没有门:正在开门的路上(状态已写成 awaiting_review、门还没登记),
 *    或者正在回炉。这时报 null,等 `duet.gate` 开门事件来了再看。
 *  · 版本读不了(库,或老讨论要读 transcript):抛错,调用方别据此收卡或发卡(im/attention.ts viewsOf 把这个任务当成「这一下看不清」)。
 *
 * 不能从 shared 的「此刻轮到你了吗」推出来:那份判据把 awaiting_review 算作「机器在动」
 * (`shared/src/task-attention.ts` 的 isTaskLive),所以闸口要单独判。
 */
export async function currentGateVersion(taskId: string): Promise<number | null> {
  const live = openGateVersion(taskId);
  if (live !== null) return live;
  const task = (await db.select({ mode: tasks.mode, status: tasks.status, version: tasks.duetGateVersion })
    .from(tasks).where(eq(tasks.id, taskId))).at(0);
  // 读库那一下有 await,门可能刚好在这期间开了或关了 —— 以读库之后这一刻的内存与锁为准。
  const opened = openGateVersion(taskId);
  if (opened !== null) return opened;
  if (task?.mode !== "duet" || task.status !== "awaiting_review") return null;
  if (isTurnClaimed(taskId)) return null;
  const version = task.version ?? legacyGateVersion(taskId);
  return version > 0 ? version : null;
}
