// 哨兵的**消费循环**:tail 读回来的行怎么变成事件,以及每一批行的**结局**。
//
// 从 monitors.ts 拆出来的（全局约定:单文件不超过 700 行）。运行时注册表、盯与停仍在那边,
// 这一层只负责「一批行」这件事的四条不变量:
//
// ① **消息落库之后**才推进事件计数和读取位置（反过来排 = 重启那一下静默吞掉几行）。
// ② **一批有上界**:`MONITOR_MAX_LINES_PER_FLUSH`。吃不完的留在缓冲里下一批接着来 ——
//    放回、渲染、重放这三步都按行数线性涨,没有上界就会在一次大爆发上各炸一次。
// ③ **每一批都答得出自己算谁的**:`FlushOutcome` 的五档。「推一次就不管了」正是第 1、2 轮
//    审查那几个现场的共同形状:行没送出去,而调用方按「已经送完」继续往下走。
// ④ **读取位置只许推到「它前面每个字节都已交付或已明确放弃」的地方**（第 3 轮审查 F1）。
//    这一条是 ① 的对称面:①管「这一批」,④管**整个游标**—— 空行快进、分批、失败重试、
//    收尾排干、离线补读全都在写同一个游标,所以判据只有一份(`commitProgress`),而不是每个
//    写入口各自现场判一次时序。
// ⑤ **终态放行之前,每一批都得有归宿**:已交付 / 已明确放弃 / 已持久移交,三者之一
//    （第 4 轮审查 F1）。④管的是游标,⑤管的是**那几行本身**,而两者的判据是同一个
//    `outstanding` —— 「缓冲这会儿是空的」既不能当成「游标可以推」,也不能当成「没有东西
//    要交接」:`flushBuffer` 一开头就把那一批 `splice` 走了。收尾那一路问这件事走
//    `drainOwed`,它是唯一答得出「还欠着哪几行」的地方。
import { eq } from "drizzle-orm";
import {
  MONITOR_BATCH_MS,
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

/**
 * 还有没有**没结清**的内容。两项都要看:
 *
 *  · 缓冲里压着的 —— 还没送的，以及送失败放回来等重试的
 *  · **正在送的那一批** —— `flushBuffer` 一开头就 `splice` 走了它,那一刻缓冲是空的,而那
 *    几行一个都还没落库
 *
 * 只看缓冲就是上一版那个洞（第 3 轮审查 F1）。
 */
const outstanding = (rt: Runtime): boolean => rt.buffer.length > 0 || rt.inflight > 0;

/**
 * 把读取位置落库。**没结清的内容在场时一个字节都不推**（见文件头 ④）。
 *
 * 不传运行时就按注册表里那一个判:离线补读那一路已经把运行时撤了,查不到 = 内存里没有任何
 * 没结清的内容,跟「有运行时、而它是干净的」是同一个答案。
 *
 * 落空（返回 false）不需要补救:下一批行交付时会把游标带到它自己的位置,之后的空行照旧快进。
 * 代价只是命令**从此彻底安静**时游标停在交付点上 —— 重启接回从那儿重读一遍,空行照旧被过滤
 * 掉,而没交付的那几行**正该**再推一次。
 */
export async function commitProgress(monitorId: string, offset: number, rtOverride?: Runtime): Promise<boolean> {
  const rt = rtOverride ?? runtimes.get(monitorId);
  if (rt && outstanding(rt)) return false;
  if (dbClient.closed) return false;
  try {
    await db.update(monitors).set({ offset }).where(eq(monitors.id, monitorId));
    return true;
  } catch (error) {
    // 落不下去是安全的那一侧（游标偏小 ⇒ 重读 ⇒ 最多重推一次），但不静默:静默会让
    // 「一直推不动的游标」看起来跟「没有新内容」一模一样。
    console.error(`[ash] 哨兵 ${monitorId} 的读取位置没落下去（offset=${offset}）:`, error);
    return false;
  }
}

/**
 * 一次 tail 回调:几行新内容 + **整个缓冲读到文件哪个字节**。
 *
 * 这一支是「空行快进」唯一的入口。读到的全是空行时位置本可以直接前进 —— 没有事件要落,不
 * 存在「推进了却丢事件」。但**「缓冲这会儿是空的」不等于「前面那几行已经交付」**:上一版拿
 * `rt.buffer.length` 当判据、把一个**无条件**的 offset 提交排进队列,于是第 3 轮审查实测的
 * 那一幕 —— 命令打完 `FINAL_OFFSET=0` 就睡,那一笔事件 INSERT 失败一次、行回到缓冲等两秒后
 * 重试,排在后面的空行提交却成功了:游标走到日志结尾(offset=16、events=0、消息从未入队),
 * 重启接回从那儿开始读,那一行再也读不回来。
 *
 * 所以判据挪进 `commitProgress`,而且**在队列里现算**:排队那一刻和真正提交之间隔着一整笔
 * 推送,时序只能在提交的那一刻判。
 */
export function consumeTailChunk(rt: Runtime, monitorId: string, lines: string[], offset: number): void {
  for (const line of lines) if (line.trim()) rt.buffer.push(line);
  if (!rt.buffer.length) {
    void serialize(monitorId, () => commitProgress(monitorId, offset, rt));
    return;
  }
  rt.readTo = offset;
  armFlush(rt, monitorId, MONITOR_BATCH_MS);
}

function trim(line: string): string {
  return line.length > MONITOR_MAX_LINE_CHARS ? `${line.slice(0, MONITOR_MAX_LINE_CHARS)}…（本行已截断）` : line;
}

/**
 * 这一批里**命中结束条件的那一行**（没有就是 null）。纯内存、纯比较,没有回溯这回事
 * （见 shared 的 `monitor-end-condition.ts` 文件头 ①）。
 *
 * **正文构造层自己算，不让调用点传**（第 3 轮审查 N1）。上一版它是 `pushLines` 的一个可选
 * 参数:在线冲刷和在线收尾都传了,离线补读那一处没传 —— 于是重启之后补读出来的那一批里,
 * 排在第 41 行往后的结束结果照旧被正文省掉,而那一行多半就是 agent 要的结果本身。可选参数
 * 的默认值就是「忘了传」那条路,所以这一版不给调用点这个选择:算它只需要行和 `stopWhen`,
 * 两样在构造正文的那一刻本来就都在手上。
 */
export function hitOf(row: Pick<Row, "stopWhen">, lines: readonly string[]): string | null {
  const cond = parseEndCondition(row.stopWhen);
  return cond.ok && cond.cond ? endConditionHit(lines, cond.cond) : null;
}

/**
 * 命中之后那句结束原因。**只写一处**:在线命中（下面 `flushLocked`）和到期排干时才命中那一种
 * （折叠进持有者的结局，见 monitor-finish.ts 的 `foldHit`）念的必须是同一句话。
 */
export const matchedReason = (hit: string): string =>
  `等到了约定的那一行（${JSON.stringify(hit.length > 120 ? `${hit.slice(0, 120)}…` : hit)}），哨兵就此收工`;

/**
 * 一批行渲染成一段话:前几行 + 省略了多少 + **命中那一行**。
 *
 * 命中那一行必须出现在这段话里（第 2 轮审查 N2）:列表只列前 `MONITOR_MAX_LINES_PER_PUSH`
 * 行,而命中那一行恰恰可以排在第 41 行往后 —— 它多半就是 agent 要的那个结果本身,被省略掉
 * 的话,它只会收到一句「等到了约定的那一行」和一批看不出所以然的开头几行。
 *
 * 收尾那条通知也用这一份（见 `finish` 里的「尚欠的那一批」）:两处各写一遍渲染,就会出现
 * 「单独送的时候列 40 行、附在通知里时列 5 行」这种说不清的差别。
 */
export function linesBody(row: Pick<Row, "stopWhen">, lines: string[]): string {
  const keep = hitOf(row, lines);
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
export function renderLines(row: Row, lines: string[]): string {
  return `【哨兵事件】${row.description}（monitorId=${row.id}）\n${linesBody(row, lines)}`;
}

/**
 * 把一批行变成一条事件消息，**消息落库之后**才推进事件计数和读取位置。
 *
 * 这个顺序是硬要求，不是讲究：位置先走、消息后落的话，中间哪怕只隔那 300ms 的批量窗口，
 * server 一停这几行就永远没人读了——游标已经越过去，内容还躺在日志里，任务却一个字都
 * 收不到（第 1 轮审查复现：read_offset=13、events=0、消息为空，日志里那行完好无损）。
 * 反过来排的代价只是重启后可能把同一批行再推一次，重复远比静默丢失便宜。
 */
export async function pushLines(row: Row, lines: string[], readTo: number | null): Promise<number> {
  const delivered = await pushToTask(row, renderLines(row, lines));
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
  // **从这一刻起这一批算「在途」**（见 `outstanding`）:它已经不在缓冲里了,而一个字节都还
  // 没落库 —— 空行快进这期间必须挡住。`finally` 里减,所以抛了也不会把它永久算成在途。
  rt.inflight += 1;
  try {
    return await flushLocked(rt, monitorId, lines, partial);
  } finally {
    rt.inflight -= 1;
  }
}

/**
 * 收尾那一路的**排干**:把这条哨兵手上没结清的内容全部结清,把结清不掉的那几行**交出去**。
 *
 * 判据是 `outstanding`,不是 `rt.buffer.length`（第 4 轮审查 F1）。上一版这个循环写在 `finish`
 * 里、条件是「缓冲非空」—— 于是审查实测的那一幕:命令打完 `FINAL_INFLIGHT=0` 就睡,那一笔
 * 事件 INSERT 挂在半空中(缓冲已经空了、`inflight=1`),命令随后自己退出 —— `finish` 看一眼
 * 空缓冲就认为没什么要交接,结束通知里一个字都没附,终态落定;再让那笔 INSERT 失败,行被放回
 * 一个**已经撤掉、而且 closing** 的运行时:`armFlush` 不再排重试,接回那条路只枚举 running,
 * 结束通知里也没有它 —— 那一行(多半就是 agent 要的结果本身)此后谁都不管了。
 *
 * **进队列一次就等于等在途那一批**:推送一律排在 `serialize(monitorId)` 上,在途那一批比我们
 * 先排进去,所以我们这一轮一定排在它后面 —— 它要是失败放回,那几行在我们这一轮看缓冲时已经
 * 在里面了。所以这里的循环只要**按 `outstanding` 决定要不要再进一次队列**,不必（也不能）
 * 自己去 await 那一批:它是别人的 promise。
 *
 * 调用方必须**不在** `serialize(monitorId)` 的队列里（`finish` 一路都是这么调的）—— 在队列里
 * 再排一次就是等自己后面那一位（同一条约束见 `teardownRuntimeLocked`:它在队列里,所以直接
 * 调 `flushBuffer`）。
 */
export async function drainOwed(monitorId: string, rt: Runtime): Promise<string[]> {
  while (outstanding(rt)) {
    const outcome = await serialize(monitorId, () => flushBuffer(monitorId, rt))
      .catch((): FlushOutcome => "owed");
    // 没交付就停:`closing` 之下 `armFlush` 不再排重试,再转一圈也只是同一笔失败
    //（`idle` = 在途那一批自己成了,缓冲里本来就没东西）。
    if (outcome !== "delivered") break;
  }
  const owed = rt.buffer.splice(0, rt.buffer.length);
  // 走到这儿 `inflight` 必须是 0:所有推送都排在那条队列上,而我们刚从队列里出来,定时器也
  // 已经撤了。不是 0 就说明**又多了一个不走队列的推送入口** —— 那一批的归宿这里答不出来,
  // 只能当场出声（静默的话它就是下一次「结果再也收不到」）。
  if (rt.inflight > 0) {
    console.error(
      `[ash] 哨兵 ${monitorId} 排干之后还有 ${rt.inflight} 批在途:有推送没走 serialize 队列,`
      + `这一批的归宿没人答得出来（已交出 ${owed.length} 行）`,
    );
  }
  return owed;
}

async function flushLocked(
  rt: Runtime, monitorId: string, lines: string[], partial: boolean,
): Promise<FlushOutcome> {
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
  const hit = hitOf(row, lines);

  let events: number;
  try {
    events = await pushLines(row, lines, readTo);
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
    // **证据先记在运行时上**（第 1 轮审查 N1）:这一笔 `settle` 很可能占不到收尾槽位 ——
    // 到期（或自退）先占到、正在排干,这一批恰恰是它排出来的。那时合并等待不会改变结局,
    // 于是「字样明明到了」被写成「盯满了约定的时长」。持有者落终态前会读这里（`foldHit`）。
    rt.hit = hit;
    settleInBackground(monitorId, "matched", matchedReason(hit), null);
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
