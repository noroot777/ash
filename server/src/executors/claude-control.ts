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
  interruptPending = false;
  /**
   * 这条常驻流是不是**单飞**那一路：本回合的 `result` 一到，`singleRunFromResident` 就关掉
   * stdin 收台、不再读流。进程里还在跑的工作流跟着没了，它们的终态只能赶在 `turnEnd` 之前发。
   * 团队调度台的进程跨回合活着，不在这时收尾。
   */
  constructor(readonly reapsAtTurnEnd = false) {}
  /**
   * 此刻有没有回合在进行。回合结束(`result`)之后为 false,主智能体再开口、或我们送进一条
   * 消息就为 true。单飞等后台工作的空档里插话靠它判断:没有回合可打断,直接送进去。
   */
  turnActive = true;
  /** CLI 自己开了一回合(解析层见到 `turnActive` 从 false 变 true)。见 ResidentHandle.onTurnStart。 */
  onTurnStart: (() => void) | null = null;
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
