import { useCallback, useEffect, useState } from "react";
import { readRenamedStorage } from "../lib/renamedStorage.ts";

/**
 * diff 怎么摆：`unified` 是单栏行内对比（增删行前后相邻），`split` 是左右并排（旧的在
 * 左、新的在右）。两者各有各的好处——改一个字用单栏一眼就看完，整段重写用并排才对得上
 * 位——所以给用户自己选，而不是替他定死。
 *
 * 选择是**全局一份**，不按文件也不按任务记：这是「我习惯怎么读 diff」，不是某个文件的
 * 属性。工作区 diff 和分支审查共用同一个键，在哪儿切另一处也跟着变。
 */
export type DiffLayout = "unified" | "split";

const STORAGE_KEY = "ash:diff-layout";

export const DIFF_LAYOUT_LABEL: Record<DiffLayout, string> = {
  unified: "单栏",
  split: "并排",
};

/** 读屏和 aria-label 用整词，界面上只放得下两个字。 */
export const DIFF_LAYOUT_TITLE: Record<DiffLayout, string> = {
  unified: "单栏对比（统一视图）",
  split: "并排对比（左右分栏）",
};

function stored(): DiffLayout {
  try {
    return readRenamedStorage(STORAGE_KEY) === "split" ? "split" : "unified";
  } catch {
    // 隐私模式下读 localStorage 会抛，回落到默认即可。
    return "unified";
  }
}

export function useDiffLayout(): [DiffLayout, (next: DiffLayout) => void] {
  const [layout, setLayout] = useState<DiffLayout>(stored);

  // 同一个页面里可能同时摆着好几个 diff（工作区的、审查工作区的）。切一处就都跟着换，
  // 否则用户得在每一块上各切一次。storage 事件只跨标签页，所以自己再广播一次。
  useEffect(() => {
    const sync = () => setLayout(stored());
    window.addEventListener("storage", sync);
    window.addEventListener("ash:diff-layout", sync);
    return () => {
      window.removeEventListener("storage", sync);
      window.removeEventListener("ash:diff-layout", sync);
    };
  }, []);

  const change = useCallback((next: DiffLayout) => {
    setLayout(next);
    try {
      window.localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // 存不下也不该影响这一次切换。
    }
    window.dispatchEvent(new Event("ash:diff-layout"));
  }, []);

  return [layout, change];
}
