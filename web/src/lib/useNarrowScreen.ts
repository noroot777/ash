import { useSyncExternalStore } from "react";

// 手机这么窄的屏（飞书里点开 ash 链接、手机浏览器）：任务列表、任务内容、Inspector 摆不下三栏，
// 一次只给一样（WorkspaceShell 在列表和内容之间切，InspectorHost 改成盖在内容上的一层）。
// 判据和样式里的 @media (max-width: 720px) 是同一条线。
export const NARROW_SCREEN_QUERY = "(max-width: 720px)";

function subscribe(onChange: () => void) {
  const query = window.matchMedia(NARROW_SCREEN_QUERY);
  query.addEventListener("change", onChange);
  return () => query.removeEventListener("change", onChange);
}

export function useNarrowScreen(): boolean {
  return useSyncExternalStore(subscribe, () => window.matchMedia(NARROW_SCREEN_QUERY).matches, () => false);
}
