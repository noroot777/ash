import { loadSteerJournal, saveSteerJournal, type SteerEntry } from "./claude-recovery.js";

type PendingControl = {
  resolve(): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
};

const responseError = (response: any): string => {
  if (typeof response?.error === "string") return response.error;
  if (typeof response?.message === "string") return response.message;
  return `Claude control_response: ${String(response?.subtype ?? "unknown")}`;
};

/** Claude stream-json 的 interrupt 请求与真实 control_response 配对。 */
export class ClaudeControlBridge {
  /**
   * 这条常驻流是不是**单飞**那一路：本回合的 `result` 一到，`singleRunFromResident` 就关掉
   * stdin 收台、不再读流。进程里还在跑的工作流跟着没了，它们的终态只能赶在 `turnEnd` 之前发。
   * 团队调度台的进程跨回合活着，不在这时收尾。
   */
  constructor(
    readonly reapsAtTurnEnd = false,
    /** 打断记录落在哪(输出文件旁,见 claude-recovery.ts 的 steer journal)。不传 = 不会被接管,不必落。 */
    private readonly journalPath?: string,
  ) {}
  /** 第几个回合结尾(孤儿回执不算),由解析层推进。打断认领哪一个结尾按它记。 */
  turns = 0;
  /**
   * 此刻名下还没了结的后台工作(解析层的实时账本,见 ResidentHandle.backgroundPending)。
   * 解析层接上之前一律按「不知道」答。
   */
  backgroundPending: () => { agent: number; workflow: number; unknown?: true } = () => ({ agent: 0, workflow: 0, unknown: true });
  /**
   * ash 发出去的打断各认领哪一个回合结尾。**身份在写 stdin 之前就落盘**:打断出来的那条
   * `result` 跟自然结束的长得一样(都可能是 error_during_execution),回执(control_response)和它
   * 谁先谁后都有,重启接管时光看输出认不出来(自由审查 i8RAcPM3zvgD R1)。一条打断认领它发出
   * 那一刻**之后**的第一个还没被认领的结尾 —— 打断总会让 CLI 收一个结尾。
   */
  private entries: SteerEntry[] = [];
  private unclaimed: (SteerEntry & { inherited?: true })[] = [];

  /**
   * 此刻有没有回合在进行。回合结束(`result`)之后为 false,主智能体再开口、或我们送进一条
   * 消息就为 true。单飞等后台工作的空档里插话靠它判断:没有回合可打断,直接送进去。
   */
  turnActive = true;
  /** 第几个回合(见 ResidentHandle.epoch)。只经 `beginTurn` 推进。 */
  epoch = 0;
  /**
   * 一个回合开始了。`sent`:我们刚送进一条消息 —— 那一定是新的一段(排在当前回合之后也算),
   * 无条件 +1;CLI 自己开口只在从空闲变成在忙时 +1。
   */
  beginTurn(sent = false): void {
    if (sent || !this.turnActive) this.epoch += 1;
    this.turnActive = true;
  }
  /** 重启接管:把上一代记下的打断读回来(读不出就抛,调用方按状态未知处理)。 */
  restore(): void {
    if (!this.journalPath) return;
    this.entries = loadSteerJournal(this.journalPath);
    this.unclaimed = this.entries.map((entry) => ({ ...entry, inherited: true }));
    for (const entry of this.entries) {
      const n = Number(entry.id.replace(/^ash_int_/, ""));
      if (Number.isInteger(n) && n > this.sequence) this.sequence = n;
    }
  }

  /**
   * 要发打断了:先记下它认领哪个结尾(`message`:之后还要送一条插话)。落不了盘就抛 —— 调用方
   * 这时还没写 stdin,打断不发,什么都没变。
   */
  claimInterrupt(requestId: string, message: boolean): void {
    const last = this.unclaimed.at(-1)?.result ?? 0;
    const entry: SteerEntry = { id: requestId, result: Math.max(this.turns + 1, last + 1), ...(message ? { sent: false } : {}) };
    this.persist([...this.entries, entry]);
    this.entries.push(entry);
    this.unclaimed.push(entry);
  }

  /** 插话正文**马上**写进 stdin(调用方在同一个同步段里紧接着写)。落不了盘就抛,正文不写。 */
  markSent(requestId: string): void {
    const entries = this.entries.map((entry) => entry.id === requestId ? { ...entry, sent: true } : entry);
    this.persist(entries);
    this.entries = entries;
    for (const entry of this.unclaimed) if (entry.id === requestId) entry.sent = true;
  }

  /** 打断没写出去:撤掉它的认领。 */
  withdraw(requestId: string): void {
    const entries = this.entries.filter((entry) => entry.id !== requestId);
    try {
      this.persist(entries);
    } catch (error) {
      // 落盘的那条留着也只会在接管时把一个结尾认成打断;内存里照样撤。
      console.warn("[ash] 撤不掉没发出去的打断记录:", error);
    }
    this.entries = entries;
    this.unclaimed = this.unclaimed.filter((entry) => entry.id !== requestId);
  }

  /**
   * 第 `result` 个回合结尾是不是 ash 打断出来的。是就认领掉,`abandoned`:上一代发了插话的打断,
   * 正文却没来得及送进去(重启在两步之间)—— 回合确实是被打断的,但不会有插话开的下一回合了。
   */
  takeInterrupt(result: number): { abandoned: boolean } | null {
    const index = this.unclaimed.findIndex((entry) => entry.result === result);
    if (index < 0) return null;
    const [entry] = this.unclaimed.splice(index, 1);
    return { abandoned: !!entry.inherited && entry.sent === false };
  }

  private persist(entries: SteerEntry[]): void {
    if (this.journalPath) saveSteerJournal(this.journalPath, entries);
  }

  private sequence = 0;
  private readonly pending = new Map<string, PendingControl>();

  request(): { requestId: string; line: string } {
    const requestId = `ash_int_${++this.sequence}`;
    return {
      requestId,
      line: `${JSON.stringify({
        type: "control_request",
        request_id: requestId,
        request: { subtype: "interrupt" },
      })}\n`,
    };
  }

  waitFor(requestId: string): { promise: Promise<void>; cancel(): void } {
    let cancel = () => {};
    const promise = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new Error("Claude interrupt ACK 超时"));
      }, 2_000);
      this.pending.set(requestId, { resolve, reject, timer });
      cancel = () => {
        const waiter = this.pending.get(requestId);
        if (!waiter) return;
        this.pending.delete(requestId);
        clearTimeout(waiter.timer);
        waiter.resolve();
      };
    });
    void promise.catch(() => undefined);
    return { promise, cancel };
  }

  handleResponse(message: any): void {
    const response = message?.response ?? message;
    const requestId = response?.request_id ?? message?.request_id;
    if (typeof requestId !== "string") return;
    const waiter = this.pending.get(requestId);
    if (!waiter) return;
    this.pending.delete(requestId);
    clearTimeout(waiter.timer);
    if (response?.subtype === "success") waiter.resolve();
    else waiter.reject(new Error(responseError(response)));
  }

  failPending(error: Error): void {
    for (const waiter of this.pending.values()) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
    this.pending.clear();
  }
}
