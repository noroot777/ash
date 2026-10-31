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
  /**
   * 「现在该追平了」。同一时刻**只许有一发在途**:在途期间再触发不会并发开第二发,而是
   * 记下「还欠一趟」,等在途那一发落地之后自动补上(见 createCatchUp 里的单飞那一段)。
   */
  run: () => void;
  /**
   * 停(断线、卸载):排着的重试取消,这一代次欠着的那一趟作废,已发出的那一发回来也不再
   * 续排。**停过之后再 run 是新的一代次**,它自己发车,不排在作废的那一发后面(见下)。
   */
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
  // 代次:取消之后,已经在途的那一发回来时不许再续排重试、也不许再去补欠下的那一趟。
  let generation = 0;
  // ── 单飞 ───────────────────────────────────────────────────────────────────────
  // **同一代次同一时刻只许有一发在途**,在途期间来的触发只记一笔「还欠一趟」。
  //
  // 为什么这条纪律必须在这一层:追平的触发口有四个(挂载首读、SSE 事件、重连对账、调用方
  // 手动 reload),它们随时重叠。并发发车时**响应可以乱序回来**,而每个调用方都是在自己的
  // then 里就地 `setState` —— 迟到的那份旧快照会把新的盖掉,于是页面倒退回一个服务端早就
  // 不这么说的状态(第 2 轮审查实测:占位已解除、记录已更新,旧响应一落地,失效的救援按钮
  // 又回来、最新一条记录消失,此后没有新变化来纠正它)。
  //
  // 这里**不是**靠「请各调用点自己核代次」解决的:那正是上一版的形状 —— 任务列表那个 hook
  // 自己写了 fetchGen、验收卡自己 abort,新接进来的消费者默认就是没有防护的那一种,而
  // 「共用了同一份追平策略」看起来像是已经继承了这条保证。改成串行之后,乱序在物理上就不
  // 成立:一代次内至多一发在途 ⇒ 落地顺序必定等于发车顺序,无论调用方在 then 里做什么。
  //
  // 代价是在途那一发若长期不返回,这个槽位就一直占着(传输层本来就没有 deadline,那是另一
  // 条已告知的待办)—— 但它换来的是「最后落地的一定是最新那一份」,这是正确性,不是优化。
  // (「长期不返回」最常见的成因是断线,而断线会 cancel,下一段正是为此:换了代次就不再
  // 等它。)
  //
  // ── 排队只在同一代次之内(第 1 轮审查 F3 实测)────────────────────────────────────
  // 槽位和欠账都**记着自己属于哪个代次**。两件事都靠它:
  //  · 旧代次那一发回来时不许清掉新代次欠下的那一趟 —— 清掉之后既没有请求在途、也没有
  //    重试在排,恢复责任凭空消失(实测:断线期间权威列表变了,重连后页面一直停在断线前
  //    那一份快照上,connected 已经回到 true,此后没有任何事件会来纠正它,只有手动刷新
  //    才对得上);
  //  · 新代次不排在作废的那一发后面 —— 换代次正是因为上下文已经变了(断线/卸载/切身份),
  //    那一发的快照生成于断线之前,**物理上不可能**包含断线窗口里的变化,拿它当追平等于
  //    没追;何况它很可能永远不返回(断线那一下的请求挂在传输层上,没有 deadline)。
  //
  // 所以跨 cancel 的那一瞬可以有两发在途(旧的一发 + 新代次自己的一发)。它们之间的落地
  // 顺序由消费方按「发起序号」裁决(任务列表的 fetchGen;另两处 hook 在 cleanup 里就把
  // 结果整个丢掉了),而旧那一发的快照只会更旧 —— 这一层保证的是**同代次内至多一发在途**,
  // 也就是「最后落地的一定是这一代次最新那一份」。
  let inFlight: { generation: number; serial: number } | null = null;
  let serials = 0;
  /** 哪个代次还欠一趟(null = 没人欠)。 */
  let owed: number | null = null;
  const attempt = (generationAtStart: number) => {
    if (generationAtStart !== generation) return;
    if (inFlight?.generation === generation) {
      owed = generation; // 不并发开第二发:责任连代次一起记下来,别丢
      return;
    }
    const serial = ++serials;
    inFlight = { generation, serial };
    // 这一发出去之后才到的触发才算欠账:它自己已经把此刻之前欠的全补了。
    if (owed === generation) owed = null;
    const settle = (ok: boolean) => {
      // 只清自己占的那个槽:旧代次的响应落地时,槽位可能已经被新代次那一发接走了。
      if (inFlight?.serial === serial) inFlight = null;
      if (generationAtStart !== generation) {
        // 作废的一代次:什么都不动。此刻的 owed 要么是 null,要么是别人的责任。
        return;
      }
      if (!ok) {
        // 重试本身就是一趟新的读取,欠的那趟由它一并补上。
        owed = null;
        timer = timers.set(() => attempt(generationAtStart), retryMs);
        return;
      }
      if (owed === generationAtStart) attempt(generationAtStart);
    };
    // **抛出来的也算「没读到」。** `refetch` 的约定是「返回成不成，别抛」，但那是约定:
    // 调用方的成功分支里只要有一处 `r.x.map(...)`，一个形状不对的响应体就会在这里变成
    // 一条没人接的 rejection —— 没有重试,而且在浏览器里它是一个 unhandled error,
    // 整页都跟着报错(实测:某个 fixture 的兜底路由回 `[]`,页面连弹 5 条)。恢复责任既然
    // 收在这一处,这一处就不能假设调用方不出错。
    void refetch().then((ok) => settle(!!ok), () => settle(false));
  };
  const cancel = () => {
    generation += 1;
    owed = null;
    if (timer !== undefined) {
      timers.clear(timer);
      timer = undefined;
    }
  };
  return {
    run: () => {
      // 排着的那次重试被这一次取代。**不动代次** —— 在途的那一发仍然是自己人,它落地时
      // 还要负责把这一次欠下的那一趟补上(动了代次就等于把这次触发丢掉)。
      if (timer !== undefined) {
        timers.clear(timer);
        timer = undefined;
      }
      attempt(generation);
    },
    cancel,
  };
}
