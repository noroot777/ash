// 智能体开了共享浏览器：右栏自己切到「浏览器」那一格（宽格，跟会话大约五五开），你不用去找。
// 每个浏览器会话只切一次（记在 localStorage），之后你切走、关掉都算数，刷新也不会再拽回来；
// 你自己接管着的、已经关掉的、窄屏（右栏会盖住会话）都不切。
import { useEffect } from "react";
import type { TaskBrowserState } from "@ash/shared/task-runtime";
import { useNarrowScreen } from "../lib/useNarrowScreen.ts";

const seenKey = (taskId: string) => `navi:browser-auto-open:${taskId}`;

export function RuntimeAutoOpen({ taskId, browser, openTab }: {
  taskId: string;
  browser: TaskBrowserState | null;
  openTab: (id: string) => void;
}) {
  const narrow = useNarrowScreen();
  const live = !!browser && (browser.status === "starting" || browser.status === "ready") && browser.control === "agent";
  const browserId = browser?.id ?? null;
  useEffect(() => {
    if (!live || !browserId || narrow) return;
    try {
      if (localStorage.getItem(seenKey(taskId)) === browserId) return;
      localStorage.setItem(seenKey(taskId), browserId);
    } catch {
      // 存不下就每次进来都切一次，不至于丢功能。
    }
    openTab("browser");
  }, [taskId, browserId, live, narrow]);
  return null;
}
