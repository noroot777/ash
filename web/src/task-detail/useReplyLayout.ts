import { useLayoutEffect, useRef } from "react";

export function useReplyLayout() {
  const shellRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const shell = shellRef.current;
    const container = shell?.closest(".task-detail-main, .team-flow-main");
    if (!shell || !container) return;
    const resize = () => {
      const height = container.clientHeight;
      shell.style.setProperty("--reply-layout-height", `${Math.max(0, height - Math.min(100, height / 5))}px`);
    };
    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(container);
    return () => observer.disconnect();
  }, []);
  return shellRef;
}
