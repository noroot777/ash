import { useLayoutEffect, useRef, useState, type KeyboardEventHandler, type ReactNode } from "react";
import { CaretLeft, CaretRight } from "@phosphor-icons/react";

export function PreviewServiceStrip({ children, label, tabs = false, onKeyDown }: {
  children: ReactNode;
  label: string;
  tabs?: boolean;
  onKeyDown?: KeyboardEventHandler<HTMLDivElement>;
}) {
  const strip = useRef<HTMLDivElement>(null);
  const viewport = useRef<HTMLDivElement>(null);
  const [overflow, setOverflow] = useState(false);
  const [edges, setEdges] = useState({ start: true, end: false });
  const measure = () => {
    const el = viewport.current;
    if (!el || !strip.current) return;
    setOverflow(el.scrollWidth > strip.current.clientWidth + 1);
    setEdges({ start: el.scrollLeft <= 1, end: el.scrollLeft + el.clientWidth >= el.scrollWidth - 1 });
  };
  useLayoutEffect(() => {
    const observer = new ResizeObserver(measure);
    if (strip.current) observer.observe(strip.current);
    if (viewport.current) observer.observe(viewport.current);
    return () => observer.disconnect();
  }, []);
  useLayoutEffect(measure, [children]);
  const scroll = (direction: number) => {
    const el = viewport.current;
    if (el) el.scrollBy({ left: direction * el.clientWidth * .75 });
  };

  return <div className="preview-service-strip" ref={strip}>
    {overflow && <button type="button" className="preview-service-scroll-control" tabIndex={-1} aria-label="向左查看服务" disabled={edges.start} onClick={() => scroll(-1)}><CaretLeft size={13} /></button>}
    <div className="preview-service-scroll" ref={viewport} role={tabs ? "tablist" : "group"} aria-label={label} onScroll={measure} onKeyDown={onKeyDown}>
      {children}
    </div>
    {overflow && <button type="button" className="preview-service-scroll-control" tabIndex={-1} aria-label="向右查看服务" disabled={edges.end} onClick={() => scroll(1)}><CaretRight size={13} /></button>}
  </div>;
}
