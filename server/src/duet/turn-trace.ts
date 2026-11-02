// 讨论回合的**执行过程**:条数上限,以及「关键生命周期事件不许被上限砍掉」。
//
// 为什么单独一个文件:上限原先是 `runTurn` 里的一行 `if (trace.length < TRACE_CAP)`,在五处各写
// 一遍。那种形状下「普通过程」和「关键诊断」是同一档待遇 —— 前面已经攒了 200 条工具/思考事件
// 时,新来的停滞警告和熔断诊断连这一轮最终落盘的 transcript 都进不去(第 1 轮审查 F4)。而那两
// 条恰恰是**最该留的**:它们是这一轮为什么失败的唯一解释,而工具调用少记一条只是细节少一行。
//
// 所以上限归这一处管,并且认一件事:**关键事件挤掉最早的一条普通过程,绝不被普通过程挤掉。**
// 上限本身是**硬的** —— 它防的是一场几千步的讨论把一行 transcript 撑成几兆,那个理由还在。
// 腾不出普通过程时(整份都是关键事件)挤掉最早的那条关键事件,而不是让数组超出上限:上限如果
// 能被「关键」这个标记突破,它的大小就由调用方有多自觉决定,而那正是这一轮审查反复拆掉的形状。
import type { TurnTraceEvent } from "@ash/shared";

/** 一条 transcript 行里最多留多少条过程事件。 */
export const TRACE_CAP = 200;

export interface TurnTrace {
  /** 落盘用的那份(就是这个数组本身,顺序即发生顺序)。 */
  events: TurnTraceEvent[];
  /**
   * 记一条。`critical` = 这一轮的生命周期事件(停滞警告、熔断诊断)—— 满了也要进去。
   * 普通过程满了就丢,跟从前一样。
   */
  push(event: TurnTraceEvent, critical?: boolean): void;
}

export function createTurnTrace(cap = TRACE_CAP): TurnTrace {
  const events: TurnTraceEvent[] = [];
  // 关键事件按**对象身份**记,不往 TurnTraceEvent 上加字段:那个类型要落盘、要过前端,多一个
  // 只有这一处看得懂的字段等于把实现细节写进持久格式里。
  const criticals = new WeakSet<TurnTraceEvent>();
  return {
    events,
    push(event, critical = false) {
      if (critical) criticals.add(event);
      if (events.length < cap) {
        events.push(event);
        return;
      }
      if (!critical) return;
      // 先吃普通过程;整份都是关键事件时退而挤掉**最早**的那一条 —— 上限不破,而留下的是最近
      // 那几条(熔断的解释排在警告后面,这一轮为什么失败由它们说清)。
      const victim = events.findIndex((e) => !criticals.has(e));
      events.splice(victim >= 0 ? victim : 0, 1);
      events.push(event);
    },
  };
}
