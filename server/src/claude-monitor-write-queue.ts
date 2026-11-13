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
// - **销账只有三种理由**，每一种都是确定的结论，不是「等烦了」：写成了；任务被删了（明确
//   撤销，`revoked` 说了算）；库已经关了（进程在退出，这份内存账本本来就要跟着没）。
// - **注定写不成的单独认出来**（约束冲突、类型不符、语句本身错了这类）：等多久都是同一个
//   结果，留着只会把后面每一笔一起堵死。这类直接丢掉并留诊断。判据只看错误本身，认不出
//   来的一律当作「库暂时不可用」继续等 —— 宁可多等，不可错丢。
// - **积压有上界**（`maxBacklog`）：库长时间不可用时，超出上界的新事实不再进队、留诊断。
//   一个回合里内置 Monitor 的事件是几十条的量级，这个上界只在真出事时才够得着；收尾那一笔
//   不受它限制，否则一次积压就让面板上留下永远「正在盯着」的卡。
//
// 进程崩溃时还压在内存里的那几笔会跟着没：这份投影没有自己的持久待写表，开机清扫
// （`loseDeadClaudeMonitors`）只负责把已经落库、却没人收尾的行收成「进程已不在」。
import { dbClient } from "./db/index.js";

export type WriteJob = () => Promise<void>;

export type WriteQueueOptions = {
  /** 这一笔还要不要：返回 true = 任务已被明确撤销（删掉了），立即销账、不留诊断。 */
  revoked: () => boolean;
  /** 旁路诊断（调用方负责限频和带上会话身份）。 */
  warn: (what: string, detail: unknown) => void;
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
   * 交一笔进来。`always` 给收尾用：它不受积压上界限制（理由见文件头）。
   *
   * 每一笔都必须**可以安全重跑**：重试就是原样再调一次。
   */
  push(job: WriteJob, opts: { always?: boolean } = {}): void {
    if (!opts.always && this.backlog >= MonitorWriteQueue.maxBacklog) {
      if (!this.overflowWarned) {
        this.overflowWarned = true;
        this.opts.warn(`积压已满（${MonitorWriteQueue.maxBacklog} 笔还没写成），之后的新事件不再记账`, "库长时间不可用");
      }
      return;
    }
    this.backlog += 1;
    const run = async (): Promise<void> => {
      try {
        await this.commit(job);
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

  private async commit(job: WriteJob): Promise<void> {
    const ladder = MonitorWriteQueue.retryMs;
    for (let attempt = 0; ; attempt += 1) {
      if (this.opts.revoked()) return;
      try {
        await job();
        if (attempt > 0) this.opts.warn(`记账在第 ${attempt + 1} 次尝试时写成了`, "此前积压的事件随后依次补上");
        return;
      } catch (e) {
        if (dbClient.closed) return; // 进程在退出：内存账本本来就要跟着没
        if (permanentWriteFailure(e)) {
          this.opts.warn("记账失败且重试也不会成功，这一条没有记上", e);
          return;
        }
        if (attempt === 0) this.opts.warn("记账失败，留在队头退避重试，写成之前后面的事件排着等", e);
        await new Promise<void>((resolve) => setTimeout(resolve, ladder[Math.min(attempt, ladder.length - 1)]));
      }
    }
  }
}
