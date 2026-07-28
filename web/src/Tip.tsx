import { useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

// 自绘 tooltip:原生 title 在这类每秒重渲染的列表里不可靠(悬停计时器被刷新打断,
// 气泡永远弹不出来),而且 16px 图标的悬停目标太小、原生延迟也长。portal + fixed
// 定位,不受列表容器 overflow-hidden 裁剪。
export function Tip({
  label,
  className = "",
  children,
}: {
  label: string;
  className?: string;
  children: ReactNode;
}) {
  const ref = useRef<HTMLSpanElement>(null);
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  return (
    <span
      ref={ref}
      className={className}
      aria-label={label}
      onMouseEnter={() => {
        const r = ref.current?.getBoundingClientRect();
        if (r) setPos({ x: r.left + r.width / 2, y: r.bottom });
      }}
      onMouseLeave={() => setPos(null)}
    >
      {children}
      {pos &&
        createPortal(
          <div
            className="pointer-events-none fixed z-[100] max-w-[280px] -translate-x-1/2 rounded-md border border-line2 bg-panel px-2 py-1 text-[11px] leading-snug text-ink shadow-xl"
            style={{ left: pos.x, top: pos.y + 6 }}
          >
            {label}
          </div>,
          document.body,
        )}
    </span>
  );
}
