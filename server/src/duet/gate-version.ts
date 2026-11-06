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
// 为什么记在 transcript 里而不加数据库列:transcript 本来就是 duet 重启后重建状态的依据
// (`resumeAtGate` 就读它),而且只追加不删 —— `resumeDuet` 重写文件时只拿掉失败的那一轮,
// 闸口行都保留。读文件的写法与 `resumeAtGate` 一致,直接读 RUNS_DIR 下那一份。
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { tasks } from "../db/schema.js";
import { RUNS_DIR } from "../paths.js";
import { isTurnClaimed } from "../turn-lock.js";
import { openGateVersion } from "./gates.js";

const isVersion = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v >= 1;

/**
 * transcript 里每一次开门的版本,按出现顺序。
 *
 * 同时认 `duet.gate` 和改名前的 `debate.gate`(老记录,见 transcript-reads.ts 的归一)。
 * 行上带了 version 就用它;没带(加版本之前的老记录)就按开门序号补 —— 老记录全没带时
 * 补出来就是 1、2、3…,和新记录的发号规则同一套,两种算法在新老交界处接得上。
 * 坏行(半截写入)跳过,不让一行坏数据把版本判断整个掀翻。
 */
function openedVersions(taskId: string): number[] {
  let raw: string;
  try { raw = readFileSync(join(RUNS_DIR, taskId, "transcript.jsonl"), "utf8"); } catch { return []; }
  const out: number[] = [];
  let last = 0;
  for (const line of raw.split("\n")) {
    // 先按字面筛一遍:发言行带着整段执行过程,逐行 JSON.parse 一份几 MB 的 transcript 不划算。
    // 闸口行由 JSON.stringify 写出,`"type":"duet.gate"` 里必然有这几个字;误中的照样走下面的判断。
    if (!line.includes('.gate"')) continue;
    let row: { type?: unknown; open?: unknown; version?: unknown };
    try { row = JSON.parse(line); } catch { continue; }
    if (row?.type !== "duet.gate" && row?.type !== "debate.gate") continue;
    if (row.open !== true) continue;
    last = isVersion(row.version) ? row.version : last + 1;
    out.push(last);
  }
  return out;
}

/** 最近一次开门的版本;这场讨论从没开过门返回 0。 */
export function lastOpenedGateVersion(taskId: string): number {
  return openedVersions(taskId).at(-1) ?? 0;
}

// 本进程发出过的最大版本。`recordGateEvent` 写 transcript 只是尽力而为,某次追加失败时
// 文件里就少一扇门 —— 只看文件会把同一个版本号发两次,旧卡就又能对上新门了。
const issued = new Map<string, number>();

/** 给即将打开的那扇门发号:文件里最大的版本和本进程发过的最大版本取大,再加一。 */
export function nextGateVersion(taskId: string): number {
  const onDisk = openedVersions(taskId).reduce((max, v) => Math.max(max, v), 0);
  const next = Math.max(onDisk, issued.get(taskId) ?? 0) + 1;
  issued.set(taskId, next);
  return next;
}

/**
 * 「这场讨论的闸口此刻开着第几版」—— 只读,给要推卡片的那一侧(飞书)判断用;null = 现在
 * 没有能点的门。
 *
 *  · 内存里有开着的门:就是它的版本(讨论正在 `runGate` 里等)。
 *  · 内存里没有、任务停在 duet 的 awaiting_review、回合锁也没人占:server 重启丢了内存里的门,
 *    `/gate` 会走重启补救那一路(`resumeAtGate`),版本取 transcript 里最近一次开门。
 *  · 锁被占着而内存里又没有门:正在开门的路上(状态已写成 awaiting_review、门还没登记),
 *    或者正在回炉。这时报 null,等 `duet.gate` 开门事件来了再看。
 *
 * 不能从 shared 的「此刻轮到你了吗」推出来:那份判据把 awaiting_review 算作「机器在动」
 * (`shared/src/task-attention.ts` 的 isTaskLive),所以闸口要单独判。
 */
export async function currentGateVersion(taskId: string): Promise<number | null> {
  const live = openGateVersion(taskId);
  if (live !== null) return live;
  const task = (await db.select({ mode: tasks.mode, status: tasks.status }).from(tasks).where(eq(tasks.id, taskId))).at(0);
  // 读库那一下有 await,门可能刚好在这期间开了或关了 —— 以读库之后这一刻的内存与锁为准。
  const opened = openGateVersion(taskId);
  if (opened !== null) return opened;
  if (task?.mode !== "duet" || task.status !== "awaiting_review") return null;
  if (isTurnClaimed(taskId)) return null;
  const version = lastOpenedGateVersion(taskId);
  return version > 0 ? version : null;
}
