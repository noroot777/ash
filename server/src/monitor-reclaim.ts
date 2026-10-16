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
// ④ **撤销是一段时间,不是一个瞬间。** 「扫完一遍」不等于这一生命周期已经被撤销:这一刀可能
//    落不下去,而调用方紧接着就销毁了 pid 这个唯一线索。所以停不掉的那一条必须留下**持久的
//    回收责任**(monitor-reclaim-debts.ts),连枚举都失败时则**整笔不许往下走**(第 3 轮审查
//    F1)。「不许再创建」是同一条不变量的另一半,在 monitor-session.ts 的资格闸里。
import { and, eq } from "drizzle-orm";
import { db } from "./db/index.js";
import { freeReviewRuns, monitors } from "./db/schema.js";
import { killByPid } from "./executors/spawn.js";
import { cancelPendingMonitorEvents } from "./monitor-events.js";
import { noteReclaimDebt } from "./monitor-reclaim-debts.js";
import { isReviewSourceActive } from "./monitor-session.js";
import { finish, isAshKind, serialize } from "./monitors.js";
import { isSameProcess } from "./proc.js";

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
      id: monitors.id, status: monitors.status, pid: monitors.pid, pidStartedAt: monitors.pidStartedAt,
      command: monitors.command,
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
  let stopped = 0;
  for (const m of doomed) {
    try {
      await finish(m.id, "stopped", reason, null, { notify: false, keepBuffered: false });
      stopped += 1;
    } catch (err) {
      // **这一刀必须尽力落下去**:destroy 的调用方紧接着就要删掉 pid,这是最后一次有线索
      // 能停掉这个进程。一行失败也不能把后面几行一起带走。
      console.error(`[ash] stop monitor ${m.id} (${intent}) failed:`, err);
      await reclaimDebtFor(m, taskId, reason, err);
    }
  }
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

/**
 * 停止没能确认 ⇒ **补杀一次,仍然活着就把回收责任留下来**。
 *
 * 为什么不是「记一行日志就算了」:destroy 的调用方紧接着就把 `monitors` 这一行删掉,pid 和
 * 启动时刻这对唯一线索随之消失 —— 之后没有任何入口能再找到那个进程(第 3 轮审查 F1 的
 * `aliveAfterDelete`)。责任落在另一张不随任务删除的表上,由退避梯子和启动期清扫推(见
 * monitor-reclaim-debts.ts)。
 *
 * pid 对不上同代就什么都不做:那个进程已经退了(或者那个号早被别人复用,杀它才是事故)。
 */
async function reclaimDebtFor(
  m: { id: string; pid: number | null; pidStartedAt: string | null; command: string },
  taskId: string, reason: string, error: unknown,
): Promise<void> {
  if (!m.pid || !isSameProcess(m.pid, m.pidStartedAt)) return; // 已经不在了/pid 被别人复用
  // **先记账,再补杀**。两个顺序只有这一个对:
  // - 反过来的话,记账之前这个进程(或整个 server)没了,那笔责任就谁也不知道了;
  // - 「补杀成了」也不能靠紧接着的一次 ps 断言 —— SIGTERM 到进程真的退出之间有几毫秒,那
  //   一问多半还看得见它,于是又变成「看运气记账」。
  // 责任一律先落盘,由退避梯子/启动期清扫按「进程确认不在了」销账(幂等,见那个文件)。
  await noteReclaimDebt({
    monitorId: m.id, taskId, pid: m.pid, pidStartedAt: m.pidStartedAt,
    command: m.command, reason, error,
  }).catch((err) => console.error(`[ash] 落回收责任失败 ${m.id}:`, err));
  killByPid(m.pid);
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
        id: monitors.id, status: monitors.status, pid: monitors.pid,
        pidStartedAt: monitors.pidStartedAt, command: monitors.command,
      })
      .from(monitors)
      .where(and(eq(monitors.sourceReviewRun, runId), isAshKind));
    let stopped = 0;
    for (const row of rows.filter((r) => r.status === "running")) {
      try {
        await finish(row.id, "stopped", reason, null, { notify: false, keepBuffered: false });
        stopped += 1;
      } catch (err) {
        console.error(`[ash] stop review monitor ${row.id} failed:`, err);
        await reclaimDebtFor(row, run.taskId, reason, err);
      }
    }
    // 待发通知要按**全部归属行**收，不按「命令还活着」裁剪：命令早退出、结果还排在托盘里
    // 等投递，正是审查者挂的哨兵最常见的形态。漏掉它们的话，审查都给了结论，旧结果还会
    // 把一条已经结束的审查重新叫起来跑一轮（第 2 轮审查 F5）。
    if (rows.length) {
      await cancelPendingMonitorEvents(run.taskId, { only: rows.map((r) => r.id) });
    }
    return stopped;
  });
}
