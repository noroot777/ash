// **一件事现在说不上来,那就一直核验到它有结论为止** —— 两处共用的那段退避。
//
// 为什么抽出来:本仓有两处形状完全一样的「未知」,而它们栽的是同一个坑 —— 试几次、之后
// 打一行日志退场。第 2 轮自由审查两条意见各打中一处:
//   · 接管回合的身份读不出来(executors/codex-app-server-adopt.ts 的 `recoverAdoptedIdentity`):
//     五次两秒之后 `onGiveUp` 只打印一句,而「进展证明读不出来 ⇒ 静默档也不开」同时成立 ——
//     两个保守分支叠起来就是谁都不负责,审查把协议文件藏了 10.6 秒再放回来,那个闲置进程
//     就永远挂着了(F3);
//   · 这一轮有没有过进展读不出来(turn-progress-mark.ts 的 `recoverTurnProgress`):同样
//     不许在 `seen` 与 `none` 里任选一边,未知得有自己的恢复路(F2)。
//
// 所以口径一份:**不设上限、不自行退场**。前几拍按原节奏(一瞬的 I/O 故障几秒就自己好),
// 之后翻倍退避到封顶,一直盯着。计时器一律 `unref` —— 核验绝不该让进程多活一毫秒(同
// turn-input-acceptance.ts 的有界等待);进程真的没了也有人接着管:重启时这一轮会重新走一遍
// 接管判定,证明也会被重新读一次。
//
// 收口由调用方说:`onKnown` 返回真 = 这个结论我已经处置了,别再核验;`onUnknown` 返回假 =
// 不必再核验了(它自己已经收口,或者这一轮结束了)。

export interface VerifyPace {
  /** 前几拍的间隔(缺省 2 秒)。 */
  everyMs?: number;
  /** 退避封顶(缺省 30 秒)。 */
  maxMs?: number;
  /** 前几拍按 `everyMs`,之后才开始翻倍(缺省 5 拍)。 */
  steadyAfter?: number;
}

export function verifyUntilKnown<T>(opts: {
  /** 重读那件事。抛了算「还是说不上来」(由 `known` 对 `fallback` 判定)。 */
  read: () => T;
  /** 读抛了时拿它当这一拍的结果。 */
  fallback: T;
  /** 这个结果算结论了吗。 */
  known: (value: T) => boolean;
  /** 有结论了。返回真 = 已处置,停止核验。 */
  onKnown: (value: T) => boolean;
  /** 这一拍仍然说不上来。返回假 = 不必再核验。 */
  onUnknown: (attempt: number, nextMs: number) => boolean;
  pace?: VerifyPace;
}): void {
  const everyMs = opts.pace?.everyMs ?? 2_000;
  const maxMs = Math.max(everyMs, opts.pace?.maxMs ?? 30_000);
  const steadyAfter = opts.pace?.steadyAfter ?? 5;
  const delayFor = (attempt: number): number =>
    Math.min(everyMs * 2 ** Math.max(0, attempt - steadyAfter + 1), maxMs);
  let attempt = 0;
  const tick = (): void => {
    attempt += 1;
    let value: T;
    try {
      value = opts.read();
    } catch {
      value = opts.fallback;
    }
    if (opts.known(value) && opts.onKnown(value)) return;
    const nextMs = delayFor(attempt);
    if (!opts.onUnknown(attempt, nextMs)) return;
    const timer = setTimeout(tick, nextMs);
    timer.unref?.();
  };
  const first = setTimeout(tick, everyMs);
  first.unref?.();
}
