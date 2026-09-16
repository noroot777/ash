import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";

const defaultRatio = 5 / 9;
const storageKey = "ash:git-history-split";

function readRatio() {
  try {
    const value = Number(localStorage.getItem(storageKey));
    if (Number.isFinite(value) && value > 0 && value < 1) return value;
  } catch { /* 无法读取偏好时使用设计稿比例。 */ }
  return defaultRatio;
}

export function HistorySplit({ children }: { children: [ReactNode, ReactNode] }) {
  const container = useRef<HTMLDivElement>(null);
  const [ratio, setRatio] = useState(readRatio);
  const [width, setWidth] = useState(0);
  const [drag, setDrag] = useState<{ x: number; width: number } | null>(null);
  const min = width ? Math.min(280 / width, 0.45) : 0.2;
  const max = 1 - min;
  const clamp = (value: number) => Math.max(min, Math.min(max, value));
  const visibleRatio = clamp(ratio);

  useEffect(() => {
    const node = container.current!;
    const observer = new ResizeObserver(() => {
      setWidth(node.getBoundingClientRect().width);
      setDrag(null);
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    try { localStorage.setItem(storageKey, String(ratio)); } catch { /* 当前会话仍可调宽。 */ }
  }, [ratio]);

  return (
    <div
      ref={container}
      className={`gwb-split gwb-history-split history-view${drag ? " is-resizing" : ""}`}
      style={{ "--gwb-history-width": `${visibleRatio * 100}%` } as CSSProperties}
    >
      {children[0]}
      <div
        className="gwb-history-resize"
        role="separator"
        tabIndex={0}
        aria-label="调整历史列表宽度"
        aria-description="左右拖动或使用方向键调整，双击恢复默认比例"
        aria-orientation="vertical"
        aria-valuemin={Math.round(min * 100)}
        aria-valuemax={Math.round(max * 100)}
        aria-valuenow={Math.round(visibleRatio * 100)}
        aria-valuetext={`历史列表占 ${Math.round(visibleRatio * 100)}%`}
        onPointerDown={(event) => {
          if (event.button !== 0) return;
          event.preventDefault();
          event.currentTarget.focus();
          event.currentTarget.setPointerCapture(event.pointerId);
          setDrag({ x: event.clientX, width: visibleRatio * width });
        }}
        onPointerMove={(event) => {
          if (drag && width) setRatio(clamp((drag.width + event.clientX - drag.x) / width));
        }}
        onPointerUp={(event) => {
          setDrag(null);
          if (event.currentTarget.hasPointerCapture(event.pointerId))
            event.currentTarget.releasePointerCapture(event.pointerId);
        }}
        onPointerCancel={() => setDrag(null)}
        onLostPointerCapture={() => setDrag(null)}
        onDoubleClick={() => setRatio(defaultRatio)}
        onKeyDown={(event) => {
          const step = (event.shiftKey ? 50 : 10) / (width || 1);
          if (event.key === "ArrowLeft") setRatio(clamp(visibleRatio - step));
          else if (event.key === "ArrowRight") setRatio(clamp(visibleRatio + step));
          else if (event.key === "Home") setRatio(min);
          else if (event.key === "End") setRatio(max);
          else return;
          event.preventDefault();
        }}
      />
      {children[1]}
    </div>
  );
}
