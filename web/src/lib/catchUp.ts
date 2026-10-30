// **静默追平的重试策略** —— 恢复责任收在这一处，调用方只管说「该追平了」。
//
// 从 useTasks.ts 拆出来:两类读取共用同一条纪律（而「每个调用点自己决定要不要重试」正是
// 下面那两条缺陷的共同形状）——
//  · 任务列表的哨兵事件刷新（useTasks.ts，C1）:事件只来一次，掉了就一直停在旧快照上;
//  · 验收卡的管理权限读取（review/AcceptGateCard.tsx，C3）:读失败被收成「确认无权限」，
//    那颗「改这条命令」从此不再出现，而页面上一个字都不会说为什么。
//
// 两者的教训是同一条:**「我没读到」不是一个事实**，它只是还没读到 —— 要么重试到读到，
// 要么把「没读到」如实显示出来，不许就地变成一个否定事实。

/** 静默追平失败后隔多久再试。 */
export const CATCH_UP_RETRY_MS = 5000;

export interface CatchUp {
  /** 「现在该追平了」。已有在排的重试被这一次取代，同时只有一条在跑。 */
  run: () => void;
  /** 停(断线、卸载):排着的重试取消,已发出的那一发回来也不再续排。 */
  cancel: () => void;
}

/**
 * 静默追平的重试策略 —— **恢复责任收在这一处**,调用方只管说「该追平了」。
 *
 * 触发追平的都是「只来一次」的通知:SSE 的 task.monitors(哨兵起了/推了一批/结束了)、
 * 一次重连。服务端不补发,所以这一发 GET 掉了就再没有第二次通知,而静默追平按定义不翻
 * loading、不换错误横幅 —— 界面会一直停在旧快照上(哨兵在跑的任务显示成没在跑),用户
 * 连「它陈旧了」都看不出来,只有手动刷新才对得上。所以失败的那一方必须自己安排下一次。
 *
 * 原先只有重连那一条路写了重试,SSE 事件那一条直接 `void refetch({silent:true})` 把
 * 失败丢掉(C1);策略分散在调用点上,下一个新增的触发点默认就是没有恢复责任的那一种。
 */
export function createCatchUp(
  refetch: () => Promise<boolean>,
  retryMs = CATCH_UP_RETRY_MS,
  timers: {
    set: (run: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
    clear: (handle: ReturnType<typeof setTimeout>) => void;
    // 必须包一层而不是直接写 `{ set: setTimeout }`:浏览器里把 setTimeout 从 window 上摘
    // 下来再裸调会 Illegal invocation,而它抛在 then 回调里 —— 没有重试、没有报错、
    // pageerror 也收不到(真浏览器实测)。
  } = { set: (run, delayMs) => setTimeout(run, delayMs), clear: (handle) => clearTimeout(handle) },
): CatchUp {
  let timer: ReturnType<typeof setTimeout> | undefined;
  // 代次:取消/重新触发之后,已经在途的那一发回来时不许再续排重试。
  let generation = 0;
  const attempt = (generationAtStart: number) => {
    void refetch().then((ok) => {
      if (!ok && generationAtStart === generation) timer = timers.set(() => attempt(generationAtStart), retryMs);
    });
  };
  const cancel = () => {
    generation += 1;
    if (timer !== undefined) {
      timers.clear(timer);
      timer = undefined;
    }
  };
  return {
    run: () => {
      cancel();
      attempt(generation);
    },
    cancel,
  };
}
