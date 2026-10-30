// 队列占位的兜底补偿。从 scheduler.ts 搬出来(那份已经 715 行,而这一段自己就是一条
// 完整的、有重试状态机的职责)。
//
// 它收的是:续跑没接管占位 —— turnHeld 的锁被 enterTurn 退回(验收互斥、接力拒收),
// 或占位写入半途而废(UPDATE 已提交、附带读取才失败)—— 任务停在 queued、回合又没人
// 持有,不收拾就是永久「排队中」。与 queue-seat 的 seat.release 同款:正常跑完的回合在
// 这里全是 no-op(状态早被结算覆盖/锁被真实回合接管)。回滚用 quiet(回原样不是落位);
// 重推延迟一拍 —— 互斥方(典型:验收)没有结束钩子来推队列,立刻重试只会原地打转。
//
// **身份整份传,不许拆成几个可选字段**(第 1 轮审查 F4)。这条职责会被延续好几趟:
// 锁占着时排到 whenTurnIdle、重排到顶改隔 30s 再来、自己撞上写锁退避 5s 重试。每一趟
// 都是同一份补偿责任的延续,所以延续入口(`laterSeatReclaim`)只收完整的 `SeatReclaim`,
// 调用方拿 `{ ...job }` 改字段,**漏带一项编译就不过**。此前 30s 那一趟只传了
// `{ repush }`,凭证 `reservation` 在那里掉了;而丢了凭证的下一趟会在「库里这具 queued
// 带着凭证就说明它有主」那一道上把**自己那份**凭证误读成别人的,直接 return —— 遗留从此
// 再没有负责人,正是这条路存在要防的那个结局。
import { eq } from "drizzle-orm";
import type { TaskStatus } from "@ash/shared";
import { db } from "./db/index.js";
import { tasks } from "./db/schema.js";
import { SEAT_ROLLBACK_ROLE, claimNonTurn, whenTurnIdle } from "./runs.js";
import { noteMissedAdvance } from "./queue-seat.js";
import { restoreQueuedTask, type TaskQueueReservation } from "./task-queue-reservation.js";
import { deferQueueAdvance } from "./queue-advance-retry.js";

/**
 * 回收之后要不要记账重推队列,三档按**是谁欠下这次启动**选:
 *   "always"   队列推进自己的占位写失败:交接确实发生过、语义就是 resume-or-run,
 *              即使写入没提交也要记账,数据库恢复后由 advanceQueue 原样补办;
 *   "stranded" finally 的常规兜底(缺省):只有真收拾了 queued 遗留才记账 —— 正常
 *              结算的回合自有终态钩子,不额外多推;
 *   "never"    手动/扫描入口(/run、/fire、/retry、消息投递)的占位写失败:只回滚
 *              遗留,**绝不记账重推** —— advanceQueue 的补办是 resumeOrRunTask,会把
 *              /fire 的「全新一轮」偷换成续跑旧会话、消费掉检查点指令(第 ll7XKsu_ps0n
 *              链第 2 轮实测);这些入口各有自己的重试面(用户重点、扫描重投、定时
 *              不消费班次),失败就让原入口按原语义重来。
 */
export type SeatRepush = "always" | "stranded" | "never";

/**
 * 一次补偿责任的**整份身份**。延续时整个带走,所以这里一个可选字段都没有 ——
 * `reservation` 写成 `| null` 而不是 `?`,就是要让「我这一趟没有凭证」必须被明写出来,
 * 不能靠忘记某个键来表达。
 */
export type SeatReclaim = {
  taskId: string;
  queueId: string;
  /** 占位之前那个状态:回滚就是写回它。由**欠下这次启动的那一方**传进来 */
  prevStatus: TaskStatus;
  repush: SeatRepush;
  /** 调用方自己那一份占位凭证;null = 纯兜底直调,「有没有主」只能问库 */
  reservation: TaskQueueReservation | null;
  /** 已经为了等锁重排过几趟 */
  deferrals: number;
  /** 重排到顶之后隔多久再来一趟(回归要把它压到毫秒级) */
  deferMs: number;
};

/**
 * 重排有上限,只挡病态来回(两个入口在同一个释放点上反复互相接手)。到顶**不是撒手**:
 * 这具遗留没有别的负责人了,隔 `deferMs` 再来一趟 —— 一把真正没人管的锁要等到用户手动
 * 放开,那一刻 whenTurnIdle 也会放行(第 2 轮审查 F2:留下无人负责的遗留就是永久
 * 「排队中」)。
 */
const MAX_DEFERRALS = 5;
const DEFAULT_DEFER_MS = 30_000;
/** 补偿自己撞上写锁时的退避 */
const RETRY_MS = 5_000;

/**
 * 外部入口。导出供回归直调(触发它的真实路径是「UPDATE 提交后附带 SELECT 超时」,无法
 * 从测试外侧精确注入到两条语句之间)。
 */
export async function reclaimStrandedSeat(
  taskId: string,
  queueId: string,
  prevStatus: TaskStatus,
  opts?: {
    repush?: SeatRepush;
    reservation?: TaskQueueReservation;
    deferrals?: number;
    deferMs?: number;
  },
): Promise<void> {
  return reclaimSeat({
    taskId,
    queueId,
    prevStatus,
    repush: opts?.repush ?? "stranded",
    reservation: opts?.reservation ?? null,
    deferrals: opts?.deferrals ?? 0,
    deferMs: opts?.deferMs ?? DEFAULT_DEFER_MS,
  });
}

/**
 * 延期一趟。`job` 是整份身份,**不接受「只传变化的那几个字段」** —— 那正是 F4 的形状。
 * 等了一段墙上时间再来算新的一趟,所以重排预算重新给满(`deferrals: 0`):它存在只为挡
 * 同一个释放点上的病态来回,不为给整条补偿记总账。
 */
function laterSeatReclaim(job: SeatReclaim, delayMs: number): void {
  const timer = setTimeout(() => void reclaimSeat({ ...job, deferrals: 0 }), delayMs);
  timer.unref?.();
}

/** 队列推进自己的占位写失败那一路:延迟一拍,语义固定 resume-or-run(见 SeatRepush) */
export function scheduleSeatReclaim(
  taskId: string,
  queueId: string,
  prevStatus: TaskStatus,
  delayMs: number,
  reservation: TaskQueueReservation | null,
): void {
  laterSeatReclaim({
    taskId, queueId, prevStatus, repush: "always", reservation,
    deferrals: 0, deferMs: DEFAULT_DEFER_MS,
  }, delayMs);
}

async function reclaimSeat(job: SeatReclaim): Promise<void> {
  const { taskId, queueId, prevStatus, repush } = job;
  // 本函数收的是「**没有任何活着的 seat 认领**的 queued 遗留」。「有没有主」这一问由
  // 持久凭证回答(见下面读到 row 之后那一段),不是内存里的代次表 —— 重启之后代次表是空的,
  // 而遗留还在库里。
  // **占住回合锁再提交**,和 queue-seat 的 rollback 同一条理由(见那个模块头):
  // setTaskStatus 内部先 SELECT 再 UPDATE,「写之前再查一次所有权」挡不住那段窗口 ——
  // 新持有者能在其中占锁、绑令牌、落 running,这次补偿随后照样把它写回终态,还连带触发
  // 结算与队列推进(第 2 轮审查 F1)。占着锁写就没有这段窗口。
  //
  // 占不到 = 有人正拿着这个占位真正起跑,排到它释放之后再看一眼:那时状态要么已被真实
  // 结算覆盖(本函数自然是 no-op),要么确实还孤零零停在 queued。
  const releaseLock = claimNonTurn(taskId, SEAT_ROLLBACK_ROLE);
  if (!releaseLock) {
    if (job.deferrals >= MAX_DEFERRALS) {
      console.warn(`[ash] 队列占位守卫重排已达上限(${taskId}),改为 ${job.deferMs}ms 后再试一趟`);
      laterSeatReclaim(job, job.deferMs);
      return;
    }
    whenTurnIdle(taskId, () => void reclaimSeat({ ...job, deferrals: job.deferrals + 1 }));
    return;
  }
  try {
    const row = (await db.select().from(tasks).where(eq(tasks.id, taskId))).at(0);
    // 没带 reservation 的直调(回归、以及纯兜底那一趟):库里这具 queued 带着一份凭证就说明
    // 它**有主** —— 回滚它等于撤掉别人的占位,任务被翻回终态、结算钩子放行下一个成员,反而
    // 造出双跑。那种该由它自己的 release() 负责,外人不插手。带着 reservation 进来的调用方
    // 拿的就是自己那一份凭证,不在此列。
    if (!job.reservation && row?.status === "queued" && row.queueSeatToken) return;
    const reservation: TaskQueueReservation | null = job.reservation ?? (row ? {
      taskId, prevStatus, token: row.queueSeatToken, epoch: row.directionEpoch,
    } : null);
    if (reservation?.advanceRequest && (row?.queueAdvanceRequest?.id !== reservation.advanceRequest.id
      || row.resumePromptGeneration !== reservation.advanceRequest.resumePromptGeneration)) return;
    const stranded = !!reservation && await restoreQueuedTask(reservation);
    if (!stranded) {
      console.warn(`[ash] 队列占位守卫未提交(${taskId}):库里不再是我这一份凭证的 queued`);
    }
    if (repush === "never" || (repush === "stranded" && !stranded)) return;
    if (row && !stranded && (row.status !== prevStatus || row.directionEpoch !== reservation?.epoch)) return;
    if (reservation?.advanceRequest) {
      deferQueueAdvance(queueId);
      return;
    }
    const timer = setTimeout(() => noteMissedAdvance(taskId, queueId), 1_000);
    timer.unref?.();
  } catch (err) {
    // 补偿自己也可能撞上还没放开的写锁:不放弃,退避后重试 —— 这正是「数据库恢复后
    // 再补办交接」的那一等(第 7 轮审查:一次短暂锁故障不许变成永久停滞)。
    console.error(`[ash] 队列占位补偿失败(${taskId}),${RETRY_MS}ms 后重试:`, err);
    laterSeatReclaim(job, RETRY_MS);
  } finally {
    releaseLock();
  }
}
