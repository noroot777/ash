// 哨兵的**消费循环**:tail 读回来的行怎么变成事件,以及每一批行的**结局**。
//
// 从 monitors.ts 拆出来的（全局约定:单文件不超过 700 行）。运行时注册表、盯与停仍在那边,
// 这一层只负责「一批行」这件事的三条不变量:
//
// ① **消息落库之后**才推进事件计数和读取位置（反过来排 = 重启那一下静默吞掉几行）。
// ② **一批有上界**:`MONITOR_MAX_LINES_PER_FLUSH`。吃不完的留在缓冲里下一批接着来 ——
//    放回、渲染、重放这三步都按行数线性涨,没有上界就会在一次大爆发上各炸一次。
// ③ **每一批都答得出自己算谁的**:`FlushOutcome` 的五档。「推一次就不管了」正是第 1、2 轮
//    审查那几个现场的共同形状:行没送出去,而调用方按「已经送完」继续往下走。
import { eq } from "drizzle-orm";
import {
  MONITOR_MAX_EVENTS,
  MONITOR_MAX_LINE_CHARS,
  MONITOR_MAX_LINES_PER_FLUSH,
  MONITOR_MAX_LINES_PER_PUSH,
  MONITOR_RETRY_FLUSH_MS,
} from "@ash/shared/monitor";
import { endConditionHit, parseEndCondition } from "@ash/shared/monitor-end-condition";
import { db, dbClient } from "./db/index.js";
import { monitors } from "./db/schema.js";
import { pushToTask } from "./monitor-events.js";
import { publish, runtimes, serialize, settleInBackground, type Row, type Runtime } from "./monitors.js";

export async function commitOffset(monitorId: string, offset: number): Promise<void> {
  if (dbClient.closed) return;
  await db.update(monitors).set({ offset }).where(eq(monitors.id, monitorId)).catch(() => {});
}

function trim(line: string): string {
  return line.length > MONITOR_MAX_LINE_CHARS ? `${line.slice(0, MONITOR_MAX_LINE_CHARS)}…（本行已截断）` : line;
}

/**
 * 一批行渲染成一段话:抬头 + 前几行 + 省略了多少 + **命中那一行**。
 *
 * `keep` 是这一批里命中结束条件的那一行。它必须出现在这段话里（第 2 轮审查 N2）:列表只列
 * 前 `MONITOR_MAX_LINES_PER_PUSH` 行,而命中那一行恰恰可以排在第 41 行往后 —— 它多半就是
 * agent 要的那个结果本身,被省略掉的话,它只会收到一句「等到了约定的那一行」和一批看不出
 * 所以然的开头几行。
 *
 * 收尾那条通知也用这一份（见 `finish` 里的「尚欠的那一批」）:两处各写一遍渲染,就会出现
 * 「单独送的时候列 40 行、附在通知里时列 5 行」这种说不清的差别。
 */
export function linesBody(lines: string[], keep: string | null): string {
  const shown = lines.slice(0, MONITOR_MAX_LINES_PER_PUSH).map(trim);
  const omitted = lines.length - shown.length;
  const tail = omitted > 0 ? `\n…（这一批共 ${lines.length} 行，上面只列了前 ${shown.length} 行）` : "";
  const missed = keep !== null && lines.indexOf(keep) >= shown.length
    ? `\n…（约定的那一行在后面：${trim(keep)}）`
    : "";
  return `${shown.join("\n")}${tail}${missed}`;
}

/** 同上，外面套一层抬头。**抬头只在「这条消息就是一批事件」时才给** —— 收尾那条通知自己 */
/*  已经有抬头了，再套一层就是同一个 description + monitorId 连说两遍。 */
export function renderLines(row: Row, lines: string[], keep: string | null): string {
  return `【哨兵事件】${row.description}（monitorId=${row.id}）\n${linesBody(lines, keep)}`;
}

/**
 * 把一批行变成一条事件消息，**消息落库之后**才推进事件计数和读取位置。
 *
 * 这个顺序是硬要求，不是讲究：位置先走、消息后落的话，中间哪怕只隔那 300ms 的批量窗口，
 * server 一停这几行就永远没人读了——游标已经越过去，内容还躺在日志里，任务却一个字都
 * 收不到（第 1 轮审查复现：read_offset=13、events=0、消息为空，日志里那行完好无损）。
 * 反过来排的代价只是重启后可能把同一批行再推一次，重复远比静默丢失便宜。
 */
export async function pushLines(
  row: Row,
  lines: string[],
  readTo: number | null,
  /** 这一批里命中结束条件的那一行（没有就是 null）。**一定要出现在消息里**，见下。 */
  keep: string | null = null,
): Promise<number> {
  const delivered = await pushToTask(row, renderLines(row, lines, keep));
  // `events` 数的是「**唤醒过任务几次**」，不是「读到过几行」。没投出去的那几行一次唤醒
  // 都没造成，计进去只会让卡片显示「已有 3 条事件」而任务那边一声没响——用户据此以为
  // 通知已经处理过了（第 2 轮审查实测：终态任务上卡片显示 1 条事件、待发消息数 0）。
  // 位置同理不推进：这批行没人读过，留着让日志回看还能看到。
  const events = delivered ? row.events + lines.length : row.events;
  await db
    .update(monitors)
    .set({ events, ...(delivered && readTo !== null ? { offset: readTo } : {}) })
    .where(eq(monitors.id, row.id));
  publish(row.taskId);
  return events;
}

/**
 * 排一次批量冲刷。已经排着一次的就不动它 —— 它到点会把缓冲里**下一批**带走。
 *
 * 返回**这一批之后还有人管吗**:收尾中（`closing`）没人管了,那一批得由 `finish` 接走
 * （见 `attach` 里的说明、以及 `FlushOutcome` 的 `owed`）。上一版这里是 `void`,于是
 * 「放回去了但没排上重试」跟「放回去了,两秒后再试」在调用方眼里一模一样（第 2 轮审查 F1）。
 */
export function armFlush(rt: Runtime, monitorId: string, delayMs: number): boolean {
  if (rt.closing) return false;
  if (rt.flush) return true;
  rt.flush = setTimeout(() => {
    rt.flush = null;
    void serialize(monitorId, () => flushBuffer(monitorId, rt));
  }, delayMs);
  (rt.flush as { unref?: () => void }).unref?.();
  return true;
}

/**
 * 一批行的**结局**。每一批都必须答得出这一句（第 2 轮审查 F1）—— 「推完就不管了」正是
 * 上一版那几个现场的共同形状:行没送出去,而调用方按「已经送完」继续往下走。
 */
export type FlushOutcome =
  /** 没有待推的行（或者库已经关了）。 */
  | "idle"
  /** **已交付**:消息落库、事件计数与读取位置都跟着推进了。 */
  | "delivered"
  /** **可重放待重试**:原样放回队头,重试已经排上。 */
  | "retry"
  /** **尚欠**:原样放回队头了,但没人会来重试（收尾中）—— 调用方必须接走这笔责任。 */
  | "owed"
  /** **明确放弃**:这一行已经不是运行态,这一批不再送（由那条收尾路径负责交代）。 */
  | "abandoned";

/**
 * **这一批没写成,就一个字都不算消费过**（第 1 轮审查 F2）。
 *
 * 缓冲是这几行唯一的在内存副本：`splice` 之后 tail 自己的读取位置已经越过去了，而落库那一笔
 * （`monitors.offset`）只有写成功才前进。所以中途抛了既不能当它推过去了，也不能把它丢掉 ——
 * 原样放回**队头**（新来的行排在它后面，顺序不乱），再排一次冲刷。
 *
 * 不放回的后果是审查实测的那一幕：约定的 `DONE` 已经吐出来了，通知那一笔 INSERT 失败一次，
 * 这几行就此蒸发 —— 命令后面再没有输出，于是这条哨兵永远不收工，只能干等到期。
 *
 * **放回这一步自己也要有上界**（第 2 轮审查 F1-B）：上一版是 `unshift(...lines)`，而展开传参
 * 是按参数个数吃栈的 —— 18 万行就是一次 `RangeError: Maximum call stack size exceeded`，
 * 而排重试那一句排在它后面，于是这条哨兵连重试都没排上，就那么挂着（实测 events=0、
 * 待发队列空、状态 running）。现在批次本身有上界（`MONITOR_MAX_LINES_PER_FLUSH`），拼接
 * 也不再展开。
 */
function returnToBuffer(
  rt: Runtime, monitorId: string, lines: string[], readTo: number | null,
): "retry" | "owed" {
  rt.buffer = lines.concat(rt.buffer);
  // 这中间可能又来了新行，`rt.readTo` 已经是更大的那个（它覆盖这一批）——那就别往回改。
  if (rt.readTo === null) rt.readTo = readTo;
  return armFlush(rt, monitorId, MONITOR_RETRY_FLUSH_MS) ? "retry" : "owed";
}

export async function flushBuffer(monitorId: string, rtOverride?: Runtime): Promise<FlushOutcome> {
  const rt = rtOverride ?? runtimes.get(monitorId);
  if (!rt || !rt.buffer.length || dbClient.closed) return "idle";
  // **一批有上界**（见 `MONITOR_MAX_LINES_PER_FLUSH`）。吃不完的留在缓冲里,马上再排一次。
  const partial = rt.buffer.length > MONITOR_MAX_LINES_PER_FLUSH;
  const lines = rt.buffer.splice(0, MONITOR_MAX_LINES_PER_FLUSH);
  // 分批的那几批**不推游标**:`readTo` 说的是「整个缓冲读到文件哪个字节」,前一批先把它推
  // 上去,留在缓冲里的后一批就被跳过去了（重启/离线补读都会从游标之后开始找）。
  const readTo = partial ? null : rt.readTo;
  if (!partial) rt.readTo = null;
  let row: Row | undefined;
  try {
    row = (await db.select().from(monitors).where(eq(monitors.id, monitorId))).at(0);
  } catch (error) {
    console.error(`[ash] 哨兵 ${monitorId} 读不到自己那一行,这一批 ${lines.length} 行放回缓冲重试:`, error);
    return returnToBuffer(rt, monitorId, lines, readTo);
  }
  if (!row || row.status !== "running") {
    // **明确放弃**:结局已经被别人写下了。那条路径自己负责交代这一批（`finish` 把尚欠的
    // 那一批附在结束通知里),这里只留一行日志 —— 静默返回会让「放弃」和「推完了」同形。
    console.error(
      `[ash] 哨兵 ${monitorId} 已经不是运行态（${row?.status ?? "行没了"}），这一批 ${lines.length} 行不再单独推送`,
    );
    return "abandoned";
  }

  // **结束条件先判,而且只看这一批行本身**（第 1 轮审查 F2）。
  //
  // 判据一旦依赖「前面那几笔读写恰好都成功」，它就跟着那些读写一起失败：上一版把这一句排在
  // `pushLines` 之后，于是通知入队失败一次，这一批里那条 `DONE` 就再也不会被看见
  // （后面没有输出 ⇒ 不会再有下一次 flush）。现在它是纯内存的，排在任何库操作之前。
  //
  // 匹配本身没有回溯这回事（结束条件是字面量候选，见 shared 的 `monitor-end-condition.ts`
  // 文件头 ①），所以这一笔在主线程上跑是有上界的。
  const cond = parseEndCondition(row.stopWhen);
  const hit = cond.ok && cond.cond ? endConditionHit(lines, cond.cond) : null;

  let events: number;
  try {
    events = await pushLines(row, lines, readTo, hit);
  } catch (error) {
    console.error(`[ash] 哨兵 ${monitorId} 这一批 ${lines.length} 行没推出去,放回缓冲重试:`, error);
    return returnToBuffer(rt, monitorId, lines, readTo);
  }

  // **约定的那一行到了 ⇒ 当场收工**。顺序是「先推、后收尾」:命中的那一行本身照常送给 agent
  // (它多半就是结果本身),收尾通知紧跟在后面。不能 await,理由同下面那条上限 —— 这里正跑在
  // `serialize(monitorId, …)` 的队列里,而 finish 还要往同一条队列排最后一次 flush。
  //
  // 这是「命令自己永远不会结束」那一类的**唯一一条非到期出路**:没有它,`tail -F` 这种命令
  // 被盯的活早跑完了,任务还得干等到期(2026-10-21 实测白等 30 分钟)。
  if (hit !== null) {
    settleInBackground(
      monitorId, "matched",
      `等到了约定的那一行（${JSON.stringify(hit.length > 120 ? `${hit.slice(0, 120)}…` : hit)}），哨兵就此收工`,
      null,
    );
    return "delivered";
  }

  if (events >= MONITOR_MAX_EVENTS) {
    // **不能 await**：这里正跑在 `serialize(monitorId, …)` 的队列里，而 finish 收尾时
    // 还要往同一条队列里排一次最后的 flush。await 它就是等自己后面那一位，当场死锁。
    settleInBackground(monitorId, "stopped", `推够了 ${MONITOR_MAX_EVENTS} 条事件自动停——每条事件都要唤醒任务跑一轮，再盯下去就是白烧回合。真要继续，换一条过滤更紧的命令重起一个`, null, { endedBy: "limit" });
    return "delivered";
  }
  // 这一批吃不完（有上界），缓冲里还压着下一批 —— 马上接着来，不等那 300ms 的窗口。
  if (partial) armFlush(rt, monitorId, 0);
  return "delivered";
}

