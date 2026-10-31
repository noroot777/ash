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
//
// 接线那一半在 useCatchUp.ts（`useCatchUp` / `useCatchUpLink`）:**谁来触发追平**同样不许
// 由各调用点自己写。这一层只回答「该不该再读一次、这一份算不算数」。

/** 静默追平失败后隔多久再试。 */
export const CATCH_UP_RETRY_MS = 5000;

/**
 * 重试的**节奏**:一个数就是「每次都隔这么久、一直试到读到」;给函数则由它按「这是连续第
 * 几次没读到」决定隔多久,**返回 null = 到此为止,不再自动重试**。
 *
 * 为什么这一项要可配置,而别的不行:统一的是**不变量** —— 断线就作废代次、一发挂住就掐断、
 * 同代次至多一发在途、没读到必须有下一步。而「下一步是五秒后再试一次,还是退几次之后停下来
 * 让人按一下」是**这一屏自己的判断**:任务列表、通知、哨兵列表都是静默追平(用户不知道它在
 * 读,所以必须一直试到读到);而验收闸那条等待条是用户正盯着的,它选的是「退五次(1→10 秒)
 * 之后停下来、如实说状态待核对、给一颗刷新按钮」—— 那是实测确立过的行为,把它一并统一成
 * 无限重试就是拿「策略该统一」的名义改掉一个有理由的产品决定。
 *
 * 显式触发(`run()`)会把连续失败计数清零:人点了刷新,就该重新拿到完整的额度。
 */
export type CatchUpRetry = number | ((failures: number) => number | null);

/**
 * 一发读取等多久算「它不会回来了」。
 *
 * 为什么**必须**有这个数（第 5 轮审查 N1）:单飞那一段把「同代次至多一发在途」当成正确性
 * 来守，而槽位是靠 promise settle 释放的 —— 传输层本身没有 deadline，于是一发永远不 settle
 * 的请求就把这一代次整个锁死:后续触发只会记一笔欠账，既没有请求在途、也没有重试在排，
 * 界面从此停在旧快照上，连「它陈旧了」都看不出来。断线那一种由 `cancel` 兜住（换代次），
 * 但「连接还在、这一发却挂住了」没有任何人兜 —— 反向代理吞掉响应、服务端卡在一个慢查询、
 * 移动端切换网络而 TCP 还没断，都是这一种。
 *
 * 15 秒的来由:这几条都是小 JSON 读取（任务列表、哨兵列表、通知、验收闸状态），正常百毫秒
 * 级别;比它慢一个数量级就该按「这一发废了」重发，而不是继续等。原先 useAcceptGate 自己写
 * 的也正是 15 秒 —— 现在它不必再自己写。
 */
export const CATCH_UP_DEADLINE_MS = 15_000;

/** 到点没回来时的默认说法。**用户看得见**,所以每一屏可以给自己的措辞(deadlineMessage)。 */
export const CATCH_UP_DEADLINE_MESSAGE = "这一次读取超时，已按「没读到」重新安排";
/** 换代次（断线/切身份/卸载）时掐断在途那一发用的理由。这一种不往界面上说。 */
export const CATCH_UP_CANCEL_REASON = "这一次读取已作废（断线、换了任务或离开页面）";
/** 被一次显式重读（`runNow`）接替时的理由。同样不往界面上说 —— 接替它的那一趟会说话。 */
export const CATCH_UP_SUPERSEDE_REASON = "这一次读取已被一次更新的读取接替";

/**
 * 掐断在途那一发时放进 `signal.reason` 的东西。
 *
 * 带一个 `kind` 而不是让调用方去比对文案:文案是**每一屏自己的**(见 deadlineMessage),比对
 * 文本等于把一句产品文字当成协议 —— 改一个字就静默失效,而失效的后果是界面上冒出一句
 * 「The operation was aborted」。
 */
export class CatchUpAbort extends Error {
  readonly kind: "deadline" | "stale";

  constructor(kind: "deadline" | "stale", message: string) {
    super(message);
    this.name = "CatchUpAbort";
    this.kind = kind;
  }
}

/**
 * 这一发是**被追平层掐掉的**吗,如果是,是哪一种 —— 它决定界面上该不该出现一句话。
 *
 * 为什么必须分清:掐断是这一层自己的动作,而调用方的 catch 分支通常直接把 `reason.message`
 * 贴到界面上 —— 不分清的话,断线那一下、切任务那一下、读取超时那一下,面板上会多出一句
 * 「The operation was aborted」:用户什么都没做错,服务端也没说过这句话。
 *
 *  · `"stale"`(换了代次:断线、切任务、卸载)—— **一个字都不要说**。这一发已经不作数,
 *    页面接下来要么由新代次自己追平,要么整个换掉了。
 *  · `"deadline"`(这一发等到点了)—— **照实说**,而且 reason 本身就是人话(见
 *    CATCH_UP_DEADLINE_MESSAGE):它还会自己重试,但「这一份还没读到」不许瞒着用户 ——
 *    那正是这一层开头写的那条教训。
 *  · `null` —— 不是这一层掐的,是真的读失败,按调用方自己的措辞显示。
 *
 * 判据是 `CatchUpAbort` 上的标记(这一层亲手放进 `signal.reason` 的),`AbortError` 作兜底 ——
 * 有些实现会把 abort 变成一个与 signal 失联的 rejection;认不出哪一种时保守归 `"stale"`
 * (宁可少说一句,也不要把一句看不懂的英文贴到界面上)。
 */
export function catchUpAbortKind(signal: AbortSignal, reason?: unknown): "deadline" | "stale" | null {
  const marked = (value: unknown) => (value instanceof CatchUpAbort ? value.kind : null);
  const kind = marked(signal.reason) ?? marked(reason);
  if (kind) return kind;
  if (signal.aborted) return "stale";
  return reason instanceof Error && reason.name === "AbortError" ? "stale" : null;
}

export interface CatchUp {
  /**
   * 「现在该追平了」。同一时刻**只许有一发在途**:在途期间再触发不会并发开第二发,而是
   * 记下「还欠一趟」,等在途那一发落地之后自动补上(见 createCatchUp 里的单飞那一段)。
   *
   * 返回的 promise 在**为这次触发而读的那一趟落地之后**兑现(成功、没读到、超时、代次作废
   * 都算落地 —— 它从不 reject)。为什么要可等待:有几处调用方是「点下去 → 等状态刷新 →
   * 解锁按钮」那种用法(review/AcceptGateCard.tsx 的几个动作),它们原先各自 await 自己那个
   * reload。追平收到这一层之后,如果 run 只是 fire-and-forget,那几处的等待就被悄悄改掉了
   * ——按钮会在状态刷新之前解锁。排了重试的那一次不吊着调用方(重试是下一趟的事)。
   */
  run: () => Promise<void>;
  /**
   * 「**人正等着**,现在就读一趟」—— 在途那一发当场作废(同一代次内接替它),这一趟立刻发车,
   * 返回的 promise 就是它的落地。
   *
   * 为什么必须和 `run` 分成两个口子(第 5 轮审查 N1 的修法实测):`run` 的合流(在途就记一笔
   * 欠账、等它落地之后再补一趟)是为**背景触发**设计的 —— SSE 可以成串地来,每来一条就掐掉
   * 在途那一发重发,比到达间隔还慢的接口会被活活饿死,一趟都读不完。但同一套合流套到「人点
   * 了刷新」「动作做完要确认状态」这类调用上就错了:那一发可能已经挂住(等到 deadline 才算
   * 完),而调用方 `await` 的是「状态刷新了再解锁按钮」—— 于是一颗按钮凭什么要陪一发别人的
   * 背景读取等满 15 秒?实测:验收台在一发挂住的背景读取期间点「验收通过」,POST 要等到那一发
   * 到点、补发那一趟也到点才发得出去。
   *
   * 判据就一句:**这次触发背后有没有人在等**。有人等 ⇒ runNow(抢占,拿最新那一份,顺带把
   * 重试额度清零);没人等 ⇒ run(合流,保证有进展)。两条路都守同一条不变量:同代次至多一发
   * 在途。
   */
  runNow: () => Promise<void>;
  /**
   * 停(断线、卸载):排着的重试取消,这一代次欠着的那一趟作废,在途那一发**连传输一起掐断**
   * 并立刻腾出槽位。**停过之后再 run 是新的一代次**,它自己发车,不排在作废的那一发后面。
   */
  cancel: () => void;
}

export interface CatchUpTimers {
  /**
   * `kind` 只为了让调用方（和回归用例）分得清这是哪一种定时器:`retry` 是「隔一会儿再读
   * 一次」,`deadline` 是「这一发等到这里为止」。生产实现一律 setTimeout,不看这个参数。
   */
  set: (run: () => void, delayMs: number, kind: "retry" | "deadline") => ReturnType<typeof setTimeout>;
  clear: (handle: ReturnType<typeof setTimeout>) => void;
}

export interface CatchUpOptions {
  /** 没读到之后的节奏(默认每 5 秒试到读到)。见 CatchUpRetry。 */
  retry?: CatchUpRetry;
  /** 只有测试需要换掉它(手工跑的定时器队列)。 */
  timers?: CatchUpTimers;
  /** 一发读取等多久算「它不会回来了」(默认 CATCH_UP_DEADLINE_MS)。 */
  deadlineMs?: number;
  /**
   * 等到点时交给调用方的那句话。**用户看得见**,所以由这一屏自己说 —— 它才知道自己有没有
   * 一颗「刷新」按钮、要不要把秒数讲出来。追平层只负责把它原样放进 `signal.reason`。
   */
  deadlineMessage?: string;
}

const realTimers: CatchUpTimers = {
  // 必须包一层而不是直接写 `{ set: setTimeout }`:浏览器里把 setTimeout 从 window 上摘
  // 下来再裸调会 Illegal invocation,而它抛在 then 回调里 —— 没有重试、没有报错、
  // pageerror 也收不到(真浏览器实测)。
  set: (run, delayMs) => setTimeout(run, delayMs),
  clear: (handle) => clearTimeout(handle),
};

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
 *
 * `refetch` 收到一个 **AbortSignal**:超时与换代次都要真的把那一发掐掉,不然「放弃等它」
 * 只是不看了,连接还占着、状态还可能在很久以后被它写一笔。调用方把它原样交给 `fetch`
 * （`api.*` 这几条都收 signal）即可;读不了 signal 的调用方可以不理它,但那一发就只能靠
 * 自己回来 —— 代次仍然保证它落地时写不进状态。
 */
export function createCatchUp(
  refetch: (signal: AbortSignal) => Promise<boolean>,
  options: CatchUpOptions = {},
): CatchUp {
  const {
    retry = CATCH_UP_RETRY_MS,
    timers = realTimers,
    deadlineMs = CATCH_UP_DEADLINE_MS,
    deadlineMessage = CATCH_UP_DEADLINE_MESSAGE,
  } = options;
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
  // 串行的代价是「在途那一发不回来就一直占着槽位」—— 那个口子由 deadline 堵上
  // (CATCH_UP_DEADLINE_MS):到点就按「没读到」算、掐断传输、腾出槽位、照常排重试。
  //
  // ── 排队只在同一代次之内(第 1 轮审查 F3 实测)────────────────────────────────────
  // 槽位和欠账都**记着自己属于哪个代次**。两件事都靠它:
  //  · 旧代次那一发回来时不许清掉新代次欠下的那一趟 —— 清掉之后既没有请求在途、也没有
  //    重试在排,恢复责任凭空消失(实测:断线期间权威列表变了,重连后页面一直停在断线前
  //    那一份快照上,connected 已经回到 true,此后没有任何事件会来纠正它,只有手动刷新
  //    才对得上);
  //  · 新代次不排在作废的那一发后面 —— 换代次正是因为上下文已经变了(断线/卸载/切身份),
  //    那一发的快照生成于断线之前,**物理上不可能**包含断线窗口里的变化,拿它当追平等于
  //    没追。
  //
  // 换代次时在途那一发会被 abort,所以跨 cancel 之后通常只剩新代次自己那一发;掐不掉的
  // 情形(调用方不理 signal)仍可能两发并存,它们之间的落地顺序由消费方按「发起序号」裁决,
  // 而旧那一发的快照只会更旧 —— 这一层保证的是**同代次内至多一发在途**,也就是「最后落地
  // 的一定是这一代次最新那一份」。
  let inFlight: {
    generation: number;
    serial: number;
    controller: AbortController;
    deadline?: ReturnType<typeof setTimeout>;
    /** 等这一发落地的那些 run()。发车时从 `waiting` 整个接过来。 */
    waiters: Array<() => void>;
    /** 让它就地作废:之后它自己回来也不再算数(见 supersede)。发车时装上。 */
    abandon?: () => void;
  } | null = null;
  let serials = 0;
  /** 连续几次没读到(读到了、或者人又点了一次就清零)。只有函数形式的节奏会用到它。 */
  let failures = 0;
  /** 哪个代次还欠一趟(null = 没人欠)。 */
  let owed: number | null = null;
  /**
   * 还没被哪一发认领的等待者:`run()` 先把自己的 resolve 放进这里,**发车那一刻由那一发整个
   * 取走**(见 attempt)。于是「这次触发等的是哪一趟」有了确定答案:
   *  · 能立刻发车 ⇒ 等的就是这一发;
   *  · 在途期间触发(记了欠账)⇒ 留在这里,等**补发那一趟**把它取走。
   * 兑现的是「那一趟落地了」,不是「读到了」—— 没读到、超时、代次作废都算落地,从不 reject。
   */
  let waiting: Array<() => void> = [];
  const wake = (list: Array<() => void>) => {
    for (const resolve of list) resolve();
  };
  const attempt = (generationAtStart: number) => {
    if (generationAtStart !== generation) return;
    if (inFlight?.generation === generation) {
      owed = generation; // 不并发开第二发:责任连代次一起记下来,别丢
      return;
    }
    const serial = ++serials;
    const controller = new AbortController();
    // 攒着的等待者由这一发接走:它们等的就是它。
    const live: NonNullable<typeof inFlight> = { generation, serial, controller, waiters: waiting };
    waiting = [];
    inFlight = live;
    // 这一发出去之后才到的触发才算欠账:它自己已经把此刻之前欠的全补了。
    if (owed === generation) owed = null;
    // 超时与真实落地**只认先到的那一个**:到点之后那一发即便回来了也不再算数(它的 settle
    // 已经被这一句吃掉),否则同一发会既排一次重试、又补一次欠账。
    let done = false;
    // 被接替时用:标记这一发不再算数(它回来时的 settle 整个跳过 —— 既不排重试、也不补欠账,
    // 那两件事都已经由接替它的那一趟负责了),并把到点闹钟撤掉。
    live.abandon = () => {
      done = true;
      if (live.deadline !== undefined) timers.clear(live.deadline);
    };
    const settle = (ok: boolean) => {
      if (done) return;
      done = true;
      // 只清自己占的那个槽:旧代次的响应落地时,槽位可能已经被新代次那一发接走了。
      if (inFlight?.serial === serial) {
        if (live.deadline !== undefined) timers.clear(live.deadline);
        inFlight = null;
      }
      // 这一发落地了 —— 等它的那些 run() 到此为止,不管读到没读到(「没读到」也是落地,
      // 吊着它们等下一次重试等于把 5 秒延迟塞进一次点击的反馈里)。
      wake(live.waiters);
      live.waiters = [];
      if (generationAtStart !== generation) {
        // 作废的一代次:什么都不动。此刻的 owed 要么是 null,要么是别人的责任。
        return;
      }
      if (!ok) {
        // 重试本身就是一趟新的读取,欠的那趟由它一并补上。
        owed = null;
        const delay = typeof retry === "function" ? retry(++failures) : retry;
        // `null` = 这一屏的节奏说「到此为止」。**不是把恢复责任丢掉** —— 那几处都同时把
        // 「没读到」如实显示出来并给了一颗手动按钮(见 CatchUpRetry 的说明);按下去就是一次
        // 新的 run(),额度也跟着清零。
        if (delay !== null) timer = timers.set(() => attempt(generationAtStart), delay, "retry");
        return;
      }
      failures = 0;
      // 还欠一趟:它发车时会把 `waiting` 里攒着的那些接走(那正是欠账期间触发的那几次)。
      if (owed === generationAtStart) attempt(generationAtStart);
    };
    live.deadline = timers.set(() => {
      // 到点还没回来:**先掐断再判失败**。掐断是为了把连接和「它还会写状态」这件事一起
      // 收掉 —— 不然腾出来的槽位虽然能让新的一发发车,那一发却还在后台活着。
      controller.abort(new CatchUpAbort("deadline", deadlineMessage));
      settle(false);
    }, deadlineMs, "deadline");
    // **抛出来的也算「没读到」。** `refetch` 的约定是「返回成不成，别抛」，但那是约定:
    // 调用方的成功分支里只要有一处 `r.x.map(...)`，一个形状不对的响应体就会在这里变成
    // 一条没人接的 rejection —— 没有重试,而且在浏览器里它是一个 unhandled error,
    // 整页都跟着报错(实测:某个 fixture 的兜底路由回 `[]`,页面连弹 5 条)。恢复责任既然
    // 收在这一处,这一处就不能假设调用方不出错。
    void refetch(controller.signal).then((ok) => settle(!!ok), () => settle(false));
  };
  /**
   * 让在途那一发**就地作废、腾出槽位**(代次不动:接替它的是同一代次里更新的一趟)。
   *
   * 等它落地的那些人**转交**给接替它的那一趟 —— 他们要的是「状态刷新了」,而不是「那一发
   * 回来了」,新那一趟更新,拿它兑现才对(就地 resolve 等于骗他们说状态已经刷新了)。
   */
  const supersede = () => {
    const flying = inFlight;
    if (!flying) return;
    inFlight = null;
    flying.abandon?.();
    flying.controller.abort(new CatchUpAbort("stale", CATCH_UP_SUPERSEDE_REASON));
    waiting = [...flying.waiters, ...waiting];
    flying.waiters = [];
  };
  const cancel = () => {
    generation += 1;
    owed = null;
    failures = 0;
    if (timer !== undefined) {
      timers.clear(timer);
      timer = undefined;
    }
    if (inFlight) {
      const flying = inFlight;
      const { controller, deadline } = inFlight;
      if (deadline !== undefined) timers.clear(deadline);
      // 槽位立刻腾出来:新代次不必等一发**已经不作数**的读取回来。
      inFlight = null;
      controller.abort(new CatchUpAbort("stale", CATCH_UP_CANCEL_REASON));
      wake(flying.waiters);
    }
    // 作废了就别再吊着调用方:它等的那一趟不会有了(页面已经断线/换了任务/卸载)。
    const pending = waiting;
    waiting = [];
    wake(pending);
  };
  return {
    run: () => {
      // 排着的那次重试被这一次取代。**不动代次** —— 在途的那一发仍然是自己人,它落地时
      // 还要负责把这一次欠下的那一趟补上(动了代次就等于把这次触发丢掉)。
      if (timer !== undefined) {
        timers.clear(timer);
        timer = undefined;
      }
      // 人(或一次显式触发)又来了:重新给足额度 —— 上一轮退到顶停下来的那种,这一下要能
      // 重新开始(验收闸那颗「刷新状态」按的就是这个)。
      failures = 0;
      const landed = new Promise<void>((resolve) => { waiting.push(resolve); });
      attempt(generation);
      return landed;
    },
    runNow: () => {
      if (timer !== undefined) {
        timers.clear(timer);
        timer = undefined;
      }
      failures = 0;
      // 跟 run 只差这一句:在途那一发让位。理由见 CatchUp.runNow。
      supersede();
      const landed = new Promise<void>((resolve) => { waiting.push(resolve); });
      attempt(generation);
      return landed;
    },
    cancel,
  };
}
