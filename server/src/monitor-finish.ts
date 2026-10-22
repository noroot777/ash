// 收尾:一条哨兵的**结局由谁写、什么时候许写**。
//
// 从 monitors.ts 拆出来(单文件 700 行的约定),它自成一块职责 —— 停/过期/自退/命中/推满上限
// 这几条路最后全汇到这里,而「汇到一处」本身就是这一摊反复出事的地方:每一轮审查挑出来的洞
// 都不是某个回调写错了,而是**两笔收尾对同一条哨兵答得不一样**(谁负责把没送出去的行交出去、
// 谁有资格把终态写下来)。所以这个文件的中心不是 `finish` 那串步骤,而是它上面那个所有权槽位。
//
// 运行时账本(`runtimes`/`serialize`/`attach`)仍在 monitors.ts,批次的归宿仍在 monitor-consume.ts,
// 这边只按它们的公开判据组合。**公开面照旧从 monitors.ts 出**(那边 re-export 这几个名字,
// 调用方一个都不用改)。
import { and, eq } from "drizzle-orm";
import type { MonitorStatus } from "@ash/shared/monitor";
import { monitorEventTally } from "@ash/shared/monitor-silence";
import { db, dbClient } from "./db/index.js";
import { monitors } from "./db/schema.js";
import { drainOwed, linesBody, matchedReason, renderLines } from "./monitor-consume.js";
import { deliverResultHandoff } from "./monitor-events.js";
import { ensureSupervised } from "./monitor-handover.js";
import { reclaimMonitorProcess, settleReclaim } from "./monitor-reclaim-debts.js";
import { clearSpawnIdentity } from "./monitor-spawn.js";
import { monitorLogBytes, publish, runtimes } from "./monitors.js";
import { appendTaskTimeline } from "./task-timeline.js";
import { now } from "./util.js";

/**
 * 收尾放手时手上还攥着没送出去的行 —— **出声,别静默**。
 *
 * 游标那一侧没动过(见 `commitProgress`),日志里的原文还对得上,所以这不是数据没了;真正
 * 不能接受的是「静默丢弃」和「明确放弃」混成一件事:前者连查都没处查。
 */
function reportOwedDropped(monitorId: string, owed: string[], why: string): void {
  if (!owed.length) return;
  console.error(
    `[ash] 哨兵 ${monitorId} 收尾放手时还欠着 ${owed.length} 行没送出去（${why}）：`
    + JSON.stringify(owed.slice(0, 3)),
  );
}

/**
 * **这条哨兵的收尾此刻归谁**。键 = 哨兵 id,值 = 那一笔跑完为止(只 resolve,不 reject)。
 *
 * 「没有运行时对象」**不等于**「没有人正在收尾、而且手里还握着输出」(第 1 轮审查 F1)。
 * `finish` 第一件事就是把运行时从 `runtimes` 里摘掉,随后才在 `drainOwed` 里一批批往外推,
 * 那几行此刻只活在它的局部变量上。上一版的防重入判据恰恰是「还能从 `runtimes` 取到同一个
 * 对象」—— 于是这段时间里另一笔收尾什么都看不见:消费层在排干过程中命中约定字样、或者推满
 * 上限,都会再调一次 `settleInBackground`,那一笔读到一行还 running 的记录,就把 matched/
 * stopped 和一条**不带欠账**的结束通知先写了下去;第一笔那一批随后入队失败、行被放回一个
 * 已经撤掉又 `closing` 的运行时(排不上重试、接回只枚举 running),而它重读到终态就直接返回
 * —— 那几行(多半就是 agent 要的结果本身)此后谁都不管了(审查实测 limit 与 matched 两路
 * 对称复现:`reachedAgent:false`、交接凭证为空,真跑一遍 `reattachMonitors()` 也补不回来)。
 *
 * 所以资格改成这个槽位:**占到的那一笔负责把账结清**(交付 / 明确放弃 / 落一笔持久交接),
 * 其余**非放弃型**结束请求只能合并等它,一个字都不许先写进终态。
 *
 * **放弃型不在此列**(`opts.abandon`:用户点停、任务清场)。那几条路的凭证另有落点 —— 点停
 * 先把「它还没送到的结果我不要了」落了库(`results_abandoned_at`,见 monitor-stop.ts),清场
 * 随后把排着的事件整批作废(`cancelPendingMonitorEvents`,见 monitor-reclaim.ts),都对得上
 * 「明确放弃」这一档,所以它们不欠投递、也就不该为谁等着。让它们等的代价是真的:**点停这
 * 一跳必须整跳落定**,而持有者可能正卡在一笔秒级的库操作上 —— 第 21 轮审查 F2 钉的「停止
 * 赢了就是赢了」会当场变成「按了停,页面一直转」(实测:让这两边互等,那条回归直接挂住)。
 * 持有者随后重读到终态就放手,手上还攥着的行由 `reportOwedDropped` 如实报出来。
 *
 * **等不出死锁**:排干要的是 `serialize(monitorId)` 那条队列,而消费层那两个出口一律 `void`
 * 调 `finish`(见 `settleInBackground`),等在槽位上的那一笔不占着队列;会等的那几个入口
 * (自退、到期、接回)手里一条队列都没有。
 */
const finishing = new Map<string, Promise<void>>();

/** 这条哨兵此刻有没有人正在收尾(手里可能还握着没交出去的行)。`null` = 没有。 */
export const finishInFlight = (monitorId: string): Promise<void> | null => finishing.get(monitorId) ?? null;

/**
 * 占下「这条哨兵的收尾归我」。占到 = 一个幂等的 release;占不到 = `null`。
 *
 * 给**不走 `finish` 的那条终态写入**用(`finishOffline`:它整段跑在 `serialize(row.id)` 上,
 * 所以它只能退出不能等 —— 排干也要那条队列)。
 */
export function claimFinish(monitorId: string): (() => void) | null {
  if (finishing.has(monitorId)) return null;
  let settle!: () => void;
  finishing.set(monitorId, new Promise<void>((resolve) => { settle = resolve; }));
  let released = false;
  return () => {
    if (released) return;
    released = true;
    finishing.delete(monitorId);
    settle();
  };
}

/**
 * 收尾。三条路都可能到这儿（过期、进程自己退出、有人点停），只做一次。
 *
 * 「只做一次」的判据是上面那个槽位,不是内存里还能不能取到运行时(见 `finishing`)。占不到
 * 就合并:等那一笔收完,它的结局就是这条哨兵的结局。
 *
 * `notify=false` 用在「任务自己已经结束了」那一路：那时候再推一条收尾事件就等于把一个
 * 已经 done 的任务重新叫起来跑一轮，纯属倒忙。
 */
export async function finish(
  monitorId: string,
  status: Exclude<MonitorStatus, "running">,
  reason: string,
  exitCode: number | null,
  // `endedBy` = **谁让它停的**(见 schema 的 ended_by)。缺省 `system`:拿不准的时候一律
  // 不算主动撤 —— 说成「本回合撤掉了哨兵」是个会误导人的断言,说成系统回收顶多是少说一句。
  // `abandon` = **这一笔明确放弃它还没交出去的东西**(见 `finishing`:只有它不参与合并等待)。
  opts: {
    notify?: boolean; keepBuffered?: boolean; abandon?: boolean;
    endedBy?: "actor" | "limit" | "system";
  } = {},
): Promise<void> {
  const release = claimFinish(monitorId);
  if (!release) {
    // 槽位被占着。非放弃型合并到那一笔上;放弃型照旧往下走(它不欠投递,见 `finishing`)。
    if (!opts.abandon) {
      await (finishing.get(monitorId) ?? Promise.resolve());
      return;
    }
    await finishHeld(monitorId, status, reason, exitCode, opts);
    return;
  }
  try {
    await finishHeld(monitorId, status, reason, exitCode, opts);
  } finally {
    release();
  }
}

/**
 * 收尾的本体。**调用方要么是收尾所有权的持有者,要么是放弃型那一笔**(见 `finishing`)。
 */
async function finishHeld(
  monitorId: string,
  status: Exclude<MonitorStatus, "running">,
  reason: string,
  exitCode: number | null,
  opts: NonNullable<Parameters<typeof finish>[4]>,
): Promise<void> {
  const notify = opts.notify ?? true;
  const keepBuffered = opts.keepBuffered ?? true;
  /** **尚欠的那一批**:最后那几次冲刷没能交付的行。下面跟着结束通知一起落库交接。 */
  let owed: string[] = [];
  const rt = runtimes.get(monitorId);
  if (rt) {
    if (rt.closing) return;
    rt.closing = true;
    runtimes.delete(monitorId);
    for (const t of rt.timers) { clearInterval(t); clearTimeout(t); }
    if (rt.flush) clearTimeout(rt.flush);
    if (keepBuffered) {
      // 进程刚死那一瞬写进去的最后几行也算数：先把文件吸干，再把缓冲里剩下的一并推出去。
      rt.tail.drain();
      rt.tail.stop();
      // **排干这件事归消费层**（`drainOwed`，判据见那边文件头 ⑤）:按批推（一批有上界，见
      // `MONITOR_MAX_LINES_PER_FLUSH`），推不动的那几行交回来 —— 由下面的 `owed` 跟结束通知
      // 一起落库交接。
      //
      // 这一层**不自己判「还有没有东西要交接」**（第 4 轮审查 F1）。上一版这里的循环条件是
      // 「缓冲非空」,而 `flushBuffer` 一开头就把在途那一批 `splice` 走了 —— 于是在途那一笔
      // 事件 INSERT 挂在半空中时,这里看一眼空缓冲就认定没什么要交接,结束通知里一个字都没
      // 附、终态当场落定;那笔 INSERT 随后失败,行被放回一个已经撤掉、而且 `closing` 的运行
      // 时:`armFlush` 不排重试、接回只枚举 running、通知里也没有它 —— 那一行(多半就是
      // agent 要的结果本身)此后谁都不管了（审查实测:自退与到期两路都是 events=0、offset=0、
      // 待发里只有【哨兵结束】）。
      //
      // 更早那一版连「推不动」都不管（`.catch(() => {})`，第 2 轮审查 F1-A）:行就地蒸发,
      // 而终态、结束通知、回收责任照旧一路写下去。
      owed = await drainOwed(monitorId, rt);
    } else {
      // 任务自己已经结束的那一路：缓冲里这几行一个都不推。`notify=false` 只挡住最后那条
      // 「哨兵结束」，挡不住这一批——它照样会排进待发队列，而紧接着的 flushPendingForTask
      // 会立刻把它送进会话（第 1 轮审查实测：任务 done 之后被重新拉起跑了一轮）。
      //
      // **这一路算「明确放弃」**（见消费层文件头 ⑤ 的三种归宿）:在途那一批要么自己落了库、
      // 要么失败放回这个再也没人读的缓冲 —— 两样都对得上「这几行一个都不推」这个决定,所以
      // 这里不等它。点停那一路要的是另一半（已攒的行照常推完，见 monitor-stop.ts），它走的
      // 是上面那一支。
      rt.tail.stop();
      rt.buffer.length = 0;
      rt.readTo = null;
    }
  }
  /**
   * **排干阶段读到的结束证据,落终态之前折叠进来**（第 1 轮审查 N1）。
   *
   * 所有权仍然只有一个:命中那一笔占不到槽位、只能合并等着（见 `finishing`）—— 改的是**这个
   * 持有者写下的那个结局**。不折叠的话,到期先占到槽位、它排干时才读到约定的字样,库里落的是
   * expired「盯满了约定的时长」,而那句话会被读成「约定的字样一直没出现」（审查实测:字样比
   * 期限早 209ms,正文里 READY 和结束通知都在,状态仍是 expired）。
   *
   * **用户点的停不在此列**:`abandon` 和 `endedBy="actor"` 那几笔说的是「我停的」,而且它们
   * 明确放弃了还没送出去的结果 —— 把它改写成「等到了约定的那一行」等于把第 21 轮审查 F2 钉的
   * 「停止赢了就是赢了」又拆掉一次。到期/自退/推满上限这几种是兜底原因,让位给**约定好的那条
   * 出路**;`endedBy` 也跟着回到 `system`(不是「推满上限才停的」)。
   *
   * **离线补读那一路的折叠在它自己那边**(`monitor-offline-finish.ts`:它手上没有运行时、也没有
   * 排干,证据是刚补读出来的那几行)。那一侧折的是同一件事、用的是同一个 `hitOf`/`matchedReason`,
   * 但它**把原来那句「进程已经不在了」接在后面而不是换掉**:进程为什么没了只有那句话答得出来,
   * 而退出码那一路从来就拿不到（新一轮审查 N1）。
   */
  const foldHit = !opts.abandon && opts.endedBy !== "actor" ? rt?.hit ?? null : null;
  if (foldHit !== null) {
    status = "matched";
    reason = matchedReason(foldHit);
  }
  const endedBy = foldHit !== null ? "system" : opts.endedBy ?? "system";
  if (dbClient.closed) { reportOwedDropped(monitorId, owed, "库已经关了"); return; }
  // 运行时已经撤了,而终态还没落盘 —— 下面每一步都可能抛(回收层、条件更新、通知)。
  // **出这个函数时如果库里还是 running,监督必须还在**(第 23 轮审查 F1),所以从这里起包进
  // try/finally。成功那一路 `ensureSupervised` 读到终态,什么都不做。
  try {
    const row = (await db.select().from(monitors).where(eq(monitors.id, monitorId))).at(0);
    if (!row || row.status !== "running") {
      // **这一支不许静默**(第 1 轮审查 F1)。收尾所有权立起来之后,能走到这儿的只剩「结局不是
      // 由收尾写的」那几种(行被删、任务清场那一路把它整条作废、离线收尾抢在前面)—— 都属于
      // 明确放弃,但手上还攥着没送出去的行时,放弃和静默蒸发必须分得开。
      reportOwedDropped(monitorId, owed, `结局已经是 ${row?.status ?? "行已不在"} 了`);
      return;
    }
    // **回收这个进程的责任从这里起**(见文件头第 ③ 条)。下刀资格由取证层按档位判,这一层
    // 不再传「刚刚还在我们手上吗」那个开关(第 14 轮审查 F1:四个入口共用同一份判据)。
    //
    // 记账排在**改状态之前**:顺序一反,中间崩一下这一行就成了「显示已停止、责任没人认、
    // pid 线索下一步就被删除抹掉」(第 4、5 轮审查 F1 都是这个现场)。
    const outcome = await reclaimMonitorProcess(row, reason);
    // **条件落定**(第 21 轮审查 F2)。上面那次重读之后还 await 了回收层(问状态、下刀、等确认,
    // 秒级),而这期间用户完全可以点停、可以删任务 —— 上一版这条 UPDATE 无条件,通知还紧跟其后,
    // 于是「点停已经成功返回、页面写着用户停的」随后被这条在途的收尾改写成 expired 并补推一条
    // 【哨兵结束】。条件没落上就**结局不改、通知不推**;回收责任照旧结清 —— 那一笔是上面已经
    // 发生的事,跟谁写下结局无关。
    const code = exitCode === null ? "" : `，退出码 ${exitCode}`;
    // **结束通知的责任凭证跟终态同一条语句落库**(第 1 轮审查 F1)。上一版是「先写终态,再去
    // 入队」,中间还隔着时间线那一笔 await —— 那一瞬库里既没有 running 的哨兵、也没有排着的
    // 消息,而完成闸问的恰好就是这两样,于是它放行、任务落 done,紧接着的入队被终态挡回,
    // 那条通知就此蒸发(实测 `F1_END_RESULT_HANDOFF`)。一条语句写下来就没有那条缝:从这一刻
    // 起闸看得见这笔交接(见 schema 的 `result_handoff_at`),入队完成后才销。
    // 事件数**重读**：它要反映收尾前最后那一次 flush。有没有产出过则一律问日志文件本身,
    // 不问投递游标(见 `monitorLogBytes`:游标被终态挡回时会把「它说了但没送出去」说成
    // 「它什么都没说」—— 第 2 轮审查 R2-4)。
    //
    // **读一次、两处用**:这句话既要给 agent 看(下面那条结束通知),也要给人看(时间线)。
    // 各读一次会让两边报出不同的数,而「0 条事件」这件事恰恰是 agent 最该当场知道的 ——
    // 它只拿到一句「盯满了约定的时长」的话,分不出「哨兵哑了」和「我漏读了几条」,只能靠猜
    // (用户 2026-10-21 要的那半件事)。通知的文字必须在下面那条 UPDATE **之前**定好:这两笔
    // 得在同一条语句里落库,所以读也只能排在它前面。
    const total = (await db
      .select({ events: monitors.events })
      .from(monitors).where(eq(monitors.id, monitorId))).at(0)?.events ?? row.events;
    const tally = monitorEventTally(total, monitorLogBytes(row.logPath));
    // **尚欠的那一批跟着结束通知走**（第 2 轮审查 F1-A）。要的是「持久化的交接责任、而且
    // 完成闸看得见」—— 而这里已经现成有一份:这条通知的凭证跟终态写在同一条 UPDATE 里
    // （`result_handoff_at`）、入队失败有补发扫描（monitor-handoff-retry.ts）、从产出到入队
    // 的每一刻完成闸都看得见它（task-complete-monitors.ts 的第二、三类）。所以不另开一张
    // 欠账表:这几行附在那条通知里,就继承了同一份责任。游标那一侧也没动过,日志里的原文
    // 照旧对得上。
    //
    // `notify=false` 那一路（任务自己已经结束、或者有人点停）**照样附**:它压的是「哨兵结束」
    // 这句播报,不是已经吐出来的内容 —— monitor-stop.ts 写明「已经攒在缓冲里的行要照常推完」。
    const owedNote = `…（下面这 ${owed.length} 行没能单独送出来，附在收尾这一条里）`;
    const endNotice = notify
      ? `【哨兵结束】${row.description}（monitorId=${row.id}）${code}。${reason}（${tally}）`
        + (owed.length ? `\n${owedNote}\n${linesBody(row, owed)}` : "")
      // `notify=false` 那一路没有抬头可借,这几行自己成一条事件消息。
      : owed.length ? `${renderLines(row, owed)}\n${owedNote}` : null;
    const result = await db
      .update(monitors)
      .set({
        status, endedAt: now(), endedReason: reason, exitCode, endedBy,
        ...(endNotice ? { resultHandoffAt: now(), resultHandoffText: endNotice } : {}),
      })
      .where(and(eq(monitors.id, monitorId), eq(monitors.status, "running")));
    if (Number((result as { rowsAffected?: number | bigint } | null)?.rowsAffected ?? 0) === 0) {
      console.error(`[ash] 哨兵收尾放手 monitor=${monitorId}：条件更新没落上，结局已经有人写过了（${reason}）`);
      // 放手这一支手上还攥着尚欠批次时,**那几行就是真丢了**:结局归别人写,这条 UPDATE 带着
      // 的交接凭证一个字都没落上。概率很窄(得正好是「排干时撞上推满上限/点停」加「那一批
      // 又没交付」),但静默丢弃和明确放弃必须分得开 —— 所以这里报出来,游标那一侧照旧没动,
      // 日志里的原文还对得上。
      reportOwedDropped(monitorId, owed, "结局被别人写了，这一批没有交接凭证可搭");
      await settleReclaim(outcome);
      return;
    }
    publish(row.taskId);
    await appendTaskTimeline(row.taskId, `哨兵结束：${row.description}${code}。${reason}（${tally}）`);
    // 入队 + 销凭证。顺序反过来那条缝又回来了(见 `deliverResultHandoff`)。
    if (endNotice) await deliverResultHandoff(monitorId);
    // **追线索放在最后**:状态、时间线、通知都已落定,这一步只负责「能收的档收掉」。
    // 它会等到补刀生效(有界,见 `confirmReclaimed`)—— 于是这个函数返回时,要么进程确认不在了,
    // 要么责任稳稳地留在账本上。
    //
    // 第三种(`unaccounted`:库写不进去)这里只能出声:**身份还在**(这一行没被删,pid 和启动
    // 时刻都还在上面),开机时 `reclaimUnconfirmedStops` 会按非运行态把它重问一遍。真正不能
    // 放过它的是**销毁身份**那条路 —— 那边整笔中止(见 monitor-reclaim.ts)。
    const verdict = await settleReclaim(outcome);
    if (verdict === "unaccounted") {
      console.error(
        `[ash] 哨兵收尾时既没确认退出、回收责任也没落库 monitor=${monitorId} pid=${row.pid}`
        + `（哨兵行还留着它的身份，开机会再问一遍）`,
      );
    }
    // 身份边条**只在线索追空之后**才撤(`closed`)。
    //
    // 它不只是「pid 空着那一档的兜底」:当这一行的 `pid_started_at` 还空着时,边条里那个时间锚
    // 是**唯一**能把身份补全的东西(见 monitor-reclaim-debts 的 `completeIdentity`)。责任还欠着
    // 就把它删掉,等于把「这一刻 ps 答不出来」永久固化成「这条永远证不出身份」:之后既不敢下刀,
    // 也销不掉账(第 10 轮审查 F2-B)。确认退出之后它才真的没用了。
    if (row.kind === "ash" && row.logPath && verdict === "closed") clearSpawnIdentity(row.logPath);
  } finally {
    // 不传 `holdingChain`:这个函数本身不跑在 `serialize(monitorId)` 上(它只在里面排过
    // flush),所以让交接层把这一趟排进那条队列 —— 并发的两笔收尾于是各自有序,后落定的
    // 那一笔一定看得到前一笔刚挂回来的运行时(第 24 轮审查 N1)。
    await ensureSupervised(monitorId);
  }
}

/**
 * **放后台跑的那种收尾**:定时器、探活、推满上限、进程自己退出 —— 四条都没有调用方在等
 * 它的结果,所以**它的失败只能进日志**。
 *
 * 不接住的话就是一个没人管的 rejection:Node 默认把那个当致命错误,于是「一次收尾里的某笔
 * 读写失败」会把整个 ash 带下去。撞上关库是最常见的一种(判出结束的那一刻 ash 可能正在退出,
 * 实测:审查生命周期那份回归在 teardown 之后收到一条 `database is not open`)。
 */
export function settleInBackground(
  monitorId: string, status: Exclude<MonitorStatus, "running">, reason: string, code: number | null,
  opts?: Parameters<typeof finish>[4],
): void {
  void finish(monitorId, status, reason, code, opts)
    .catch((e) => console.error(`[ash] 后台收尾失败 monitor=${monitorId}（${reason}）:`, e));
}
