// 内置 Monitor 实时投影的**写库责任**：一笔事实交进来，只有写成了或者被明确撤销才销账。
//
// ── 为什么不能「试几次就放手」 ───────────────────────────────────────────────
//
// 交进来的每一笔都是**已经从事件流里消费掉的事实**：`tool_use`/`task_started` 处理过就从
// 内存账本里删了，来源侧不会再发一遍，库里也没有别的地方能把它补回来（翻会话记录的历史
// 扫描已经删了）。所以「重试预算」只能决定**多久再试一次**，不能决定**要不要这一笔**：
// 上一版试满约 5 秒就 return，库恢复后后面的新事件照常落库，前面那几笔却永远回不来，回合
// 收尾那句「本轮起了几个」也跟着少数（第 2 轮审查实测：5 个只落了 1 个，说明也写 1 个）。
//
// 现在的规矩：
//
// - **失败的那一笔留在队头**，按阶梯退避、到顶后按最长那一档一直试下去；后面的排在它后头，
//   先后顺序不变（`close` 必须落在 `open` 之后，收尾必须数到前面每一笔）。库一恢复，队头
//   最多再等一档就写成，后面的紧跟着全部落地。
// - **销账只有三种理由**，每一种都是确定的结论，不是「等烦了」：写成了；任务**确认**删掉了
//   （`deleted`）；库已经关了（进程在退出，这份内存账本本来就要跟着没）。**删除中**（`deleting`）
//   不是理由：删除可能整批回滚、任务还在，那时已经放手的事实就永远回不来了（新一轮第 1 轮审查
//   实测：删除失败回滚后，排着的卡片和收尾说明全没了）。删除中只是先等着，结果出来再说 ——
//   队头那道闸和每一笔 job 自己落库前那道闸都按这个分（`admitWrite`）。
// - **注定写不成的单独认出来**（约束冲突、类型不符、语句本身错了这类）：等多久都是同一个
//   结果，留着只会把后面每一笔一起堵死。这类直接丢掉并留诊断。判据只看错误本身，认不出
//   来的一律当作「库暂时不可用」继续等 —— 宁可多等，不可错丢。
// - **积压有上界**（`maxBacklog`）：库长时间不可用时，超出上界的新事实不再进队。一个回合里
//   内置 Monitor 的事件是几十条的量级，这个上界只在真出事时才够得着；收尾那一笔不受它限制，
//   否则一次积压就让面板上留下永远「正在盯着」的卡。
// - **丢掉的不能只记在日志里**：溢出和注定写不成这两种，凡是交进来时说明了自己是哪一类事实
//   （`fact`）的，丢掉那一刻报给 `dropped`。调用方据此在回合收尾那条说明里如实说出「有几个
//   没能记成卡片」—— 用户看到的数字不能比真实的少，又不告诉他少了。
//
// 进程崩溃时还压在内存里的那几笔会跟着没：这份投影没有自己的持久待写表，开机清扫
// （`loseDeadClaudeMonitors`）只负责把已经落库、却没人收尾的行收成「进程已不在」。
import { taskRevocation } from "./claude-monitor-revoked.js";
import { dbClient } from "./db/index.js";

export type WriteJob = () => Promise<void>;
/** 这一笔是哪一类事实：`start` = 一个监听起来了；`update` = 一张已有卡片的状态变化。 */
export type WriteFact = "start" | "update";

/**
 * job 里落库前问到「任务正在删」时抛它：这一笔**先等着**，删除有了结果再说（见文件头）。
 * 队列认得它，不算失败、不报诊断。
 */
export class TaskDeletingError extends Error {
  constructor(readonly taskId: string) {
    super(`任务 ${taskId} 正在删除，这一笔等删除有结果再写`);
  }
}

/**
 * 一笔一次性事实落库前的那道闸：`true` = 写；`false` = 任务确认删掉了，这一笔可以放弃；
 * 任务**正在删**就抛 `TaskDeletingError`，让队列把它留着等。
 */
export function admitWrite(taskId: string): boolean {
  const state = taskRevocation(taskId);
  if (state === "deleting") throw new TaskDeletingError(taskId);
  return state !== "deleted";
}

export type WriteQueueOptions = {
  /** 这条流所属任务的删除闸在哪一档（见 `taskRevocation`）；还不知道归哪个任务就给 `null`。 */
  revocation: () => "deleting" | "deleted" | null;
  /** 旁路诊断（调用方负责限频和带上会话身份）。 */
  warn: (what: string, detail: unknown) => void;
  /** 一笔带 `fact` 的事实被丢掉了（溢出 / 注定写不成）。撤销和库已关闭不算丢。 */
  dropped?: (fact: WriteFact) => void;
};

/** SQLite 主错误码里「等多久都是同一个结果」的那几类。 */
const PERMANENT_SQLITE = new Set([
  1,  // SQLITE_ERROR：语句本身错了（列/表不存在、语法）
  18, // SQLITE_TOOBIG
  19, // SQLITE_CONSTRAINT
  20, // SQLITE_MISMATCH
  25, // SQLITE_RANGE
]);

/** 这次失败能不能靠等来解决。认不出来的一律算「能」（见文件头）。 */
export function permanentWriteFailure(e: unknown): boolean {
  // 代码自己的错（读了 undefined 的属性之类）重跑一万次也一样。
  if (e instanceof TypeError || e instanceof ReferenceError || e instanceof RangeError || e instanceof SyntaxError) {
    return true;
  }
  const errcode = (e as { errcode?: unknown } | null)?.errcode;
  return typeof errcode === "number" && PERMANENT_SQLITE.has(errcode & 0xff);
}

export class MonitorWriteQueue {
  /** 退避阶梯（毫秒）。到顶之后按最后一档一直试。回归脚本可以改小。 */
  static retryMs = [50, 250, 1_000, 4_000];
  /** 队里最多压多少笔事实。 */
  static maxBacklog = 1_000;
  /** 任务正在删时多久再看一眼（删除是一批语句，通常几毫秒就有结果）。 */
  static deferMs = 50;

  private chain: Promise<void> = Promise.resolve();
  private backlog = 0;
  /** 上界溢出只报一次：库坏着的时候每条事件都报一遍没有信息量。 */
  private overflowWarned = false;

  constructor(private readonly opts: WriteQueueOptions) {}

  /** 还压着几笔（含正在跑的那一笔）。 */
  get pending(): number {
    return this.backlog;
  }

  /**
   * 交一笔进来。`always` 给收尾用：它不受积压上界限制（理由见文件头）。`fact` 说明这一笔是
   * 哪一类事实，丢掉时据此报给 `dropped`；不带的（认不出归属的投机通知、收尾本身）丢了也不报。
   *
   * 每一笔都必须**可以安全重跑**：重试就是原样再调一次。
   */
  push(job: WriteJob, opts: { always?: boolean; fact?: WriteFact } = {}): void {
    if (!opts.always && this.backlog >= MonitorWriteQueue.maxBacklog) {
      if (!this.overflowWarned) {
        this.overflowWarned = true;
        this.opts.warn(`积压已满（${MonitorWriteQueue.maxBacklog} 笔还没写成），之后的新事件不再记账`, "库长时间不可用");
      }
      if (opts.fact) this.opts.dropped?.(opts.fact);
      return;
    }
    this.backlog += 1;
    const run = async (): Promise<void> => {
      try {
        await this.commit(job, opts.fact);
      } finally {
        this.backlog -= 1;
        if (this.backlog === 0) this.overflowWarned = false;
      }
    };
    this.chain = this.chain.then(run, run);
  }

  /** 队里此刻排着的全部写完（或被销账）的那一刻。永不 reject。 */
  settled(): Promise<void> {
    return this.chain;
  }

  /**
   * 最多等 `maxMs`：到点还没写完就先返回 `false`，**队列照旧接着写**。给流结束那一刻用——
   * 库坏着的时候不能把 agent 的收尾无限期拖住，但收尾那一笔也不能因此作废。
   */
  async drain(maxMs: number): Promise<boolean> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<false>((resolve) => {
      timer = setTimeout(() => resolve(false), maxMs);
      timer.unref?.();
    });
    try {
      return await Promise.race([this.chain.then(() => true as const), late]);
    } finally {
      clearTimeout(timer);
    }
  }

  private async commit(job: WriteJob, fact: WriteFact | undefined): Promise<void> {
    const ladder = MonitorWriteQueue.retryMs;
    const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
    for (let failures = 0; ;) {
      const gate = this.opts.revocation();
      if (gate === "deleted") return;
      if (gate === "deleting") {
        await pause(MonitorWriteQueue.deferMs);
        continue;
      }
      try {
        await job();
        if (failures > 0) this.opts.warn(`记账在第 ${failures + 1} 次尝试时写成了`, "此前积压的事件随后依次补上");
        return;
      } catch (e) {
        // job 里那道闸问到了「正在删」（队头那道还不知道是哪个任务时，或者收尾涉及别的任务时）。
        if (e instanceof TaskDeletingError) {
          await pause(MonitorWriteQueue.deferMs);
          continue;
        }
        if (dbClient.closed) return; // 进程在退出：内存账本本来就要跟着没
        if (permanentWriteFailure(e)) {
          this.opts.warn("记账失败且重试也不会成功，这一条没有记上", e);
          if (fact) this.opts.dropped?.(fact);
          return;
        }
        if (failures === 0) this.opts.warn("记账失败，留在队头退避重试，写成之前后面的事件排着等", e);
        await pause(ladder[Math.min(failures, ladder.length - 1)]!);
        failures += 1;
      }
    }
  }
}
