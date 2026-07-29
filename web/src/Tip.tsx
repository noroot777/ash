import { cloneElement, isValidElement, useRef, useState, type ReactElement, type ReactNode } from "react";
import { createPortal } from "react-dom";

// 自绘 tooltip:原生 title 在这类每秒重渲染的列表里不可靠(悬停计时器被刷新打断,
// 气泡永远弹不出来),而且 16px 图标的悬停目标太小、原生延迟也长。portal + fixed
// 定位,不受列表容器 overflow-hidden 裁剪。
//
// label 会注入给子元素当 aria-label(它自己没写才注入),而不是留在外层 span 上:
// span 没有 role,挂在它身上的 aria-label 会被辅助技术忽略,于是「图标按钮 + Tip」
// 这个最常见的组合就成了一个没有可访问名称的按钮 —— 从 title= 迁过来时这块是净损失,
// 而 title 恰好是自带可访问名称的。放在组件层做,调用点就不必记得每次补一遍。
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
  const labelled =
    isValidElement(children) && (children.props as { "aria-label"?: string })["aria-label"] === undefined
      ? cloneElement(children as ReactElement<{ "aria-label"?: string }>, { "aria-label": label })
      : children;
  return (
    <span
      ref={ref}
      className={className}
      onMouseEnter={() => {
        const r = ref.current?.getBoundingClientRect();
        if (r) setPos({ x: r.left + r.width / 2, y: r.bottom });
      }}
      onMouseLeave={() => setPos(null)}
    >
      {labelled}
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
