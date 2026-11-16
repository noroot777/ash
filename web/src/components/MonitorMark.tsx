/**
 * 哨兵那几行最前面的小记号，一眼分出「还在盯」和「已经结束」：在盯的是一颗琥珀色、缓缓呼吸的点；
 * 内置 Monitor 也在跑、但不会叫醒任务，是一颗不动的灰点；已经结束、结果还排着没送进会话的，
 * 是一个不动的灰色空心方块。读屏读的是它的名字。
 */
export function MonitorMark({ state }: { state: "live" | "builtin" | "ended" }) {
  const name = state === "live" ? "在盯" : state === "builtin" ? "内置，在跑" : "已结束";
  return <span className={`scheduled-monitor-mark is-${state}`} role="img" aria-label={name} />;
}
