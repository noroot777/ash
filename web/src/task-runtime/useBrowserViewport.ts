import { useEffect, useRef } from "react";
import type { BrowserDisplayMode, BrowserUserAction, TaskBrowserState } from "@navi/shared/task-runtime";

export function browserPanelSize(element: HTMLElement) {
  const style = getComputedStyle(element);
  const width = Math.floor(element.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight));
  const height = Math.floor(element.clientHeight - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom));
  return width >= 320 && height >= 240 ? { width: Math.min(2560, width), height: Math.min(1800, height) } : null;
}

export function useBrowserViewport(state: TaskBrowserState, act: (action: BrowserUserAction) => Promise<unknown>) {
  const viewport = useRef<HTMLDivElement>(null);
  const current = useRef({ state, act });
  const intent = useRef<BrowserDisplayMode | null>(null);
  current.current = { state, act };
  const mode = state.display?.mode ?? "scaled";
  const ready = state.status === "ready";
  useEffect(() => {
    const element = viewport.current;
    if (!element || !ready || mode !== "responsive") return;
    let timer: ReturnType<typeof setTimeout>;
    let disposed = false;
    let requested = "";
    const resize = () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        const size = browserPanelSize(element);
        const latest = current.current;
        if (disposed || !size || latest.state.status !== "ready" || (intent.current ?? latest.state.display?.mode) !== "responsive") return;
        const key = `${size.width}:${size.height}`;
        if (key === requested || (size.width === latest.state.width && size.height === latest.state.height)) return;
        requested = key;
        void latest.act({ action: "viewport", mode: "responsive", ...size });
      }, 240);
    };
    const observer = new ResizeObserver(resize);
    observer.observe(element);
    resize();
    return () => { disposed = true; clearTimeout(timer); observer.disconnect(); };
  }, [state.id, ready, mode]);

  const changeMode = (next: BrowserDisplayMode) => {
    const size = next === "responsive" && viewport.current ? browserPanelSize(viewport.current) : null;
    const reference = size ?? state.display ?? state;
    intent.current = next;
    return act({ action: "viewport", mode: next, width: reference.width, height: reference.height }).finally(() => { intent.current = null; });
  };
  return { viewport, mode, changeMode };
}
