import { useEffect } from "react";
import type { TaskBrowserState } from "@navi/shared/task-runtime";
import { useNarrowScreen } from "../lib/useNarrowScreen.ts";

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
      const key = `navi:browser-auto-open:${taskId}`;
      if (localStorage.getItem(key) === browserId) return;
      localStorage.setItem(key, browserId);
    } catch {}
    openTab("browser");
  }, [taskId, browserId, live, narrow]);
  return null;
}
