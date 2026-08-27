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
