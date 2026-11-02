// 追平的**接线**:谁来触发、什么时候作废。策略那一半在 catchUp.ts。
//
// 为什么这两个 hook 必须存在(第 5 轮审查 N1):追平这件事有两半 —— 「该不该再读一次」收在
// `createCatchUp` 里了,而「连上就对一次账、断线就把这一代次作废」当时还是**每个调用点自己
// 写**的,于是五个消费者长出了五种写法,其中四种都漏了同一条:
//
//   · useTasks.ts         `if (!connected) return; run(); return () => cancel();`  ← 唯一对的
//   · useRejectionNotices  只在 connected 由 false 翻 true 那一下 reload(),断线不作废
//   · useTaskMonitors      同上,而且整个没走追平层(自己一套 gen/seq,读失败不重试)
//   · useAcceptGate        同上,而且自己一套 abort + 15 秒超时 + 指数退避
//   · QuestionHistory      connectedOnce + setTimeout 兜底,自己一套 generation
//
// 漏掉「断线作废」的后果不是少一次刷新:断线那一下发出的请求往往永远不 settle,而串行的
// 槽位是靠 settle 释放的 —— 于是重连后的 `reload()` 只记一笔欠账就没有下文,页面停在断线前
// 那份快照上,connected 已经回到 true,此后没有任何事件会来纠正它(审查按代码推断,与第 1
// 轮在任务列表上实测过的那一幕同形)。
//
// 所以这里把那条接线做成**唯一一份实现**。新增一个消费者时要么用 `useCatchUp`,要么拿着
// 自己的实例调 `useCatchUpLink` —— 两条路都不需要记得「断线要 cancel」。
import { useEffect, useMemo, useRef } from "react";
import { type CatchUp, type CatchUpOptions, createCatchUp } from "./catchUp.ts";

/**
 * 按 hook 寿命持有一个追平实例。
 *
 * - `refetch` 的身份随渲染变化没关系:实例经由 ref 取最新那一份,自己保持稳定(否则每次
 *   渲染都换一个实例 ⇒ 代次天天在变 ⇒ 单飞和欠账都失去意义)。
 * - `identity` 是**这份数据属于谁**(通常就是 taskId)。它一变就是新一代次:上一个身份在途
 *   那一发当场掐断、欠账作废 —— 旧任务的响应绝不许写进新任务的面板。
 * - 卸载时同样作废。
 * - `options` 是这一屏自己的节奏与措辞(重试曲线、超时时长、超时那句话;见 CatchUpOptions)。
 *   它按**首次**取用:要换就换 identity,别指望改一个对象字面量就生效。
 */
export function useCatchUp(
  refetch: (signal: AbortSignal) => Promise<boolean>,
  identity: string = "",
  options?: CatchUpOptions,
): CatchUp {
  const refetchRef = useRef(refetch);
  refetchRef.current = refetch;
  const optionsRef = useRef(options);
  const catchUp = useMemo(
    () => createCatchUp((signal) => refetchRef.current(signal), optionsRef.current),
    [identity],
  );
  useEffect(() => () => catchUp.cancel(), [catchUp]);
  return catchUp;
}

/**
 * 把「连上」接到追平上:**每次连上都重新对一遍账,断线就把这一代次作废**。
 *
 * 两件事都不能少，少哪件都在界面上留下一个永远不会自己纠正的陈旧页面:
 *
 * ① **连上就对账**(含首次)。事件流没有历史回放(服务端只订阅当前 bus、不带事件 id、没有
 *    Last-Event-ID),断线那几十秒里的变化一条都补不回来;「挂载时那一发 GET」和「事件流
 *    建立」也是并发的,中间那段的事件同样没人接。
 * ② **断线就作废**。断线那一下在途的请求挂在传输层上,可能永远不 settle,而串行槽位靠
 *    settle 释放 —— 不作废的话重连后的追平只会记一笔欠账,然后就没有下文了。它还顺带把
 *    那一发掐断:那份快照生成于断线之前,物理上不含断线窗口里的变化,拿它当追平等于没追。
 *
 * 写成 effect 的 cleanup 而不是「比对上一次的 connected」:`connected` 翻成 false 时 React
 * 会先跑 cleanup,这正是作废的时机 —— 而边沿比对那种写法只认 false→true 这一下,断线那一下
 * 什么都不做,上面 ② 就漏了。
 *
 * **发车推迟到下一个 tick**(原先各调用点里那句 `setTimeout(reload, 0)` 就是为此):开发期的
 * StrictMode 把每个 effect 跑成 mount → cleanup → mount,立刻发车的话第一发会真的出门、又
 * 立刻被 cleanup 掐断 —— 一次白跑的往返、日志里多一条、服务端多一次查询,而它什么都没换来
 * (真浏览器实测:同一条 question-history 读了两遍)。零延迟的定时器在同一个周期内被
 * clearTimeout 收掉,于是开发期和生产期都只发一发。
 */
export function useCatchUpLink(catchUp: CatchUp, connected: boolean): void {
  useEffect(() => {
    if (!connected) return;
    const handle = setTimeout(() => { void catchUp.run(); }, 0);
    return () => {
      clearTimeout(handle);
      catchUp.cancel();
    };
  }, [catchUp, connected]);
}
