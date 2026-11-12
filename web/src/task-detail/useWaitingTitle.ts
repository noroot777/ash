import { useEffect } from "react";

/**
 * 它在等你答复时，标签页标题前面多一个「● 等你答复」（docs/ui-ux-audit run-7）：切到别的
 * 标签页也看得出它停在你这儿。答完、换任务就摘掉，标题回到原来那样。
 */
export function useWaitingTitle(waiting: boolean, taskId: string) {
  useEffect(() => {
    if (!waiting || typeof document === "undefined") return;
    const base = document.title;
    document.title = `● 等你答复 · ${base}`;
    return () => { document.title = base; };
  }, [waiting, taskId]);
}
