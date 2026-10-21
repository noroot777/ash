import { useEffect, useState } from "react";

/**
 * 「这一轮证据目录里有哪些文件」—— 报告正文里一处相对路径的**文档根归属**靠它算出来。
 *
 * 为什么必须是服务端列的清单,而不是「先试证据目录、取不到就换工作目录」:加载失败只能证明
 * 那个文件此刻取不到,证明不了这处引用说的是另一个根。报告目录里本该有的那张图丢了、而被审
 * 任务工作目录里刚好有个同名的别的文件时,试出来的那一版会把**别的图**当成证据端上来
 * (审查第 2 轮 F1 的同类位置)。
 *
 * 三处表面共用这一个 hook:团队审查证据、自由工作流审查面板、以及**孤立打开的报告弹窗**
 * (它手上只有报告自己的地址,清单地址由 evidenceListingUrl 从那个地址推出来)。清单还没到货
 * 或者取不到时返回 undefined,调用点退回原来的「按顺序试」—— 那是一档降级,不是判据。
 */
export function useEvidenceNames(load: (() => Promise<string[]>) | null, key: string): string[] | undefined {
  const [names, setNames] = useState<Record<string, string[]>>({});
  useEffect(() => {
    if (!load) return;
    let alive = true;
    void load().then((list) => {
      if (alive) setNames((current) => (current[key] ? current : { ...current, [key]: list }));
    }).catch(() => undefined /* 取不到就退回按顺序试 */);
    return () => { alive = false; };
    // 只认 key:`load` 每次渲染都是新函数,放进依赖里会变成每渲染一次重取一次。
  }, [key]);
  return names[key];
}
