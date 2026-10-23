// 哨兵的**回收层**:谁来收、按什么资格收。
//
// 从 `monitors.ts` 分出来的是「一条哨兵该不该被收走」这一摊判断;那边留下的是哨兵自己的
// 运行时(起进程、盯 stdout、收尾、重启接回)与 CRUD。分界线就是这个文件里的两个入口:
// 它们一行运行时都不碰,只回答资格问题,真正的收尾动作调那边的 `finish`。
//
// 贯穿这一侧的三条:
//
// ① **命令的命 ≠ 结果的命。** 命令退出不代表它的通知已经送达 —— 保留集合要覆盖所有归属行,
//    停止进程的集合才只看 `running`(第 2 轮审查 F1)。
// ② **任务终态 ≠ 审查结束。** 审查是旁路回合,跑在一个已经 done 的任务上;判据是「起它的那次
//    审查(那一轮)还在不在」,不是任务此刻什么状态(第 1 轮审查 F1)。
// ③ **「审查还在进行」推不出「用户仍然允许这个任务的资源继续存在」。** 所以入口要带显式的
//    生命周期意图,不靠 reason 那段自由文本猜(第 2 轮审查 F2)。
// ④ **撤销是一段时间,不是一个瞬间**,而且**「停止函数正常返回」不等于资源已经回收**。
//    不变量是:**销毁持久身份之前,每一条要么已确认退出、要么回收责任已经可靠落盘**。
//    那一圈(落责任 → 发信号 → 追到线索空 → 收档)**住在运行时收尾层**(`monitors.ts` 的
//    `finish`),不在这个文件里 —— 装在这边的包装函数上时,用户点停、到期、推满上限、启动
//    接回判无出口、创建后登记失败全都绕过了它(第 5 轮审查 F1)。
//    所以这一侧只剩两件事:
//    - `destroy` 之前**按资源责任核对一遍**(`accountForLiveProcesses`):判据是「这一行的
//      进程组还活着吗」和「账本上有人认它吗」,**不是卡片状态是不是 running** —— 先点停再
//      删除的那条路上,行早就是 stopped 了,照状态过滤等于整条跳过(审查实测:删除后
//      debtRows=0、命令仍活);
//    - 连责任都落不下、又确认不了退出时,销毁那条路(删除)整笔中止;连枚举都失败时同样
//      整笔不许往下走(第 3、4 轮审查 F1)。
//    「不许再创建」是同一条不变量的另一半,在 monitor-session.ts 的资格闸里;「重启之后谁来
//    问一遍」在 `reattachMonitors`(按同一份出口资格)和启动期的债务清扫里。
import { and, eq, ne } from "drizzle-orm";
import { db } from "./db/index.js";
import { freeReviewRuns, monitors } from "./db/schema.js";
import { cancelPendingMonitorEvents } from "./monitor-events.js";
import {
  archiveTracelessIdentity, heldReclaimDebts, reclaimMonitorProcess, settleReclaim,
} from "./monitor-reclaim-debts.js";
import { reclaimState } from "./monitor-reclaim-evidence.js";
import { intentStillOpen } from "./monitor-adopt.js";
import { isReviewSourceActive } from "./monitor-session.js";
import { finish, isAshKind, serialize } from "./monitors.js";

/**
 * **为什么来收**。回收入口不能靠 reason 那段自由文本猜语义：
 *
 * - `task-settled` = 任务自己落了终态（done/failed/canceled）。审查是旁路回合，它跑在一个
 *   已经终态的任务上，所以「还在进行的审查」名下的哨兵要放过（见下）。
 * - `destroy` = 用户要求这个任务的一切就此结束（删除/归档）。**没有豁免**，而且必须在调用
 *   方销毁持久身份（tasks/monitors 行、pid）之前停完。
 */
export type MonitorStopIntent = "task-settled" | "destroy";

/**
 * 把一个任务名下还活着的哨兵全停掉。调用点是任务**自己**结束的那一刻（落 done/failed/
 * canceled、归档、删除）。
 *
 * 为什么任务一结束就连坐：哨兵唯一的出口是「唤醒这个任务」，任务都结束了，它再醒来也只是
 * 花钱。要让哨兵继续盯，这一轮该用 pause_task 收尾而不是 complete_task —— 这句话同时写在
 * MCP 工具的说明里，是 agent 做选择时唯一能看到的判据。
 *
 * **跟创建走同一条 `task:<id>` 队列**：不排队的话「正在创建」和「任务刚结束」会并发——
 * 创建那边数完活着的哨兵、起完进程、还没插库，连坐这边已经扫完了一遍，于是新起的那个
 * 谁也没停，它会一直跑到自己结束或到期，而它推的每一条都被终态挡回（第 2 轮审查第 3 条
 * 要求一并护住的那个窗口）。排上队之后两种顺序都收口：连坐先跑 → 创建在锁里读到终态、
 * 直接拒；创建先跑 → 连坐看得见那一行、照常停它。
 */
export async function stopMonitorsForTask(
  taskId: string, reason: string,
  // 省略 = 任务自己落了终态。删除/归档要显式传 `destroy`（见 MonitorStopIntent）。
  intent: MonitorStopIntent = "task-settled",
): Promise<number> {
  return serialize(`task:${taskId}`, () => stopMonitorsForTaskLocked(taskId, reason, intent));
}

async function stopMonitorsForTaskLocked(
  taskId: string, reason: string, intent: MonitorStopIntent,
): Promise<number> {
  // **两个集合各问各的**，这是这个函数最容易写错的地方：
  //
  // - `kept`（通知资格）要覆盖**所有归属行**，不论那条命令此刻还在不在。命令退出 ≠ 它的
  //   结果已经送达：审查者自己还在跑的那几分钟里，stdout 和「哨兵结束」只能排在托盘里等
  //   这一轮结束；它 pause 退出、任务被恢复成 done，紧接着就轮到这里。按「还在 running」
  //   构造保留集,等于把一条已经拿到结果、只差送达的哨兵的整批通知作废,而审查链还停在
  //   reviewing 等一个永远不会到的唤醒(第 2 轮审查 F1 实测:beforePending=1 正文含
  //   SUITE_DONE,after[0].status=canceled,reviewStatus=reviewing)。
  // - `doomed`（要去停的进程）才只看 `running`。
  //
  // 这是两件事,不是一件事的两种写法:正常退出、到期、被停、推满上限,只要结果还没送达、
  // 所属审查还有效,它就仍有消费价值。
  const all = await db
    .select({
      id: monitors.id, taskId: monitors.taskId, status: monitors.status,
      pid: monitors.pid, pidStartedAt: monitors.pidStartedAt, command: monitors.command,
      // 资源记号:归属与整项退出都只认它(见 monitor-reclaim-evidence 的 `MonitorUnit`)。
      unitToken: monitors.unitToken,
      // 身份边条就在它旁边:pid 还空着的创建意图行靠它认领(见 `reclaimMonitorProcess`)。
      logPath: monitors.logPath,
      sourceReviewRun: monitors.sourceReviewRun, sourceReviewRound: monitors.sourceReviewRound,
    })
    .from(monitors)
    .where(and(eq(monitors.taskId, taskId), isAshKind));
  // **任务终态 ≠ 审查结束**。自由工作流的审查是旁路回合：它跑的时候任务被写成 running，
  // 回合一退出又被恢复成原来的 done —— 于是这个函数紧接着就被叫起来。照着终态一刀切,
  // 审查者刚按提示挂好的哨兵会在同一瞬间被停掉、待发事件一并作废,而审查链还停在
  // reviewing 等一个永远不会到的唤醒(第 1 轮审查 F1 实测:pause 成功、monitorStatus
  // =stopped、reviewStatus=reviewing、resumePrompt 还留着)。
  //
  // 所以判据不是任务状态,而是**起它的那次审查(那一轮)还在不在**(创建、出口、唤醒三处
  // 同一份判据,见 monitor-session.ts)。那次审查自己收尾时由 `stopMonitorsForReviewRun`
  // 来收,哨兵不会因此漏在后台。
  //
  // **但这条豁免只对 `task-settled` 成立**：审查还在进行推不出「用户仍然允许这个任务的
  // 资源继续存在」。删除/归档是用户要求这个任务的一切就此结束,豁免放在那里会留下一个
  // 没人能再叫停的后台进程 —— 删除紧接着就把 tasks/monitors 整批删掉,pid 这个唯一线索
  // 跟着消失,之后 `finish` 查不到行直接返回,重启也认领不回来(第 2 轮审查 F2 实测:
  // taskRows=0、monitorRows=0、aliveAfterDelete=true)。
  const kept: string[] = [];
  const doomed: typeof all = [];
  for (const m of all) {
    const spared = intent === "task-settled" && m.sourceReviewRun !== null
      && await isReviewSourceActive(m.sourceReviewRun, m.sourceReviewRound);
    if (spared) kept.push(m.id);
    else if (m.status === "running") doomed.push(m);
  }
  // 停:一行失败也不能把后面几行一起带走。「落责任 → 发信号 → 追到线索空 → 收档」那一圈由
  // `finish` 自己走(见文件头第 ④ 条),所以这里只数停了几条。
  let stopped = 0;
  for (const m of doomed) if (await signalStop(m, reason, intent)) stopped += 1;
  // **按资源责任核对一遍**,范围是「这一次不再允许它继续存在」的全部归属行 —— 不只是刚才
  // 停掉的那几条:先点停再删除的那条路上,行早就不是 running 了(`doomed` 根本不含它),而它
  // 的进程可能还在跑,旧版本停下来时又没留责任。照状态过滤等于整条跳过(第 5 轮审查 F1 实测)。
  //
  // **放过的那几条要原样放过**:它们是审查还在用的哨兵,正在跑着才是对的,拿回收那把尺子
  // 去量它等于当场杀掉(`kept` 只在 `task-settled` 时非空,销毁那条路没有豁免)。
  await accountForLiveProcesses(all.filter((m) => !kept.includes(m.id)), reason,
    { fatal: intent === "destroy" });
  // 收尾只清得掉**还在缓冲里**的行。已经开始推的那一批不受影响：它手里拿着自己的
  // `lines`、也早就过了状态闸，落库会发生在清理之后——于是作废那一步扫不到它，它排进
  // 队列、把一个已经 done 的任务重新叫起来（第 3 轮审查实测：done → running → done）。
  // 所以先往每条哨兵自己的队列尾上排一个空活并等它轮到：轮到了就说明那一批已经写完。
  for (const m of all) await serialize(m.id, async () => {});
  // 停掉进程还不够：这一刻**已经排在待发队列里**的哨兵事件同样会把任务重新拉起来。
  // 留下来的那几条例外:它们的事件正是审查在等的东西,跟着任务终态作废就等于白留。
  await cancelPendingMonitorEvents(taskId, { keep: kept });
  return stopped;
}

type MonitorRow = {
  id: string; taskId: string; status: string;
  pid: number | null; pidStartedAt: string | null; command: string; unitToken: string | null;
  /** 身份边条的落点。pid 还空着时它是唯一的线索(第 19 轮审查 F2)。 */
  logPath: string;
};

/** 停一条。返回「这一刀发出去了吗」;回收责任那一圈在 `finish` 里面(见文件头第 ④ 条)。 */
async function signalStop(
  m: MonitorRow, reason: string, intent: MonitorStopIntent | "review-finished",
): Promise<boolean> {
  try {
    // `abandon`:这一路本来就是「这几行一个都不推」(`keepBuffered:false`),而且紧接着
    // `cancelPendingMonitorEvents` 会把排着的整批作废 —— 对得上「明确放弃」那一档,所以它
    // 不参与收尾所有权的合并等待(见 monitors.ts 的 `finishing`)。
    await finish(m.id, "stopped", reason, null, { notify: false, keepBuffered: false, abandon: true });
    return true;
  } catch (err) {
    // 停止动作本身失败(库忙、行被改走):`finish` 可能连记账那一步都没走到。这里不自己
    // 补刀,交给紧接着的 `accountForLiveProcesses` —— 它按真实状态重判一遍,顺带把责任记上。
    console.error(`[ash] stop monitor ${m.id} (${intent}) failed:`, err);
    return false;
  }
}

/**
 * **按资源责任核对一遍**:这些行里凡是进程组还活着的,要么账本上已经有人认它,要么现在
 * 就记上一笔并再发一刀。
 *
 * 判据是**进程还在不在 + 账本上有没有人认**,不是卡片状态 —— 「已停止」只说明有人发过
 * 信号,不说明它退了(第 5 轮审查 F1:先点停再删除,行是 stopped、命令仍活、债表为空,
 * 删除照状态过滤就整条跳过了它)。
 *
 * `fatal`(= 销毁持久身份那条路)时,**只要有一条没拿到持久交接就把整笔操作抛回去**:删除失败
 * 可重试,留下一个谁都找不到的后台进程不可逆 —— 跟枚举失败那一条同一个判据。两种都算:
 * 该留的责任落不下来,以及**线索追空那几条的最后一份身份留不下来**(第 14 轮审查 F2 实测:
 * 留档失败只记日志、追空分支照样返回 `closed`,于是任务和哨兵行一起被删掉,后代仍在跑)。
 * 审查收尾那一侧不销毁身份(行还在、启动期还会再问一遍),所以只出声不抛。
 */
async function accountForLiveProcesses(
  rows: MonitorRow[], reason: string, opts: { fatal: boolean },
): Promise<void> {
  // 「还收不干净」就得核对 —— 判据是 `reclaimState` 的那四档不确定,**不是**「卡片是不是
  // running」。`unknown`(ps 这一问自己失败了)也在里面:它恰恰是最该留责任的一档,原来却被
  // 当成「没什么可收」放行了(第 6 轮审查 F1 实测的那条路)。
  const withPid = rows.filter((r): r is MonitorRow & { pid: number } => r.pid !== null);
  const judged = withPid.map((r) => ({ row: r, traceless: reclaimState(r.pid, r.pidStartedAt, r) === "traceless" }));
  // **pid 还空着的创建意图行是最该核的一档**(第 19 轮审查 F2):身份先落库、进程后起、pid
  // 回填(见 monitor-create.ts),ash 死在中间时库里剩下的就是这个样子 —— 它的结局恰恰从没被
  // 确认过。上一版这里一句 `r.pid !== null` 把它们整批滤掉,于是删除拿到「没什么要负责的」、
  // 把任务和哨兵行一起带走,而那条命令可能还在跑(审查实测:taskRows=0、monitorRows=0、
  // 债表空、诊断进程仍活)。判档和落点都交给 `reclaimMonitorProcess`:它先问一遍认领,真的
  // 没有落点(claude 投影行 / 连边条都没留下)才返回 `closed`。
  const intents = rows.filter((r) => r.pid === null);
  const risky = [...judged.filter((j) => !j.traceless).map((j) => j.row), ...intents];
  // **追不到线索的那几条也要留下一行档**(第 13 轮审查 F1-B):它们起过进程,而「线索追空」
  // 不等于「整项退出已证明」—— 后代能同时甩掉记号和进程组。这一侧原来把它们整条跳过,于是
  // 删除把哨兵行连任务一起带走之后,那条可能还在跑的命令再也没有任何可定位身份
  // (审查实测 `R1_RESOURCE_FALSE_GONE`:taskRows=0、monitorRows=0、debtRows=0、命令仍活)。
  // 留档是幂等的,也不发任何信号。
  //
  // **留档的结果必须核**(第 14 轮审查 F2):写不进去就等于没有持久交接,而这一侧正是身份
  // 真要消失的那一刻 —— 下面按 `fatal` 把它和「责任落不下来」一起抛回去。
  const lostIdentity: MonitorRow[] = [];
  await Promise.all(judged.filter((j) => j.traceless).map(async (j) => {
    if (await archiveTracelessIdentity(j.row) === "failed") lostIdentity.push(j.row);
  }));
  const unaccounted: MonitorRow[] = [];
  if (!risky.length) return finishAccounting(unaccounted, lostIdentity, opts);
  const held = await heldReclaimDebts(risky.map((r) => r.id));
  // 并行:它们互不相干,而这段等待发生在 `task:<id>` 锁里面,顺序等会把删除吊很久。
  await Promise.all(risky.map(async (r) => {
    if (held.has(r.id)) return; // 已经有人负责了 —— 那正是不变量允许的另一半
    // 下刀资格只看档位(判据见 reclaimMonitorProcess 那张表),不看这一行是不是 running ——
    // 第 14 轮把那个 `fresh` 开关去掉了:它唯一还想收口的「存量行孤儿组」在取证层根本到不了
    // 可下刀的那一档。无论哪一档,这里都**一定会记责任**。
    const outcome = await reclaimMonitorProcess(r, reason);
    // 确认退出要**等到补刀生效**(默认 3 秒,见 confirmReclaimed):并行等,所以这一整批只花
    // 一个窗口。不等的话「收掉了几条」就只是「发出去几刀」,跟第 4 轮那版一个毛病。
    if (await settleReclaim(outcome) === "unaccounted") unaccounted.push(r);
  }));
  return finishAccounting(unaccounted, lostIdentity, opts);
}

/**
 * 核对的收口:**账本上没拿到持久交接的那几条,决定整笔操作的生死**。
 *
 * 两种各说一句(第 14 轮审查 F2:不要把「有行/无行」混成一句话):
 *  · `unaccounted` —— 该留的回收责任落不下来(进程还在/证不出,而账上没人认);
 *  · `lostIdentity` —— 线索追空、但最后一份身份留不下来(行要被删,之后谁都找不到它)。
 */
function finishAccounting(
  unaccounted: MonitorRow[], lostIdentity: MonitorRow[], opts: { fatal: boolean },
): void {
  // pid 还空着的行也会落到这里(创建意图这一刻认不回来,第 20 轮审查 F1),所以逐条带各自的
  // 说法 —— 外面统一套一个「pid …」会写出「pid （pid 还空着）」。
  const pids = (rows: MonitorRow[]) =>
    rows.map((r) => (r.pid === null ? "pid 还空着" : `pid ${r.pid}`)).join("、");
  if (!opts.fatal) {
    // 审查收尾那一侧:身份不销毁(哨兵行还在),所以只出声 —— 开机清扫会再问一遍。
    if (lostIdentity.length) {
      console.error(
        `[ash] 有 ${lostIdentity.length} 条哨兵的最后身份没能留档（${pids(lostIdentity)}）`
        + `，哨兵行还在，开机会再问一遍`,
      );
    }
    return;
  }
  if (!unaccounted.length && !lostIdentity.length) return;
  const parts: string[] = [];
  if (unaccounted.length) {
    parts.push(`${unaccounted.length} 个既没确认退出、回收责任也没能落库（${pids(unaccounted)}）`);
  }
  if (lostIdentity.length) {
    parts.push(`${lostIdentity.length} 个线索已追空、但最后一份身份没能留档（${pids(lostIdentity)}）`);
  }
  throw new Error(`有哨兵进程：${parts.join("；")}，不能销毁它们的身份记录。请重试。`);
}

/**
 * 一次审查收尾了，把**属于它**的哨兵收回来。
 *
 * 跟任务终态那条连坐是一对：那边放过了「还在进行的审查」名下的哨兵（见上），所以这边必须
 * 在那次审查真正结束时补上这一刀 —— 否则审查链都收尾了，它挂的哨兵还在后台盯着，推的每
 * 一条又都被出口闸拒回，纯属空烧（最多烧到自己到期）。
 *
 * 审查落终态的写点有好几处（`free-workflow.ts` 的三种结局、`free-review-round.ts` 的启动
 * 失败），所以这个函数按 **runId** 收而不是按任务收：调用方只需要知道「哪一次审查结束了」。
 */
export async function stopMonitorsForReviewRun(runId: string, reason: string): Promise<number> {
  // **锁谁**：这次审查跑在哪个任务上，哨兵就挂在哪个任务上，所以锁的是那条 `task:<id>`
  // 队列 —— 跟创建、跟终态连坐同一条，一把就够。「归属行一定都在这个任务上」不是巧合：
  // `source_review_run` 只由 `monitorSourceGate` 写，而它取的是**这个任务自己**正在进行
  // 的那次审查（`reviewingRun(task.id)`）。
  //
  // run 行已经不在（任务整批删了）时没有要收的东西。
  const run = (await db
    .select({ taskId: freeReviewRuns.taskId })
    .from(freeReviewRuns)
    .where(eq(freeReviewRuns.id, runId))).at(0);
  if (!run) return 0;
  return serialize(`task:${run.taskId}`, async () => {
    // **枚举必须在锁里**。拿锁之前查的话：创建方刚在锁里确认「来源审查有效」、进程已经
    // 起来、还没插库，这边查到空集合就返回了 —— 审查收了尾，却留下一个后台命令，它推的
    // 每一条又都被出口闸拒回，一直烧到自己到期（第 2 轮审查 F2 的同类并发缺口）。进了
    // 锁之后两种顺序都收口：收尾先 → 创建在同一把锁里重读 run 状态、直接拒；创建先 →
    // 这里看得见那一行、照常停它。
    const rows = await db
      .select({
        id: monitors.id, taskId: monitors.taskId, status: monitors.status,
        pid: monitors.pid, pidStartedAt: monitors.pidStartedAt, command: monitors.command,
        // 资源记号:归属与整项退出都只认它(见 monitor-reclaim-evidence 的 `MonitorUnit`)。
        unitToken: monitors.unitToken,
        // 身份边条就在它旁边:pid 还空着的创建意图行靠它认领(见 `reclaimMonitorProcess`)。
        logPath: monitors.logPath,
      })
      .from(monitors)
      .where(and(eq(monitors.sourceReviewRun, runId), isAshKind));
    // 跟任务侧同一条路:`finish` 走记账那一圈,这边再按资源责任核对一遍(见文件头第 ④ 条)。
    // 这一侧不销毁身份(审查结束而已,行还在),所以责任落不下来时只出声,不往上抛。
    let stopped = 0;
    for (const row of rows.filter((r) => r.status === "running")) {
      if (await signalStop(row, reason, "review-finished")) stopped += 1;
    }
    await accountForLiveProcesses(rows, reason, { fatal: false });
    // 待发通知要按**全部归属行**收，不按「命令还活着」裁剪：命令早退出、结果还排在托盘里
    // 等投递，正是审查者挂的哨兵最常见的形态。漏掉它们的话，审查都给了结论，旧结果还会
    // 把一条已经结束的审查重新叫起来跑一轮（第 2 轮审查 F5）。
    if (rows.length) {
      await cancelPendingMonitorEvents(run.taskId, { only: rows.map((r) => r.id) });
    }
    return stopped;
  });
}

/**
 * 启动期:**「已停止」不等于「已退出」** —— 把非运行态的归属行也问一遍。
 *
 * `reattachMonitors` 只枚举还在 running 的行,`sweepMonitorReclaimDebts` 只认账本上已有的
 * 那几笔。中间漏的正是第 5 轮审查实测的那条路:上一辈子有人把它停了(或者启动接回时判它
 * 没出口而停了),信号发出去了、命令却没死,而旧版本停下来时又没留责任 —— 重启之后两边都
 * 扫不到它。
 *
 * **只对身份对得上的那一档下刀**(`ours-alive`,见 `reclaimMonitorProcess` 的 `fresh`):隔了
 * 一次重启,「组长已死、组里还有人」跟「别人拿这个号当过组长」分不开,那一档只记责任;
 * 「认不出来」也一样 —— **记责任、不下刀**。
 *
 * 排在 `sweepMonitorReclaimDebts` **之前**:这里新记下的责任由它在同一次开机里接着推。
 */
export async function reclaimUnconfirmedStops(): Promise<number> {
  const rows = await db
    .select({
      id: monitors.id, taskId: monitors.taskId, status: monitors.status,
      pid: monitors.pid, pidStartedAt: monitors.pidStartedAt, command: monitors.command,
      // 资源记号:归属与整项退出都只认它(见 monitor-reclaim-evidence 的 `MonitorUnit`)。
      unitToken: monitors.unitToken,
      // 身份边条就在它旁边:pid 还空着的创建意图行靠它认领(见 `reclaimMonitorProcess`)。
      logPath: monitors.logPath,
    })
    .from(monitors)
    .where(and(isAshKind, ne(monitors.status, "running")));
  // 先用最便宜的那一问(`kill(-pgid, 0)`)把绝大多数历史行筛掉,ps 只对组还活着的那几条问。
  //
  // **pid 还空着的那几行按边条筛**(第 19 轮审查 F2):它们是创建意图行,结局从没被确认过
  // (`settleIntentRow` 写 `lost` 时并不撤边条)。判据在 `intentStillOpen` —— 跟回收层那一侧
  // 同源,**读不出来也算没确认**(第 20 轮审查 F1:上一版这里一个 `!== null` 把 EIO 读成
  // 「没有边条」,于是这一类行连开机这一问都捞不到)。
  const live = rows.filter((r) => (r.pid === null
    ? intentStillOpen(r.logPath)
    : reclaimState(r.pid, r.pidStartedAt, r) !== "traceless"));
  if (!live.length) return 0;
  console.error(`[ash] 开机发现 ${live.length} 条「停了但退出从没被确认」的哨兵（进程组还活着，`
    + `或者 pid 还空着、创建意图没有结论），按责任重收一遍`);
  await accountForLiveProcesses(live, "上一辈子把它停了，但退出从没被确认", { fatal: false });
  return live.length;
}
